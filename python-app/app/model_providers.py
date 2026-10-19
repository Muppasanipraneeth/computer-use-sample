"""Claude and OpenAI-compatible chat APIs for the same code-execution loop."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections.abc import Iterable, Sequence
from itertools import count
from typing import Any

from .asking import ASK_TOOL_NAME, ask_user, parse_ask
from .attachments import task_text
from .errors import RunnerCoreError
from .model_selection import ModelSelection
from .processes import assert_active, await_active
from .responses_loop import execute_python_tool_call, session_code_tool_definitions, steer_text, user_input
from .run_model import ESCALATE_TOOL_NAME, RunModel, call_usage, parse_escalate, token_count

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"


class ExternalCodeModel:
    def __init__(self, selection: ModelSelection) -> None:
        self.selection = selection
        if selection.provider == "anthropic":
            key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
            if not key:
                raise RunnerCoreError(
                    "ANTHROPIC_API_KEY is required to run Claude.",
                    code="missing_api_key",
                    status_code=400,
                    hint="Set ANTHROPIC_API_KEY in the root .env, then rerun the scenario.",
                )
            self._key = key
            return
        if selection.provider != "compatible":
            raise RunnerCoreError(
                f"Unsupported model provider: {selection.provider}.",
                code="unsupported_provider",
                status_code=400,
                hint="Use an unprefixed OpenAI model, anthropic:<model>, or compatible:<model>.",
            )
        base_url = os.environ.get("JARVIS_COMPATIBLE_BASE_URL", "").strip().rstrip("/")
        key = os.environ.get("JARVIS_COMPATIBLE_API_KEY", "").strip()
        if not base_url or not key:
            raise RunnerCoreError(
                "JARVIS_COMPATIBLE_BASE_URL and JARVIS_COMPATIBLE_API_KEY are required for this provider.",
                code="missing_api_key",
                status_code=400,
                hint="Set both variables in the root .env. The base URL should end in /v1 for OpenAI-compatible servers.",
            )
        if not base_url.startswith(("https://", "http://")):
            raise RunnerCoreError(
                "JARVIS_COMPATIBLE_BASE_URL must start with http:// or https://.",
                code="invalid_configuration",
                status_code=400,
            )
        self._key = key
        self._url = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"

    async def close(self) -> None:
        return None

    async def complete(
        self,
        *,
        instructions: str,
        prompt: list[dict[str, Any]],
        turns: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        signal: asyncio.Event | None,
    ) -> dict[str, Any]:
        """The classified reply plus "usage" (call_usage terms, None when the provider reported none)."""
        names = {tool["name"] for tool in tools}
        if self.selection.provider == "anthropic":
            body = build_anthropic_body(self.selection.model_id, instructions, prompt, turns, tools)
            payload = await post_json(
                ANTHROPIC_URL,
                {"x-api-key": self._key, "anthropic-version": "2023-06-01"},
                body,
                signal,
            )
            return {**classify_anthropic_response(payload, names), "usage": anthropic_usage(payload)}
        body = build_compatible_body(self.selection.model_id, instructions, prompt, turns, tools)
        payload = await post_json(self._url, {"authorization": f"Bearer {self._key}"}, body, signal)
        return {**classify_compatible_response(payload, names), "usage": compatible_usage(payload)}


def anthropic_usage(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Claude's input_tokens leave out the cached prompt, which it reports as cache reads and cache writes."""
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    prompt = sum(token_count(usage.get(key)) for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return call_usage(input_tokens=prompt, output_tokens=usage.get("output_tokens"), cached_tokens=usage.get("cache_read_input_tokens"))


def compatible_usage(payload: dict[str, Any]) -> dict[str, Any] | None:
    """OpenAI-compatible chat usage; prompt_tokens already includes the cached part."""
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("prompt_tokens_details")
    return call_usage(input_tokens=usage.get("prompt_tokens"), output_tokens=usage.get("completion_tokens"),
                      cached_tokens=details.get("cached_tokens") if isinstance(details, dict) else 0)


def create_external_code_model(selection: ModelSelection) -> ExternalCodeModel:
    return ExternalCodeModel(selection)


def _text_blocks(output: list[dict[str, Any]]) -> list[dict[str, str]]:
    blocks: list[dict[str, str]] = []
    for item in output:
        if item.get("type") == "input_text" and isinstance(item.get("text"), str):
            blocks.append({"type": "text", "text": item["text"]})
    if not blocks:
        blocks.append({"type": "text", "text": "Tool completed."})
    return blocks


def _image_blocks(output: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for item in output:
        if item.get("type") != "input_image":
            continue
        url = item.get("image_url")
        if not isinstance(url, str) or "," not in url or not url.startswith("data:image/"):
            raise RunnerCoreError(
                "Tool returned an image the model provider cannot read.",
                code="unexpected_tool_output",
                status_code=500,
            )
        header, data = url.split(",", 1)
        media_type = header[5:].split(";", 1)[0]
        if media_type not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
            raise RunnerCoreError(
                f"Unsupported screenshot type: {media_type}.",
                code="unexpected_tool_output",
                status_code=500,
            )
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
    return blocks


def _anthropic_user_blocks(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """User-authored input items (task, follow-ups, attached images) as Claude content blocks."""
    texts = [{"type": "text", "text": item["text"]} for item in items if item.get("type") == "input_text"]
    return [*texts, *_image_blocks(items)]


def _compatible_user_content(items: list[dict[str, Any]]) -> str | list[dict[str, Any]]:
    """Plain text unless an image is attached, so text-only servers keep receiving the shape they always did."""
    text = "\n\n".join(item["text"] for item in items if item.get("type") == "input_text")
    images = [{"type": "image_url", "image_url": {"url": item["image_url"]}} for item in items if item.get("type") == "input_image"]
    return [{"type": "text", "text": text}, *images] if images else text


def _call_input(call: dict[str, Any]) -> dict[str, Any]:
    """The arguments a replayed call was made with."""
    return call["input"] if call["name"] in (ASK_TOOL_NAME, ESCALATE_TOOL_NAME) else {"code": call["code"]}


def _parse_call(name: str, call_id: str, arguments: Any) -> dict[str, Any]:
    """One validated tool call: exec_py carries its code, ask_user its parsed question and escalate its reason, both
    with the raw input for replay."""
    if name == ASK_TOOL_NAME:
        try:
            return {"id": call_id, "name": name, "input": arguments, "question": parse_ask(arguments)}
        except ValueError as error:
            raise _unexpected(f"{ASK_TOOL_NAME}: {error}") from error
    if name == ESCALATE_TOOL_NAME:
        try:
            return {"id": call_id, "name": name, "input": arguments, "reason": parse_escalate(arguments)}
        except ValueError as error:
            raise _unexpected(f"{ESCALATE_TOOL_NAME}: {error}") from error
    if not isinstance(arguments, dict) or set(arguments) != {"code"} or not isinstance(arguments.get("code"), str):
        raise _unexpected("exec_py requires a code string and no other arguments.")
    return {"id": call_id, "name": name, "code": arguments["code"]}


def build_anthropic_body(
    model_id: str,
    instructions: str,
    prompt: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": _anthropic_user_blocks(prompt)}]
    for turn in turns:
        content: list[dict[str, Any]] = []
        if turn.get("commentary"):
            content.append({"type": "text", "text": turn["commentary"]})
        for call in turn["calls"]:
            content.append({"type": "tool_use", "id": call["id"], "name": call["name"], "input": _call_input(call)})
        messages.append({"role": "assistant", "content": content})
        results = []
        for result in turn["results"]:
            results.append({
                "type": "tool_result",
                "tool_use_id": result["call_id"],
                "content": [*_text_blocks(result["output"]), *_image_blocks(result["output"])],
            })
        # Follow-ups the user sent after this turn ride in the same user message, after the tool results Claude requires first.
        messages.append({"role": "user", "content": [*results, *_anthropic_user_blocks(turn.get("user", []))]})
    return {
        "max_tokens": 8192,
        "model": model_id,
        "system": instructions,
        "tools": [{"name": tool["name"], "description": tool["description"], "input_schema": tool["parameters"]} for tool in tools],
        "messages": messages,
    }


def build_compatible_body(
    model_id: str,
    instructions: str,
    prompt: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": instructions},
        {"role": "user", "content": _compatible_user_content(prompt)},
    ]
    for turn in turns:
        messages.append({
            "role": "assistant",
            "content": turn.get("commentary") or None,
            "tool_calls": [
                {
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["name"], "arguments": json.dumps(_call_input(call))},
                }
                for call in turn["calls"]
            ],
        })
        for result in turn["results"]:
            text = "\n".join(block["text"] for block in _text_blocks(result["output"]))
            messages.append({"role": "tool", "tool_call_id": result["call_id"], "content": text})
            images = [item["image_url"] for item in result["output"] if item.get("type") == "input_image"]
            if images:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Screenshot from the last action."},
                        *[{"type": "image_url", "image_url": {"url": url}} for url in images],
                    ],
                })
        if turn.get("user"):
            messages.append({"role": "user", "content": _compatible_user_content(turn["user"])})
    return {
        "max_tokens": 8192,
        "model": model_id,
        "messages": messages,
        "tools": [
            {"type": "function", "function": {"name": tool["name"], "description": tool["description"], "parameters": tool["parameters"]}}
            for tool in tools
        ],
    }


