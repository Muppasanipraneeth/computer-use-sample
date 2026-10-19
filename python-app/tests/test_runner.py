import asyncio
import base64
import io
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from app.config import Settings
from app.errors import RunnerCoreError
from app.lab_catalog import list_scenarios
from app.runner import RunnerManager
from app.storage import model_image_path


@pytest.fixture
async def manager_factory(tmp_path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "index.html").write_text("<h1>Fixture</h1>")
    scenarios = [{**scenario, "workspaceTemplatePath": str(template)} for scenario in list_scenarios()]
    managers = []
    def create(executor, **kwargs):
        manager = RunnerManager(tmp_path / f"data-{len(managers)}", scenarios=scenarios,
                                executor=executor, **kwargs)
        managers.append(manager)
        return manager
    yield create
    for manager in managers:
        await manager.shutdown()


async def idle(context):
    await context.signal.wait()


async def wait_for_run_status(manager, run_id, status):
    async def wait():
        while True:
            detail = await manager.get_run_detail(run_id)
            if detail["run"]["status"] == status:
                return detail
            await asyncio.sleep(0.01)
    return await asyncio.wait_for(wait(), 5)


def request(**kwargs):
    return {"scenarioId": "kanban-reprioritize-sprint", "prompt": "Move the cards", **kwargs}


async def test_admission_is_reserved_before_workspace_copy_and_capped(manager_factory, monkeypatch):
    manager = manager_factory(idle, settings=Settings(max_concurrent_runs=2))
    entered, release = [], asyncio.Event()
    prepare = manager.storage.prepare
    async def slow_prepare(*args):
        entered.append(args)
        await release.wait()
        await prepare(*args)
    monkeypatch.setattr(manager.storage, "prepare", slow_prepare)
    starts = []
    for count in (1, 2):
        starts.append(asyncio.create_task(manager.start_run(request())))
        while len(entered) < count:
            await asyncio.sleep(0.005)
    with pytest.raises(RunnerCoreError) as caught:
        await manager.start_run(request())
    assert (caught.value.code, caught.value.status_code) == ("run_limit_reached", 409)
    assert str(caught.value) == "Jarvis is already doing 2 tasks. Stop one or wait for it to finish."
    lookup = asyncio.create_task(manager.get_active_run_detail())
    await asyncio.sleep(0)
    assert not lookup.done()
    release.set()
    first, second = await asyncio.gather(*starts)
    assert (await lookup)["run"]["id"] == second["run"]["id"]
    assert [detail["run"]["id"] for detail in await manager.get_running_run_details()] == [first["run"]["id"], second["run"]["id"]]
    first["events"].clear()
    assert (await manager.get_run_detail(first["run"]["id"]))["events"]


async def test_success_holds_its_admission_until_executor_cleanup(manager_factory):
    completed, cleanup = asyncio.Event(), asyncio.Event()
    async def executor(context):
        await context.complete_run(notes=["done"])
        completed.set()
        await cleanup.wait()
    manager = manager_factory(executor, settings=Settings(max_concurrent_runs=1))
    detail = await manager.start_run(request())
    await completed.wait()
    assert (await manager.get_run_detail(detail["run"]["id"]))["run"]["status"] == "running"
    with pytest.raises(RunnerCoreError) as caught:
        await manager.start_run(request())
    assert str(caught.value) == "Jarvis is already doing 1 task. Stop one or wait for it to finish."
    cleanup.set()
    final = await wait_for_run_status(manager, detail["run"]["id"], "completed")
    replay = await manager.get_replay_bundle(detail["run"]["id"])
    assert replay["events"][-1]["type"] == "run_completed"
    assert replay["run"] == final["run"]
    assert set(final["run"]["summary"]) == {"notes", "stepCount", "screenshotCount"}
    assert await manager.get_active_run_detail() is None


