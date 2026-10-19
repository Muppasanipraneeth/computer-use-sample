import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.desktop.app_session import DesktopAppSession
from app.errors import RunnerCoreError
from app.responses_loop import execute_python_tool_call
from app.screen import RunScreen, ScreenLock, uses_screen


@pytest.mark.parametrize("code", [
    "pyautogui.click(10, 10)",
    "import subprocess\nsubprocess.run(['osascript', '-e', 'beep'])",
    "import os\nos.system('open -a Safari')",
    "display(pyautogui.screenshot())",
    "from PIL import ImageGrab\ndisplay(ImageGrab.grab())",
    "pg.click(1, 1)",  # an alias bound by an earlier step
    "globals()['pyautogui'].press('a')",
    "().__class__.__base__.__subclasses__()",
    "import sys",
])
def test_code_that_may_touch_the_screen_takes_the_lock(code):
    assert uses_screen(code)


@pytest.mark.parametrize("code", [
    "text = read('https://example.com')\nlog(text[:200])",
    "web.goto('https://example.com')\ndisplay(web.screenshot())",
    "import json, re\nprint(json.dumps({'a': len(re.findall('x', 'xx'))}))",
    "for item in apps.gmail.search('from:me'):\n    log(item)",
    "def total(values):\n    return sum(value * 2 for value in values)\nlog(total([1, 2]))",
    "def broken(:",  # a syntax error runs nothing
])
def test_background_and_plain_python_code_runs_without_the_lock(code):
    assert not uses_screen(code)


def test_names_from_screen_free_steps_stay_lock_free_and_screen_steps_taint_theirs():
    screen = RunScreen(ScreenLock())
    screen.step("page = read('https://example.com')")
    assert not uses_screen("log(page[:10])", screen.safe_names)
    screen.step("pg = pyautogui\npage = pg.screenshot()")
    assert uses_screen("log(page)", screen.safe_names)


class FakeWorker:
    """Records when each step runs; a step finishes when its gate opens."""

    def __init__(self, timeline: list, name: str, gate: asyncio.Event) -> None:
        self.timeline, self.name, self.gate = timeline, name, gate

    async def execute(self, code, signal=None):
        self.timeline.append(f"{self.name} start")
        await self.gate.wait()
        self.timeline.append(f"{self.name} end")
        return {"output": [{"type": "input_text", "text": "ok"}]}


def run(lock: ScreenLock, timeline: list, name: str, gate: asyncio.Event):
    signal = asyncio.Event()
    events: list[dict] = []

    async def emit(event):
        events.append(event)

    screen = RunScreen(lock, signal, on_wait=lambda: emit({"message": "Waiting for the screen…"}))
    context = SimpleNamespace(signal=signal, emit_event=emit, capture_screenshot=AsyncMock(), sync_browser_state=AsyncMock())
    session = SimpleNamespace(execution=FakeWorker(timeline, name, gate), screen=screen, web_instruments=False)
    return SimpleNamespace(context=context, session=session, events=events, signal=signal)


def call(code: str) -> dict:
    return {"arguments": "{}", "code": code, "call_id": "1"}


def waits(state) -> int:
    return sum(event["message"] == "Waiting for the screen…" for event in state.events)


async def until(condition) -> None:
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.002)
    raise AssertionError("condition never held")


async def test_screen_steps_from_two_runs_never_overlap():
    lock, timeline = ScreenLock(), []
    gate_a, gate_b = asyncio.Event(), asyncio.Event()
    a, b = run(lock, timeline, "a", gate_a), run(lock, timeline, "b", gate_b)
    first = asyncio.create_task(execute_python_tool_call(a.context, a.session, call("pyautogui.click(1, 1)"), preview=False))
    await until(lambda: timeline == ["a start"])
    second = asyncio.create_task(execute_python_tool_call(b.context, b.session, call("pyautogui.press('a')"), preview=False))
    await until(lambda: waits(b) == 1)
    assert timeline == ["a start"]  # b waits for the screen instead of starting
    gate_b.set()
    gate_a.set()
    await asyncio.gather(first, second)
    assert timeline == ["a start", "a end", "b start", "b end"]
    assert waits(a) == 0


async def test_a_read_only_step_runs_while_another_run_holds_the_screen():
    lock, timeline = ScreenLock(), []
    gate_a, gate_b = asyncio.Event(), asyncio.Event()
    a, b = run(lock, timeline, "a", gate_a), run(lock, timeline, "b", gate_b)
    first = asyncio.create_task(execute_python_tool_call(a.context, a.session, call("pyautogui.click(1, 1)"), preview=False))
    await until(lambda: timeline == ["a start"])
    gate_b.set()
    await execute_python_tool_call(b.context, b.session, call("log(read('https://example.com'))"), preview=False)
    assert timeline == ["a start", "b start", "b end"]
    assert waits(b) == 0
    gate_a.set()
    await first


async def test_stop_while_waiting_for_the_screen_ends_the_wait_without_running_the_step():
    lock, timeline = ScreenLock(), []
    gate_a = asyncio.Event()
    a, b = run(lock, timeline, "a", gate_a), run(lock, timeline, "b", asyncio.Event())
    first = asyncio.create_task(execute_python_tool_call(a.context, a.session, call("pyautogui.click(1, 1)"), preview=False))
    await until(lambda: timeline == ["a start"])
    second = asyncio.create_task(execute_python_tool_call(b.context, b.session, call("pyautogui.click(2, 2)"), preview=False))
    await until(lambda: waits(b) == 1)
    b.signal.set()
    with pytest.raises(asyncio.CancelledError):
        await second
    gate_a.set()
    await first
    assert timeline == ["a start", "a end"]
    # The abandoned wait left the lock usable.
    async with RunScreen(lock).hold():
        pass


async def test_a_runs_own_input_release_inside_its_step_reenters_and_others_wait():
    lock = ScreenLock()
    mine, other = RunScreen(lock), RunScreen(lock)
    async with mine.hold():
        async with mine.hold_for_cleanup():
            pass
        waiting = asyncio.create_task(other.hold_for_cleanup().__aenter__())
        await asyncio.sleep(0.01)
        assert not waiting.done()
    await waiting
    assert lock._owner is other


async def test_desktop_capture_takes_the_screen():
    lock = ScreenLock()
    holder = RunScreen(lock)
    worker = SimpleNamespace(platform="darwin", execute=AsyncMock(return_value={"output": []}))
    session = DesktopAppSession(worker, screenshot_dir=None)
    session.screen = RunScreen(lock)
    async with holder.hold():
        capture = asyncio.create_task(session.capture_screenshot("look"))
        await asyncio.sleep(0.01)
        worker.execute.assert_not_awaited()
    with pytest.raises(RunnerCoreError):  # the fake returns no image; the capture ran only after the hold ended
        await capture
    worker.execute.assert_awaited_once()


async def test_a_disabled_screen_refuses_steps_but_not_input_release():
    lock = ScreenLock()
    lock.disable("Desktop input cleanup failed in another task, so the screen can't be used.")
    with pytest.raises(RunnerCoreError) as caught:
        async with RunScreen(lock).hold():
            pass
    assert caught.value.code == "desktop_cleanup_failed"
    async with RunScreen(lock).hold_for_cleanup():
        pass