def _unexpected(message: str) -> RunnerCoreError:
    return RunnerCoreError(message, code="unexpected_model_response", status_code=400)


def _error_message(payload: dict[str, Any]) -> str:
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str) and error["message"].strip():
        return error["message"].strip()
    return "The model API rejected the request."


def classify_anthropic_response(payload: dict[str, Any], tool_names: set[str]) -> dict[str, Any]:
    if payload.get("type") == "error" or payload.get("error"):
        raise _unexpected(_error_message(payload))
    content = payload.get("content")
    if not isinstance(content, list):
        raise _unexpected("Claude response content is missing.")
    calls: list[dict[str, Any]] = []
    texts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            raise _unexpected("Claude response content is malformed.")
        if block.get("type") == "thinking":
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str) and block["text"].strip():
            texts.append(block["text"].strip())
            continue
        if block.get("type") != "tool_use":
            raise _unexpected(f"Unsupported Claude content: {block.get('type')}.")
        tool_input = block.get("input")
        call_id = block.get("id")
        if block.get("name") not in tool_names or not isinstance(call_id, str) or not call_id.strip():
            raise _unexpected("Claude returned an invalid tool call.")
        calls.append(_parse_call(block["name"], call_id, tool_input))
    commentary = "\n\n".join(texts)
    if calls:
        return {"kind": "calls", "calls": calls, "commentary": commentary}
    if commentary:
        return {"kind": "final", "text": commentary, "commentary": ""}
    raise _unexpected("Claude returned no tool call or final answer.")


