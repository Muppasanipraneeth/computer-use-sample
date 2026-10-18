"""Run-scoped lab setup, execution, screenshots, and awaited teardown."""
import asyncio
import re
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from .errors import RunnerCoreError
from .lab_catalog import instructions, list_scenarios
from .lab_server import start_workspace_lab_server
from .model_providers import ExternalCodeModel
from .processes import assert_active


@dataclass
class RunExecutionContext:
    detail: dict
    signal: asyncio.Event
    screenshot_directory: Path
    emit_event: Callable[..., Awaitable]
    capture_screenshot: Callable[..., Awaitable]
    sync_browser_state: Callable[..., Awaitable]
    complete_run: Callable[..., Awaitable]


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
    from .desktop.runtime import launch_python_runtime
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
    python = None
    session: Any = None

    async def cleanup() -> None:
        errors = []
        for resource in (python, session, lab_server, client):
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

    async def run_model(active_instructions: str) -> dict[str, Any]:
        if selection.provider == "openai":
            return await run_responses_code_loop(context=context, session=session, instructions=active_instructions,
                                                 max_response_turns=run["maxResponseTurns"], client=client)
        if selection.provider == "omp":
            from .omp_client import run_omp_code_loop
            return await run_omp_code_loop(context=context, session=session, instructions=active_instructions,
                                           max_response_turns=run["maxResponseTurns"], selector=selection.model_id)
        return await run_external_code_loop(context=context, session=session, instructions=active_instructions,
                                            max_response_turns=run["maxResponseTurns"], client=cast(ExternalCodeModel, client))

    try:
        assert_active(context.signal)
        if run["browserMode"] == "headless":
            if run["labId"] == "desktop":
                raise RunnerCoreError("CAD and game-engine control needs the visible desktop.", code="visible_desktop_required", status_code=400,
                                      hint="Start the Python backend and leave Unreal Editor in front on the primary display.")
            raise RunnerCoreError("Local PyAutoGUI requires a visible browser.", code="visible_browser_required", status_code=400)
        if run["labId"] == "desktop":
            desktop_message = "Using the omp account on the open Unreal Editor." if selection.provider == "omp" else "Using the desktop code loop for the open Unreal Editor."
            await context.emit_event({"type": "run_progress", "level": "ok", "detail": run["model"],
                                      "message": desktop_message})
            python = await launch_python_runtime(signal=context.signal)
            assert_active(context.signal)
            session = DesktopAppSession(python, context.screenshot_directory)
            await session.frontmost()
            await context.emit_event({"type": "browser_session_started", "level": "ok", "detail": session.page.url,
                                      "message": "Desktop session bound to the already-open Unreal Editor."})
            await context.sync_browser_state(session)
            await context.capture_screenshot(session, "desktop-loaded")
            desktop_label = selection.model_id if selection.provider != "openai" else None
            host = getattr(python, "platform", None) or sys.platform
            if desktop_label is None:
                desktop_instructions = instructions(lab_id, session.page.url, platform=host)
            else:
                desktop_instructions = instructions(lab_id, session.page.url, desktop_label, platform=host)
            result = await run_model(desktop_instructions)
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
        session = await launch_browser_session(browser_mode=run["browserMode"], screenshot_dir=context.screenshot_directory,
                                                url=lab_url, target_label=f"run-scoped {lab_id} lab", signal=context.signal)
        session.execution = python
        await session.frontmost()
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
        lab_instructions = instructions(lab_id, session.page.url) if model_label is None else instructions(lab_id, session.page.url, model_label)
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
