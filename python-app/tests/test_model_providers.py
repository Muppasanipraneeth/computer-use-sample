import asyncio
import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import model_providers
from app.errors import RunnerCoreError
from app.model_providers import (
    ExternalCodeModel,
    build_anthropic_body,
    build_compatible_body,
    classify_anthropic_response,
    run_external_code_loop,
)
from app.model_selection import parse_model_selection


def test_parse_model_selection_keeps_openai_unprefixed_and_splits_once():
    assert parse_model_selection("gpt-6-astra") == parse_model_selection("  gpt-6-astra ")
    assert parse_model_selection("gpt-6-astra").provider == "openai"
    assert parse_model_selection("anthropic:claude-sonnet-4-5").model_id == "claude-sonnet-4-5"
    assert parse_model_selection("compatible:org:model").model_id == "org:model"


def test_missing_claude_key_is_reported_before_a_request(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RunnerCoreError) as caught:
        ExternalCodeModel(parse_model_selection("anthropic:claude-sonnet-4-5"))
    assert caught.value.code == "missing_api_key"


def test_claude_response_must_be_exec_py_code():
    with pytest.raises(RunnerCoreError):
        classify_anthropic_response({"content": [{"type": "tool_use", "id": "toolu_1", "name": "exec_py", "input": {"code": 1}}]}, {"exec_py"})
    final = classify_anthropic_response({"content": [{"type": "text", "text": "Booked."}]}, {"exec_py"})
    assert final == {"kind": "final", "text": "Booked.", "commentary": ""}


async def test_external_loop_executes_code_and_returns_the_image(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    client = ExternalCodeModel(parse_model_selection("anthropic:claude-sonnet-4-5"))
    calls = {"count": 0}
    requests = []

    async def complete(**kwargs):
        calls["count"] += 1
        requests.append(kwargs)
        if calls["count"] == 1:
            return {"kind": "calls", "commentary": "Looking.", "calls": [{"id": "toolu_1", "name": "exec_py", "code": "log('ok')"}]}
        return {"kind": "final", "text": "Done.", "commentary": ""}

    client.complete = complete
    output = [{"type": "input_text", "text": "ok"}, {"type": "input_image", "image_url": "data:image/png;base64,cG5n"}]
    session = SimpleNamespace(execution=SimpleNamespace(platform="darwin", execute=AsyncMock(return_value={"output": output})))
    steers = iter([[], [{"mode": "add", "message": "Use the blue column.", "attachments": []}]])
    context = SimpleNamespace(
        detail={"run": {"prompt": "Move the card.", "model": "anthropic:claude-sonnet-4-5"}},
        signal=asyncio.Event(),
        emit_event=AsyncMock(),
        sync_browser_state=AsyncMock(),
        capture_screenshot=AsyncMock(),
        next_turn=AsyncMock(side_effect=lambda: next(steers, [])),
        ask=AsyncMock(),
    )
    result = await run_external_code_loop(context, session, "Use exec_py.", 3, client)
    assert result["final_assistant_message"] == "Done."
    assert session.execution.execute.await_args.args[0] == "log('ok')"
    assert requests[0]["prompt"] == [{"type": "input_text", "text": "Move the card."}]
    [turn] = requests[1]["turns"]
    assert turn["user"] == [{"type": "input_text", "text": "While you were working, the user added: Use the blue column."}]
    tool = [{"name": "exec_py", "description": "Run code.", "parameters": {}}]
    claude = build_anthropic_body("claude", "Use exec_py.", requests[1]["prompt"], requests[1]["turns"], tool)["messages"]
    assert [block["type"] for block in claude[-1]["content"]] == ["tool_result", "text"], "tool results must come first"
    assert claude[0]["content"] == [{"type": "text", "text": "Move the card."}]
    compatible = build_compatible_body("model", "Use exec_py.", requests[1]["prompt"], requests[1]["turns"], tool)["messages"]
    assert compatible[1] == {"role": "user", "content": "Move the card."}
    assert compatible[-1] == {"role": "user", "content": "While you were working, the user added: Use the blue column."}


def test_attached_image_reaches_claude_and_compatible_opening_messages():
    prompt = [{"type": "input_text", "text": "Copy this."}, {"type": "input_image", "image_url": "data:image/jpeg;base64,anBn"}]
    tool = [{"name": "exec_py", "description": "Run code.", "parameters": {}}]
    claude = build_anthropic_body("claude", "x", prompt, [], tool)["messages"][0]["content"]
    assert claude[1] == {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "anBn"}}
    compatible = build_compatible_body("model", "x", prompt, [], tool)["messages"][1]["content"]
    assert compatible == [{"type": "text", "text": "Copy this."}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,anBn"}}]


@pytest.mark.parametrize("provider", ["anthropic", "compatible"])
async def test_ask_user_round_trips_through_claude_and_compatible_apis(monkeypatch, provider):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("JARVIS_COMPATIBLE_BASE_URL", "https://models.example/v1")
    monkeypatch.setenv("JARVIS_COMPATIBLE_API_KEY", "test-key")
    client = ExternalCodeModel(parse_model_selection(f"{provider}:model"))
    asked = {"question": "Send the invoice to Sam?", "kind": "approval", "options": [], "detail": "To: sam@example.com"}
    if provider == "anthropic":
        replies = [{"content": [{"type": "tool_use", "id": "toolu_1", "name": "ask_user", "input": asked}]},
                   {"content": [{"type": "text", "text": "Sent."}]}]
    else:
        replies = [{"choices": [{"message": {"content": None, "tool_calls": [
                       {"id": "call_1", "type": "function", "function": {"name": "ask_user", "arguments": json.dumps(asked)}}]}}]},
                   {"choices": [{"message": {"content": "Sent."}}]}]
    bodies = []

    async def post(_url, _headers, body, _signal):
        bodies.append(copy.deepcopy(body))
        return replies[len(bodies) - 1]

    monkeypatch.setattr(model_providers, "post_json", post)
    session = SimpleNamespace(execution=SimpleNamespace(platform="darwin", execute=AsyncMock()))
    context = SimpleNamespace(detail={"run": {"prompt": "Bill Sam.", "model": f"{provider}:model"}}, signal=asyncio.Event(),
                              emit_event=AsyncMock(), next_turn=AsyncMock(return_value=[]), ask=AsyncMock(return_value="approve"))
    result = await run_external_code_loop(context, session, "Use exec_py.", 3, client)

    assert result["final_assistant_message"] == "Sent."
    context.ask.assert_awaited_once_with("Send the invoice to Sam?", kind="approval", options=["approve", "deny"], detail="To: sam@example.com")
    session.execution.execute.assert_not_awaited()
    names = [tool["name"] if provider == "anthropic" else tool["function"]["name"] for tool in bodies[0]["tools"]]
    assert names == ["exec_py", "ask_user"]
    answer = "You asked for approval: Send the invoice to Sam?\nThe user approved. Go ahead."
    messages = bodies[1]["messages"]
    if provider == "anthropic":
        assert messages[1]["content"] == [{"type": "tool_use", "id": "toolu_1", "name": "ask_user", "input": asked}]
        assert messages[2]["content"][0] == {"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": answer}]}
    else:
        assert json.loads(messages[2]["tool_calls"][0]["function"]["arguments"]) == asked
        assert messages[3] == {"role": "tool", "tool_call_id": "call_1", "content": answer}
