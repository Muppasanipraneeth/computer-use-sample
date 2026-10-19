import asyncio
import json
import logging
import shutil

import httpx
import pytest

from app import lab_catalog
from app.__main__ import LOG_HANDLER, configure_logging
from app.api import create_app
from app.config import REPO_ROOT, composio_api_key, env_file, labs_root, log_dir
from app.lab_catalog import list_scenarios
from app.runner import RunnerManager


@pytest.fixture
def scenarios(tmp_path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "index.html").write_text("fixture")
    return [{**item, "workspaceTemplatePath": str(template)} for item in list_scenarios()]


@pytest.fixture
def runner_logs(tmp_path):
    path = configure_logging(tmp_path / "logs")
    yield path
    root = logging.getLogger()
    for handler in [handler for handler in root.handlers if handler.get_name() == LOG_HANDLER]:
        root.removeHandler(handler)
        handler.close()


async def test_run_finish_is_logged_without_secrets(tmp_path, scenarios, runner_logs, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-very-secret")
    async def executor(context):
        await context.complete_run(notes=["Model final response: done"])
    manager = RunnerManager(tmp_path / "data", executor=executor, scenarios=scenarios)
    detail = await manager.start_run({"scenarioId": "kanban-reprioritize-sprint", "prompt": "Move " + "x" * 300})
    run_id = detail["run"]["id"]
    async def finished():
        while (await manager.get_run_detail(run_id))["run"]["status"] == "running":
            await asyncio.sleep(0.01)
    await asyncio.wait_for(finished(), 5)
    await manager.shutdown()
    for handler in logging.getLogger().handlers:
        handler.flush()
    text = runner_logs.read_text(encoding="utf-8")
    assert runner_logs == tmp_path / "logs" / "runner.log"
    assert f"Run {run_id} started" in text
    finish = next(line for line in text.splitlines() if f"Run {run_id} finished" in line)
    assert "status=completed" in finish and "input_tokens=0" in finish and "duration=" in finish
    assert "sk-ant-very-secret" not in text
    assert "x" * 121 not in text


def test_logging_setup_is_idempotent_and_survives_unwritable_folder(tmp_path, runner_logs):
    blocker = tmp_path / "file"
    blocker.write_text("")
    assert configure_logging(blocker / "logs") is None
    assert sum(handler.get_name() == LOG_HANDLER for handler in logging.getLogger().handlers) == 1


def test_log_dir_reads_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_LOG_DIR", str(tmp_path))
    assert log_dir() == tmp_path
    monkeypatch.delenv("JARVIS_LOG_DIR")
    assert log_dir().name.lower() in ("jarvis", "logs")


def test_env_file_reads_environment(tmp_path, monkeypatch):
    saved = tmp_path / ".env"
    saved.write_text("COMPOSIO_API_KEY=from-user-data\n", encoding="utf-8")
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    monkeypatch.setenv("JARVIS_ENV_FILE", str(saved))
    assert env_file() == saved and composio_api_key() == "from-user-data"
    monkeypatch.delenv("JARVIS_ENV_FILE")
    assert env_file() == REPO_ROOT / ".env"


def test_labs_root_reads_environment(tmp_path, monkeypatch):
    assert labs_root() == REPO_ROOT / "labs"
    bundled = tmp_path / "labs"
    shutil.copytree(REPO_ROOT / "labs", bundled)
    monkeypatch.setenv("JARVIS_LABS_ROOT", str(bundled))
    lab_catalog.catalog.cache_clear()
    try:
        paths = [item["workspaceTemplatePath"] for item in list_scenarios()]
        assert paths and all(path.startswith(str(bundled)) for path in paths)
    finally:
        lab_catalog.catalog.cache_clear()


def write_run(root, run_id, prompt, started, *, reply=None, event_reply=None):
    run_dir = root / "runs" / run_id
    run_dir.mkdir(parents=True)
    record = {"id": run_id, "prompt": prompt, "status": "completed", "startedAt": started}
    if reply is not None:
        record["summary"] = {"notes": ["Executed.", f"Model final response: {reply}"]}
    (run_dir / "run.json").write_text(json.dumps(record), encoding="utf-8")
    events = [{"type": "run_progress", "message": "Model returned a final response.", "detail": event_reply}] if event_reply else []
    (run_dir / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")


@pytest.fixture
async def client(tmp_path, scenarios):
    data = tmp_path / "data"
    write_run(data, "old", "Book a FLIGHT to Paris", "2026-01-01T00:00:00Z")
    write_run(data, "mid", "Check mail", "2026-02-01T00:00:00Z", reply="Your flight is confirmed " + "y" * 400)
    write_run(data, "new", "Summarise news", "2026-03-01T00:00:00Z", event_reply="Nothing about flights today.")
    write_run(data, "miss", "Draw a cat", "2026-04-01T00:00:00Z", reply="Drew it.")
    (data / "runs" / "broken").mkdir()
    manager = RunnerManager(data, executor=lambda context: context.signal.wait(), scenarios=scenarios)
    app = create_app(manager=manager, acquire_lease=False)
    async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://runner") as http:
        yield http


async def test_search_matches_prompt_and_reply_newest_first(client):
    results = (await client.get("/api/runs/search", params={"q": "Flight"})).json()
    assert [item["runId"] for item in results] == ["new", "mid", "old"]
    assert results[0]["snippet"] == "Nothing about flights today."
    assert results[2] == {"runId": "old", "prompt": "Book a FLIGHT to Paris", "status": "completed",
                          "startedAt": "2026-01-01T00:00:00Z", "snippet": "Book a FLIGHT to Paris"}
    snippet = results[1]["snippet"]
    assert "flight" in snippet and snippet.endswith("…") and len(snippet) <= 161
    limited = (await client.get("/api/runs/search", params={"q": "flight", "limit": 1})).json()
    assert [item["runId"] for item in limited] == ["new"]
    assert (await client.get("/api/runs/search", params={"q": "zebra"})).json() == []


@pytest.mark.parametrize("params", [{}, {"q": "a"}, {"q": " a "}, {"q": "x" * 201}, {"q": "flight", "limit": 0}])
async def test_search_rejects_bad_queries(client, params):
    assert (await client.get("/api/runs/search", params=params)).status_code == 400
