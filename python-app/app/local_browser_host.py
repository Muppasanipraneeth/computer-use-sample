"""One headless Chromium on Jarvis's browser profile, shared by every concurrent run that browses on this computer.

Chromium allows one browser per profile folder, and copying the profile per run would fork the user's logins, so the
runner owns a single host: the first web-using run launches it, the last one to finish closes it. Each run's worker
connects over CDP, opens its own pages in the default (persistent) context and closes only those pages.

The command line keeps `--headless` and `--user-data-dir=<profile>` literally: the desktop app's sign-in window
(desktop/browser-profile.mjs headlessHolder) looks for them to tell the user the profile is busy."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal as signals
import sys
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path

from .browser import wait_for_devtools_port
from .errors import RunnerCoreError
from .processes import OwnedProcess, child_environment, drain_tail

PROFILE_IN_USE = "Close the Jarvis sign-in browser window, then try again."
WINDOW = "1280,900"


def profile_in_use(directory: str) -> bool:
    """True while another Chromium (the user's sign-in window) holds the profile. Two browsers writing one profile
    corrupt it, and Chromium would only forward our launch to that window."""
    if sys.platform == "win32":
        # Chromium holds this file open without write sharing and deletes it when it exits.
        lockfile = os.path.join(directory, "lockfile")
        if not os.path.exists(lockfile):
            return False
        try:
            with open(lockfile, "a"):
                return False
        except PermissionError:
            return True
    try:
        target = os.readlink(os.path.join(directory, "SingletonLock"))  # "<hostname>-<pid>"
    except OSError:
        return False
    pid = target.rpartition("-")[2]
    if not pid.isdigit():
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False  # a stale lock from a crash; Chromium takes it over
    except PermissionError:
        return True
    return True


def host_arguments(executable: str, profile: str) -> list[str]:
    # --use-mock-keychain and --password-store=basic match Playwright's launch flags and the sign-in window's, so cookies
    # saved by either can be decrypted by the other.
    return [executable, "--headless", f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
            "--password-store=basic", "--hide-scrollbars", "--mute-audio", f"--window-size={WINDOW}", "about:blank"]


async def playwright_chromium() -> str:
    """The full Chromium the runner's Playwright ships (not the headless shell), the build the sign-in window uses."""
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        executable = playwright.chromium.executable_path
    if not Path(executable).exists():
        raise RunnerCoreError("Chromium for the background browser is not installed.", code="browser_not_installed",
                              status_code=400, hint="Run `pnpm python:playwright:install` from the repository root, then start the run again.")
    return executable


class BrowserLease:
    """A run's share of the host. close() is idempotent; the run's cleanup calls it after its worker exits."""

    def __init__(self, host: LocalBrowserHost, endpoint: str) -> None:
        self.endpoint = endpoint
        self._host: LocalBrowserHost | None = host

    async def close(self) -> None:
        host, self._host = self._host, None
        if host is not None:
            await host._release()


class LocalBrowserHost:
    def __init__(self, *, executable: Callable[[], Awaitable[str]] = playwright_chromium,
                 spawn: Callable[..., Awaitable[OwnedProcess]] = OwnedProcess.spawn,
                 ready_timeout: float = 15, exit_grace: float = 5) -> None:
        self._executable = executable
        self._spawn = spawn
        self._ready_timeout = ready_timeout
        self._exit_grace = exit_grace
        self._lock = asyncio.Lock()
        self._users = 0
        self._process: OwnedProcess | None = None
        self._drains: list[asyncio.Task[bytes]] = []
        self._profile: str | None = None
        self._endpoint: str | None = None

    @property
    def users(self) -> int:
        return self._users

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.process.returncode is None

    async def lease(self, profile: str) -> BrowserLease:
        """Launch the host on first use (or after it crashed) and count this run as a user."""
        async with self._lock:
            if self._process is not None and not self.running:
                await self._stop()  # Crashed: reap it and start a fresh one for this and the remaining runs.
            if self._process is None:
                await self._launch(profile)
            elif profile != self._profile:
                raise RunnerCoreError("The background browser is already open on another profile.", code="browser_profile_in_use",
                                      status_code=409, hint="Restart the runner after changing JARVIS_BROWSER_PROFILE.")
            assert self._endpoint is not None
            self._users += 1
            return BrowserLease(self, self._endpoint)

    async def _release(self) -> None:
        async with self._lock:
            self._users = max(0, self._users - 1)
            if self._users == 0:
                await self._stop()

    async def close(self) -> None:
        """Runner shutdown: close the host even if a lease was never returned."""
        async with self._lock:
            self._users = 0
            await self._stop()

    async def _launch(self, profile: str) -> None:
        if profile_in_use(profile):
            raise RunnerCoreError(PROFILE_IN_USE, code="browser_profile_in_use", status_code=409,
                                  hint="The Settings sign-in window holds Jarvis's browser profile; background browsing needs it.")
        os.makedirs(profile, exist_ok=True)
        # The endpoint file of an earlier browser would point at a dead port.
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(profile, "DevToolsActivePort"))
        command: Sequence[str] = host_arguments(await self._executable(), profile)
        process = await self._spawn(command, env=child_environment())
        self._process, self._profile = process, profile
        self._drains = [asyncio.create_task(drain_tail(process.stdout)), asyncio.create_task(drain_tail(process.stderr))]
        try:
            self._endpoint = await wait_for_devtools_port(Path(profile), process, None, self._ready_timeout)
        except BaseException:
            await self._stop()
            raise

    async def _stop(self) -> None:
        process, self._process, self._endpoint, self._profile = self._process, None, None, None
        if process is None:
            return
        try:
            # SIGTERM lets Chromium flush cookies and release the profile; the group kill below reaps anything left.
            if os.name != "nt" and process.process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(process.pid, signals.SIGTERM)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), self._exit_grace)
            await process.close()
        finally:
            drains, self._drains = self._drains, []
            await asyncio.gather(*drains, return_exceptions=True)
