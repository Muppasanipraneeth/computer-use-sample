import asyncio
import base64
import json
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.errors import RunnerCoreError
from app.responses_loop import (
    build_code_tool_definitions,
    classify_response,
    create_default_responses_client,
    run_responses_code_loop,
)


def call(code="log('hello')", call_id="call-1", **overrides):
    return {
        "type": "function_call",
        "call_id": call_id,
        "name": "exec_py",
        "arguments": json.dumps({"code": code}),
        **overrides,
    }


def message(text="Done.", phase=None, **overrides):
    return {
        "type": "message",
        "role": "assistant",
        "phase": phase,
        "content": [{"type": "output_text", "text": text}],
        **overrides,
    }


def response(*output, response_id="response-1", **overrides):
    return {"id": response_id, "status": "completed", "output": list(output), **overrides}


def harness(*responses, steers=None):
    turns = iter(steers or [])
    context = SimpleNamespace(
        signal=asyncio.Event(),
        detail={"run": {"prompt": "Move a card.", "model": "test-model"}},
        emit_event=AsyncMock(),
        sync_browser_state=AsyncMock(),
        capture_screenshot=AsyncMock(),
        next_turn=AsyncMock(side_effect=lambda: next(turns, [])),
    )
    session = SimpleNamespace(
        execution=SimpleNamespace(
            platform="darwin",
            execute=AsyncMock(return_value={"output": [{"type": "input_text", "text": "ok"}]}),
        )
    )
    client = SimpleNamespace(create=AsyncMock(side_effect=responses))
    return context, session, client


async def test_loop_returns_call_ids_state_instructions_and_distinct_screenshot_sources():
    context, session, client = harness(
        response(message("I am moving the card.", "commentary"), call(), response_id="r1"),
        response(call("log('second')", "call-2"), response_id="r2"),
        response(message(), response_id="r3"),
    )
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 8 + struct.pack(">II", 1400, 900)
    encoded = base64.b64encode(png).decode()
    outputs = [
        {"type": "input_text", "text": "ok"},
        {"type": "input_image", "image_url": "data:image/png;base64," + encoded, "detail": "original"},
    ]
    session.execution.execute.return_value = {"output": outputs}
    result = await run_responses_code_loop(context, session, "Lab instructions", 3, client=client)
    assert result["final_assistant_message"] == "Done."
    requests = [entry.args[0] for entry in client.create.call_args_list]
    assert requests[0]["input"] == "Move a card."
    assert "previous_response_id" not in requests[0]
    assert requests[1]["previous_response_id"] == "r1"
    assert requests[2]["previous_response_id"] == "r2"
    assert requests[1]["input"] == [{"type": "function_call_output", "call_id": "call-1", "output": outputs}]
    assert requests[2]["input"][0]["call_id"] == "call-2"
    assert all(item["instructions"] == "Lab instructions" and item["model"] == "test-model" for item in requests)
    assert all(item["parallel_tool_calls"] is False for item in requests)
    first_capture = context.capture_screenshot.call_args_list[0]
    assert first_capture.args == (
        session,
        "Code tool image",
        {"base64": encoded, "width": 1400, "height": 900},
    )
    assert len(context.capture_screenshot.call_args_list[1].args) == 2  # Browser preview, not model input.


async def test_commentary_continues_and_unphased_message_is_final():
    context, session, client = harness(
        response(message("Thinking", "commentary")),
        response(message("Progress", "commentary"), message("Finished"), response_id="r2"),
    )
    result = await run_responses_code_loop(context, session, "Instructions", 3, client=client)
    assert result["final_assistant_message"] == "Finished"
    assert client.create.call_args_list[1].args[0]["input"] == []
    session.execution.execute.assert_not_called()


async def test_follow_ups_join_the_next_turn_input_as_user_messages(tmp_path):
    png = tmp_path / "card.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
    image = {"kind": "image", "path": str(png), "name": "card.png"}
    context, session, client = harness(
        response(call(), response_id="r1"),
        response(message(), response_id="r2"),
        steers=[[], [{"mode": "redirect", "message": "Move it to Done.", "attachments": [image]}]],
    )
    await run_responses_code_loop(context, session, "Instructions", 3, client=client)
    second = client.create.call_args_list[1].args[0]["input"]
    assert second[0]["type"] == "function_call_output"
    assert second[1]["role"] == "user"
    text, picture = second[1]["content"]
    assert text["text"].startswith("The user changed the request: Move it to Done.\nFollow this from now on;")
    assert f"- image card.png: {png}" in text["text"]
    assert picture == {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(png.read_bytes()).decode()}


