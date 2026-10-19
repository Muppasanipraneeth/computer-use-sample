import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.errors import RunnerCoreError
from app.local_browser_host import PROFILE_IN_USE
from app.scenario_runtime import RunExecutionContext, browser_profile_directory, execute_scenario
from app.screen import RunScreen, ScreenLock


@pytest.fixture
def flow(monkeypatch, tmp_path):
    client = SimpleNamespace(close=AsyncMock())
    worker = SimpleNamespace(close=AsyncMock())
    page = SimpleNamespace(url="http://127.0.0.1/lab", bring_to_front=AsyncMock())
    browser = SimpleNamespace(close=AsyncMock(), frontmost=AsyncMock(), page=page, target_label="lab", execution=None)
    server = SimpleNamespace(close=AsyncMock(), url_for=lambda _: "http://127.0.0.1/lab")
    browser_lease = SimpleNamespace(endpoint="http://127.0.0.1:9222", close=AsyncMock())
    browser_host = SimpleNamespace(lease=AsyncMock(return_value=browser_lease))
    launch_worker = AsyncMock(return_value=worker)
    launch_browser = AsyncMock(return_value=browser)
    monkeypatch.setattr("app.responses_loop.create_default_responses_client", lambda: client)
    monkeypatch.setattr("app.responses_loop.run_responses_code_loop", AsyncMock(return_value={"notes": ["model final"]}))
    monkeypatch.setattr("app.desktop.runtime.launch_python_runtime", launch_worker)
    monkeypatch.setattr("app.browser.launch_browser_session", launch_browser)
    monkeypatch.setattr("app.scenario_runtime.start_workspace_lab_server", AsyncMock(return_value=server))
    monkeypatch.setattr("app.scenario_runtime.hold_browser", AsyncMock())
    def context(lab="kanban", prompt="Do the task"):
        scenario = {"kanban": "kanban-reprioritize-sprint", "paint": "paint-draw-poster", "booking": "booking-complete-reservation"}[lab]
        signal = asyncio.Event()
        return RunExecutionContext(detail={"run": {"labId": lab, "scenarioId": scenario, "browserMode": "headful",
                                   "prompt": prompt, "model": "fixture", "maxResponseTurns": 24},
                                   "workspacePath": str(tmp_path)}, signal=signal, screenshot_directory=Path(tmp_path),
                                   emit_event=AsyncMock(), capture_screenshot=AsyncMock(),
                                   sync_browser_state=AsyncMock(), complete_run=AsyncMock(), next_turn=AsyncMock(return_value=[]),
                                   screen=RunScreen(ScreenLock(), signal), browser_host=browser_host)
    return SimpleNamespace(context=context, worker=worker, browser=browser, server=server, client=client,
                           launch_worker=launch_worker, launch_browser=launch_browser,
                           browser_host=browser_host, browser_lease=browser_lease)


@pytest.mark.parametrize("lab", ["kanban", "paint", "booking"])
async def test_all_scenarios_finish_only_with_awaited_resource_cleanup(flow, lab):
    context = flow.context(lab)
    await execute_scenario(context)
    flow.worker.close.assert_awaited_once()
    flow.browser.close.assert_awaited_once()
    flow.server.close.assert_awaited_once()
    flow.client.close.assert_awaited_once()
    context.complete_run.assert_awaited_once()
    assert set(context.complete_run.call_args.kwargs) == {"notes"}
    assert context.capture_screenshot.call_args.args[1] == f"{lab}-final"
    assert context.complete_run.call_args.kwargs["notes"] == ["model final"]
    assert flow.browser.execution is flow.worker


