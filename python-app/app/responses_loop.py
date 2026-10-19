"""The complete Responses API → Python tool → tool results → response loop."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import re
import struct
import time
from collections.abc import Iterable, Sequence
from itertools import count
from typing import Any

from .asking import ASK_TOOL_NAME, ask_tool_definition, ask_user, parse_ask
from .attachments import attachment_lines, inline_image, task_text
from .desktop.input_rules import shortcut_instruction
from .desktop.runtime import PythonRuntimeError
from .errors import RunnerCoreError
from .instruments import instrument_lines
from .processes import assert_active, await_active
from .run_model import ESCALATE_TOOL_NAME, RunModel, call_usage, escalate_tool_definition, parse_escalate


def steer_text(steer: dict[str, Any]) -> str:
    """How a user's follow-up reads to the model in every provider loop; the original task stays in context."""
    if steer["mode"] == "redirect":
        text = (f"The user changed the request: {steer['message']}\n"
                "Follow this from now on; where it conflicts with the original task, this wins.")
    else:
        text = f"While you were working, the user added: {steer['message']}"
    return "\n\n".join(part for part in (text, attachment_lines(steer.get("attachments", []))) if part)


async def user_input(text: str, attachments: list[dict[str, str]]) -> list[dict[str, Any]]:
    """User content as input items; the first attached image rides along so the model sees it without asking."""
    image = await asyncio.to_thread(inline_image, attachments)
    return [{"type": "input_text", "text": text}, *([image] if image else [])]


class OpenAIResponsesClient:
    def __init__(self, api_key: str) -> None:
        from openai import AsyncOpenAI

        self.client = AsyncOpenAI(api_key=api_key)

    async def create(self, request: dict[str, Any], signal: asyncio.Event | None = None) -> dict[str, Any]:
        response = await await_active(self.client.responses.create(**request), signal)
        return response.model_dump(exclude_none=True)

    async def close(self) -> None:
        await self.client.close()


def create_default_responses_client() -> OpenAIResponsesClient:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RunnerCoreError(
            "OPENAI_API_KEY is required to run a lab.",
            code="missing_api_key",
            status_code=400,
            hint="Set OPENAI_API_KEY in the runner environment, then rerun the scenario.",
        )
    return OpenAIResponsesClient(key)


def _target_lines(*, desktop_app: bool, target_label: str, web: bool, cloud: bool = False, apps: bool = False) -> list[str]:
    if not desktop_app:
        return [
            "Start with display(pyautogui.screenshot()).",
            "A visible Chromium window is already open to the lab.",
            "Operate only the lab window.",
        ]
    if target_label == "Unreal Editor":
        return [
            "Unreal Editor is already open on the primary display. No practice web lab is open.",
            "Operate only Unreal Editor. Do not click the operator console or other windows.",
        ]
    return [
        "Use any app on this computer's primary display. Never click or type in the Jarvis window.",
        *instrument_lines(web=web, cloud=cloud, apps=apps),
    ]


def build_code_tool_definitions(
    platform: str, *, desktop_app: bool = False, target_label: str = "the desktop", web: bool = False, cloud: bool = False,
    apps: bool = False,
) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": "exec_py",
            "strict": True,
            "description": "Execute Python in the persistent PyAutoGUI desktop session for this run.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["code"],
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "\n".join(
                            [
                                f"Python to execute on the local {platform} desktop. Python globals survive between calls.",
                                "Available globals: pyautogui, log(value), and display(image), accepting a Pillow image.",
                                *_target_lines(desktop_app=desktop_app, target_label=target_label, web=web, cloud=cloud, apps=apps),
                                shortcut_instruction(platform),
                                "Screenshots use the same coordinates as PyAutoGUI input on macOS Retina displays and on scaled Windows displays. All coordinates refer to the full desktop screenshot.",
                                *([] if web else ["No Playwright objects are available."]),
                                "Do not change the PyAutoGUI fail-safe setting.",
                            ]
                        ),
                    }
                },
            },
        }
    ]


def session_code_tool_definitions(session: Any, *, escalate: bool = False) -> list[dict[str, Any]]:
    """exec_py for this session, then ask_user, then escalate when Auto may switch to a stronger model."""
    return [
        *build_code_tool_definitions(
            session.execution.platform,
            desktop_app=bool(getattr(session, "desktop_app", False)),
            target_label=getattr(session, "target_label", "the desktop"),
            web=bool(getattr(session, "web_instruments", False)),
            cloud=bool(getattr(session, "browser_gateway", None)),
            apps=bool(getattr(session, "apps_gateway", None)),
        ),
        ask_tool_definition(),
        *([escalate_tool_definition()] if escalate else []),
    ]