async def test_overlapping_stop_and_shutdown_wait_for_one_cleanup(manager_factory):
    running, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    cleanups = []
    async def executor(context):
        running.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await release.wait()
            cleanups.append(True)
    manager = manager_factory(executor)
    detail = await manager.start_run(request())
    await running.wait()
    stop = asyncio.create_task(manager.stop_run(detail["run"]["id"]))
    await cleaning.wait()
    shutdown = asyncio.create_task(manager.shutdown())
    assert (await manager.get_run_detail(detail["run"]["id"]))["run"]["status"] == "running"
    assert detail["run"]["id"] in manager.active
    release.set()
    final, _ = await asyncio.gather(stop, shutdown)
    assert final["run"]["status"] == "cancelled"
    assert cleanups == [True]
    assert [event["type"] for event in final["events"]].count("run_cancelled") == 1


@pytest.mark.parametrize("code,blocked", [("cleanup_failed", False), ("desktop_cleanup_failed", True)])
async def test_stop_reports_cleanup_failure_and_desktop_lockout(manager_factory, code, blocked):
    started = asyncio.Event()
    async def executor(context):
        started.set()
        try:
            await context.signal.wait()
        finally:
            raise RunnerCoreError("cleanup broken", code=code)
    manager = manager_factory(executor)
    detail = await manager.start_run(request())
    await started.wait()
    final = await manager.stop_run(detail["run"]["id"])
    assert final["run"]["status"] == "failed"
    assert manager.desktop_recovery_required is blocked
    if blocked:
        with pytest.raises(RunnerCoreError) as caught:
            await manager.start_run(request())
        assert caught.value.code == "desktop_cleanup_failed"
    else:
        manager.executor = idle
        assert (await manager.start_run(request()))["run"]["status"] == "running"


async def test_failsafe_cancellation_and_missing_completion(manager_factory):
    async def failsafe(context):
        raise RunnerCoreError("corner", code="python_failsafe")
    manager = manager_factory(failsafe)
    detail = await manager.start_run(request())
    final = await wait_for_run_status(manager, detail["run"]["id"], "cancelled")
    assert final["run"]["status"] == "cancelled"
    manager.executor = AsyncMock()
    second = await manager.start_run(request())
    failed = await wait_for_run_status(manager, second["run"]["id"], "failed")
    assert "without completing" in failed["run"]["summary"]["notes"][0]


async def test_concurrent_runs_both_make_progress(manager_factory):
    arrived: list[str] = []
    both = asyncio.Event()
    async def executor(context):
        arrived.append(context.detail["run"]["id"])
        if len(arrived) == 2:
            both.set()
        await both.wait()  # each run needs the other to be running at the same time
        await context.emit_event({"type": "run_progress", "level": "ok", "message": "working"})
        await context.complete_run(notes=["done"])
    manager = manager_factory(executor)
    first = await manager.start_run(request())
    second = await manager.start_run(request(scenarioId="paint-draw-poster"))
    for detail in (first, second):
        final = await wait_for_run_status(manager, detail["run"]["id"], "completed")
        assert any(event["message"] == "working" for event in final["events"])
    assert await manager.get_running_run_details() == []


async def test_failsafe_corner_stops_every_running_run(manager_factory):
    corner = asyncio.Event()
    async def executor(context):
        if context.detail["run"]["prompt"] == "corner":
            await corner.wait()
            raise RunnerCoreError("corner", code="python_failsafe")
        await context.signal.wait()
    manager = manager_factory(executor)
    others = [await manager.start_run(request()), await manager.start_run(request(scenarioId="paint-draw-poster"))]
    hit = await manager.start_run(request(prompt="corner"))
    corner.set()
    assert (await wait_for_run_status(manager, hit["run"]["id"], "cancelled"))["run"]["summary"]["notes"] == ["Desktop fail-safe activated."]
    for detail in others:
        final = await wait_for_run_status(manager, detail["run"]["id"], "cancelled")
        assert final["run"]["summary"]["notes"] == ["Desktop fail-safe activated."]
    assert not manager.active


