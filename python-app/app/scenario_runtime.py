"""Run-scoped lab setup, execution, screenshots, and awaited teardown."""
import asyncio
import os
import re
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from .apps_gateway import AppsGateway
from .browser_gateway import BrowserGateway
from .config import composio_api_key, desktop_user_data
from .errors import RunnerCoreError
from .lab_catalog import instructions, list_scenarios, target_app, uses_cloud_browser
from .lab_server import start_workspace_lab_server
from .local_browser_host import BrowserLease, LocalBrowserHost
from .model_providers import ExternalCodeModel
from .processes import assert_active
from .screen import RunScreen
from .user_profile import load_memories, load_profile, memory_path


@dataclass
class RunExecutionContext:
    detail: dict
    signal: asyncio.Event
    screenshot_directory: Path
    emit_event: Callable[..., Awaitable]
    capture_screenshot: Callable[..., Awaitable]
    sync_browser_state: Callable[..., Awaitable]
    complete_run: Callable[..., Awaitable]
    # Model loops await this before every model call: it blocks while the run is paused and returns the user's
    # queued follow-ups ([{"mode": "add" | "redirect", "message": str, "attachments": [...]}]) for that turn.
    next_turn: Callable[[], Awaitable[list[dict[str, Any]]]]
    # ask(text, kind="question" | "approval", options=[...], detail=None) → the user's answer ("approve"/"deny" for an
    # approval). The question shows on the run record until answered; Stop raises CancelledError.
    ask: Callable[..., Awaitable[str]]
    # This run's handle on the runner's one screen lock: screen steps, desktop captures and input release hold it.
    screen: RunScreen
    # The runner's shared headless Chromium for local background browsing.
    browser_host: LocalBrowserHost
    # The user's workspace for this run ({"name", "instructions"}), or None.
    workspace: dict[str, str] | None = None
    # Auto's stronger models (same provider as detail["run"]["model"]), weakest first, which the loop may escalate to.
    stronger_models: tuple[str, ...] = ()


def browser_profile_directory() -> str:
    """Jarvis's browser profile, inside the desktop app's Electron userData folder: the Settings sign-in window
    (desktop/browser-profile.mjs) stores the user's logins there and the local background browser reuses them.
    JARVIS_BROWSER_PROFILE in the runner's environment overrides it."""
    override = os.environ.get("JARVIS_BROWSER_PROFILE", "").strip()
    if override:
        return override
    return str(desktop_user_data() / "browser-profile")


async def delay(milliseconds: int, signal: asyncio.Event) -> None:
    assert_active(signal)
    try:
        await asyncio.wait_for(signal.wait(), milliseconds / 1000)
    except asyncio.TimeoutError:
        return
    raise asyncio.CancelledError("Run aborted.")


async def hold_browser(context: RunExecutionContext) -> None:
    if context.detail["run"]["browserMode"] != "headful":
        return
    prompt = context.detail["run"]["prompt"].lower()
    match = re.search(r"wait\s+(\d+)\s*(?:seconds?|secs?|s)\b|keep(?:\s+it)?\s+open\s+for\s+(\d+)\s*(?:seconds?|secs?|s)\b", prompt)
    if match:
        milliseconds = min(15000, max(1000, int(match[1] or match[2]) * 1000))
    else:
        milliseconds = 5000 if any(word in prompt for word in ("wait", "hold open", "keep open", "stay open")) else 3500
    await context.emit_event({"type": "run_progress", "level": "pending", "detail": f"{milliseconds / 1000:g}s operator review window",
                              "message": "Holding the headful browser session open before teardown."})
    await delay(milliseconds, context.signal)