async def test_attached_image_rides_with_the_opening_task(tmp_path):
    jpeg = tmp_path / "plan.jpg"
    jpeg.write_bytes(b"jpeg")
    context, session, client = harness(response(message()))
    context.detail["run"]["attachments"] = [{"kind": "image", "path": str(jpeg), "name": "plan.jpg"}]
    await run_responses_code_loop(context, session, "Instructions", 3, client=client)
    [opening] = client.create.call_args_list[0].args[0]["input"]
    assert opening["content"][0]["text"].startswith("Move a card.\n\nThe user attached these:\n- image plan.jpg:")
    assert opening["content"][1]["image_url"] == "data:image/jpeg;base64," + base64.b64encode(b"jpeg").decode()


@pytest.mark.parametrize(
    "bad",
    [
        response(call(), call(call_id="call-1")),
        response(call(), {"type": "computer_call"}),
        response(call(), message("", content=[{"type": "refusal", "refusal": "Cannot do it."}])),
        response(call(), message(phase="unknown")),
        response(call(), call(arguments="broken", call_id="call-2")),
        response(call(), call(arguments=json.dumps({"code": "x", "extra": True}), call_id="call-2")),
        response(call(), call(code=" ")),
        response(call(), call(code="😀" * 17000, call_id="call-2")),
        response(call(), call(call_id="")),
        response(call(), call(status="in_progress", call_id="call-2")),
        response(call(), message(role="user")),
        response(call(), message(status="in_progress")),
        response(call(), message(content=[{"type": "image"}])),
        response(call(), None),
        response(call(), status="incomplete"),
        response(call(), error={"message": "upstream"}),
        response(call(), id=""),
        response(call(), call(name="exec_js", call_id="call-2")),
    ],
)
async def test_validates_entire_response_before_executing_any_code(bad):
    context, session, client = harness(bad)
    with pytest.raises(RunnerCoreError):
        await run_responses_code_loop(context, session, "Instructions", 1, client=client)
    session.execution.execute.assert_not_called()


@pytest.mark.parametrize(
    "bad", [response(), response(message(" ")), response({"type": "reasoning"}), response(output=None)]
)
def test_empty_or_missing_output_is_invalid(bad):
    with pytest.raises(RunnerCoreError):
        classify_response(bad)


async def test_turn_exhaustion_is_not_success():
    context, session, client = harness(response(message("Still working", "commentary")))
    with pytest.raises(RuntimeError, match="exhausted the configured 1-turn budget"):
        await run_responses_code_loop(context, session, "Instructions", 1, client=client)


async def test_stop_during_model_request_cancels_request_without_execution():
    context, session, client = harness()
    requested = asyncio.Event()
    cancelled = asyncio.Event()

    async def blocked(*args):
        requested.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    client.create.side_effect = blocked
    task = asyncio.create_task(run_responses_code_loop(context, session, "Instructions", 2, client=client))
    await requested.wait()
    context.signal.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert cancelled.is_set()
    session.execution.execute.assert_not_called()


async def test_stop_after_response_or_event_prevents_late_tool_execution():
    context, session, client = harness(response(call()))

    async def stop_after_event(event):
        context.signal.set()

    context.emit_event.side_effect = stop_after_event
    with pytest.raises(asyncio.CancelledError):
        await run_responses_code_loop(context, session, "Instructions", 2, client=client)
    session.execution.execute.assert_not_called()


def test_default_client_requires_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RunnerCoreError) as error:
        create_default_responses_client()
    assert error.value.code == "missing_api_key"


async def test_null_budget_keeps_looping_past_the_old_cap():
    calls = [response(call(f"log({turn})", f"call-{turn}"), response_id=f"r{turn}") for turn in range(1, 60)]
    context, session, client = harness(*calls, response(message(), response_id="r60"))
    result = await run_responses_code_loop(context, session, "Instructions", None, client=client)
    assert result["final_assistant_message"] == "Done."
    assert client.create.await_count == 60


def tool_text(**kwargs):
    return build_code_tool_definitions("darwin", **kwargs)[0]["parameters"]["properties"]["code"]["description"]


def test_unreal_desktop_tool_keeps_unreal_lines():
    text = tool_text(desktop_app=True, target_label="Unreal Editor")
    assert "Unreal Editor is already open on the primary display. No practice web lab is open." in text
    assert "Operate only Unreal Editor. Do not click the operator console or other windows." in text
    assert "Start with display" not in text


def test_general_desktop_tool_names_instruments_not_unreal():
    text = tool_text(desktop_app=True, target_label="the desktop", web=True)
    assert "Unreal Editor" not in text  # The instrument guidance may still name Unreal as an example desktop app.
    assert "Never click or type in the Jarvis window." in text
    assert "web.goto" in text and "read(url)" in text
    assert "Start with display" not in text
    offline = tool_text(desktop_app=True, target_label="the desktop")
    assert "Only pyautogui (this computer) is available." in offline and "Unreal" not in offline


def test_lab_tool_still_starts_with_a_screenshot():
    assert "Start with display(pyautogui.screenshot())." in tool_text()
