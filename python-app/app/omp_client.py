"""Run a computer-use turn through the local omp CLI and its saved account logins."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .errors import RunnerCoreError
from .processes import assert_active, await_active
from .responses_loop import execute_python_tool_call

SELECTOR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$")
OMP_ACTION_CONTRACT = (
    "This session has no function tools.\n"
    "Reply with one JSON object and no markdown.\n"
    'To act, return {"action":"code","code":"<python>"}.\n'
    "That Python runs in the persistent desktop worker. Globals that survive between calls: pyautogui, log(value), and display(image).\n"
    "Start with display(pyautogui.screenshot()) when you need to see the desktop.\n"
    'After at least one code action, finish with {"action":"final","text":"<what is visible>"}.\n'
    "Do not invent an exec_py or exec_js call. Put the Python in the code field."
)


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


def _action_from_value(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    if value.get("action") == "code" and isinstance(value.get("code"), str) and value["code"].strip():
        return {"action": "code", "code": value["code"]}
    if value.get("action") == "final" and isinstance(value.get("text"), str) and value["text"].strip():
        return {"action": "final", "text": value["text"].strip()}
    return None


def _changes_desktop(code: str) -> bool:
    return re.search(
        r"\b(?:click|doubleClick|rightClick|hotkey|press|keyDown|keyUp|moveTo|drag|write|typewrite|scroll|hscroll)\s*\(",
        code,
    ) is not None


def parse_omp_action(text: str) -> dict[str, str]:
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    source = (fenced.group(1) if fenced else text).strip()
    decoder = json.JSONDecoder()
    actions: list[dict[str, str]] = []
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
        hint='The model must return {"action":"code","code":"..."} or {"action":"final","text":"..."}.',
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


def _history_text(history: list[dict[str, str]]) -> str:
    blocks = []
    for item in history:
        if item["kind"] == "code":
            blocks.append(f"Code already run:\n{item['code']}\n\nText output:\n{item.get('output') or '(no text output)'}")
        else:
            blocks.append(f"The previous reply was not usable JSON:\n{item['text']}\nReply again with one JSON object.")
    return "\n\n".join(blocks)


def _output_text(output: list[dict[str, Any]]) -> str:
    return "\n".join(item.get("text", "") for item in output if item.get("type") == "input_text").strip()[:4000]


async def complete_omp(
    *, instructions: str, prompt: str, selector: str, image_path: str, signal: asyncio.Event | None
) -> str:
    assert_omp_selector(selector)
    directory = Path(tempfile.mkdtemp(prefix="cua-omp-"))
    prompt_path = directory / "prompt.md"
    try:
        prompt_path.write_text(prompt)
        stdout, _stderr = await _run_process(
            [
                "--mode", "json", "-p", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules",
                "--max-time", "180", "--system-prompt", instructions, "--model", selector,
                f"@{image_path}", f"@{prompt_path}",
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
    max_response_turns: int,
    selector: str,
    complete: Any = complete_omp,
) -> dict[str, Any]:
    assert_omp_selector(selector)
    instructions = f"{instructions.rstrip()}\n\n{OMP_ACTION_CONTRACT}"
    task = context.detail["run"]["prompt"].strip()
    history: list[dict[str, str]] = []
    final_assistant_message: str | None = None
    for turn in range(1, max_response_turns + 1):
        assert_active(context.signal)
        screenshot = await await_active(context.capture_screenshot(session, f"omp-turn-{turn}"), context.signal)
        prior = _history_text(history)
        prompt = f"Task:\n{task}\n\n{prior}" if prior else task
        try:
            text = await complete(
                instructions=instructions, prompt=prompt, selector=selector, image_path=screenshot["path"], signal=context.signal
            )
        except RunnerCoreError:
            raise
        except asyncio.TimeoutError as error:
            raise RunnerCoreError(
                "The omp model call timed out before it returned an action.",
                code="model_request_failed",
                status_code=502,
                hint="Retry the run. A hung call usually means omp waited on inherited input instead of the screenshot.",
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
        if action["action"] == "final":
            if not any(item["kind"] == "code" for item in history):
                history.append({"kind": "invalid", "text": text[:2000]})
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
        if not action["code"].strip():
            history.append({"kind": "invalid", "text": text[:2000]})
            continue
        output = await execute_python_tool_call(
            context, session, {"arguments": json.dumps({"code": action["code"]}), "code": action["code"], "call_id": f"omp-{turn}"}
        )
        history.append({"kind": "code", "code": action["code"], "output": _output_text(output)})
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
