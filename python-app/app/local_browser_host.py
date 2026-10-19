"""One Chromium on Jarvis's browser profile, shared by every concurrent run that browses on this computer.

Chromium allows one browser per profile folder, and copying the profile per run would fork the user's logins, so the
runner owns a single host: the first web-using run launches a headless Chromium, the last one to finish closes it. Each
run's worker connects over CDP, opens its own pages in the default (persistent) context and closes only those pages.

The Settings sign-in window (desktop/browser-profile.mjs) is the only other browser on this profile, and the two take
turns instead of refusing each other:
- The sign-in window listens on a DevTools port too, so while it is open the host attaches to it instead of launching.
- When the user asks to sign in while the headless browser runs, the desktop app drops a HANDOVER_REQUEST file into the
  profile. The host holds new model steps, lets running ones finish, closes the headless browser and attaches to the
  sign-in window once it appears. A run that is waiting for the user (to sign in, say) has no step running, so the
  window opens at once.
- When the sign-in browser quits while runs still need the web, the host launches the headless browser again.
- When no browser can open (a sign-in browser started without a DevTools port holds the profile, say), runs still get
  their lease: the host writes the reason to BLOCKED_FILE, which workers report instead of browsing, and keeps trying
  until the last run ends, so the run recovers once the user quits that browser.
Workers never keep an endpoint: they read DevToolsActivePort, which whichever browser holds the profile writes, and
reconnect after a switch.

The headless command line keeps `--headless` and `--user-data-dir=<profile>` literally: the desktop app
(browser-profile.mjs headlessHolder) looks for them to know it has to ask for the profile."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal as signals
import sys
import time
import urllib.request
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from pathlib import Path

from .browser import wait_for_devtools_port
from .errors import RunnerCoreError
from .processes import OwnedProcess, await_active, child_environment, drain_tail

logger = logging.getLogger(__name__)

PROFILE_IN_USE = "Quit the Jarvis sign-in browser, then try again."
# Closing the last window of a Chromium on macOS leaves it running, still holding the profile.
PROFILE_IN_USE_MACOS = "Quit the Jarvis sign-in browser with ⌘Q (closing its window isn't enough), then try again."
SIGN_IN_AGAIN = (
    "Jarvis now protects website logins with the macOS Keychain, so logins saved before this update can't be read: "
    "sign in to your sites again in Settings → Connections → Sign in to websites."
)
# File names inside the profile; the first two must match desktop/browser-profile.mjs.
HANDOVER_REQUEST = "JarvisSignInRequest"
KEYCHAIN_MARKER = "JarvisKeychain"
PORT_FILE = "DevToolsActivePort"
# Why the host has no browser right now; workers raise its text. Removed once a browser is in use again.
BLOCKED_FILE = "JarvisBrowserBlocked"
# The desktop app gives up after 90 s, so an older request was left by an app that quit while waiting.
REQUEST_MAX_AGE = 120
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


def host_arguments(executable: str, profile: str, platform: str = sys.platform) -> list[str]:
    # No --use-mock-keychain: on macOS Chromium encrypts cookies with its "Chromium Safe Storage" Keychain item, the
    # same one the sign-in window uses, so each browser reads the other's cookies. Linux keeps the basic store (as the
    # sign-in window does): the runner may not see the desktop session's keyring, and both browsers must agree.
    store = ["--password-store=basic"] if platform.startswith("linux") else []
    return [executable, "--headless", f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", *store, "--hide-scrollbars",
            "--mute-audio", f"--window-size={WINDOW}", "about:blank"]


def adopt_keychain(profile: str, platform: str = sys.platform) -> bool:
    """Marks the profile as encrypted with the macOS Keychain's key. True only the first time, for a profile that already
    has cookies: Jarvis used to run both browsers with Chromium's mock keychain, and those cookies can't be decrypted
    with the real key, so the user has to sign in again."""
    if platform != "darwin":
        return False
    marker = os.path.join(profile, KEYCHAIN_MARKER)
    if os.path.exists(marker):
        return False
    had_cookies = os.path.exists(os.path.join(profile, "Default", "Cookies"))
    os.makedirs(profile, exist_ok=True)
    Path(marker).write_text("keychain\n")
    return had_cookies


def handover_requested(profile: str) -> bool:
    request = os.path.join(profile, HANDOVER_REQUEST)
    try:
        age = time.time() - os.stat(request).st_mtime
    except FileNotFoundError:
        return False
    if age <= REQUEST_MAX_AGE:
        return True
    with contextlib.suppress(FileNotFoundError):
        os.remove(request)
    return False


def blocked_reason(error: Exception) -> str:
    """What a worker tells the model when the host has no browser: the error and, for a RunnerCoreError, its hint."""
    hint = getattr(error, "hint", None)
    text = str(error) or type(error).__name__
    return f"{text} {hint}" if hint else text


# Loopback only: a proxy from the environment must not see or answer DevTools requests.
_LOOPBACK = urllib.request.build_opener(urllib.request.ProxyHandler({}))


async def live_endpoint(profile: str, timeout: float = 2) -> str | None:
    """The DevTools endpoint of the browser holding the profile, or None. Chromium leaves DevToolsActivePort behind when
    it exits, so the port must answer with the browser id the file names."""
    try:
        port_line, browser_path = Path(profile, PORT_FILE).read_text().splitlines()[:2]
        port = int(port_line)
    except (OSError, ValueError):
        return None
    if not (0 < port < 65536 and browser_path.startswith("/devtools/browser/")):
        return None
    endpoint = f"http://127.0.0.1:{port}"

    def version() -> object:
        with _LOOPBACK.open(f"{endpoint}/json/version", timeout=timeout) as response:
            return json.loads(response.read())

    try:
        info = await asyncio.to_thread(version)
    except (OSError, ValueError):
        return None
    url = info.get("webSocketDebuggerUrl") if isinstance(info, dict) else None
    return endpoint if isinstance(url, str) and url.endswith(browser_path) else None


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

    def __init__(self, host: LocalBrowserHost, profile: str, notice: str | None, blocked: str | None) -> None:
        # The worker reads the current endpoint from here, before connecting and after every browser switch.
        self.endpoint_file = os.path.join(profile, PORT_FILE)
        # While no browser can open, the reason, for the worker to report; the host keeps trying meanwhile.
        self.blocked_file = os.path.join(profile, BLOCKED_FILE)
        self.blocked = blocked
        # SIGN_IN_AGAIN for the run that found logins saved under the old mock keychain.
        self.notice = notice
        self._host: LocalBrowserHost | None = host

    @contextlib.asynccontextmanager
    async def step(self, signal: asyncio.Event | None = None) -> AsyncIterator[None]:
        """Hold around each model step: a switch of browsers waits for running steps and holds new ones (the wait
        honours Stop). Every step counts, since model code may keep a page from an earlier step."""
        host = self._host
        if host is None:
            yield
            return
        async with host._step(signal):
            yield

    async def close(self) -> None:
        host, self._host = self._host, None
        if host is not None:
            await host._release()


class LocalBrowserHost:
    def __init__(self, *, executable: Callable[[], Awaitable[str]] = playwright_chromium,
                 spawn: Callable[..., Awaitable[OwnedProcess]] = OwnedProcess.spawn,
                 ready_timeout: float = 15, exit_grace: float = 5, attach_timeout: float = 3, poll_interval: float = 0.5,
                 retry_interval: float = 5, drain_timeout: float = 90, window_timeout: float = 20,
                 platform: str = sys.platform) -> None:
        self._executable = executable
        self._spawn = spawn
        self._ready_timeout = ready_timeout
        self._exit_grace = exit_grace
        self._attach_timeout = attach_timeout
        self._poll_interval = poll_interval
        # Between attempts that failed for another reason than a sign-in browser holding the profile (no Chromium, ...).
        self._retry_interval = retry_interval
        self._retry_at = 0.0
        self._blocked: str | None = None  # the reason no browser could open, while none is in use
        # A model step ends within its 60 s deadline plus the interrupt grace.
        self._drain_timeout = drain_timeout
        # How long a hand-over waits for the desktop app to open the sign-in window before relaunching headless.
        self._window_timeout = window_timeout
        self._platform = platform
        self._lock = asyncio.Lock()
        self._users = 0
        self._profile: str | None = None  # set while leased
        self._process: OwnedProcess | None = None  # the headless browser this host launched
        self._drains: list[asyncio.Task[bytes]] = []
        self._endpoint: str | None = None  # the browser in use: ours, or the sign-in window we attached to
        self._watcher: asyncio.Task[None] | None = None
        self._steps = 0
        self._open = asyncio.Event()  # cleared while switching browsers; steps wait for it
        self._open.set()
        self._quiet = asyncio.Event()  # set while no step runs
        self._quiet.set()

    @property
    def users(self) -> int:
        return self._users

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.process.returncode is None

    @property
    def attached(self) -> bool:
        """True while runs use the sign-in window rather than a headless browser of ours."""
        return self._process is None and self._endpoint is not None

    @property
    def endpoint(self) -> str | None:
        return self._endpoint

    async def lease(self, profile: str) -> BrowserLease:
        """Open the profile's browser on first use (or after it crashed) and count this run as a user. A browser that
        can't open doesn't refuse the run: the lease carries the reason, and the host keeps trying while it is held."""
        async with self._lock:
            if self._profile is not None and profile != self._profile:
                raise RunnerCoreError("The background browser is already open on another profile.", code="browser_profile_in_use",
                                      status_code=409, hint="Restart the runner after changing JARVIS_BROWSER_PROFILE.")
            os.makedirs(profile, exist_ok=True)
            notice = SIGN_IN_AGAIN if adopt_keychain(profile, self._platform) else None
            if self._endpoint is None or (self._process is not None and not self.running):
                await self._stop()  # Crashed: reap it and start a fresh one for this and the remaining runs.
                with contextlib.suppress(Exception):  # kept as the blocker; the watcher tries again
                    await self._acquire(profile)
            self._profile = profile
            self._users += 1
            if self._watcher is None:
                self._watcher = asyncio.create_task(self._watch())
            return BrowserLease(self, profile, notice, self._blocked)

    async def _release(self) -> None:
        async with self._lock:
            self._users = max(0, self._users - 1)
            if self._users == 0:
                await self._shut()

    async def close(self) -> None:
        """Runner shutdown: close the host even if a lease was never returned."""
        watcher = self._watcher
        if watcher is not None:
            watcher.cancel()  # first, so a hand-over waiting on a step doesn't hold up shutdown
        async with self._lock:
            self._users = 0
            await self._shut()

    async def _shut(self) -> None:
        watcher, self._watcher = self._watcher, None
        if watcher is not None:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        await self._stop()
        if self._profile is not None:
            self._set_blocked(self._profile, None)
        self._profile = None
        self._open.set()

    @contextlib.asynccontextmanager
    async def _step(self, signal: asyncio.Event | None) -> AsyncIterator[None]:
        while not self._open.is_set():
            await await_active(self._open.wait(), signal)
        self._steps += 1
        self._quiet.clear()
        try:
            yield
        finally:
            self._steps -= 1
            if self._steps == 0:
                self._quiet.set()

    async def _acquire(self, profile: str) -> None:
        """Attach to the open sign-in window, else launch the headless browser. A failure stays the blocker that workers
        report until an attempt succeeds."""
        os.makedirs(profile, exist_ok=True)
        try:
            if profile_in_use(profile):
                self._endpoint = await self._wait_for_window(profile, self._attach_timeout)
                if self._endpoint is None:
                    raise self._held_error()
            else:
                await self._launch(profile)
        except Exception as error:
            self._retry_at = time.monotonic() + self._retry_interval
            self._set_blocked(profile, blocked_reason(error))
            raise
        self._set_blocked(profile, None)

    def _held_error(self) -> RunnerCoreError:
        """The profile is held by a sign-in browser without a DevTools port, which tasks can't share."""
        return RunnerCoreError(PROFILE_IN_USE_MACOS if self._platform == "darwin" else PROFILE_IN_USE,
                               code="browser_profile_in_use", status_code=409,
                               hint="It was started without a DevTools port (by an older Jarvis, or reopened by hand), so tasks can't share it.")

    def _set_blocked(self, profile: str, reason: str | None) -> None:
        path = os.path.join(profile, BLOCKED_FILE)
        if reason is None:
            self._blocked = None
            with contextlib.suppress(FileNotFoundError):
                os.remove(path)  # also one left by a runner that didn't shut down
            return
        if reason != self._blocked:
            self._blocked = reason
            # Replaced in one step: a worker never reads half a reason.
            temporary = f"{path}.tmp"
            Path(temporary).write_text(reason + "\n")
            os.replace(temporary, path)

    async def _wait_for_window(self, profile: str, timeout: float) -> str | None:
        deadline = time.monotonic() + timeout
        while True:
            if profile_in_use(profile):
                endpoint = await live_endpoint(profile)
                if endpoint is not None:
                    return endpoint
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(0.1)

    async def _launch(self, profile: str) -> None:
        # The endpoint file of an earlier browser would point at a dead port.
        with contextlib.suppress(FileNotFoundError):
            os.remove(os.path.join(profile, PORT_FILE))
        command: Sequence[str] = host_arguments(await self._executable(), profile, self._platform)
        process = await self._spawn(command, env=child_environment())
        self._process = process
        self._drains = [asyncio.create_task(drain_tail(process.stdout)), asyncio.create_task(drain_tail(process.stderr))]
        try:
            self._endpoint = await wait_for_devtools_port(Path(profile), process, None, self._ready_timeout)
        except BaseException:
            await self._stop()
            raise

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(self._poll_interval)
            async with self._lock:
                if self._profile is None:
                    return
                try:
                    await self._check(self._profile)
                except Exception as error:  # noqa: BLE001 - retried next tick; workers meanwhile report Chromium's error
                    logger.warning("Background browser switch failed: %s", error)

    async def _check(self, profile: str) -> None:
        if self.running:
            if handover_requested(profile):
                await self._hand_over(profile)
            return
        if self.attached and profile_in_use(profile):
            return  # the sign-in window is still open
        if self._process is None and self._endpoint is None:
            # No browser yet: the last attempt failed (self._blocked says why).
            if profile_in_use(profile) and await live_endpoint(profile) is None:
                self._set_blocked(profile, blocked_reason(self._held_error()))
                self._retry_at = 0  # try the moment the user quits it
                return
            if time.monotonic() < self._retry_at:
                return
            # Workers wait for this attempt instead of reporting a blocker that may be gone.
            self._set_blocked(profile, None)
            await self._acquire(profile)
            return
        # The browser in use is gone (Chromium crashed, or the user quit the sign-in browser).
        self._open.clear()
        try:
            await self._stop()
            await self._acquire(profile)
        finally:
            self._open.set()

    async def _hand_over(self, profile: str) -> None:
        """Give the profile to the sign-in window the desktop app is about to open, and attach to it."""
        request = os.path.join(profile, HANDOVER_REQUEST)
        self._open.clear()
        try:
            try:
                await asyncio.wait_for(self._quiet.wait(), self._drain_timeout)
            except asyncio.TimeoutError:
                with contextlib.suppress(FileNotFoundError):
                    os.remove(request)  # The desktop app gives up too and tells the user to try again.
                return
            # SIGTERM lets Chromium flush the cookies the sign-in window will read.
            await self._stop()
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(profile, PORT_FILE))
            with contextlib.suppress(FileNotFoundError):
                os.remove(request)
            self._endpoint = await self._wait_for_window(profile, self._window_timeout)
            if self._endpoint is None:
                await self._acquire(profile)  # The window never opened: browse headless again.
        finally:
            self._open.set()

    async def _stop(self) -> None:
        """Close our headless browser, or just forget the sign-in window: that one belongs to the user."""
        process, self._process, self._endpoint = self._process, None, None
        if process is None:
            return
        try:
            # SIGTERM lets Chromium flush cookies and release the profile; the group kill below reaps anything left.
            if os.name != "nt" and process.process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(process.pid, signals.SIGTERM)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(process.wait(), self._exit_grace)
        finally:
            # Also on cancellation (runner shutdown during a hand-over): the process is no longer tracked anywhere.
            try:
                await process.close()
            finally:
                drains, self._drains = self._drains, []
                await asyncio.gather(*drains, return_exceptions=True)