async def test_missing_claude_key_fails_before_desktop_start(flow, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    context = flow.context()
    context.detail["run"]["model"] = "anthropic:claude-sonnet-4-5"
    with pytest.raises(RunnerCoreError) as caught:
        await execute_scenario(context)
    assert caught.value.code == "missing_api_key"
    flow.launch_worker.assert_not_awaited()


async def test_omp_desktop_uses_the_saved_account_without_an_api_key(flow, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    loop = AsyncMock(return_value={"notes": ["omp final"]})
    monkeypatch.setattr("app.omp_client.run_omp_code_loop", loop)
    monkeypatch.setattr("app.responses_loop.create_default_responses_client", lambda: (_ for _ in ()).throw(AssertionError("api key client")))
    context = flow.context()
    context.detail["run"]["labId"] = "desktop"
    context.detail["run"]["scenarioId"] = "desktop-cad-engine"
    context.detail["run"]["model"] = "omp:openai-codex/gpt-6-astra"
    await execute_scenario(context)
    loop.assert_awaited_once()
    assert loop.await_args.kwargs["selector"] == "openai-codex/gpt-6-astra"
    assert context.complete_run.call_args.kwargs["notes"] == ["omp final"]
    flow.launch_browser.assert_not_awaited()
    # omp desktop runs capture the screen only when the model asks.
    context.capture_screenshot.assert_not_awaited()


async def test_desktop_target_does_not_open_a_web_lab(flow):
    context = flow.context()
    context.detail["run"]["labId"] = "desktop"
    context.detail["run"]["scenarioId"] = "desktop-cad-engine"
    await execute_scenario(context)
    flow.launch_browser.assert_not_awaited()
    flow.server.close.assert_not_awaited()
    flow.worker.close.assert_awaited_once()
    flow.client.close.assert_awaited_once()
    assert context.complete_run.call_args.kwargs["notes"] == ["model final"]
    assert [entry.args[1] for entry in context.capture_screenshot.await_args_list] == ["desktop-loaded", "desktop-final"]


async def test_unknown_scenario_fails_before_desktop_start(flow):
    context = flow.context()
    context.detail["run"]["scenarioId"] = "missing"
    with pytest.raises(RunnerCoreError) as caught:
        await execute_scenario(context)
    assert caught.value.code == "unsupported_scenario"
    flow.launch_worker.assert_not_awaited()


async def test_browser_start_failure_closes_worker_lab_and_client(flow):
    flow.launch_browser.side_effect = RuntimeError("Browser launch failed")
    with pytest.raises(RuntimeError, match="Browser launch"):
        await execute_scenario(flow.context())
    flow.worker.close.assert_awaited_once()
    flow.server.close.assert_awaited_once()
    flow.client.close.assert_awaited_once()


async def test_failed_input_release_still_closes_all_resources(flow):
    flow.worker.close.side_effect = RunnerCoreError("Input release failed", code="input_release_failed")
    with pytest.raises(RunnerCoreError) as caught:
        await execute_scenario(flow.context())
    assert caught.value.code == "desktop_cleanup_failed"
    flow.browser.close.assert_awaited_once()
    flow.server.close.assert_awaited_once()
    flow.client.close.assert_awaited_once()


async def test_repeated_cancellation_does_not_abandon_cleanup(flow):
    entered, release = asyncio.Event(), asyncio.Event()
    async def close():
        entered.set()
        await release.wait()
    flow.worker.close.side_effect = close
    task = asyncio.create_task(execute_scenario(flow.context()))
    await entered.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    await task
    flow.worker.close.assert_awaited_once()
    flow.browser.close.assert_awaited_once()


@pytest.mark.parametrize("saved", [None, {"document": {"paintedPixelCount": 0}}], ids=["unsaved", "saved"])
async def test_paint_completion_does_not_read_or_export_the_draft(flow, saved):
    flow.browser.page.evaluate = AsyncMock(return_value=saved)
    context = flow.context("paint")
    await execute_scenario(context)
    context.complete_run.assert_awaited_once_with(notes=["model final"])
    flow.browser.page.evaluate.assert_not_awaited()
    assert context.capture_screenshot.call_args.args[1] == "paint-final"
    assert not (Path(context.detail["workspacePath"]) / "artwork").exists()
    flow.worker.close.assert_awaited_once()
    flow.browser.close.assert_awaited_once()
    flow.server.close.assert_awaited_once()
    flow.client.close.assert_awaited_once()


async def test_local_background_browser_leases_the_shared_host_on_the_jarvis_profile(flow, monkeypatch, tmp_path):
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.setenv("JARVIS_BROWSER_PROFILE", str(tmp_path / "profile"))
    context = flow.context()
    context.detail["run"]["labId"] = "desktop"
    context.detail["run"]["scenarioId"] = "any-task"
    await execute_scenario(context)
    flow.browser_host.lease.assert_awaited_once_with(str(tmp_path / "profile"))
    environment = flow.launch_worker.await_args.kwargs["extra_environment"]
    assert environment["JARVIS_WEB_INSTRUMENTS"] == "1"
    assert environment["JARVIS_BROWSER_CDP"] == "http://127.0.0.1:9222"
    assert "JARVIS_BROWSER_PROFILE" not in environment
    # The run gives its share back after its worker (and so its CDP connection) is gone.
    flow.browser_lease.close.assert_awaited_once()
    assert flow.worker.screen is context.screen


async def test_busy_profile_leaves_the_run_going_and_tells_read_why(flow, monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    flow.browser_host.lease.side_effect = RunnerCoreError(PROFILE_IN_USE, code="browser_profile_in_use")
    context = flow.context()
    context.detail["run"]["labId"] = "desktop"
    context.detail["run"]["scenarioId"] = "any-task"
    await execute_scenario(context)
    environment = flow.launch_worker.await_args.kwargs["extra_environment"]
    assert environment["JARVIS_BROWSER_UNAVAILABLE"] == PROFILE_IN_USE
    assert "JARVIS_BROWSER_CDP" not in environment
    context.complete_run.assert_awaited_once()


def test_browser_profile_lives_in_the_desktop_apps_user_data(monkeypatch, tmp_path):
    monkeypatch.delenv("JARVIS_BROWSER_PROFILE", raising=False)
    monkeypatch.setattr("app.scenario_runtime.desktop_user_data", lambda: tmp_path / "Jarvis")
    assert browser_profile_directory() == str(tmp_path / "Jarvis" / "browser-profile")
