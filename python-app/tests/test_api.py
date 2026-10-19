import asyncio
import json

import httpx
import pytest

from app.api import create_app
from app.lab_catalog import list_scenarios
from app.lease import BackendLease
from app.runner import RunnerManager


@pytest.fixture
async def api(tmp_path):
    async def execute(context):
        await context.signal.wait()
    template = tmp_path / "template"
    template.mkdir()
    (template / "index.html").write_text("fixture")
    scenarios = [{**item, "workspaceTemplatePath": str(template)} for item in list_scenarios()]
    manager = RunnerManager(tmp_path / "data", executor=execute, scenarios=scenarios)
    app = create_app(manager=manager, acquire_lease=False)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://runner") as client:
        yield app, manager, client


async def test_routes_and_capabilities(api):
    app, _, client = api
    assert (await client.get("/health")).json() == {"status": "ok", "service": "runner"}
    capabilities = (await client.get("/api/capabilities")).json()
    assert capabilities["backendId"] == "python"
    assert capabilities["browserModes"] == ["headful"]
    assert capabilities["instanceId"] == app.state.instance_id
    assert "verificationEnabled" not in capabilities["defaults"]
    scenarios = (await client.get("/api/scenarios")).json()
    assert len(scenarios) == 5
    assert all("verification" not in scenario for scenario in scenarios)
    assert (await client.get("/api/runs/active")).json() is None
    assert (await client.get("/api/runs/running")).json() == []
    result = await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw"})
    assert result.status_code == 202
    run_id = result.json()["runId"]
    assert (await client.get("/api/runs/active")).json()["run"]["id"] == run_id
    assert (await client.get(f"/api/runs/{run_id}")).json()["run"]["browserMode"] == "headful"
    assert (await client.post(f"/api/runs/{run_id}/stop")).json()["run"]["status"] == "cancelled"
    assert (await client.get(f"/api/runs/{run_id}/replay")).json()["version"] == 3
    assert (await client.post("/api/scenarios/paint-draw-poster/reset")).json()["scenarioId"] == "paint-draw-poster"
    assert (await client.get("/api/runs/active")).json() is None
    assert (await client.get("/api/runs/running")).json() == []