async def test_failed_input_release_stops_screen_users_and_locks_the_screen(manager_factory):
    ready = asyncio.Event()
    used = asyncio.Event()
    async def executor(context):
        prompt = context.detail["run"]["prompt"]
        if prompt == "broken":
            await ready.wait()
            raise RunnerCoreError("Input release failed", code="desktop_cleanup_failed")
        if prompt == "clicks":
            async with context.screen.hold():
                used.set()
        await context.signal.wait()
    manager = manager_factory(executor)
    clicks = await manager.start_run(request(prompt="clicks"))
    reads = await manager.start_run(request(prompt="reads"))
    await used.wait()
    broken = await manager.start_run(request(prompt="broken"))
    ready.set()
    await wait_for_run_status(manager, broken["run"]["id"], "failed")
    await wait_for_run_status(manager, clicks["run"]["id"], "cancelled")
    assert (await manager.get_run_detail(reads["run"]["id"]))["run"]["status"] == "running"
    with pytest.raises(RunnerCoreError) as caught:
        async with manager.contexts[reads["run"]["id"]].screen.hold():
            pass
    assert caught.value.code == "desktop_cleanup_failed"
    with pytest.raises(RunnerCoreError):
        await manager.start_run(request())


async def test_shutdown_stops_every_run(manager_factory):
    manager = manager_factory(idle)
    runs = [await manager.start_run(request()) for _ in range(3)]
    await manager.shutdown()
    for detail in runs:
        assert (await manager.get_run_detail(detail["run"]["id"]))["run"]["status"] == "cancelled"
    assert not manager.active


async def test_reset_stops_every_run_of_that_scenario_only(manager_factory):
    manager = manager_factory(idle)
    kanban = [await manager.start_run(request()) for _ in range(2)]
    paint = await manager.start_run(request(scenarioId="paint-draw-poster"))
    state = await manager.reset_scenario("kanban-reprioritize-sprint")
    assert state["cancelledRunId"] == kanban[-1]["run"]["id"]
    for detail in kanban:
        assert (await manager.get_run_detail(detail["run"]["id"]))["run"]["status"] == "cancelled"
    assert [detail["run"]["id"] for detail in await manager.get_running_run_details()] == [paint["run"]["id"]]


async def test_cleanup_error_after_complete_never_publishes_success(manager_factory):
    async def executor(context):
        await context.complete_run(notes=[])
        raise RunnerCoreError("Browser cleanup failed", code="cleanup_failed")
    manager = manager_factory(executor)
    detail = await manager.start_run(request())
    final = await wait_for_run_status(manager, detail["run"]["id"], "failed")
    assert not any(event["type"] == "run_completed" for event in final["events"])


async def test_terminal_replay_failure_keeps_truthful_live_result(manager_factory, monkeypatch):
    from app import storage
    original = storage.atomic_json
    async def executor(context):
        await context.complete_run(notes=[])
    def fail_terminal(path, value):
        if path.name == "replay.json" and value["run"]["status"] in ("completed", "failed"):
            raise OSError("disk full")
        return original(path, value)
    manager = manager_factory(executor)
    monkeypatch.setattr(storage, "atomic_json", fail_terminal)
    detail = await manager.start_run(request())
    final = await wait_for_run_status(manager, detail["run"]["id"], "failed")
    assert "disk full" in str(final["run"]["summary"]["notes"])
    assert await manager.get_active_run_detail() is None
    json.loads((manager.storage.run_dir(detail["run"]["id"]) / "replay.json").read_text())


async def test_cancelled_write_finishes_before_terminal_snapshot(manager_factory, monkeypatch):
    from app import storage
    original = storage.atomic_json
    writing = threading.Event()
    release = threading.Event()
    async def executor(context):
        await context.emit_event({"type": "run_progress", "message": "block write", "level": "ok"})
        await context.signal.wait()
    def hold_progress(path, value):
        if path.name == "replay.json" and value["events"] and value["events"][-1]["message"] == "block write":
            writing.set()
            assert release.wait(5)
        original(path, value)
    manager = manager_factory(executor)
    monkeypatch.setattr(storage, "atomic_json", hold_progress)
    detail = await manager.start_run(request())
    assert await asyncio.to_thread(writing.wait, 5)
    stopping = asyncio.create_task(manager.stop_run(detail["run"]["id"]))
    await asyncio.sleep(0.02)
    assert not stopping.done()
    release.set()
    await stopping
    replay = await manager.get_replay_bundle(detail["run"]["id"])
    assert replay["run"]["status"] == "cancelled"
    assert replay["events"][-1]["type"] == "run_cancelled"