def invalid_response(message: str) -> RunnerCoreError:
    return RunnerCoreError(message, code="unexpected_model_response", status_code=400)


def classify_response(response: dict[str, Any]) -> dict[str, Any]:
    """Validate *all* output items before allowing any model code to execute."""
    if not isinstance(response, dict):
        raise invalid_response("Malformed Responses API response.")
    if response.get("status") != "completed" or response.get("error"):
        error = response.get("error")
        message = error.get("message", "") if isinstance(error, dict) else ""
        raise invalid_response(
            f"Responses API request did not complete (status: {response.get('status', 'missing')}). {message}".strip()
        )
    if not isinstance(response.get("id"), str) or not response["id"].strip():
        raise invalid_response("Responses API response ID is missing.")
    if not isinstance(response.get("output"), list):
        raise invalid_response("Responses API output is missing.")
    calls: list[dict[str, Any]] = []
    call_ids: set[str] = set()
    commentary: list[str] = []
    final: list[str] = []
    refusal: str | None = None
    for item in response["output"]:
        if not isinstance(item, dict):
            raise invalid_response("Malformed response output item.")
        if item.get("type") == "reasoning":
            continue
        if item.get("type") == "function_call":
            if item.get("name") not in ("exec_py", ASK_TOOL_NAME, ESCALATE_TOOL_NAME):
                raise invalid_response(
                    f"Unexpected function call: {item.get('name', '<unknown>')}. "
                    f"Only exec_py, {ASK_TOOL_NAME} and {ESCALATE_TOOL_NAME} are supported."
                )
            if "status" in item and item["status"] != "completed":
                raise invalid_response("The response contains an unfinished function call.")
            if not isinstance(item.get("call_id"), str) or not item["call_id"].strip():
                raise invalid_response("Function call ID is missing.")
            if item["call_id"] in call_ids:
                raise invalid_response(f"Duplicate function call ID: {item['call_id']}.")
            if not isinstance(item.get("arguments"), str):
                raise invalid_response("Function call arguments must be a JSON string.")
            try:
                args = json.loads(item["arguments"])
            except ValueError as error:
                raise invalid_response("Function call arguments are not valid JSON.") from error
            if item["name"] == ASK_TOOL_NAME:
                try:
                    question = parse_ask(args)
                except ValueError as error:
                    raise invalid_response(f"{ASK_TOOL_NAME}: {error}") from error
                call_ids.add(item["call_id"])
                calls.append({"call_id": item["call_id"], "name": ASK_TOOL_NAME, "question": question})
                continue
            if item["name"] == ESCALATE_TOOL_NAME:
                try:
                    reason = parse_escalate(args)
                except ValueError as error:
                    raise invalid_response(f"{ESCALATE_TOOL_NAME}: {error}") from error
                call_ids.add(item["call_id"])
                calls.append({"call_id": item["call_id"], "name": ESCALATE_TOOL_NAME, "reason": reason})
                continue
            if not isinstance(args, dict) or set(args) != {"code"} or not isinstance(args.get("code"), str):
                raise invalid_response("exec_py requires a code string and no other arguments.")
            if not args["code"].strip() or len(args["code"].encode()) > 64 * 1024:
                raise invalid_response("Python code must be nonempty and at most 64 KiB.")
            call_ids.add(item["call_id"])
            calls.append({"call_id": item["call_id"], "name": "exec_py", "arguments": item["arguments"], "code": args["code"]})
            continue
        if item.get("type") != "message":
            raise RunnerCoreError(
                f"Unsupported response output: {item.get('type')}. Only exec_py tool calls are supported.",
                code="unsupported_tool_response",
                status_code=400,
            )
        if (
            item.get("role") != "assistant"
            or not isinstance(item.get("content"), list)
            or ("status" in item and item["status"] != "completed")
        ):
            raise invalid_response("The response contains an invalid or unfinished assistant message.")
        if item.get("phase") not in (None, "commentary", "final_answer"):
            raise invalid_response("Unknown assistant message phase.")
        for part in item["content"]:
            if not isinstance(part, dict):
                raise invalid_response("Malformed assistant message content.")
            if part.get("type") == "refusal":
                text = part.get("refusal")
                refusal = text.strip() if isinstance(text, str) and text.strip() else "The model declined this task."
                continue
            if part.get("type") != "output_text" or not isinstance(part.get("text"), str):
                raise invalid_response("Unsupported assistant message content.")
            text = part["text"].strip()
            if text:
                (commentary if item.get("phase") == "commentary" else final).append(text)
    if refusal:
        raise RunnerCoreError(refusal, code="model_refusal", status_code=400)
    progress = "\n\n".join(commentary)
    if calls:
        return {"kind": "calls", "calls": calls, "commentary": progress}
    if final:
        return {"kind": "final", "text": "\n\n".join(final), "commentary": progress}
    if commentary:
        return {"kind": "commentary", "commentary": progress}
    raise invalid_response("Responses API returned no tool calls or nonempty final assistant message.")