async def test_running_lists_every_run_in_start_order_and_the_cap_is_a_409(api):
    _, _, client = api
    started = []
    for scenario in ("paint-draw-poster", "kanban-reprioritize-sprint", "paint-draw-poster"):
        result = await client.post("/api/runs", json={"scenarioId": scenario, "prompt": "Work"})
        assert result.status_code == 202
        started.append(result.json()["runId"])
    running = (await client.get("/api/runs/running")).json()
    assert [detail["run"]["id"] for detail in running] == started
    assert all(detail["run"]["status"] == "running" and detail["eventStreamUrl"] for detail in running)
    assert (await client.get("/api/runs/active")).json()["run"]["id"] == started[-1]
    refused = await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "One more"})
    assert refused.status_code == 409
    assert refused.json()["code"] == "run_limit_reached"
    assert refused.json()["error"] == "Jarvis is already doing 3 tasks. Stop one or wait for it to finish."
    await client.post(f"/api/runs/{started[-1]}/stop")
    assert (await client.get("/api/runs/active")).json()["run"]["id"] == started[1]
    assert (await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Room again"})).status_code == 202


@pytest.mark.parametrize("payload", [{"scenarioId": "paint-draw-poster", "prompt": "Draw", "mode": "code"},
                                     {"scenarioId": "paint-draw-poster", "prompt": "Draw", "verificationEnabled": "false"},
                                     {"scenarioId": "paint-draw-poster", "prompt": "Draw", "browserMode": "headless"}])
async def test_request_errors_before_workspace_allocation(api, payload):
    _, manager, client = api
    result = await client.post("/api/runs", json=payload)
    assert result.status_code == 400
    assert set(result.json()) == {"code", "error", "hint"}
    assert not manager.storage.root.exists()


async def test_malformed_json_and_unexpected_error_envelope(api, monkeypatch):
    _, manager, client = api
    result = await client.post("/api/runs", content="{", headers={"Content-Type": "application/json"})
    assert result.status_code == 400
    assert result.json()["code"] == "invalid_request"
    async def broken():
        raise RuntimeError("private stack trace")
    monkeypatch.setattr(manager, "get_active_run_detail", broken)
    response = await client.get("/api/runs/active")
    assert response.status_code == 500
    assert "private stack" not in response.text


async def test_origin_and_backend_guard(api):
    _, manager, client = api
    for origin in ("http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"):
        response = await client.get("/api/capabilities", headers={"Origin": origin})
        assert response.headers["access-control-allow-origin"] == origin
    for origin in ("https://foreign.example", "http://127.0.0.1:3041", "http://localhost:3050"):
        denied = await client.post("/api/runs", headers={"Origin": origin}, json={})
        assert denied.status_code == 403
    for expected in ("javascript", ""):
        denied = await client.post("/api/runs", headers={"X-Jarvis-Backend": expected}, json={})
        assert denied.status_code == 409
        assert denied.json()["code"] == "backend_mismatch"
    allowed = await client.options("/api/runs", headers={"Origin": "http://localhost:3000"})
    assert allowed.status_code == 204
    assert "X-Jarvis-Backend" in allowed.headers["access-control-allow-headers"]
    assert not manager.storage.root.exists()


async def test_sse_replays_and_deduplicates_snapshot_subscription_race(api, monkeypatch):
    _, manager, client = api
    detail = await manager.start_run({"scenarioId": "paint-draw-poster", "prompt": "Draw"})
    run_id = detail["run"]["id"]
    original = manager.get_run_detail
    reads = 0
    async def racing(run_id):
        nonlocal reads
        reads += 1
        if reads == 2:
            await manager.emit_event(manager.contexts[run_id], {"type": "run_progress", "message": "between reads", "level": "ok"})
        return await original(run_id)
    monkeypatch.setattr(manager, "get_run_detail", racing)
    streaming = asyncio.create_task(client.get(detail["eventStreamUrl"], headers={"Origin": "http://localhost:3000"}))
    for _ in range(100):
        if reads >= 2:
            break
        await asyncio.sleep(0.001)
    await manager.stop_run(run_id)
    response = await asyncio.wait_for(streaming, 2)
    events = [json.loads(frame.removeprefix("data: ")) for frame in response.text.strip().split("\n\n")]
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert sum(event["message"] == "between reads" for event in events) == 1
    assert events[-1]["type"] == "run_cancelled"
    assert not manager.contexts[run_id].subscribers
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    persisted = await client.get(detail["eventStreamUrl"])
    assert persisted.text == response.text


async def test_historical_running_sse_has_json_error_and_artifacts_are_confined(api):
    _, manager, client = api
    detail = await manager.start_run({"scenarioId": "paint-draw-poster", "prompt": "Draw"})
    run_id = detail["run"]["id"]
    await manager.stop_run(run_id)
    directory = manager.storage.run_dir(run_id)
    (directory / "screenshots" / "safe.png").write_bytes(b"png")
    assert (await client.get(f"/api/runs/{run_id}/artifacts/screenshots/safe.png")).content == b"png"
    outside = directory / "private.json"
    outside.write_text("secret")
    (directory / "screenshots" / "linked.png").symlink_to(outside)
    assert (await client.get(f"/api/runs/{run_id}/artifacts/screenshots/linked.png")).status_code == 404
    stored = json.loads((directory / "replay.json").read_text())
    stored["run"]["status"] = "running"
    (directory / "replay.json").write_text(json.dumps(stored))
    manager.contexts.clear()
    response = await client.get(detail["eventStreamUrl"])
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")


async def test_lost_http_start_is_retained_and_discoverable(api, monkeypatch):
    app, manager, client = api
    entered, release = asyncio.Event(), asyncio.Event()
    original = manager.storage.prepare
    async def prepare(*args):
        entered.set()
        await release.wait()
        await original(*args)
    monkeypatch.setattr(manager.storage, "prepare", prepare)
    request = asyncio.create_task(client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw"}))
    await entered.wait()
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert len(app.state.start_requests) == 1
    release.set()
    detail = await manager.get_active_run_detail()
    assert detail["run"]["status"] == "running"
    await manager.stop_run(detail["run"]["id"])


def test_lifetime_lease_excludes_another_backend_and_releases():
    first = BackendLease(port=0)
    first.acquire()
    port = first.socket.getsockname()[1]
    second = BackendLease(port=port)
    try:
        with pytest.raises(Exception, match="already running"):
            second.acquire()
    finally:
        first.close()
    second.acquire()
    second.close()


@pytest.mark.parametrize("value", [True, False])
async def test_obsolete_verification_option_is_rejected_before_allocating_a_run(api, value):
    _, manager, client = api
    response = await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw",
                                                  "verificationEnabled": value})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"
    assert not manager.storage.root.exists()


