import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.desktop import web_instruments
from app.errors import RunnerCoreError
from app.local_browser_host import (
    BLOCKED_FILE,
    HANDOVER_REQUEST,
    PORT_FILE,
    PROFILE_IN_USE_MACOS,
    SIGN_IN_AGAIN,
    LocalBrowserHost,
    adopt_keychain,
    handover_requested,
    host_arguments,
)
from app.processes import OwnedProcess

# Stands in for the headless Chromium: writes the DevTools endpoint file into --user-data-dir, then waits to be terminated.
FAKE_CHROMIUM = """
import sys, time
profile = next(arg.split("=", 1)[1] for arg in sys.argv[1:] if arg.startswith("--user-data-dir="))
with open(profile + "/DevToolsActivePort", "w") as handle:
    handle.write("9222\\n/devtools/browser/fake\\n")
time.sleep(60)
"""

# Stands in for the visible sign-in window: holds the profile lock and answers /json/version on its DevTools port.
FAKE_WINDOW = """
import http.server, json, os, sys
profile = sys.argv[1]
class Version(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/devtools/browser/window"}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(("127.0.0.1", 0), Version)
port = server.server_address[1]
lock = os.path.join(profile, "SingletonLock")
if os.path.lexists(lock):
    os.remove(lock)
os.symlink(f"host-{os.getpid()}", lock)
with open(os.path.join(profile, "DevToolsActivePort"), "w") as handle:
    handle.write(f"{port}\\n/devtools/browser/window\\n")
server.serve_forever()
"""

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="Chromium locks profiles with a SingletonLock symlink on macOS and Linux")


@pytest.fixture
def host():
    commands: list[list[str]] = []
    processes: list[OwnedProcess] = []

    async def executable() -> str:
        return "/fake/Chromium"

    async def spawn(command, *, env=None):
        commands.append(list(command))
        process = await OwnedProcess.spawn([sys.executable, "-c", FAKE_CHROMIUM, *command[1:]], env=env)
        processes.append(process)
        return process

    host = LocalBrowserHost(executable=executable, spawn=spawn, exit_grace=2, attach_timeout=0.3, poll_interval=0.02,
                            window_timeout=0.5, platform="darwin")
    host.commands, host.processes = commands, processes
    yield host


@pytest.fixture
async def window():
    """open(profile) starts a fake sign-in window and waits until its DevTools port is up."""
    started: list[asyncio.subprocess.Process] = []

    async def open_window(profile: str) -> asyncio.subprocess.Process:
        process = await asyncio.create_subprocess_exec(sys.executable, "-c", FAKE_WINDOW, profile)
        started.append(process)
        port_file = Path(profile, PORT_FILE)
        await until(lambda: port_file.exists() and "/devtools/browser/window" in port_file.read_text())
        return process

    yield open_window
    for process in started:
        if process.returncode is None:
            process.kill()
        await process.wait()


async def until(predicate, timeout: float = 5) -> None:
    for _ in range(int(timeout / 0.02)):
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not reached")


def test_both_browsers_use_the_real_keychain_with_platform_specific_flags():
    for platform in ("darwin", "win32", "linux"):
        command = host_arguments("/c", "/p", platform)
        assert "--use-mock-keychain" not in command
        assert ("--password-store=basic" in command) == (platform == "linux")
        # desktop/browser-profile.mjs headlessHolder recognises the host by these two literal arguments.
        assert "--headless" in command and "--user-data-dir=/p" in command


def test_mock_keychain_cookies_need_a_fresh_sign_in_once_on_macos(tmp_path):
    used = tmp_path / "used"
    (used / "Default").mkdir(parents=True)
    (used / "Default" / "Cookies").write_bytes(b"")
    assert adopt_keychain(str(used), "darwin") is True
    assert adopt_keychain(str(used), "darwin") is False
    assert adopt_keychain(str(tmp_path / "fresh"), "darwin") is False
    linux = tmp_path / "linux"
    (linux / "Default").mkdir(parents=True)
    (linux / "Default" / "Cookies").write_bytes(b"")
    assert adopt_keychain(str(linux), "linux") is False


