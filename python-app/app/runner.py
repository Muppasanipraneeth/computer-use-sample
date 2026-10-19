"""Run lifecycle for up to max_concurrent_runs runs at once. A terminal status means teardown and persistence finished.
Runs share one screen lock (app/screen.py) and one local background browser (app/local_browser_host.py)."""
import asyncio
import base64
import copy
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .attachments import copy_images, plan_attachments, resolve_attachments
from .config import Settings
from .errors import RunnerCoreError
from .local_browser_host import LocalBrowserHost
from .models import (
    AnswerRunRequest,
    BrowserScreenshotArtifact,
    BrowserState,
    RunDetail,
    RunEvent,
    RunQuestion,
    RunRecord,
    StartRunRequest,
    SteerRunRequest,
    validate_wire,
)
from .processes import await_active
from .screen import RunScreen, ScreenLock
from .storage import RunStorage, run_in_thread, store_screenshot, validate_run_id

logger = logging.getLogger(__name__)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _set_event() -> asyncio.Event:
    event = asyncio.Event()
    event.set()
    return event


@dataclass
class InternalRun:
    detail: dict[str, Any]
    signal: asyncio.Event = field(default_factory=asyncio.Event)
    execution: asyncio.Task | None = None
    stopping: asyncio.Task | None = None
    finalizing: bool = False
    completion: dict | None = None
    subscribers: set[Callable[[dict], None]] = field(default_factory=set)
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Follow-up instructions wait here until the model loop's next turn drains them, so a step never sees them mid-way.
    steers: list[dict[str, Any]] = field(default_factory=list)
    # Set while the run may proceed; Pause clears it and the loop blocks before its next model call.
    resumed: asyncio.Event = field(default_factory=_set_event)
    # This run's handle on the shared screen lock, created when execution starts.
    screen: RunScreen | None = None
    # One question at a time: a second asker (e.g. an approval from parallel tool code) waits for the first to settle.
    ask_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Resolved with the user's answer to detail["run"]["question"]; None when nothing is pending.
    answer: asyncio.Future | None = None
    # The user's workspace ({"name", "instructions"}) from the start request; the record keeps only its name.
    workspace: dict[str, str] | None = None


SCREEN_WAIT_EVENT = {"type": "run_progress", "level": "warn", "message": "Waiting for the screen…",
                     "detail": "Another task is using the mouse and keyboard; this step starts when it finishes."}