@pytest.mark.parametrize("version", [1, 2, 4])
async def test_unsupported_saved_replay_returns_409_without_modifying_history(api, version):
    _, manager, client = api
    detail = await manager.start_run({"scenarioId": "paint-draw-poster", "prompt": "Draw"})
    run_id = detail["run"]["id"]
    await manager.stop_run(run_id)
    replay_path = manager.storage.run_dir(run_id) / "replay.json"
    stored = json.loads(replay_path.read_text())
    assert stored["version"] == 3
    stored["version"] = version
    stored["run"]["verificationEnabled"] = True
    stored["run"]["summary"].update(verificationPassed=True, outcome="success")
    replay_path.write_text(json.dumps(stored, indent=2))
    original = replay_path.read_bytes()
    manager.contexts.pop(run_id)
    for suffix in ("", "/replay", "/events"):
        response = await client.get(f"/api/runs/{run_id}{suffix}")
        assert response.status_code == 409
        assert response.json()["code"] == "unsupported_replay_version"
        assert replay_path.read_bytes() == original


async def test_steer_pause_and_resume_report_state_and_events(api):
    _, manager, client = api
    run_id = (await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw"})).json()["runId"]
    assert (await client.get(f"/api/runs/{run_id}")).json()["run"]["paused"] is False

    steered = await client.post(f"/api/runs/{run_id}/steer", json={"message": "  Use red.  ", "mode": "add"})
    assert (steered.status_code, steered.json()) == (202, {"ok": True})
    assert manager.contexts[run_id].steers == [{"mode": "add", "message": "Use red.", "attachments": []}]
    paused = await client.post(f"/api/runs/{run_id}/pause")
    assert (paused.status_code, paused.json()) == (200, {"ok": True, "paused": True})
    assert (await client.get("/api/runs/active")).json()["run"]["paused"] is True
    assert (await client.post(f"/api/runs/{run_id}/steer", json={"message": "Make it big.", "mode": "redirect"})).status_code == 202
    assert (await client.get(f"/api/runs/{run_id}")).json()["run"]["paused"] is True, "a follow-up does not resume"
    assert (await client.post(f"/api/runs/{run_id}/resume")).json() == {"ok": True, "paused": False}
    detail = (await client.get(f"/api/runs/{run_id}")).json()
    assert detail["run"]["paused"] is False
    progress = [(event["message"], event["level"], event.get("detail")) for event in detail["events"] if event["type"] == "run_progress"]
    assert progress == [
        ("User instruction added.", "ok", "Added: Use red."),
        ("Run paused.", "warn", "The current step finishes; the next model call waits for Resume."),
        ("User instruction added.", "ok", "Changed plan: Make it big."),
        ("Run resumed.", "ok", None),
    ]
    replay = json.loads((manager.storage.run_dir(run_id) / "replay.json").read_text())
    assert replay["run"]["paused"] is False

    await client.post(f"/api/runs/{run_id}/stop")
    for path, body in (("steer", {"message": "Late.", "mode": "add"}), ("pause", None), ("resume", None)):
        response = await client.post(f"/api/runs/{run_id}/{path}", json=body)
        assert (response.status_code, response.json()["code"]) == (409, "run_not_running")
    assert (await client.post("/api/runs/unknown-run/pause")).status_code == 409


@pytest.mark.parametrize("body", [{"message": "   ", "mode": "add"}, {"message": "x" * 4001, "mode": "add"},
                                  {"message": "Hi", "mode": "replace"}, {"message": "Hi"},
                                  {"message": "Hi", "mode": "add", "extra": 1}, ["Hi"]])
async def test_steer_rejects_bad_bodies(api, body):
    _, _, client = api
    run_id = (await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw"})).json()["runId"]
    response = await client.post(f"/api/runs/{run_id}/steer", json=body)
    assert (response.status_code, response.json()["code"]) == (400, "invalid_request")


async def test_answer_endpoint_resolves_only_the_pending_question(tmp_path):
    answers: list[str] = []
    asking = asyncio.Event()

    async def execute(context):
        await asyncio.wait_for(asking.wait(), 5)
        answers.append(await context.ask("Which size?", options=["Small", "Large"]))
        answers.append(await context.ask("Gmail: send email", kind="approval", detail="to: a@b.c"))
        await context.complete_run(notes=["done"])
    template = tmp_path / "template"
    template.mkdir()
    scenarios = [{**item, "workspaceTemplatePath": str(template)} for item in list_scenarios()]
    manager = RunnerManager(tmp_path / "data", executor=execute, scenarios=scenarios)
    app = create_app(manager=manager, acquire_lease=False)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        run_id = (await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw"})).json()["runId"]
        url = f"/api/runs/{run_id}/answer"

        async def question():
            while (pending := (await client.get(f"/api/runs/{run_id}")).json()["run"]["question"]) is None:
                await asyncio.sleep(0.01)
            return pending

        assert (await client.get(f"/api/runs/{run_id}")).json()["run"]["question"] is None
        early = await client.post(url, json={"questionId": "nothing", "answer": "Large"})
        assert (early.status_code, early.json()["code"]) == (409, "no_pending_question")
        asking.set()
        first = await asyncio.wait_for(question(), 5)
        for body in ({"questionId": first["id"], "answer": "   "}, {"questionId": first["id"], "answer": "x" * 2001},
                     {"questionId": first["id"]}, {"questionId": first["id"], "answer": "Large", "extra": 1}):
            response = await client.post(url, json=body)
            assert (response.status_code, response.json()["code"]) == (400, "invalid_request")
        wrong = await client.post(url, json={"questionId": "another-question", "answer": "Large"})
        assert (wrong.status_code, wrong.json()["code"]) == (409, "no_pending_question")
        answered = await client.post(url, json={"questionId": first["id"], "answer": " Large "})
        assert (answered.status_code, answered.json()) == (202, {"ok": True})
        again = await client.post(url, json={"questionId": first["id"], "answer": "Small"})
        assert (again.status_code, again.json()["code"]) == (409, "no_pending_question")

        approval = await asyncio.wait_for(question(), 5)
        assert (approval["kind"], approval["options"], approval["detail"]) == ("approval", ["approve", "deny"], "to: a@b.c")
        unclear = await client.post(url, json={"questionId": approval["id"], "answer": "yes"})
        assert (unclear.status_code, unclear.json()["code"]) == (400, "invalid_answer")
        assert (await client.post(url, json={"questionId": approval["id"], "answer": "approve"})).status_code == 202
        while (await client.get(f"/api/runs/{run_id}")).json()["run"]["status"] == "running":
            await asyncio.sleep(0.01)
        assert answers == ["Large", "approve"]
        late = await client.post(url, json={"questionId": approval["id"], "answer": "approve"})
        assert (late.status_code, late.json()["code"]) == (409, "run_not_running")


async def test_attachments_are_copied_recorded_and_told_to_the_model(api, tmp_path):
    _, manager, client = api
    image = tmp_path / "my cover.PNG"
    image.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
    link = tmp_path / "link.png"
    link.symlink_to(image)
    folder = tmp_path / "songs"
    folder.mkdir()
    body = {"scenarioId": "paint-draw-poster", "prompt": "Draw",
            "attachments": [{"kind": "image", "path": str(link)}, {"kind": "folder", "path": str(folder)}]}
    run = (await client.post("/api/runs", json=body)).json()["detail"]["run"]
    copied = manager.storage.run_dir(run["id"]) / "attachments" / "0-link.png"
    assert run["attachments"] == [{"kind": "image", "path": str(copied), "name": "link.png"},
                                  {"kind": "folder", "path": str(folder.resolve()), "name": "songs"}]
    assert copied.read_bytes() == image.read_bytes()
    image.unlink()
    assert copied.exists(), "the run keeps its own copy"

    from app.attachments import task_text
    assert task_text(run).splitlines() == [
        "Draw", "", "The user attached these:", f"- image link.png: {copied}",
        f"- folder songs: {folder.resolve()} (read and write files there with Python)",
        "To look at an attached image, run `import PIL.Image` and `display(PIL.Image.open(path))`; the next turn shows it to you.",
    ]

    second = tmp_path / "map.webp"
    second.write_bytes(b"webp")
    steer = {"message": "Use this map.", "mode": "add", "attachments": [{"kind": "image", "path": str(second)}]}
    assert (await client.post(f"/api/runs/{run['id']}/steer", json=steer)).status_code == 202
    queued = manager.contexts[run["id"]].steers[0]["attachments"]
    assert queued == [{"kind": "image", "path": str(copied.with_name("2-map.webp")), "name": "map.webp"}]
    detail = (await client.get(f"/api/runs/{run['id']}")).json()
    assert detail["run"]["attachments"][-1] == queued[0]
    assert detail["events"][-1]["detail"] == "Added: Use this map.\nAttached: map.webp"


async def test_invalid_attachments_are_rejected_before_allocation(api, tmp_path):
    _, manager, client = api
    text = tmp_path / "notes.txt"
    text.write_text("x")
    huge = tmp_path / "huge.png"
    with huge.open("wb") as handle:
        handle.truncate(20 * 1024 * 1024 + 1)
    cases = [
        ({"kind": "image", "path": "relative.png"}, "full path"),
        ({"kind": "image", "path": str(tmp_path / "missing.png")}, "not found"),
        ({"kind": "image", "path": str(text)}, "PNG, JPEG, GIF, or WebP"),
        ({"kind": "image", "path": str(tmp_path)}, "PNG, JPEG, GIF, or WebP"),
        ({"kind": "image", "path": str(huge)}, "larger than 20 MB"),
        ({"kind": "folder", "path": str(text)}, "not a folder"),
    ]
    for attachment, message in cases:
        response = await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw", "attachments": [attachment]})
        assert response.status_code == 400
        assert (response.json()["code"], message in response.json()["error"]) == ("invalid_attachment", True)
    too_many = [{"kind": "folder", "path": str(tmp_path)}] * 11
    response = await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw", "attachments": too_many})
    assert (response.status_code, response.json()["code"]) == (400, "invalid_request")
    assert not manager.storage.root.exists()


async def test_workspace_is_validated_recorded_and_given_to_the_executor(tmp_path):
    seen = []

    async def execute(context):
        seen.append(context.workspace)
        await context.complete_run(notes=["done"])
    template = tmp_path / "template"
    template.mkdir()
    scenarios = [{**item, "workspaceTemplatePath": str(template)} for item in list_scenarios()]
    manager = RunnerManager(tmp_path / "data", executor=execute, scenarios=scenarios)
    app = create_app(manager=manager, acquire_lease=False)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://runner") as client:
        for workspace in ({"name": " " * 3}, {"name": "x" * 81}, {"name": "Taxes", "instructions": "y" * 4001},
                          {"name": "Taxes", "folder": "/tmp"}, None):
            response = await client.post("/api/runs", json={"scenarioId": "any-task", "prompt": "Go", "workspace": workspace})
            assert (response.status_code, response.json()["code"]) == (400, "invalid_request")
        assert not manager.storage.root.exists()

        body = {"scenarioId": "any-task", "prompt": "Go", "workspace": {"name": "  Taxes ", "instructions": " Keep receipts. "}}
        run = (await client.post("/api/runs", json=body)).json()["detail"]["run"]
        assert run["workspace"] == {"name": "Taxes"}
        await manager.contexts[run["id"]].execution
        assert seen == [{"name": "Taxes", "instructions": "Keep receipts."}]
        manager.contexts.clear()  # Read the finished run back from disk.
        assert (await client.get(f"/api/runs/{run['id']}")).json()["run"]["workspace"] == {"name": "Taxes"}

        plain = (await client.post("/api/runs", json={"scenarioId": "any-task", "prompt": "Go"})).json()["detail"]["run"]
        assert plain["workspace"] is None
        await manager.contexts[plain["id"]].execution
        assert seen[-1] is None


async def test_delete_removes_a_finished_run_and_refuses_running_unknown_and_bad_ids(api):
    _, manager, client = api
    run_id = (await client.post("/api/runs", json={"scenarioId": "paint-draw-poster", "prompt": "Draw"})).json()["runId"]
    running = await client.delete(f"/api/runs/{run_id}")
    assert (running.status_code, running.json()["code"], running.json()["error"]) == (409, "run_not_finished", "Stop the task before deleting it.")
    assert manager.storage.run_dir(run_id).is_dir()

    await client.post(f"/api/runs/{run_id}/stop")
    frames = manager.storage.run_dir(run_id) / "model-frames"
    frames.mkdir()
    (frames / "a.png").write_bytes(b"png")
    assert manager.storage.workspace(run_id).is_dir()
    deleted = await client.delete(f"/api/runs/{run_id}")
    assert (deleted.status_code, deleted.json()) == (200, {"ok": True, "deleted": run_id})
    assert not manager.storage.run_dir(run_id).exists()
    assert not manager.storage.workspace(run_id).exists()
    assert (await client.get(f"/api/runs/{run_id}")).status_code == 404

    again = await client.delete(f"/api/runs/{run_id}")
    assert (again.status_code, again.json()["code"]) == (404, "run_not_found")
    invalid = await client.delete("/api/runs/..%2Fworkspaces")
    assert invalid.status_code in (400, 404)
    bad = await client.delete("/api/runs/bad.id")
    assert (bad.status_code, bad.json()["code"]) == (400, "invalid_request")
    assert manager.storage.root.joinpath("runs").is_dir()