# Model code that used the background browser (read(...), web.goto, web.page...).
BACKGROUND_WEB = re.compile(r"\b(?:read\s*\(|web\s*\.)")
# Shows the page the background browser used last, without adding names to the model's Python globals.
PREVIEW_CODE = "(lambda image: image and display(image))(web.preview())"


async def execute_python_tool_call(
    context: Any, session: Any, call: dict[str, Any], *, preview: bool = True
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run model code; return its tool output and the saved paths of the images it displayed.

    preview=False skips the routine after-code screenshot for loops where the model sees the screen only on request.
    Code that used the background browser always gets a picture of its page for the app's Live view, which the model
    never sees: background work otherwise leaves Live blank.
    """
    if session.execution is None:
        raise RuntimeError("Python runtime is unavailable. Run uv sync and start a new run.")
    await await_active(
        context.emit_event(
            {
                "detail": f"exec_py {call['arguments']}",
                "level": "pending",
                "message": "Function tool call received from the model.",
                "type": "function_call_requested",
            }
        ),
        context.signal,
    )
    # Steps that may use the screen take turns with other runs; the wait isn't part of the step's deadline. Steps of a
    # run sharing the local browser also wait while the runner hands it over to (or back from) the sign-in window.
    screen = getattr(session, "screen", None)
    browser = getattr(session, "browser_lease", None)
    async with (
        browser.step(context.signal) if browser is not None else contextlib.nullcontext(),
        screen.step(call["code"]) if screen is not None else contextlib.nullcontext(),
    ):
        result = await await_active(session.execution.execute(call["code"], context.signal), context.signal)
        assert_active(context.signal)
        image_paths: list[str] = []
        for item in result["output"]:
            if item["type"] != "input_image":
                continue
            encoded = item["image_url"][len("data:image/png;base64,") :]
            image = base64.b64decode(encoded)
            observation: dict[str, Any] = {"base64": encoded}
            if len(image) >= 24 and image[:8] == b"\x89PNG\r\n\x1a\n":
                observation["width"], observation["height"] = struct.unpack(">II", image[16:24])
            artifact = await await_active(context.capture_screenshot(session, "Code tool image", observation), context.signal)
            image_paths.append(artifact["path"])
        await await_active(context.sync_browser_state(session), context.signal)
        if getattr(session, "web_instruments", False) and BACKGROUND_WEB.search(call["code"]):
            await _capture_background_page(context, session)
        if preview:
            # Inside the same hold, so the picture shows this step's result rather than another run's.
            await await_active(
                context.capture_screenshot(session, f"responses-code-turn-{time.time_ns() // 1_000_000}"), context.signal
            )
    await await_active(
        context.emit_event(
            {
                "detail": "exec_py",
                "level": "ok",
                "message": "Function tool call completed.",
                "type": "function_call_completed",
            }
        ),
        context.signal,
    )
    return result["output"] or [{"text": "exec_py completed with no output.", "type": "input_text"}], image_paths


async def _capture_background_page(context: Any, session: Any) -> None:
    try:
        result = await await_active(session.execution.execute(PREVIEW_CODE, context.signal), context.signal)
    except PythonRuntimeError:
        return  # Cosmetic: a failed preview must not fail the run.
    for item in result["output"]:
        if item["type"] == "input_image":
            encoded = item["image_url"][len("data:image/png;base64,") :]
            image = base64.b64decode(encoded)
            observation: dict[str, Any] = {"base64": encoded}
            if len(image) >= 24 and image[:8] == b"\x89PNG\r\n\x1a\n":
                observation["width"], observation["height"] = struct.unpack(">II", image[16:24])
            await await_active(context.capture_screenshot(session, "Background browser", observation), context.signal)


def responses_usage(response: dict[str, Any]) -> dict[str, Any] | None:
    """A Responses API call's usage; input_tokens already includes the cached part."""
    usage = response.get("usage") if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return None
    details = usage.get("input_tokens_details")
    return call_usage(input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"),
                      cached_tokens=details.get("cached_tokens") if isinstance(details, dict) else 0)


async def run_responses_code_loop(
    context: Any,
    session: Any,
    instructions: str,
    max_response_turns: int | None,
    client: Any,
    stronger_models: Sequence[str] = (),
) -> dict[str, Any]:
    """Each iteration requests a response and sends all matching tool results back. stronger_models: Auto's stronger
    OpenAI models, weakest first, switched to one at a time if the run struggles; previous_response_id carries the
    conversation over."""
    model = RunModel(context, context.detail["run"]["model"], stronger_models)
    previous_response_id: str | None = None
    task = task_text(context.detail["run"])
    opening = await user_input(task, context.detail["run"].get("attachments", []))
    # A plain string stays the opening input unless an attached image has to ride along.
    next_input: Any = task if len(opening) == 1 else [{"role": "user", "content": opening}]
    final_assistant_message: str | None = None
    budget: Iterable[int] = count(1) if max_response_turns is None else range(1, max_response_turns + 1)
    for turn in budget:
        assert_active(context.signal)
        steers = await context.next_turn()
        if steers:
            # Responses input accepts user messages after tool outputs, so a follow-up joins this turn's input.
            items = [{"role": "user", "content": next_input}] if isinstance(next_input, str) else list(next_input)
            for steer in steers:
                items.append({"role": "user", "content": await user_input(steer_text(steer), steer.get("attachments", []))})
            next_input = items
        request: dict[str, Any] = {
            "instructions": instructions,
            "input": next_input,
            "model": (await model.next()).model_id,
            "parallel_tool_calls": False,
            "reasoning": {"effort": "low"},
            "truncation": "auto",
            "tools": session_code_tool_definitions(session, escalate=model.offers_escalation),
        }
        if previous_response_id is not None:
            request["previous_response_id"] = previous_response_id
        response = await await_active(client.create(request, context.signal), context.signal)
        assert_active(context.signal)
        model.replied(responses_usage(response))
        classified = classify_response(response)
        usage = response.get("usage") or {}
        reasoning = (usage.get("output_tokens_details") or {}).get("reasoning_tokens", 0)
        await await_active(
            context.emit_event(
                {
                    "detail": f"{response['id']} · {usage.get('input_tokens', 0)} in · {usage.get('output_tokens', 0)} out · {reasoning} reasoning",
                    "level": "ok",
                    "message": f"Responses API turn {turn} completed.",
                    "type": "run_progress",
                }
            ),
            context.signal,
        )
        previous_response_id = response["id"]
        if classified["commentary"]:
            await await_active(
                context.emit_event(
                    {
                        "type": "run_progress",
                        "level": "pending",
                        "message": "Model progress.",
                        "detail": classified["commentary"],
                    }
                ),
                context.signal,
            )
        if classified["kind"] == "final":
            final_assistant_message = classified["text"]
            break
        if classified["kind"] == "commentary":
            next_input = []
            continue
        tool_outputs = []
        for call in classified["calls"]:
            assert_active(context.signal)
            if call["name"] == ASK_TOOL_NAME:
                output: list[dict[str, Any]] = [{"type": "input_text", "text": await ask_user(context, call["question"])}]
            elif call["name"] == ESCALATE_TOOL_NAME:
                output = [{"type": "input_text", "text": model.requested(call["reason"])}]
            else:
                output, _images = await execute_python_tool_call(context, session, call)
                model.stepped(output)
            assert_active(context.signal)
            tool_outputs.append({"call_id": call["call_id"], "output": output, "type": "function_call_output"})
        next_input = tool_outputs
    if final_assistant_message is None:
        raise RuntimeError(
            f"Responses API code loop exhausted the configured {max_response_turns}-turn budget without producing a final assistant message."
        )
    await await_active(
        context.emit_event(
            {
                "detail": final_assistant_message,
                "level": "ok",
                "message": "Model returned a final response.",
                "type": "run_progress",
            }
        ),
        context.signal,
    )
    return {
        "final_assistant_message": final_assistant_message,
        "notes": [
            "Executed the scenario through a live Responses API code loop.",
            f"Model final response: {final_assistant_message}",
        ],
    }
