"""Run a computer-use turn through the local omp CLI and its saved account logins."""

from __future__ import annotations

import ast
import asyncio
import json
import os
import re
import shutil
import tempfile
from collections.abc import Iterable
from itertools import count
from pathlib import Path
from typing import Any

from .asking import ASK_GUIDANCE, ask_user, parse_ask
from .attachments import first_image, task_text
from .errors import RunnerCoreError
from .processes import assert_active, await_active
from .responses_loop import execute_python_tool_call, steer_text
from .storage import model_image_path

SELECTOR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$")
DISPLAYED_IMAGE_NOTE = "The attached image is the last image your code displayed."
SCREEN_IMAGE_NOTE = "The attached image is a screenshot of this computer's screen taken just now."
NO_IMAGE_NOTE = 'No image is attached this turn. Return {"action":"look"} if you need to see the screen.'
ANSWERED_BEFORE_ACTING_NOTE = "You answered before taking any action. Run code that does the task first."
STEERED_NOTE = "The user sent new instructions since your last reply (see above). Take them into account in this reply."


def omp_action_contract(*, web: bool, apps: bool = False) -> str:
    return "\n".join([
        "This session has no function tools.",
        "Reply with one JSON object and no markdown.",
        'To act, return {"action":"code","code":"<python>"}.',
        # The run instructions already carry instrument_lines(); repeating them here only spends tokens.
        "That Python runs in the persistent desktop worker. Globals that survive between calls: pyautogui, log(value), and display(image)"
        + ((", plus the web, read and apps instruments described above." if apps else ", plus the web and read instruments described above.") if web else "."),
        (
            "You do not see this computer's screen unless you ask. "
            'To see it, return {"action":"look"}; the next turn attaches a screenshot taken just then.'
        ),
        (
            "Prefer actions that need no looking and leave the user's screen alone: the read and web instruments "
            "when available, subprocess (open -a <App> on macOS), AppleScript through osascript, "
            "and state read through code output with log(value)."
            if web
            else "Prefer direct actions that need no looking: open apps with subprocess (open -a <App> on macOS), "
            "drive apps with AppleScript through osascript, open URLs, press keyboard shortcuts, "
            "and read state through code output with log(value)."
        ),
        "Look only to find something on the screen or to check a result that code output cannot confirm.",
        "If your code displays images, the next turn attaches the last one displayed.",
        (
            'To ask the user, return {"action":"ask","question":"<text>","kind":"question" or "approval",'
            '"options":["<choice>", …],"detail":"<exact content, for an approval>"}; options and detail are optional. '
            "The next turn carries their answer."
        ),
        ASK_GUIDANCE,
        'After at least one code action, finish with {"action":"final","text":"<what you did and what happened>"}.',
        "Do not invent an exec_py or exec_js call. Put the Python in the code field.",
    ])


def omp_binary() -> str:
    configured = os.environ.get("OMP_BIN", "").strip()
    found = configured or shutil.which("omp")
    if not found:
        raise RunnerCoreError(
            "omp is not installed, so its accounts cannot be used.",
            code="omp_unavailable",
            status_code=400,
            hint="Install omp and run `omp login` for Cursor, Claude, Codex, or any other account, then refresh the console.",
        )
    return found


def assert_omp_selector(selector: str) -> None:
    if not SELECTOR.fullmatch(selector):
        raise RunnerCoreError(
            "An omp model must look like provider/model, for example openai-codex/gpt-6-astra.",
            code="invalid_request",
            status_code=400,
            hint="Pick a model from the OMP accounts list.",
        )


def parse_omp_catalog(payload: Any) -> list[dict[str, str]]:
    models = payload.get("models") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        raise RunnerCoreError("omp models returned an unreadable catalog.", code="omp_unavailable", status_code=502)
    listed: list[dict[str, str]] = []
    for model in models:
        if not isinstance(model, dict) or model.get("kind") != "chat" or "image" not in (model.get("input") or []):
            continue
        provider, model_id, selector, name = (model.get("provider"), model.get("id"), model.get("selector"), model.get("name"))
        if not all(isinstance(value, str) and value for value in (provider, model_id, selector, name)):
            continue
        assert isinstance(provider, str) and isinstance(model_id, str) and isinstance(selector, str) and isinstance(name, str)
        if not SELECTOR.fullmatch(selector):
            continue
        listed.append({"provider": provider, "id": model_id, "selector": selector, "name": name})
    return listed