async def test_subscriber_exception_and_replay_reload(manager_factory):
    release = asyncio.Event()
    async def executor(context):
        await release.wait()
        await context.complete_run(notes=[])
    manager = manager_factory(executor)
    detail = await manager.start_run(request())
    def broken(event):
        raise RuntimeError("Subscriber bug")
    seen = []
    manager.subscribe(detail["run"]["id"], broken)
    manager.subscribe(detail["run"]["id"], seen.append)
    release.set()
    final = await wait_for_run_status(manager, detail["run"]["id"], "completed")
    assert seen[-1]["type"] == "run_completed"
    manager.contexts.clear()
    assert (await manager.get_run_detail(detail["run"]["id"])) == final


@pytest.mark.parametrize("saved", [[], None, "text", {"version": 3}])
async def test_malformed_current_replay_returns_not_found(manager_factory, saved):
    manager = manager_factory(idle)
    directory = manager.storage.run_dir("historical")
    directory.mkdir(parents=True)
    (directory / "replay.json").write_text(json.dumps(saved))
    with pytest.raises(RunnerCoreError) as caught:
        await manager.get_replay_bundle("historical")
    assert caught.value.code == "run_not_found"
    assert caught.value.status_code == 404


async def test_headless_invalid_ids_and_reset(manager_factory):
    manager = manager_factory(idle)
    with pytest.raises(RunnerCoreError) as caught:
        await manager.start_run(request(browserMode="headless"))
    assert caught.value.code == "visible_browser_required"
    assert not manager.storage.root.exists()
    with pytest.raises(RunnerCoreError):
        await manager.get_run_detail("../outside")
    detail = await manager.start_run(request())
    (Path(detail["workspacePath"]) / "index.html").write_text("mutated lab")
    state = await manager.reset_scenario(detail["run"]["scenarioId"])
    assert state["cancelledRunId"] == detail["run"]["id"]
    assert (await manager.get_run_detail(detail["run"]["id"]))["run"]["status"] == "cancelled"
    fresh = await manager.start_run(request())
    assert (Path(fresh["workspacePath"]) / "index.html").read_text() == "<h1>Fixture</h1>"


async def test_exact_model_image_metadata(manager_factory):
    buffer = io.BytesIO()
    Image.new("RGB", (2400, 1200), "white").save(buffer, "PNG")
    png = buffer.getvalue()

    async def executor(context):
        session = SimpleNamespace(mode="headful", viewport={"width": 1440, "height": 900}, target_label="lab",
                                  read_state=AsyncMock(return_value={"currentUrl": "http://127.0.0.1/lab", "pageTitle": "Lab"}))
        await context.capture_screenshot(session, "image", {"base64": base64.b64encode(png).decode(), "width": 2400, "height": 1200})
        await context.complete_run(notes=[])
    manager = manager_factory(executor)
    detail = await manager.start_run(request())
    final = await wait_for_run_status(manager, detail["run"]["id"], "completed")
    image = final["browser"]["screenshots"][0]
    # Stored small for people; the metadata and the model's copy keep the full size the model clicks in.
    with Image.open(image["path"]) as stored:
        assert (stored.format, stored.size) == ("JPEG", (1920, 960))
    assert Path(model_image_path(image["path"])).read_bytes() == png
    assert (image["source"], image["imageWidth"], image["imageHeight"], image["mimeType"]) == ("code_tool", 2400, 1200, "image/jpeg")


async def test_null_turn_budget_is_recorded_as_no_limit(manager_factory):
    manager = manager_factory(idle)
    detail = await manager.start_run(request(maxResponseTurns=None))
    assert detail["run"]["maxResponseTurns"] is None
    started = (await manager.get_run_detail(detail["run"]["id"]))["events"][0]
    assert started["detail"].endswith("· no turn limit")
    stopped = await manager.stop_run(detail["run"]["id"])
    assert stopped["run"]["maxResponseTurns"] is None
    assert (await manager.get_replay_bundle(detail["run"]["id"]))["run"]["maxResponseTurns"] is None