async def execute_scenario(context: RunExecutionContext) -> None:
    from .browser import launch_browser_session
    from .desktop.app_session import DesktopAppSession
    from .desktop.runtime import PythonRuntime, launch_python_runtime
    from .model_providers import create_external_code_model, run_external_code_loop
    from .model_selection import parse_model_selection
    from .responses_loop import create_default_responses_client, run_responses_code_loop

    run = context.detail["run"]
    if not any(item["id"] == run["scenarioId"] and item["labId"] == run["labId"] for item in list_scenarios()):
        raise RunnerCoreError(f"Unsupported public scenario: {run['scenarioId']}", code="unsupported_scenario", status_code=404,
                              hint="Use one of the public scenarios from /api/scenarios.")
    selection = parse_model_selection(run["model"])
    client: Any = None
    if selection.provider == "openai":
        client = create_default_responses_client()
    elif selection.provider != "omp":
        client = create_external_code_model(selection)
    lab_id = run["labId"]
    lab_server = None
    python: PythonRuntime | None = None
    session: Any = None
    gateway: BrowserGateway | None = None
    apps_gateway: AppsGateway | None = None
    browser_lease: BrowserLease | None = None

    async def cleanup() -> None:
        errors = []
        # The worker disconnects from the shared browser before this run gives up its share of it.
        for resource in (python, session, gateway, browser_lease, apps_gateway, lab_server, client):
            if resource is not None:
                try:
                    await resource.close()
                except (Exception, asyncio.CancelledError) as error:  # noqa: BLE001 - attempt every owned resource cleanup
                    errors.append(error)
        if errors:
            release_failed = any(getattr(error, "code", "") in ("input_release_failed", "input_release_timeout") for error in errors)
            raise RunnerCoreError("Run cleanup failed: " + "; ".join(str(error) for error in errors),
                                  code="desktop_cleanup_failed" if release_failed else "cleanup_failed",
                                  hint="Release held keys and mouse buttons, check desktop input permissions, then restart the runner before starting another run." if release_failed else None)

    async def approve_tool(text: str, detail: str) -> bool:
        # The step that called apps.run is blocked on this answer: the user's thinking time must not trip its deadline.
        if python is None:
            return await context.ask(text, kind="approval", detail=detail) == "approve"
        with python.deadline_paused():
            return await context.ask(text, kind="approval", detail=detail) == "approve"

    async def run_model(active_instructions: str) -> dict[str, Any]:
        stronger_models = context.stronger_models
        if selection.provider == "openai":
            return await run_responses_code_loop(context=context, session=session, instructions=active_instructions,
                                                 max_response_turns=run["maxResponseTurns"], client=client,
                                                 stronger_models=stronger_models)
        if selection.provider == "omp":
            from .omp_client import run_omp_code_loop
            return await run_omp_code_loop(context=context, session=session, instructions=active_instructions,
                                           max_response_turns=run["maxResponseTurns"], selector=selection.model_id,
                                           stronger_models=stronger_models)
        return await run_external_code_loop(context=context, session=session, instructions=active_instructions,
                                            max_response_turns=run["maxResponseTurns"], client=cast(ExternalCodeModel, client),
                                            stronger_models=stronger_models)

    try:
        assert_active(context.signal)
        if run["browserMode"] == "headless":
            if run["labId"] == "desktop":
                raise RunnerCoreError("CAD and game-engine control needs the visible desktop.", code="visible_desktop_required", status_code=400,
                                      hint="Start the Python backend and leave the target app on the primary display.")
            raise RunnerCoreError("Local PyAutoGUI requires a visible browser.", code="visible_browser_required", status_code=400)
        if run["labId"] == "desktop":
            app = target_app(run["scenarioId"])
            target_label = f"the open {app}" if app else "the desktop"
            desktop_message = f"Using the omp account on {target_label}." if selection.provider == "omp" else f"Using the desktop code loop for {target_label}."
            await context.emit_event({"type": "run_progress", "level": "ok", "detail": run["model"],
                                      "message": desktop_message})
            extra_environment: dict[str, str] = {}
            web = uses_cloud_browser(run["scenarioId"])
            if web:
                # read() and web work in the background on any setup: Cloudflare's cloud browser when configured,
                # otherwise the runner's shared headless Chromium. Either way the user's screen is left alone.
                extra_environment["JARVIS_WEB_INSTRUMENTS"] = "1"
                # remember()/forget() write the same memory.json the desktop app shows in Settings → You.
                extra_environment["JARVIS_MEMORY_FILE"] = str(memory_path())
                account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
                api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
                if account_id and api_token:
                    gateway = await BrowserGateway.start(account_id, api_token)
                    extra_environment["JARVIS_BROWSER_GATEWAY"] = gateway.base_url
                    await context.emit_event({"type": "run_progress", "level": "ok", "detail": "gateway on 127.0.0.1",
                                              "message": "Cloudflare Browser Run connected."})
                else:
                    try:
                        browser_lease = await context.browser_host.lease(browser_profile_directory())
                    except Exception as error:  # noqa: BLE001 - the run goes on; read() and web report why they can't browse
                        extra_environment["JARVIS_BROWSER_UNAVAILABLE"] = str(error)
                        await context.emit_event({"type": "run_progress", "level": "warn", "detail": str(error),
                                                  "message": "The background browser on this computer is unavailable."})
                    else:
                        extra_environment["JARVIS_BROWSER_CDP_FILE"] = browser_lease.endpoint_file
                        # Until the browser can open, read() and web raise the reason; the host keeps trying all run.
                        extra_environment["JARVIS_BROWSER_BLOCKED_FILE"] = browser_lease.blocked_file
                        if browser_lease.blocked:
                            await context.emit_event({"type": "run_progress", "level": "warn", "detail": browser_lease.blocked,
                                                      "message": "The background browser on this computer can't open yet."})
                        if browser_lease.notice:
                            await context.emit_event({"type": "run_progress", "level": "warn", "detail": browser_lease.notice,
                                                      "message": "Sign in to websites again."})
                        await context.emit_event({"type": "run_progress", "level": "ok",
                                                  "detail": "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to use Cloudflare's cloud browser instead.",
                                                  "message": "Web browsing runs in a background browser on this computer."})
                composio_key = composio_api_key()
                if composio_key:
                    # Model code reaches connected apps only through this gateway; the key never enters the worker.
                    apps_gateway = await AppsGateway.start(composio_key, approve=approve_tool)
                    extra_environment["JARVIS_APPS_GATEWAY"] = apps_gateway.base_url
                    await context.emit_event({"type": "run_progress", "level": "ok", "detail": "gateway on 127.0.0.1",
                                              "message": "Connected apps are available through Composio."})
            python = await launch_python_runtime(signal=context.signal, extra_environment=extra_environment)
            assert_active(context.signal)
            python.screen = context.screen
            session = DesktopAppSession(python, context.screenshot_directory, target_label=app or "the desktop")
            session.screen = context.screen
            session.browser_gateway = gateway.base_url if gateway is not None else None
            session.web_instruments = web
            # Model steps take turns with hand-overs of the browser profile to the Settings sign-in window.
            session.browser_lease = browser_lease
            session.apps_gateway = apps_gateway.base_url if apps_gateway is not None else None
            await session.frontmost()
            bound_to = f"the already-open {app}" if app else "the primary display"
            await context.emit_event({"type": "browser_session_started", "level": "ok", "detail": session.page.url,
                                      "message": f"Desktop session bound to {bound_to}."})
            await context.sync_browser_state(session)
            # The omp loop shows the model the screen only when it asks, so it skips the routine before/after captures.
            routine_captures = selection.provider != "omp"
            if routine_captures:
                await context.capture_screenshot(session, "desktop-loaded")
            desktop_label = selection.model_id if selection.provider != "openai" else None
            host = getattr(python, "platform", None) or sys.platform
            # Only the general desktop task gets the profile: a run bound to one app (Unreal) has no use for it.
            profile = load_profile() if app is None else None
            memories = load_memories() if app is None else None
            if desktop_label is None:
                desktop_instructions = instructions(run["scenarioId"], session.page.url, platform=host, web=web,
                                                    cloud=gateway is not None, apps=apps_gateway is not None, profile=profile,
                                                    memories=memories, workspace=context.workspace)
            else:
                desktop_instructions = instructions(run["scenarioId"], session.page.url, desktop_label, platform=host,
                                                    web=web, cloud=gateway is not None, apps=apps_gateway is not None, profile=profile,
                                                    memories=memories, workspace=context.workspace)
            result = await run_model(desktop_instructions)
            if routine_captures:
                await context.capture_screenshot(session, "desktop-final")
            await context.complete_run(notes=result["notes"])
            return
        if selection.provider == "openai":
            provider_message = f"Using the live Responses API code loop for the {lab_id} lab."
        elif selection.provider == "anthropic":
            provider_message = f"Using the Claude code loop for the {lab_id} lab."
        elif selection.provider == "omp":
            provider_message = f"Using the omp account code loop for the {lab_id} lab."
        else:
            provider_message = f"Using the OpenAI-compatible code loop for the {lab_id} lab."
        await context.emit_event({"type": "run_progress", "level": "ok", "detail": run["model"],
                                  "message": provider_message})
        lab_server = await start_workspace_lab_server(workspace_path=context.detail["workspacePath"])
        lab_url = lab_server.url_for("index.html")
        python = await launch_python_runtime(signal=context.signal)
        assert_active(context.signal)
        python.screen = context.screen
        session = await launch_browser_session(browser_mode=run["browserMode"], screenshot_dir=context.screenshot_directory,
                                                url=lab_url, target_label=f"run-scoped {lab_id} lab", signal=context.signal)
        session.execution = python
        session.screen = context.screen
        await session.frontmost()
        # Another run may have raised its own window since: bring the lab back before this run's next screen step.
        context.screen.refocus = session.frontmost
        assert_active(context.signal)
        await context.emit_event({"type": "lab_started", "level": "ok", "detail": lab_url,
                                  "message": "HTTP lab server booted from the mutable workspace."})
        await context.sync_browser_state(session)
        await context.emit_event({"type": "browser_session_started", "level": "ok", "detail": session.target_label,
                                  "message": "Browser session launched and bound to the run."})
        await context.emit_event({"type": "browser_navigated", "level": "ok", "detail": session.page.url,
                                  "message": f"Browser navigated to the {lab_id} lab."})
        await context.capture_screenshot(session, f"{lab_id}-loaded")
        model_label = selection.model_id if selection.provider != "openai" else None
        lab_instructions = instructions(run["scenarioId"], session.page.url, workspace=context.workspace) if model_label is None \
            else instructions(run["scenarioId"], session.page.url, model_label, workspace=context.workspace)
        result = await run_model(lab_instructions)
        await context.capture_screenshot(session, f"{lab_id}-final")
        await hold_browser(context)
        await context.complete_run(notes=result["notes"])
    finally:
        # Once teardown starts, a second cancellation must not abandon resources.
        teardown = asyncio.create_task(cleanup())
        while True:
            try:
                await asyncio.shield(teardown)
                break
            except asyncio.CancelledError:
                if teardown.done():
                    await teardown
                    break