def assistant_text_from_omp_events(stdout: str) -> str:
    text = ""
    for line in stdout.splitlines():
        trimmed = line.strip()
        if not trimmed.startswith("{"):
            continue
        try:
            event = json.loads(trimmed)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("content"), list):
            continue
        parts = [
            part.get("text", "").strip()
            for part in message["content"]
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
        ]
        text = "\n".join(part for part in parts if part)
    return text


def _action_from_value(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if value.get("action") == "code" and isinstance(value.get("code"), str) and value["code"].strip():
        return {"action": "code", "code": value["code"]}
    if value.get("action") == "final" and isinstance(value.get("text"), str) and value["text"].strip():
        return {"action": "final", "text": value["text"].strip()}
    if value.get("action") == "look":
        return {"action": "look"}
    if value.get("action") == "ask":
        try:
            return {"action": "ask", "question": parse_ask(value)}
        except ValueError:
            return None
    return None


def _changes_desktop(code: str) -> bool:
    return re.search(
        r"\b(?:click|doubleClick|rightClick|hotkey|press|keyDown|keyUp|moveTo|drag|write|typewrite|scroll|hscroll)\s*\(",
        code,
    ) is not None


def _is_call(node: ast.AST, owners: tuple[str, ...], names: tuple[str, ...]) -> bool:
    """True for owner.name(...) whose arguments contain no further calls."""
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id in owners
        and node.func.attr in names
        and not any(isinstance(child, ast.Call) for argument in [*node.args, *node.keywords] for child in ast.walk(argument))
    )


def _is_global_call(node: ast.AST, name: str) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == name and not node.keywords