class RunnerManager:
    def __init__(self, data_root: Path | str | None = None, *, executor: Callable | None = None,
                 settings: Settings | None = None, scenarios: list[dict] | None = None):
        from .lab_catalog import list_scenarios
        self.settings = settings or Settings.from_environment()
        self.storage = RunStorage(Path(data_root or self.settings.data_root))
        self.executor = executor
        self.scenarios = scenarios if scenarios is not None else list_scenarios()
        self.contexts: dict[str, InternalRun] = {}
        # Admitted runs in start order, reserved before the first await of start_run. Each event is set once that
        # run's start finished (registered or rolled back), so lookups and Stop never see a half-started run.
        self.active: dict[str, asyncio.Event] = {}
        self.screen_lock = ScreenLock()
        self.browser_host = LocalBrowserHost()
        self._stops: set[asyncio.Task] = set()
        self.shutting_down = False
        self.desktop_recovery_required = False

    def scenario(self, scenario_id: str) -> dict:
        for scenario in self.scenarios:
            if scenario["id"] == scenario_id:
                return copy.deepcopy(scenario)
        raise RunnerCoreError(f"Unknown scenario: {scenario_id}", code="unknown_scenario", status_code=404,
                              hint="Pick a scenario from /api/scenarios before starting a run.")

    async def start_run(self, input: dict) -> dict:
        request = validate_wire(StartRunRequest, input)
        # Validate attachments before admission so a bad path never allocates a run.
        resolved = await run_in_thread(lambda: resolve_attachments(request.get("attachments", [])))
        if self.desktop_recovery_required:
            raise RunnerCoreError("Desktop input cleanup failed. New runs are blocked.", code="desktop_cleanup_failed",
                                  status_code=503, hint="Release held keys and mouse buttons, check desktop input permissions, then restart the runner before starting another run.")
        if self.shutting_down:
            raise RunnerCoreError("Runner is shutting down.", code="runner_shutting_down", status_code=503,
                                  hint="Restart the runner before starting another run.")
        if request.get("browserMode") == "headless":
            raise RunnerCoreError("Local PyAutoGUI requires a visible browser.", code="visible_browser_required",
                                  status_code=400, hint="Use browserMode: headful for local PyAutoGUI execution.")
        scenario = self.scenario(request["scenarioId"])
        limit = self.settings.max_concurrent_runs
        if len(self.active) >= limit:
            raise RunnerCoreError(f"Jarvis is already doing {limit} task{'' if limit == 1 else 's'}. Stop one or wait for it to finish.",
                                  code="run_limit_reached", status_code=409,
                                  hint=f"Up to {limit} tasks run at once (JARVIS_MAX_CONCURRENT_RUNS).")
        run_id = str(uuid4())
        planned = plan_attachments(resolved, self.storage.run_dir(run_id) / "attachments", 0)
        record = validate_wire(RunRecord, {
            "id": run_id, "scenarioId": scenario["id"], "labId": scenario["labId"], "browserMode": "headful",
            "maxResponseTurns": request.get("maxResponseTurns", 24), "model": request.get("model", self.settings.default_model),
            "prompt": request["prompt"], "status": "running", "startedAt": timestamp(), "paused": False,
            "attachments": planned, "question": None,
            "workspace": {"name": request["workspace"]["name"]} if "workspace" in request else None,
        })
        # Reserve admission before the first await, including workspace copying.
        started = asyncio.Event()
        self.active[run_id] = started
        try:
            await self.storage.prepare(run_id, scenario["workspaceTemplatePath"])
            await run_in_thread(lambda: copy_images(resolved, planned))
            detail = validate_wire(RunDetail, {
                "run": record, "scenario": scenario, "workspacePath": str(self.storage.workspace(run_id)),
                "events": [], "eventStreamUrl": f"/api/runs/{run_id}/events", "replayUrl": f"/api/runs/{run_id}/replay",
            })
            context = InternalRun(detail=detail, workspace=request.get("workspace"))
            self.contexts[run_id] = context
            await self.storage.persist(detail)
            turn_limit = "no turn limit" if record["maxResponseTurns"] is None else f"{record['maxResponseTurns']} turns"
            await self.emit_event(context, {"type": "run_started", "level": "ok", "message": f"Run {run_id} started.",
                                            "detail": f"{scenario['title']} · headful · {turn_limit}"})
            await self.emit_event(context, {"type": "workspace_prepared", "level": "ok",
                                            "message": "Workspace copied into mutable run directory.",
                                            "detail": detail["workspacePath"]})
            context.execution = asyncio.create_task(self._execute(context), name=f"run:{run_id}")
            return copy.deepcopy(detail)
        except BaseException:
            self.active.pop(run_id, None)
            self.contexts.pop(run_id, None)
            raise
        finally:
            started.set()

    async def get_run_detail(self, run_id: str) -> dict:
        validate_run_id(run_id)
        if run_id in self.contexts:
            return copy.deepcopy(self.contexts[run_id].detail)
        replay = await self.storage.read_replay(run_id)
        return validate_wire(RunDetail, {"run": replay["run"], "scenario": self.scenario(replay["run"]["scenarioId"]),
                                        "workspacePath": replay["artifacts"]["workspacePath"], "events": replay["events"],
                                        "eventStreamUrl": f"/api/runs/{run_id}/events", "replayUrl": f"/api/runs/{run_id}/replay",
                                        **({"browser": replay["browser"]} if "browser" in replay else {})})

    async def _running_ids(self) -> list[str]:
        """Running runs in start order, after any start in flight has registered."""
        await asyncio.gather(*(started.wait() for started in list(self.active.values())))
        return [run_id for run_id, started in self.active.items() if started.is_set() and run_id in self.contexts]

    async def get_running_run_details(self) -> list[dict]:
        return [await self.get_run_detail(run_id) for run_id in await self._running_ids()]

    async def get_active_run_detail(self) -> dict | None:
        """The most recently started running run, for clients that follow one run."""
        running = await self._running_ids()
        return await self.get_run_detail(running[-1]) if running else None

    async def get_replay_bundle(self, run_id: str) -> dict:
        return await self.storage.read_replay(run_id)

    def subscribe(self, run_id: str, subscriber: Callable[[dict], None]) -> Callable[[], None]:
        validate_run_id(run_id)
        context = self.contexts.get(run_id)
        if context is None:
            raise RunnerCoreError(f"Run {run_id} is not active in this process.", code="run_not_active", status_code=404,
                                  hint="Open the persisted run detail instead of the live event stream.")
        context.subscribers.add(subscriber)
        return lambda: context.subscribers.discard(subscriber)

    async def stop_run(self, run_id: str, reason: str = "Operator requested stop.") -> dict:
        validate_run_id(run_id)
        started = self.active.get(run_id)
        if started is not None:
            await started.wait()
        context = self.contexts.get(run_id)
        if context is None:
            persisted = await self.get_run_detail(run_id)
            if persisted["run"]["status"] == "running":
                raise RunnerCoreError(f"Run {run_id} exists on disk but is not active in this runner process.",
                                      code="run_not_active", status_code=409,
                                      hint="The run is no longer active in this process. Inspect the persisted replay bundle.")
            return persisted
        if context.stopping:
            return await asyncio.shield(context.stopping)
        if context.finalizing or context.detail["run"]["status"] != "running":
            if context.execution:
                await asyncio.shield(context.execution)
            return copy.deepcopy(context.detail)
        context.signal.set()
        # Set stopping before cancelling so the executor cannot release the admission.
        context.stopping = asyncio.create_task(self._finish_stop(context, reason))
        if context.execution:
            context.execution.cancel()
        return await asyncio.shield(context.stopping)

    async def _finish_stop(self, context: InternalRun, reason: str) -> dict:
        try:
            if context.execution:
                try:
                    await asyncio.shield(context.execution)
                except asyncio.CancelledError:
                    # Cancellation before the task's first instruction owns no resources.
                    pass
            if context.detail["run"]["status"] == "running":
                await self._terminal(context, "cancelled", {"notes": [reason]},
                                     {"detail": reason, "level": "warn", "message": "Run cancelled before completion.", "type": "run_cancelled"})
            return copy.deepcopy(context.detail)
        finally:
            self.active.pop(context.detail["run"]["id"], None)

    async def delete_run(self, run_id: str) -> dict:
        """Remove a finished run's artifacts and workspace from disk. A run this process is still starting, running or
        finishing is refused; a record left "running" by an earlier process can be deleted."""
        validate_run_id(run_id)
        context = self.contexts.get(run_id)
        if run_id in self.active or (context is not None and context.detail["run"]["status"] == "running"):
            raise RunnerCoreError("Stop the task before deleting it.", code="run_not_finished", status_code=409,
                                  hint="Stop the run, wait for it to finish, then delete it.")
        await self.storage.delete(run_id)
        self.contexts.pop(run_id, None)
        return {"ok": True, "deleted": run_id}

    def _running(self, run_id: str) -> InternalRun:
        validate_run_id(run_id)
        context = self.contexts.get(run_id)
        if context is None or context.stopping or context.finalizing or context.detail["run"]["status"] != "running":
            raise RunnerCoreError(f"Run {run_id} is not running.", code="run_not_running", status_code=409,
                                  hint="Follow-ups, answers, pause, and resume only apply to a running run. Start a new run instead.")
        return context

    async def steer_run(self, run_id: str, input: Any) -> dict:
        request = validate_wire(SteerRunRequest, input)
        context = self._running(run_id)
        resolved = await run_in_thread(lambda: resolve_attachments(request.get("attachments", [])))
        # Number copies after the run's existing attachments so file names never collide.
        planned = plan_attachments(resolved, self.storage.run_dir(run_id) / "attachments", len(context.detail["run"]["attachments"]))
        await run_in_thread(lambda: copy_images(resolved, planned))
        context = self._running(run_id)
        context.detail["run"]["attachments"].extend(planned)
        context.steers.append({"mode": request["mode"], "message": request["message"], "attachments": planned})
        prefix = "Added" if request["mode"] == "add" else "Changed plan"
        attached = f"\nAttached: {', '.join(item['name'] for item in planned)}" if planned else ""
        await self.emit_event(context, {"type": "run_progress", "level": "ok", "message": "User instruction added.",
                                        "detail": f"{prefix}: {request['message']}{attached}"})
        return {"ok": True}

    async def pause_run(self, run_id: str) -> dict:
        context = self._running(run_id)
        if context.resumed.is_set():
            context.resumed.clear()
            context.detail["run"]["paused"] = True
            await self.emit_event(context, {"type": "run_progress", "level": "warn", "message": "Run paused.",
                                            "detail": "The current step finishes; the next model call waits for Resume."})
        return {"ok": True, "paused": True}

    async def resume_run(self, run_id: str) -> dict:
        context = self._running(run_id)
        if not context.resumed.is_set():
            context.detail["run"]["paused"] = False
            context.resumed.set()
            await self.emit_event(context, {"type": "run_progress", "level": "ok", "message": "Run resumed."})
        return {"ok": True, "paused": False}

    async def _next_turn(self, context: InternalRun) -> list[dict[str, Any]]:
        """Called by model loops before each model call: hold while paused (Stop still wins), then hand over queued steers."""
        if not context.resumed.is_set():
            await await_active(context.resumed.wait(), context.signal)
        steers, context.steers = context.steers, []
        return steers

    async def _ask(self, context: InternalRun, text: str, *, kind: str = "question", options: list[str] | None = None,
                   detail: str | None = None) -> str:
        """Hold the question on the run record until answer_run resolves it; Stop ends the wait with CancelledError.
        Model loops ask between steps; the apps gateway asks for approval from inside a step."""
        async with context.ask_lock:
            # An approval's answer is always one of these, whatever the asker suggested.
            options = ["approve", "deny"] if kind == "approval" else options or []
            question = validate_wire(RunQuestion, {"id": str(uuid4()), "kind": kind, "text": text, "options": options,
                                                  "detail": detail, "createdAt": timestamp()})
            answer: asyncio.Future[str] = asyncio.get_running_loop().create_future()
            context.answer = answer
            context.detail["run"]["question"] = question
            try:
                if kind == "approval":
                    event = {"message": "Approval requested.", "detail": text + (f"\n{detail}" if detail else "")}
                else:
                    event = {"message": "Waiting for your answer.", "detail": text}
                await await_active(self.emit_event(context, {"type": "run_progress", "level": "warn", **event}), context.signal)
                return await await_active(answer, context.signal)
            finally:
                if context.answer is answer:
                    context.answer = None
                # Unanswered (Stop, or the asking step gave up): withdraw it. The terminal record clears it too.
                run = context.detail["run"]
                if run.get("question") is not None and run["question"]["id"] == question["id"]:
                    run["question"] = None

    async def answer_run(self, run_id: str, input: Any) -> dict:
        request = validate_wire(AnswerRunRequest, input)
        context = self._running(run_id)
        question = context.detail["run"].get("question")
        pending = context.answer
        if question is None or question["id"] != request["questionId"] or pending is None or pending.done():
            raise RunnerCoreError(f"Run {run_id} has no pending question with that id.", code="no_pending_question",
                                  status_code=409, hint="Refresh the run: the question was already answered or withdrawn.")
        answer = request["answer"]
        approval = question["kind"] == "approval"
        if approval and answer not in ("approve", "deny"):
            raise RunnerCoreError('An approval takes the answer "approve" or "deny".', code="invalid_answer",
                                  status_code=400, hint='Send {"answer": "approve"} or {"answer": "deny"}.')
        # Settled before the first await, so a second answer to the same question gets no_pending_question.
        context.detail["run"]["question"] = None
        context.answer = None
        if approval:
            event = {"level": "ok", "message": "You approved.", "detail": question["text"]} if answer == "approve" else \
                {"level": "warn", "message": "You declined.", "detail": question["text"]}
        else:
            event = {"level": "ok", "message": "You answered.", "detail": answer}
        try:
            await self.emit_event(context, {"type": "run_progress", **event})
        finally:
            # The event lands first so the run's next steps read after it; the asker resumes even if persisting failed.
            if not pending.done():
                pending.set_result(answer)
        return {"ok": True}

    def _stop_others(self, internal: InternalRun, reason: str, *, screen_users_only: bool = False) -> None:
        """Stop every other admitted run (a start in flight is stopped once it registers) without waiting here."""
        for run_id in list(self.active):
            other = self.contexts.get(run_id)
            if other is internal:
                continue
            if screen_users_only and (other is None or other.screen is None or not other.screen.used):
                continue
            task = asyncio.create_task(self.stop_run(run_id, reason))
            self._stops.add(task)
            task.add_done_callback(self._stopped)

    def _stopped(self, task: asyncio.Task) -> None:
        self._stops.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("Stopping a run failed", exc_info=task.exception())

    async def shutdown(self) -> None:
        self.shutting_down = True
        await self._running_ids()
        await asyncio.gather(*(self.stop_run(run_id, "Runner shutting down.") for run_id in list(self.active)))
        await asyncio.gather(*list(self._stops), return_exceptions=True)
        await self.browser_host.close()

    async def reset_scenario(self, scenario_id: str) -> dict:
        self.scenario(scenario_id)
        running = await self._running_ids()
        state = {"scenarioId": scenario_id, "resetAt": timestamp()}
        targets = [run_id for run_id in running if self.contexts[run_id].detail["run"]["scenarioId"] == scenario_id]
        stopped = await asyncio.gather(*(self.stop_run(run_id, "Scenario reset requested.") for run_id in targets))
        if stopped:
            # The contract names one run: the most recently started, matching /api/runs/active.
            state["cancelledRunId"] = stopped[-1]["run"]["id"]
        return state

    async def _execute(self, internal: InternalRun) -> None:
        from .scenario_runtime import RunExecutionContext, execute_scenario
        internal.screen = RunScreen(self.screen_lock, internal.signal,
                                    on_wait=lambda: self.emit_event(internal, dict(SCREEN_WAIT_EVENT)))
        context = RunExecutionContext(
            detail=internal.detail, signal=internal.signal,
            screenshot_directory=self.storage.run_dir(internal.detail["run"]["id"]) / "screenshots",
            emit_event=lambda event: self.emit_event(internal, event),
            capture_screenshot=lambda session, label, observation=None: self.capture_screenshot(internal, session, label, observation),
            sync_browser_state=lambda session: self.sync_browser_state(internal, session),
            complete_run=lambda **kwargs: self._complete(internal, **kwargs),
            next_turn=lambda: self._next_turn(internal),
            ask=lambda text, **kwargs: self._ask(internal, text, **kwargs),
            screen=internal.screen, browser_host=self.browser_host, workspace=internal.workspace,
        )
        try:
            await (self.executor or execute_scenario)(context)
            if internal.signal.is_set():
                return
            internal.finalizing = True
            if not internal.completion:
                raise RuntimeError("Executor returned without completing the run.")
            await self._terminal(internal, "completed", internal.completion,
                                 {"detail": internal.detail["replayUrl"], "level": "ok",
                                  "message": "Run finished.", "type": "run_completed"})
        except (Exception, asyncio.CancelledError) as error:  # noqa: BLE001 - execution failures become persisted runs
            code = getattr(error, "code", "")
            cleanup_failed = code in ("desktop_cleanup_failed", "cleanup_failed")
            if code == "desktop_cleanup_failed":
                # Held keys or buttons may remain: no run may use the screen until the runner restarts.
                self.desktop_recovery_required = True
                self.screen_lock.disable("Desktop input cleanup failed in another task, so the screen can't be used.")
                self._stop_others(internal, "Desktop input cleanup failed in another task.", screen_users_only=True)
            if code == "python_failsafe":
                # The fail-safe corner means stop everything, not just the run whose step hit it.
                self._stop_others(internal, "Desktop fail-safe activated.")
            if internal.signal.is_set() and not cleanup_failed:
                return
            internal.finalizing = True
            if code == "python_failsafe":
                await self._terminal(internal, "cancelled", {"notes": ["Desktop fail-safe activated."]},
                                     {"detail": code, "level": "warn", "message": "Desktop fail-safe activated. Run cancelled.", "type": "run_cancelled"})
            else:
                notes = [str(error) or type(error).__name__]
                if code:
                    notes.append(f"Error code: {code}")
                hint = getattr(error, "hint", None)
                if hint:
                    notes.append(f"Hint: {hint}")
                await self._terminal(internal, "failed", {"notes": notes},
                                     {"detail": " ".join(notes), "level": "error", "message": "Run failed during execution.", "type": "run_failed"})
        finally:
            if not internal.stopping:
                self.active.pop(internal.detail["run"]["id"], None)

    async def _complete(self, context: InternalRun, *, notes: list[str]) -> None:
        if not context.signal.is_set() and context.detail["run"]["status"] == "running":
            context.completion = {"notes": notes}

    def _update_counts(self, detail: dict) -> None:
        if "summary" in detail["run"]:
            detail["run"]["summary"].update(stepCount=len(detail["events"]),
                                              screenshotCount=len(detail.get("browser", {}).get("screenshots", [])))

    def _event(self, context: InternalRun, event: dict) -> dict:
        sequence = len(context.detail["events"])
        return validate_wire(RunEvent, {**event, "id": f"{context.detail['run']['id']}:{sequence}",
                                       "runId": context.detail["run"]["id"], "sequence": sequence, "createdAt": timestamp()})

    def _notify(self, context: InternalRun, event: dict) -> None:
        for subscriber in list(context.subscribers):
            try:
                subscriber(copy.deepcopy(event))
            except Exception:
                logger.exception("Run subscriber failed")

    async def emit_event(self, context: InternalRun, input: dict, terminal_record: dict | None = None) -> None:
        async with context.write_lock:
            event = self._event(context, input)
            detail = copy.deepcopy(context.detail) if terminal_record else context.detail
            if terminal_record:
                detail["run"] = terminal_record
            detail["events"].append(event)
            self._update_counts(detail)
            await self.storage.persist(detail, event)
            if terminal_record:
                context.detail.clear()
                context.detail.update(detail)
            self._notify(context, event)

    async def _terminal(self, context: InternalRun, status: str, completion: dict, event: dict) -> None:
        end = timestamp()
        start = datetime.fromisoformat(context.detail["run"]["startedAt"].replace("Z", "+00:00"))
        duration = max(0, int((datetime.fromisoformat(end.replace("Z", "+00:00")) - start).total_seconds() * 1000))
        record = {**context.detail["run"], "status": status, "completedAt": end, "durationMs": duration, "paused": False,
                  "question": None,
                  "summary": {**completion, "screenshotCount": 0, "stepCount": 0}}
        try:
            await self.emit_event(context, event, record)
        except Exception as error:
            if status == "completed":
                raise
            # Disk failure must not strand the desktop slot or a live SSE client.
            logger.exception("Could not persist terminal run")
            record["status"] = "failed"
            record["summary"].update(notes=[*completion["notes"], f"Run artifacts could not be persisted: {error}"])
            context.detail["run"] = record
            failure = self._event(context, {"detail": str(error), "level": "error", "type": "run_failed",
                                            "message": "Run artifacts could not be persisted."})
            context.detail["events"].append(failure)
            self._update_counts(context.detail)
            self._notify(context, failure)

    async def capture_screenshot(self, context: InternalRun, session: Any, label: str, observation: dict | None = None) -> dict:
        if observation:
            identifier = f"observation-{uuid4()}"
            directory = self.storage.run_dir(context.detail["run"]["id"]) / "screenshots"
            path = await run_in_thread(lambda: store_screenshot(directory, identifier, base64.b64decode(observation["base64"])))
            snapshot = {**await session.read_state(), "id": identifier, "label": label, "path": str(path),
                        "mimeType": "image/jpeg", "capturedAt": timestamp()}
        else:
            snapshot = await session.capture_screenshot(label)
        artifact = {"id": snapshot["id"], "label": snapshot["label"], "path": str(snapshot["path"]),
                    "mimeType": snapshot["mimeType"], "capturedAt": snapshot["capturedAt"],
                    "pageUrl": snapshot["currentUrl"], "source": "code_tool" if observation else "browser_preview",
                    "url": f"/api/runs/{context.detail['run']['id']}/artifacts/screenshots/{Path(snapshot['path']).name}"}
        if snapshot.get("pageTitle"):
            artifact["pageTitle"] = snapshot["pageTitle"]
        dimensions = observation or session.viewport
        for source, target in (("width", "imageWidth"), ("height", "imageHeight")):
            if dimensions.get(source):
                artifact[target] = dimensions[source]
        artifact = validate_wire(BrowserScreenshotArtifact, artifact)
        context.detail["browser"] = self._browser_state(context, session, snapshot)
        context.detail["browser"]["screenshots"].append(artifact)
        await self.emit_event(context, {"detail": artifact["url"], "level": "ok", "type": "screenshot_captured",
                                        "message": f"Screenshot captured ({label})."})
        return artifact

    def _browser_state(self, context: InternalRun, session: Any, state: dict) -> dict:
        return validate_wire(BrowserState, {"currentUrl": state["currentUrl"], "mode": session.mode,
                              "screenshots": context.detail.get("browser", {}).get("screenshots", []),
                              "targetLabel": session.target_label, "viewport": session.viewport,
                              **({"pageTitle": state["pageTitle"]} if state.get("pageTitle") else {})})

    async def sync_browser_state(self, context: InternalRun, session: Any) -> None:
        state = await session.read_state()
        async with context.write_lock:
            context.detail["browser"] = self._browser_state(context, session, state)
            await self.storage.persist(context.detail)
