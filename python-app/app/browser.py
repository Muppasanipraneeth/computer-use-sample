"""Launch and own Chromium; use public Playwright APIs for lab inspection."""

from __future__ import annotations

import asyncio
import contextlib
import re
import shutil
import tempfile
from collections.abc import Awaitable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar

from .errors import RunnerCoreError
from .processes import OwnedProcess, assert_active, await_active, bounded, child_environment, drain_tail
from .screen import RunScreen

DEFAULT_VIEWPORT = {"width": 1440, "height": 900}
_T = TypeVar("_T")


class BrowserCleanupError(RuntimeError):
    code = "cleanup_failed"


async def wait_for_devtools_port(
    profile: Path,
    process: OwnedProcess,
    signal: asyncio.Event | None = None,
    timeout: float = 15,
) -> str:
    async def read_port() -> str:
        while True:
            assert_active(signal)
            if process.process.returncode is not None:
                raise RuntimeError("Chromium exited before its debugging endpoint was ready.")
            try:
                lines = (profile / "DevToolsActivePort").read_text().splitlines()
                if len(lines) >= 2 and 0 < int(lines[0]) < 65536 and lines[1].startswith("/devtools/browser/"):
                    return f"http://127.0.0.1:{int(lines[0])}"
            except (FileNotFoundError, ValueError, OSError):
                pass
            await asyncio.sleep(0.025)

    try:
        return await asyncio.wait_for(await_active(read_port(), signal), timeout)
    except asyncio.TimeoutError as error:
        raise RuntimeError(f"Chromium debugging endpoint was not ready within {int(timeout * 1000)}ms.") from error


class BrowserSession:
    def __init__(
        self,
        *,
        process: OwnedProcess,
        playwright: Any,
        profile: Path,
        screenshot_dir: Path,
        target_label: str,
        mode: str,
        signal: asyncio.Event | None,
    ) -> None:
        self.process = process
        self.playwright = playwright
        self.profile = profile
        self.screenshot_dir = screenshot_dir
        self.target_label = target_label
        self.mode = mode
        self.signal = signal
        self.viewport = dict(DEFAULT_VIEWPORT)
        self.browser: Any = None
        self.context: Any = None
        self.page: Any = None
        self.execution: Any = None
        self._screenshot_count = 0
        self._closing: asyncio.Task[None] | None = None
        self._stdout = asyncio.create_task(drain_tail(process.stdout))
        # The run's handle on the runner's screen lock: raising the window changes what other runs' clicks hit.
        self.screen: RunScreen | None = None
        self._stderr = asyncio.create_task(drain_tail(process.stderr))
        self._watcher = asyncio.create_task(self._watch_signal()) if signal is not None else None

    async def _watch_signal(self) -> None:
        assert self.signal is not None
        await self.signal.wait()
        # Stop desktop actions and release input before tearing down their window.
        if self.execution is not None:
            with contextlib.suppress(Exception):
                await self.execution.close()
        # The run's finally block observes this same stored cleanup failure.
        with contextlib.suppress(Exception):
            await self.close()

    async def _on_page(self, operation: Awaitable[_T]) -> _T:
        try:
            return await await_active(operation, self.signal)
        except Exception as error:
            # Playwright's TargetClosedError text. The model's own clicks (Dock, ⌘Q) can close the lab window.
            if "Target page, context or browser has been closed" in str(error):
                raise RunnerCoreError(
                    "The practice lab's browser window was closed, so the run stopped.",
                    code="lab_browser_closed",
                    status_code=409,
                    hint="Leave the lab window open while the agent works. For tasks outside the lab, use the Any task workspace.",
                ) from error
            raise

    async def navigate(self, url: str) -> None:
        await self._on_page(self.page.goto(url, wait_until="load"))

    async def frontmost(self) -> None:
        async with self.screen.hold() if self.screen is not None else contextlib.nullcontext():
            await self._on_page(self.page.bring_to_front())

    async def read_state(self) -> dict[str, Any]:
        title = await self._on_page(self.page.title())
        return {"currentUrl": self.page.url, **({"pageTitle": title} if title else {})}

    async def capture_screenshot(self, label: str) -> dict[str, Any]:
        self._screenshot_count += 1
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^a-z0-9]+", "-", label.strip().lower()).strip("-")[:64] or "capture"
        path = self.screenshot_dir / f"{self._screenshot_count:03d}-{name}.png"
        await self._on_page(self.page.screenshot(path=str(path)))
        return {
            "capturedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            **await self.read_state(),
            "id": f"screenshot-{self._screenshot_count}",
            "label": label,
            "mimeType": "image/png",
            "path": str(path),
        }

    async def _close(self) -> None:
        errors: list[Exception] = []

        async def close_playwright_connections() -> None:
            try:
                if self.context is not None:
                    await self.context.close()
            finally:
                if self.browser is not None:
                    await self.browser.close()

        try:
            await bounded(close_playwright_connections(), 1)
        except asyncio.TimeoutError:
            errors.append(RuntimeError("Browser cleanup exceeded 1000ms."))
        except Exception as error:  # noqa: BLE001 - Attempt every independent cleanup step.
            errors.append(error)
        # CDP browser.close is a disconnect, and a connection can itself hang.
        # Retain an independent OS handle and terminate Chromium in every case.
        try:
            await self.process.close()
        except Exception as error:  # noqa: BLE001 - Chromium must be reaped even when Playwright fails.
            errors.append(error)
        await asyncio.gather(self._stdout, self._stderr, return_exceptions=True)
        try:
            await bounded(self.playwright.stop(), 1)
        except Exception as error:  # noqa: BLE001 - Retain driver failure without skipping profile cleanup.
            errors.append(error)
        try:
            shutil.rmtree(self.profile)
        except FileNotFoundError:
            pass
        except OSError as error:
            errors.append(error)
        if errors:
            raise BrowserCleanupError("; ".join(str(error) for error in errors))

    async def close(self) -> None:
        if self._closing is None:
            self._closing = asyncio.create_task(self._close())
        try:
            await asyncio.shield(self._closing)
        finally:
            if self._watcher is not None and self._watcher is not asyncio.current_task():
                self._watcher.cancel()


