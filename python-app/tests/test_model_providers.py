import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.errors import RunnerCoreError
from app.model_providers import ExternalCodeModel, classify_anthropic_response, run_external_code_loop
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
        classify_anthropic_response({"content": [{"type": "tool_use", "id": "toolu_1", "name": "exec_py", "input": {"code": 1}}]}, "exec_py")
    final = classify_anthropic_response({"content": [{"type": "text", "text": "Booked."}]}, "exec_py")
    assert final == {"kind": "final", "text": "Booked.", "commentary": ""}


async def test_external_loop_executes_code_and_returns_the_image(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    client = ExternalCodeModel(parse_model_selection("anthropic:claude-sonnet-4-5"))
    calls = {"count": 0}

    async def complete(**_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            return {"kind": "calls", "commentary": "Looking.", "calls": [{"id": "toolu_1", "name": "exec_py", "code": "log('ok')"}]}
        return {"kind": "final", "text": "Done.", "commentary": ""}

    client.complete = complete
    output = [{"type": "input_text", "text": "ok"}, {"type": "input_image", "image_url": "data:image/png;base64,cG5n"}]
    session = SimpleNamespace(execution=SimpleNamespace(platform="darwin", execute=AsyncMock(return_value={"output": output})))
    context = SimpleNamespace(
        detail={"run": {"prompt": "Move the card.", "model": "anthropic:claude-sonnet-4-5"}},
        signal=asyncio.Event(),
        emit_event=AsyncMock(),
        sync_browser_state=AsyncMock(),
        capture_screenshot=AsyncMock(),
    )
    result = await run_external_code_loop(context, session, "Use exec_py.", 3, client)
    assert result["final_assistant_message"] == "Done."
    assert session.execution.execute.await_args.args[0] == "log('ok')"