def only_looks_at_screen(code: str) -> bool:
    """True when the code would only observe this computer's screen, so it is a request to look rather than an action."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    screenshots: set[str] = set()
    readings: set[str] = set()

    def screenshot(node: ast.AST) -> bool:
        return _is_call(node, ("pyautogui",), ("screenshot",))

    def reading(node: ast.AST) -> bool:
        return _is_call(node, ("pyautogui",), ("size", "position")) or (isinstance(node, ast.Name) and node.id in readings)

    def targets(node: ast.AST) -> list[str] | None:
        if isinstance(node, ast.Name):
            return [node.id]
        if isinstance(node, ast.Tuple) and all(isinstance(item, ast.Name) for item in node.elts):
            return [item.id for item in node.elts if isinstance(item, ast.Name)]
        return None

    for statement in tree.body:
        if isinstance(statement, ast.Import) and all(alias.name in {"pyautogui", "time"} and alias.asname is None for alias in statement.names):
            continue
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            names = targets(statement.targets[0])
            if names is not None and screenshot(statement.value) and len(names) == 1:
                screenshots.add(names[0])
                continue
            if names is not None and reading(statement.value):
                readings.update(names)
                continue
            return False
        if not isinstance(statement, ast.Expr):
            return False
        value = statement.value
        if isinstance(value, ast.Constant):
            continue
        if screenshot(value) or reading(value) or _is_call(value, ("pyautogui", "time"), ("sleep",)):
            continue
        if isinstance(value, ast.Call) and _is_global_call(value, "display") and len(value.args) == 1:
            shown = value.args[0]
            if screenshot(shown) or (isinstance(shown, ast.Name) and shown.id in screenshots):
                continue
        if isinstance(value, ast.Call) and _is_global_call(value, "log") and value.args and all(
            reading(argument) or isinstance(argument, ast.Constant) for argument in value.args
        ):
            continue
        return False
    return True


def parse_omp_action(text: str) -> dict[str, Any]:
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    source = (fenced.group(1) if fenced else text).strip()
    decoder = json.JSONDecoder()
    actions: list[dict[str, Any]] = []
    index = 0
    while index < len(source):
        start = source.find("{", index)
        if start < 0:
            break
        try:
            value, offset = decoder.raw_decode(source[start:])
        except json.JSONDecodeError:
            index = start + 1
            continue
        action = _action_from_value(value)
        if action is not None:
            actions.append(action)
        index = start + max(offset, 1)
    codes = [action for action in actions if action["action"] == "code"]
    for action in codes:
        if _changes_desktop(action["code"]):
            return action
    if codes:
        return codes[0]
    if actions:
        return actions[-1]
    raise RunnerCoreError(
        "The omp model did not return a JSON action.",
        code="unexpected_model_response",
        status_code=400,
        hint='The model must return {"action":"code","code":"..."}, {"action":"look"}, {"action":"ask","question":"..."}, or {"action":"final","text":"..."}.',
    )


async def _run_process(args: list[str], signal: asyncio.Event | None, timeout: float) -> tuple[str, str]:
    process = await asyncio.create_subprocess_exec(
        omp_binary(), *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await await_active(asyncio.wait_for(process.communicate(), timeout), signal)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert_active(signal)
    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip().splitlines()
        raise RunnerCoreError(
            "\n".join(detail[-4:]) or f"omp exited {process.returncode}.",
            code="model_request_failed",
            status_code=502,
            hint="Run `omp login` again if the account expired, and confirm the model accepts images.",
        )
    return stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


async def list_omp_models() -> dict[str, Any]:
    try:
        stdout, _stderr = await _run_process(["models", "--json", "--no-extensions"], None, 20)
        start, end = stdout.find("{"), stdout.rfind("}")
        if start < 0 or end <= start:
            raise RunnerCoreError("omp models returned no JSON catalog.", code="omp_unavailable", status_code=502)
        return {"available": True, "models": parse_omp_catalog(json.loads(stdout[start : end + 1]))}
    except RunnerCoreError as error:
        return {"available": False, "detail": str(error), "models": []}
    except (OSError, json.JSONDecodeError, asyncio.TimeoutError) as error:
        return {"available": False, "detail": str(error), "models": []}


def _history_text(history: list[dict[str, Any]]) -> str:
    """Replay prior turns; the note at the end of the prompt alone says whether this turn carries an image."""
    blocks = []
    # A follow-up queued after a look or an early answer must not hide that it was the model's latest move.
    last_move = max((index for index, item in enumerate(history) if item["kind"] != "user"), default=-1)
    for index, item in enumerate(history):
        latest = index == last_move
        if item["kind"] == "user":
            blocks.append(steer_text(item))
        elif item["kind"] == "code":
            shown = item["images"]
            images = "It displayed no images." if shown == 0 else f"It displayed {shown} image{'s' if shown != 1 else ''}."
            blocks.append(
                f"Code already run:\n{item['code']}\n\nText output:\n{item.get('output') or '(no text output)'}\n\n{images}"
            )
        elif item["kind"] == "look":
            looked = "You asked to see the screen." if latest else "You looked at the screen."
            if item.get("code"):
                # Screenshot-only code is served as a look, so say why it never ran.
                looked = f"Code not run, because it only looks at the screen:\n{item['code']}\n\n{looked}"
            blocks.append(looked)
        elif item["kind"] == "answered":
            blocks.append(ANSWERED_BEFORE_ACTING_NOTE if latest else "You answered before taking any action.")
        elif item["kind"] == "asked":
            blocks.append(item["text"])
        else:
            blocks.append(f"The previous reply was not usable JSON:\n{item['text']}\nReply again with one JSON object.")
    return "\n\n".join(blocks)


def _output_text(output: list[dict[str, Any]]) -> str:
    return "\n".join(item.get("text", "") for item in output if item.get("type") == "input_text").strip()[:4000]


async def complete_omp(
    *, instructions: str, prompt: str, selector: str, image_path: str | None, signal: asyncio.Event | None
) -> str:
    assert_omp_selector(selector)
    directory = Path(tempfile.mkdtemp(prefix="jarvis-omp-"))
    prompt_path = directory / "prompt.md"
    try:
        prompt_path.write_text(prompt)
        stdout, _stderr = await _run_process(
            [
                "--mode", "json", "-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules",
                "--max-time", "180", "--system-prompt", instructions, "--model", selector,
                *([f"@{image_path}"] if image_path is not None else []), f"@{prompt_path}",
            ],
            signal,
            190,
        )
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    text = assistant_text_from_omp_events(stdout)
    if not text:
        raise RunnerCoreError(
            "omp returned no assistant message.",
            code="unexpected_model_response",
            status_code=502,
            hint="Check that `omp login` is still valid for this model, then run it again.",
        )
    return text


async def run_omp_code_loop(
    context: Any,
    session: Any,
    instructions: str,
    max_response_turns: int | None,
    selector: str,
    complete: Any = complete_omp,
) -> dict[str, Any]:
    assert_omp_selector(selector)
    contract = omp_action_contract(web=bool(getattr(session, "web_instruments", False)), apps=bool(getattr(session, "apps_gateway", None)))
    instructions = f"{instructions.rstrip()}\n\n{contract}"
    task = task_text(context.detail["run"])
    history: list[dict[str, Any]] = []
    # The model sees the screen only when it asks (look) or when its own code displayed an image; the first image the
    # user attached is shown up front so the model need not spend a turn displaying it.
    attachment: tuple[str, str] | None = None
    attached = first_image(context.detail["run"].get("attachments", []))
    if attached is not None:
        attachment = (attached["path"], f"The attached image is {attached['name']}, which the user attached to the request.")
    final_assistant_message: str | None = None
    budget: Iterable[int] = count(1) if max_response_turns is None else range(1, max_response_turns + 1)
    for turn in budget:
        assert_active(context.signal)
        steers = await context.next_turn()
        history.extend({"kind": "user", **steer} for steer in steers)
        steered = first_image([item for steer in steers for item in steer.get("attachments", [])])
        # A screenshot the model asked for keeps the slot; the follow-up text still says how to display the image.
        if steered is not None and attachment is None:
            attachment = (steered["path"], f"The attached image is {steered['name']}, which the user attached to their latest message.")
        image_path, image_note = attachment if attachment is not None else (None, NO_IMAGE_NOTE)
        attachment = None
        notes = (image_note, STEERED_NOTE if steers else "")
        prompt = "\n\n".join(part for part in (f"Task:\n{task}", _history_text(history), *notes) if part)
        try:
            text = await complete(
                instructions=instructions, prompt=prompt, selector=selector, image_path=image_path, signal=context.signal
            )
        except RunnerCoreError:
            raise
        except asyncio.TimeoutError as error:
            raise RunnerCoreError(
                "The omp model call timed out before it returned an action.",
                code="model_request_failed",
                status_code=502,
                hint="Retry the run. A hung call usually means omp waited on inherited input instead of the prompt file.",
            ) from error
        except Exception as error:
            raise RunnerCoreError(
                str(error),
                code="model_request_failed",
                status_code=502,
                hint="Run `omp login` again if the account expired, and confirm the model accepts images.",
            ) from error
        await await_active(
            context.emit_event({
                "detail": f"omp:{selector}", "level": "ok", "message": f"Model turn {turn} completed.", "type": "run_progress"
            }),
            context.signal,
        )
        try:
            action = parse_omp_action(text)
        except RunnerCoreError as error:
            history.append({"kind": "invalid", "text": text[:2000]})
            await await_active(
                context.emit_event({
                    "detail": str(error), "level": "warn", "message": "Model reply was not an action. Asking it to correct the reply.",
                    "type": "run_progress",
                }),
                context.signal,
            )
            continue
        if action["action"] == "ask":
            history.append({"kind": "asked", "text": await ask_user(context, action["question"])})
            continue
        if action["action"] == "final":
            # Asking counts as acting: the user may have answered that nothing should be done.
            if not any(item["kind"] in ("code", "asked") for item in history):
                history.append({"kind": "answered"})
                await await_active(
                    context.emit_event({
                        "detail": action["text"], "level": "warn",
                        "message": "Model answered before acting. Asking it to use the desktop first.", "type": "run_progress",
                    }),
                    context.signal,
                )
                continue
            final_assistant_message = action["text"]
            break
        if action["action"] == "look" or only_looks_at_screen(action["code"]):
            screenshot = await await_active(context.capture_screenshot(session, f"omp-look-{turn}"), context.signal)
            history.append({"kind": "look", "code": action.get("code")})
            # The stored screenshot may be downscaled; clicks must use the full-size frame's coordinates.
            attachment = (model_image_path(screenshot["path"]), SCREEN_IMAGE_NOTE)
            await await_active(
                context.emit_event({
                    "detail": action.get("code", "look")[:2000], "level": "ok",
                    "message": "Model asked to see the screen.", "type": "run_progress",
                }),
                context.signal,
            )
            continue
        output, image_paths = await execute_python_tool_call(
            context,
            session,
            {"arguments": json.dumps({"code": action["code"]}), "code": action["code"], "call_id": f"omp-{turn}"},
            # Desktop runs skip the routine preview capture; lab runs keep it for the browser replay.
            preview=not getattr(session, "desktop_app", False),
        )
        history.append({"kind": "code", "code": action["code"], "output": _output_text(output), "images": len(image_paths)})
        if image_paths:
            attachment = (model_image_path(image_paths[-1]), DISPLAYED_IMAGE_NOTE)
    if final_assistant_message is None:
        raise RuntimeError(
            f"Model code loop exhausted the configured {max_response_turns}-turn budget without producing a final assistant message."
        )
    await await_active(
        context.emit_event({
            "detail": final_assistant_message, "level": "ok", "message": "Model returned a final response.", "type": "run_progress"
        }),
        context.signal,
    )
    return {
        "final_assistant_message": final_assistant_message,
        "notes": [f"Executed the scenario through omp ({selector}).", f"Model final response: {final_assistant_message}"],
    }
