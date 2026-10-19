import asyncio
import os
import sys

import pytest

from app.errors import RunnerCoreError
from app.local_browser_host import PROFILE_IN_USE, LocalBrowserHost
from app.processes import OwnedProcess

# Stands in for Chromium: writes the DevTools endpoint file into --user-data-dir, then waits to be terminated.
FAKE_CHROMIUM = """
import sys, time
profile = next(arg.split("=", 1)[1] for arg in sys.argv[1:] if arg.startswith("--user-data-dir="))
with open(profile + "/DevToolsActivePort", "w") as handle:
    handle.write("9222\\n/devtools/browser/fake\\n")
time.sleep(60)
"""


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

    host = LocalBrowserHost(executable=executable, spawn=spawn, exit_grace=2)
    host.commands, host.processes = commands, processes
    return host


async def test_one_host_is_shared_and_closed_after_the_last_run(host, tmp_path):
    profile = str(tmp_path / "profile")
    first, second = await asyncio.gather(host.lease(profile), host.lease(profile))
    assert len(host.commands) == 1 and host.users == 2
    assert first.endpoint == second.endpoint == "http://127.0.0.1:9222"
    command = host.commands[0]
    # desktop/browser-profile.mjs headlessHolder recognises the host by these two literal arguments.
    assert "--headless" in command and f"--user-data-dir={profile}" in command
    await first.close()
    await first.close()  # idempotent: one run releases once
    assert host.running and host.users == 1
    await second.close()
    assert not host.running and host.users == 0
    assert host.processes[0].process.returncode is not None
    third = await host.lease(profile)
    assert len(host.commands) == 2 and host.running
    await third.close()


async def test_a_crashed_host_is_relaunched_for_the_next_run(host, tmp_path):
    profile = str(tmp_path / "profile")
    lease = await host.lease(profile)
    host.processes[0].process.kill()
    await host.processes[0].wait()
    again = await host.lease(profile)
    assert len(host.commands) == 2 and host.running
    await lease.close()
    await again.close()
    assert not host.running


async def test_close_shuts_the_host_down_for_runner_shutdown(host, tmp_path):
    await host.lease(str(tmp_path / "profile"))
    await host.close()
    assert not host.running and host.users == 0


@pytest.mark.skipif(sys.platform == "win32", reason="Chromium locks profiles with a SingletonLock symlink on macOS and Linux")
async def test_open_sign_in_window_blocks_the_host(host, tmp_path):
    (tmp_path / "profile").mkdir()
    os.symlink(f"host-{os.getpid()}", tmp_path / "profile" / "SingletonLock")
    with pytest.raises(RunnerCoreError, match=PROFILE_IN_USE):
        await host.lease(str(tmp_path / "profile"))
    assert host.commands == [] and host.users == 0


@pytest.mark.skipif(sys.platform == "win32", reason="Chromium locks profiles with a SingletonLock symlink on macOS and Linux")
async def test_stale_lock_from_a_crashed_browser_does_not_block(host, tmp_path):
    finished = await asyncio.create_subprocess_exec(sys.executable, "-c", "pass")
    await finished.wait()
    (tmp_path / "profile").mkdir()
    os.symlink(f"host-{finished.pid}", tmp_path / "profile" / "SingletonLock")
    lease = await host.lease(str(tmp_path / "profile"))
    assert len(host.commands) == 1
    await lease.close()