def test_a_stale_handover_request_is_dropped(tmp_path):
    request = tmp_path / HANDOVER_REQUEST
    request.write_text("x")
    assert handover_requested(str(tmp_path))
    os.utime(request, (0, 0))
    assert not handover_requested(str(tmp_path)) and not request.exists()


async def test_one_host_is_shared_and_closed_after_the_last_run(host, tmp_path):
    profile = str(tmp_path / "profile")
    first, second = await asyncio.gather(host.lease(profile), host.lease(profile))
    assert len(host.commands) == 1 and host.users == 2
    assert first.endpoint_file == second.endpoint_file == os.path.join(profile, PORT_FILE)
    assert host.endpoint == "http://127.0.0.1:9222"
    await first.close()
    await first.close()  # idempotent: one run releases once
    assert host.running and host.users == 1
    await second.close()
    assert not host.running and host.users == 0
    assert host.processes[0].process.returncode is not None
    third = await host.lease(profile)
    assert len(host.commands) == 2 and host.running
    await third.close()


async def test_the_first_lease_on_a_mock_keychain_profile_carries_the_notice(host, tmp_path):
    profile = tmp_path / "profile"
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Cookies").write_bytes(b"")
    first = await host.lease(str(profile))
    second = await host.lease(str(profile))
    assert first.notice == SIGN_IN_AGAIN and second.notice is None
    await host.close()


async def test_a_crashed_host_is_relaunched_while_runs_still_need_it(host, tmp_path):
    profile = str(tmp_path / "profile")
    lease = await host.lease(profile)
    host.processes[0].process.kill()
    await host.processes[0].wait()
    await until(lambda: len(host.commands) == 2 and host.running)
    await lease.close()
    assert not host.running


async def test_close_shuts_the_host_down_for_runner_shutdown(host, tmp_path):
    await host.lease(str(tmp_path / "profile"))
    await host.close()
    assert not host.running and host.users == 0


@posix_only
async def test_an_open_sign_in_window_is_shared_instead_of_refused(host, tmp_path, window):
    profile = tmp_path / "profile"
    profile.mkdir()
    visible = await window(str(profile))
    lease = await host.lease(str(profile))
    assert host.commands == [] and host.attached and host.endpoint.startswith("http://127.0.0.1:")
    await lease.close()
    assert visible.returncode is None  # the user's window is left alone


@posix_only
async def test_quitting_the_sign_in_window_brings_the_headless_browser_back(host, tmp_path, window):
    profile = tmp_path / "profile"
    profile.mkdir()
    visible = await window(str(profile))
    lease = await host.lease(str(profile))
    visible.kill()
    await visible.wait()
    await until(lambda: host.running)
    assert len(host.commands) == 1 and not host.attached
    await lease.close()


@posix_only
async def test_a_run_blocked_at_start_browses_once_the_user_quits_the_sign_in_browser(host, tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    profile.mkdir()
    # A sign-in Chromium started without a DevTools port holds the profile; an older browser's port file is left behind.
    os.symlink(f"host-{os.getpid()}", profile / "SingletonLock")
    (profile / PORT_FILE).write_text("1\n/devtools/browser/stale\n")
    lease = await host.lease(str(profile))
    assert lease.blocked is not None and lease.blocked.startswith(PROFILE_IN_USE_MACOS)
    assert host.commands == [] and host.users == 1

    # The run's worker, as scenario_runtime starts it.
    monkeypatch.delenv("JARVIS_BROWSER_GATEWAY", raising=False)
    monkeypatch.delenv("JARVIS_BROWSER_UNAVAILABLE", raising=False)
    monkeypatch.setenv("JARVIS_BROWSER_CDP_FILE", lease.endpoint_file)
    monkeypatch.setenv("JARVIS_BROWSER_BLOCKED_FILE", lease.blocked_file)
    monkeypatch.setattr(web_instruments, "BLOCKED_WAIT_S", 0.2)
    monkeypatch.setattr(web_instruments.BackgroundBrowser, "_background_tab", lambda self, context: MagicMock())
    chromium = MagicMock()

    def connect(endpoint, timeout):
        if endpoint.endswith("/stale"):
            raise RuntimeError("connect ECONNREFUSED")
        return MagicMock()

    chromium.connect_over_cdp.side_effect = connect
    playwright = SimpleNamespace(chromium=chromium, stop=MagicMock())
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: SimpleNamespace(start=lambda: playwright))
    web = web_instruments.BackgroundBrowser()

    with pytest.raises(RuntimeError, match="⌘Q"):
        await asyncio.to_thread(lambda: web.page)
    assert host.commands == []

    os.remove(profile / "SingletonLock")  # the user quit it
    page = await asyncio.to_thread(lambda: web.page)
    assert page is not None and host.running and len(host.commands) == 1
    chromium.connect_over_cdp.assert_called_with("ws://127.0.0.1:9222/devtools/browser/fake", timeout=5_000)
    assert not os.path.exists(lease.blocked_file)

    await asyncio.to_thread(web.close)
    await lease.close()
    assert host.users == 0 and not host.running