def model_loop(turns: list, step: asyncio.Event, stop_after: int = 2):
    """A stand-in model loop: each simulated step waits on `step`, then asks for the next turn like the real loops."""
    async def executor(context):
        while len(turns) < stop_after:
            await step.wait()
            step.clear()
            turns.append(await context.next_turn())
        await context.complete_run(notes=["done"])
    return executor


async def test_pause_holds_the_next_model_call_until_resume_and_delivers_queued_steers(manager_factory):
    turns: list = []
    step = asyncio.Event()
    manager = manager_factory(model_loop(turns, step))
    run_id = (await manager.start_run(request()))["run"]["id"]
    assert await manager.pause_run(run_id) == {"ok": True, "paused": True}
    await manager.steer_run(run_id, {"message": "Also label them.", "mode": "add"})
    step.set()
    await asyncio.sleep(0.05)
    assert turns == [], "the model call waits while paused"
    assert (await manager.get_run_detail(run_id))["run"]["paused"] is True
    await manager.resume_run(run_id)
    while not turns:
        await asyncio.sleep(0.01)
    assert turns == [[{"mode": "add", "message": "Also label them.", "attachments": []}]]
    step.set()
    detail = await wait_for_run_status(manager, run_id, "completed")
    assert turns[1] == [], "steers are delivered once"
    assert detail["run"]["paused"] is False


async def test_stop_while_paused_cancels_the_run(manager_factory):
    turns: list = []
    step = asyncio.Event()
    manager = manager_factory(model_loop(turns, step))
    run_id = (await manager.start_run(request()))["run"]["id"]
    await manager.pause_run(run_id)
    step.set()
    await asyncio.sleep(0.05)
    stopped = await asyncio.wait_for(manager.stop_run(run_id), 5)
    assert stopped["run"]["status"] == "cancelled"
    assert stopped["run"]["paused"] is False
    assert turns == []
    assert await manager.get_active_run_detail() is None


async def pending_question(manager, run_id):
    async def wait():
        while (question := (await manager.get_run_detail(run_id))["run"]["question"]) is None:
            await asyncio.sleep(0.01)
        return question
    return await asyncio.wait_for(wait(), 5)


async def test_stop_while_waiting_for_an_answer_cancels_the_run_and_clears_the_question(manager_factory):
    asked: list = []

    async def executor(context):
        asked.append(await context.ask("Which account?", options=["Work", "Personal"]))
        await context.complete_run(notes=["done"])
    manager = manager_factory(executor)
    run_id = (await manager.start_run(request()))["run"]["id"]
    question = await pending_question(manager, run_id)
    assert (question["kind"], question["text"], question["options"], question["detail"]) == ("question", "Which account?", ["Work", "Personal"], None)
    stopped = await asyncio.wait_for(manager.stop_run(run_id), 5)
    assert (stopped["run"]["status"], stopped["run"]["question"], asked) == ("cancelled", None, [])
    assert (await manager.get_replay_bundle(run_id))["run"]["question"] is None


async def test_one_question_at_a_time_and_a_steer_while_waiting_reaches_the_next_turn(manager_factory):
    answers: dict = {}
    turns: list = []

    async def executor(context):
        async def ask(name, text, **kwargs):
            answers[name] = await context.ask(text, **kwargs)
        await asyncio.gather(ask("first", "Which color?"), ask("second", "Send it?", kind="approval", options=["approve", "deny"], detail="To: a@b.c"))
        turns.append(await context.next_turn())
        await context.complete_run(notes=["done"])
    manager = manager_factory(executor)
    run_id = (await manager.start_run(request()))["run"]["id"]
    first = await pending_question(manager, run_id)
    await manager.steer_run(run_id, {"message": "Hurry.", "mode": "add"})
    assert await manager.answer_run(run_id, {"questionId": first["id"], "answer": " Blue "}) == {"ok": True}
    second = await pending_question(manager, run_id)
    assert second["id"] != first["id"] and second["kind"] == "approval", "the second question waited for the first"
    assert turns == [], "the steer waits for the next turn"
    await manager.answer_run(run_id, {"questionId": second["id"], "answer": "deny"})
    detail = await wait_for_run_status(manager, run_id, "completed")
    assert answers == {"first": "Blue", "second": "deny"}
    assert turns == [[{"mode": "add", "message": "Hurry.", "attachments": []}]]
    progress = [(event["message"], event["level"], event.get("detail")) for event in detail["events"] if event["type"] == "run_progress"]
    assert progress == [
        ("Waiting for your answer.", "warn", "Which color?"),
        ("User instruction added.", "ok", "Added: Hurry."),
        ("You answered.", "ok", "Blue"),
        ("Approval requested.", "warn", "Send it?\nTo: a@b.c"),
        ("You declined.", "warn", "Send it?"),
    ]