def classify_compatible_response(payload: dict[str, Any], tool_names: set[str]) -> dict[str, Any]:
    if payload.get("error"):
        raise _unexpected(_error_message(payload))
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise _unexpected("Compatible API response choices are missing.")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise _unexpected("Compatible API response message is missing.")
    text = _message_text(message.get("content"))
    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        raise _unexpected("Compatible API tool calls are malformed.")
    calls: list[dict[str, Any]] = []
    for call in raw_calls:
        if not isinstance(call, dict):
            raise _unexpected("Compatible API tool calls are malformed.")
        raw_function = call.get("function")
        function: dict[str, Any] = raw_function if isinstance(raw_function, dict) else {}
        call_id = call.get("id")
        if function.get("name") not in tool_names or not isinstance(call_id, str) or not call_id.strip():
            raise _unexpected("Compatible API returned an invalid tool call.")
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as error:
                raise _unexpected("Function call arguments are not valid JSON.") from error
        calls.append(_parse_call(function["name"], call_id, arguments))
    if calls:
        return {"kind": "calls", "calls": calls, "commentary": text}
    if text:
        return {"kind": "final", "text": text, "commentary": ""}
    raise _unexpected("Compatible API returned no tool call or final answer.")


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [
        part.get("text", "").strip()
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str) and part.get("text", "").strip()
    ]
    return "\n\n".join(parts)