async def launch_browser_session(
    *,
    browser_mode: str,
    screenshot_dir: str | Path,
    url: str,
    target_label: str,
    signal: asyncio.Event | None = None,
) -> BrowserSession:
    from playwright.async_api import async_playwright

    if browser_mode != "headful":
        raise ValueError("Local PyAutoGUI requires a visible browser.")
    assert_active(signal)
    profile = Path(tempfile.mkdtemp(prefix="jarvis-python-chromium-"))
    playwright: Any = None
    session: BrowserSession | None = None
    try:
        playwright = await asyncio.wait_for(async_playwright().start(), 15)
        assert_active(signal)
        # We spawn the binary ourselves, so a missing download would otherwise surface as a bare FileNotFoundError.
        if not Path(playwright.chromium.executable_path).exists():
            raise RunnerCoreError(
                "Chromium for the practice labs is not installed.",
                code="browser_not_installed",
                status_code=400,
                hint="Run `pnpm python:playwright:install` from the repository root, then start the run again.",
            )
        child = await OwnedProcess.spawn(
            [
                playwright.chromium.executable_path,
                f"--user-data-dir={profile}",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--no-startup-window",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1440,900",
            ],
            env=child_environment(),
        )
        session = BrowserSession(
            process=child,
            playwright=playwright,
            profile=profile,
            screenshot_dir=Path(screenshot_dir),
            target_label=target_label,
            mode=browser_mode,
            signal=signal,
        )
        endpoint = await wait_for_devtools_port(profile, child, signal)
        session.browser = await await_active(playwright.chromium.connect_over_cdp(endpoint, timeout=15_000), signal)
        session.context = await await_active(session.browser.new_context(viewport=DEFAULT_VIEWPORT), signal)
        session.page = await await_active(session.context.new_page(), signal)
        await session.navigate(url)
        assert_active(signal)
        return session
    except BaseException:
        if session is not None:
            await session.close()
        else:
            try:
                if playwright is not None:
                    await bounded(playwright.stop(), 1)
            finally:
                shutil.rmtree(profile, ignore_errors=True)
        raise