def omp_catalog(monkeypatch, *selectors):
    async def listed():
        return {"available": True, "models": [{"selector": selector} for selector in selectors]}
    monkeypatch.setattr("app.omp_client.list_omp_models", listed)


async def test_auto_chooses_by_task_announces_it_and_persists_its_switch_and_usage(manager_factory, monkeypatch):
    from app.model_selection import FAST_MODEL, QUICK_MODEL, STRONG_MODEL
    from app.run_model import RunModel, call_usage
    omp_catalog(monkeypatch, "anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5")
    seen = {}

    async def executor(context):
        seen["start"], seen["stronger"] = context.detail["run"]["model"], context.stronger_models
        model = RunModel(context, context.detail["run"]["model"], context.stronger_models)
        model.replied(call_usage(input_tokens=100, output_tokens=5, cost_usd=0.5))
        model.requested("Stuck.")
        await model.next()
        model.replied(call_usage(input_tokens=200, output_tokens=7, cached_tokens=150))
        await context.complete_run(notes=["done"])
    manager = manager_factory(executor)
    detail = await manager.start_run(request(scenarioId="any-task", prompt="What's the weather in Paris?", model="auto"))
    run = detail["run"]
    assert run["model"] == QUICK_MODEL
    assert run["modelChoice"] == {"model": QUICK_MODEL, "tier": "quick", "reason": "quick question"}
    assert run["modelSwitches"] == []
    assert run["usage"] == {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "costUsd": None, "turns": 0}
    chose = [event for event in detail["events"] if event["message"] == "Chose a model for this task."]
    assert [(event["type"], event["level"], event["detail"]) for event in chose] == [("run_progress", "ok", "claude-haiku-5-5 · quick question")]
    final = await wait_for_run_status(manager, run["id"], "completed")
    assert seen == {"start": QUICK_MODEL, "stronger": (FAST_MODEL, STRONG_MODEL)}
    assert final["run"]["model"] == FAST_MODEL
    assert final["run"]["modelChoice"] == run["modelChoice"], "the choice records where the run started"
    assert [(switch["from"], switch["to"]) for switch in final["run"]["modelSwitches"]] == [(QUICK_MODEL, FAST_MODEL)]
    assert final["run"]["usage"] == {"inputTokens": 300, "outputTokens": 12, "cachedTokens": 150, "costUsd": 0.5, "turns": 2}
    manager.contexts.clear()
    assert (await manager.get_run_detail(run["id"]))["run"] == final["run"]


async def test_auto_without_its_models_is_refused_before_admission(manager_factory, monkeypatch):
    omp_catalog(monkeypatch)
    manager = manager_factory(idle)
    with pytest.raises(RunnerCoreError) as caught:
        await manager.start_run(request(model="auto"))
    assert caught.value.code == "model_unavailable"
    assert manager.active == {}


async def test_a_chosen_model_has_no_choice_and_no_stronger_models(manager_factory):
    seen = {}

    async def executor(context):
        seen["stronger"] = context.stronger_models
        await context.complete_run(notes=["done"])
    manager = manager_factory(executor)
    detail = await manager.start_run(request(model="omp:anthropic/claude-opus-5-5"))
    await wait_for_run_status(manager, detail["run"]["id"], "completed")
    assert detail["run"]["model"] == "omp:anthropic/claude-opus-5-5" and seen == {"stronger": ()}
    assert detail["run"]["modelChoice"] is None
    assert not any(event["message"] == "Chose a model for this task." for event in detail["events"])