async def test_a_launch_failure_is_reported_and_retried_while_the_run_lasts(tmp_path):
    installed = False

    async def executable() -> str:
        if not installed:
            raise RunnerCoreError("Chromium for the background browser is not installed.", hint="Install it.")
        return "/fake/Chromium"

    async def spawn(command, *, env=None):
        return await OwnedProcess.spawn([sys.executable, "-c", FAKE_CHROMIUM, *command[1:]], env=env)

    host = LocalBrowserHost(executable=executable, spawn=spawn, exit_grace=2, poll_interval=0.02, retry_interval=0.2)
    profile = tmp_path / "profile"
    lease = await host.lease(str(profile))
    assert lease.blocked == "Chromium for the background browser is not installed. Install it."
    assert (profile / BLOCKED_FILE).read_text().strip() == lease.blocked
    installed = True
    await until(lambda: host.running)
    assert not (profile / BLOCKED_FILE).exists()
    await lease.close()
    assert host.users == 0 and not host.running


@posix_only
async def test_the_blocker_is_cleared_when_the_last_run_ends(host, tmp_path):
    profile = tmp_path / "profile"
    profile.mkdir()
    os.symlink(f"host-{os.getpid()}", profile / "SingletonLock")
    lease = await host.lease(str(profile))
    assert (profile / BLOCKED_FILE).exists()
    await lease.close()
    assert host.users == 0 and not (profile / BLOCKED_FILE).exists()
    assert os.path.islink(profile / "SingletonLock")  # the user's browser and its lock are left alone


@posix_only
async def test_stale_lock_from_a_crashed_browser_does_not_block(host, tmp_path):
    finished = await asyncio.create_subprocess_exec(sys.executable, "-c", "pass")
    await finished.wait()
    (tmp_path / "profile").mkdir()
    os.symlink(f"host-{finished.pid}", tmp_path / "profile" / "SingletonLock")
    lease = await host.lease(str(tmp_path / "profile"))
    assert len(host.commands) == 1
    await lease.close()


@posix_only
async def test_sign_in_waits_for_the_running_step_then_the_runs_move_to_the_window(host, tmp_path, window):
    profile = tmp_path / "profile"
    lease = await host.lease(str(profile))
    running = lease.step()
    await running.__aenter__()
    (profile / HANDOVER_REQUEST).write_text("now")
    await asyncio.sleep(0.2)
    assert host.running  # never pulled from under a step
    next_step = asyncio.create_task(lease.step().__aenter__())
    await asyncio.sleep(0.1)
    assert not next_step.done()  # held until the switch is over
    await running.__aexit__(None, None, None)
    await until(lambda: not host.running)
    assert not (profile / HANDOVER_REQUEST).exists()  # consumed: the desktop app may open its window
    await window(str(profile))
    await until(lambda: host.attached)
    await asyncio.wait_for(next_step, 2)
    assert len(host.commands) == 1
    await lease.close()


async def test_a_handover_nobody_opens_a_window_for_returns_to_headless(host, tmp_path):
    profile = tmp_path / "profile"
    lease = await host.lease(str(profile))
    (profile / HANDOVER_REQUEST).write_text("now")
    await until(lambda: not host.running)
    stop = asyncio.Event()
    stop.set()
    with pytest.raises(asyncio.CancelledError):
        async with lease.step(stop):  # Stop is honoured while the step waits for the switch
            pass
    async with lease.step():
        assert host.running and len(host.commands) == 2
    await lease.close()