async def post_json(url: str, headers: dict[str, str], payload: dict[str, Any], signal: asyncio.Event | None) -> dict[str, Any]:
    assert_active(signal)

    def send() -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", **headers},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                parsed = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            message = f"Model API returned HTTP {error.code}."
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = None
            if isinstance(body, dict):
                message = _error_message(body)
            raise RunnerCoreError(
                message,
                code="model_request_failed",
                status_code=400 if 400 <= error.code < 500 else 502,
                hint="Check the API key, model id, and that the model accepts images and function tools.",
            ) from error
        except urllib.error.URLError as error:
            raise RunnerCoreError(
                "The model API could not be reached.",
                code="model_request_failed",
                status_code=502,
                hint=str(error.reason),
            ) from error
        if not isinstance(parsed, dict):
            raise RunnerCoreError(
                "Model API returned a non-object response.",
                code="unexpected_model_response",
                status_code=502,
            )
        return parsed

    return await await_active(asyncio.to_thread(send), signal)


async def run_external_code_loop(
    context: Any,
    session: Any,
    instructions: str,
    max_response_turns: int | None,
    client: ExternalCodeModel,
    stronger_models: Sequence[str] = (),
) -> dict[str, Any]:
    """stronger_models: Auto's stronger models of the same provider, weakest first, switched to one at a time if the
    run struggles; the whole conversation is rebuilt for every call, so it carries over."""
    model = RunModel(context, f"{client.selection.provider}:{client.selection.model_id}", stronger_models)
    run = context.detail["run"]
    prompt = await user_input(task_text(run), run.get("attachments", []))
    turns: list[dict[str, Any]] = []
    final_assistant_message: str | None = None
    budget: Iterable[int] = count(1) if max_response_turns is None else range(1, max_response_turns + 1)
    for turn in budget:
        assert_active(context.signal)
        steers: list[dict[str, Any]] = []
        for steer in await context.next_turn():
            steers.extend(await user_input(steer_text(steer), steer.get("attachments", [])))
        # Before the first reply nothing is replayed yet, so a follow-up joins the opening user message.
        (turns[-1].setdefault("user", []) if turns else prompt).extend(steers)
        client.selection = await model.next()
        classified = await client.complete(
            instructions=instructions,
            prompt=prompt,
            turns=turns,
            tools=session_code_tool_definitions(session, escalate=model.offers_escalation),
            signal=context.signal,
        )
        model.replied(classified["usage"])
        await await_active(
            context.emit_event({
                "detail": model.model,
                "level": "ok",
                "message": f"Model turn {turn} completed.",
                "type": "run_progress",
            }),
            context.signal,
        )
        if classified["commentary"] and classified["kind"] == "calls":
            await await_active(
                context.emit_event({
                    "type": "run_progress",
                    "level": "pending",
                    "message": "Model progress.",
                    "detail": classified["commentary"],
                }),
                context.signal,
            )
        if classified["kind"] == "final":
            final_assistant_message = classified["text"]
            break
        results = []
        for call in classified["calls"]:
            assert_active(context.signal)
            if call["name"] == ASK_TOOL_NAME:
                output = [{"type": "input_text", "text": await ask_user(context, call["question"])}]
            elif call["name"] == ESCALATE_TOOL_NAME:
                output = [{"type": "input_text", "text": model.requested(call["reason"])}]
            elif not call["code"].strip():
                output = [{"text": "No code was provided to exec_py.", "type": "input_text"}]
            else:
                output, _images = await execute_python_tool_call(
                    context,
                    session,
                    {"arguments": json.dumps({"code": call["code"]}), "code": call["code"], "call_id": call["id"]},
                )
                model.stepped(output)
            results.append({"call_id": call["id"], "output": output})
        turns.append({"calls": classified["calls"], "commentary": classified["commentary"], "results": results})
    if final_assistant_message is None:
        raise RuntimeError(
            f"Model code loop exhausted the configured {max_response_turns}-turn budget without producing a final assistant message."
        )
    await await_active(
        context.emit_event({
            "detail": final_assistant_message,
            "level": "ok",
            "message": "Model returned a final response.",
            "type": "run_progress",
        }),
        context.signal,
    )
    provider = "Claude" if client.selection.provider == "anthropic" else "OpenAI-compatible API"
    return {
        "final_assistant_message": final_assistant_message,
        "notes": [
            f"Executed the scenario through the {provider} code loop.",
            f"Model final response: {final_assistant_message}",
        ],
    }
