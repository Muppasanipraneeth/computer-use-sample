import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.instruments import instrument_lines
from app.omp_client import (
    ANSWERED_BEFORE_ACTING_NOTE,
    DISPLAYED_IMAGE_NOTE,
    NO_IMAGE_NOTE,
    SCREEN_IMAGE_NOTE,
    STEERED_NOTE,
    omp_action_contract,
    only_looks_at_screen,
    parse_omp_action,
    run_omp_code_loop,
)

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 16).decode()


def harness(*replies, output=None, steers=None, attachments=None):
    async def capture(_session, label, observation=None):
        return {"path": "/shots/displayed.png" if observation else f"/shots/{label}.png"}

    turns = iter(steers or [])
    context = SimpleNamespace(
        signal=asyncio.Event(),
        detail={"run": {"prompt": "Play Runway.", "model": "omp:test/model", "attachments": attachments or []}},
        emit_event=AsyncMock(),
        sync_browser_state=AsyncMock(),
        capture_screenshot=AsyncMock(side_effect=capture),
        # One list of queued follow-ups per turn, then none.
        next_turn=AsyncMock(side_effect=lambda: next(turns, [])),
    )
    session = SimpleNamespace(
        desktop_app=True,
        execution=SimpleNamespace(
            platform="darwin",
            execute=AsyncMock(return_value={"output": output or [{"type": "input_text", "text": "ok"}]}),
        ),
    )
    calls: list[dict] = []

    async def complete(**kwargs):
        calls.append(kwargs)
        return replies[len(calls) - 1]

    return context, session, complete, calls


def code(source):
    return json.dumps({"action": "code", "code": source})


def final(text="Playing Runway."):
    return json.dumps({"action": "final", "text": text})


LOOK = json.dumps({"action": "look"})


def labels(context):
    return [entry.args[1] for entry in context.capture_screenshot.await_args_list]


async def test_code_then_final_never_captures_the_screen():
    context, session, complete, calls = harness(code("import subprocess\nsubprocess.run(['open', '-a', 'Spotify'])"), final())
    result = await run_omp_code_loop(context, session, "Instructions", None, "test/model", complete=complete)

    assert result["final_assistant_message"] == "Playing Runway."
    context.capture_screenshot.assert_not_awaited()
    assert [call["image_path"] for call in calls] == [None, None]
    assert all(NO_IMAGE_NOTE in call["prompt"] for call in calls)
    assert SCREEN_IMAGE_NOTE not in calls[0]["prompt"]


async def test_look_attaches_one_fresh_screenshot_to_the_next_turn_only():
    context, session, complete, calls = harness(LOOK, code("pyautogui.click(10, 20)"), final())
    await run_omp_code_loop(context, session, "Instructions", None, "test/model", complete=complete)

    assert labels(context) == ["omp-look-1"]
    assert calls[0]["image_path"] is None
    assert calls[1]["image_path"] == "/shots/omp-look-1.png"
    assert SCREEN_IMAGE_NOTE in calls[1]["prompt"]
    assert "You asked to see the screen." in calls[1]["prompt"]
    assert calls[2]["image_path"] is None
    assert NO_IMAGE_NOTE in calls[2]["prompt"]
    assert SCREEN_IMAGE_NOTE not in calls[2]["prompt"]
    assert "You looked at the screen." in calls[2]["prompt"]


async def test_displayed_image_attaches_once_without_a_preview_capture():
    acting = "pyautogui.click(10, 20)\ndisplay(web.screenshot())"
    context, session, complete, calls = harness(code(acting), code("pyautogui.press('space')"), final())
    session.execution.execute.side_effect = [
        {"output": [{"type": "input_text", "text": "clicked"}, {"type": "input_image", "image_url": f"data:image/png;base64,{PNG}"}]},
        {"output": [{"type": "input_text", "text": "pressed"}]},
    ]
    await run_omp_code_loop(context, session, "Instructions", None, "test/model", complete=complete)

    assert labels(context) == ["Code tool image"], "only the image the code displayed is saved"
    assert calls[1]["image_path"] == "/shots/displayed.png"
    assert DISPLAYED_IMAGE_NOTE in calls[1]["prompt"]
    assert "It displayed 1 image." in calls[1]["prompt"]
    assert calls[2]["image_path"] is None
    assert DISPLAYED_IMAGE_NOTE not in calls[2]["prompt"]


async def test_background_browsing_shows_its_page_in_live_but_not_to_the_model():
    lookup = "log(read('https://www.techmeme.com/'))"
    context, session, complete, calls = harness(code(lookup), code("import subprocess\nsubprocess.run(['open', '-a', 'Spotify'])"), final())
    session.web_instruments = True
    page = {"type": "input_image", "image_url": f"data:image/png;base64,{PNG}"}
    session.execution.execute.side_effect = [
        {"output": [{"type": "input_text", "text": "# Techmeme"}]},
        {"output": [page]},  # the runner's preview of the background page
        {"output": [{"type": "input_text", "text": "done"}]},  # no browser use: no preview
    ]
    await run_omp_code_loop(context, session, "Instructions", None, "test/model", complete=complete)

    assert labels(context) == ["Background browser"]
    assert "web.preview()" in session.execution.execute.await_args_list[1].args[0]
    assert session.execution.execute.await_count == 3
    assert [call["image_path"] for call in calls] == [None, None, None], "the preview is for the app, not the model"


async def test_screenshot_only_code_is_served_as_a_look():
    looking = "display(pyautogui.screenshot())"
    context, session, complete, calls = harness(code(looking), code("pyautogui.click(10, 20)"), final())
    await run_omp_code_loop(context, session, "Instructions", None, "test/model", complete=complete)

    session.execution.execute.assert_awaited_once()
    assert session.execution.execute.await_args.args[0] == "pyautogui.click(10, 20)"
    assert labels(context) == ["omp-look-1"]
    assert calls[1]["image_path"] == "/shots/omp-look-1.png"
    assert SCREEN_IMAGE_NOTE in calls[1]["prompt"]
    assert f"Code not run, because it only looks at the screen:\n{looking}" in calls[1]["prompt"]
    messages = [entry.args[0]["message"] for entry in context.emit_event.await_args_list]
    assert "Model asked to see the screen." in messages


async def test_a_look_does_not_count_as_acting():
    context, session, complete, calls = harness(LOOK, final("Done already."), code("pyautogui.press('space')"), final())
    result = await run_omp_code_loop(context, session, "Instructions", 5, "test/model", complete=complete)

    assert result["final_assistant_message"] == "Playing Runway."
    assert ANSWERED_BEFORE_ACTING_NOTE in calls[2]["prompt"]
    assert calls[2]["image_path"] is None


async def test_answer_before_acting_is_replayed_truthfully():
    context, session, complete, calls = harness(final("Done already."), code("pyautogui.press('space')"), final())
    result = await run_omp_code_loop(context, session, "Instructions", 5, "test/model", complete=complete)

    assert result["final_assistant_message"] == "Playing Runway."
    assert ANSWERED_BEFORE_ACTING_NOTE in calls[1]["prompt"]
    assert "not usable JSON" not in calls[1]["prompt"]
    assert "It displayed no images." in calls[2]["prompt"]
    assert calls[2]["image_path"] is None
    context.capture_screenshot.assert_not_awaited()


async def test_a_follow_up_reaches_the_next_turn_and_is_acknowledged_once():
    added = [{"mode": "add", "message": "Shuffle the playlist too.", "attachments": []}]
    context, session, complete, calls = harness(
        code("pyautogui.press('space')"), code("pyautogui.press('s')"), final(), steers=[[], added]
    )
    await run_omp_code_loop(context, session, "Instructions", 5, "test/model", complete=complete)

    assert "Shuffle" not in calls[0]["prompt"]
    assert calls[1]["prompt"].startswith("Task:\nPlay Runway.")
    assert "While you were working, the user added: Shuffle the playlist too." in calls[1]["prompt"]
    assert calls[1]["prompt"].endswith(STEERED_NOTE)
    assert "While you were working, the user added: Shuffle the playlist too." in calls[2]["prompt"]
    assert STEERED_NOTE not in calls[2]["prompt"]


async def test_a_redirect_says_the_newest_instruction_wins():
    changed = [{"mode": "redirect", "message": "Play Jazz instead.", "attachments": []}]
    context, session, complete, calls = harness(LOOK, code("pyautogui.press('space')"), final(), steers=[[], changed])
    await run_omp_code_loop(context, session, "Instructions", 5, "test/model", complete=complete)

    assert ("The user changed the request: Play Jazz instead.\n"
            "Follow this from now on; where it conflicts with the original task, this wins.") in calls[1]["prompt"]
    assert "You asked to see the screen." in calls[1]["prompt"], "a follow-up must not hide the model's latest move"
    assert calls[1]["image_path"] == "/shots/omp-look-1.png"


async def test_attached_image_and_folder_are_described_and_the_image_shown_first():
    attachments = [{"kind": "folder", "path": "/Users/me/Songs", "name": "Songs"},
                   {"kind": "image", "path": "/runs/r/attachments/1-cover.png", "name": "cover.png"}]
    context, session, complete, calls = harness(code("pyautogui.press('space')"), final(), attachments=attachments)
    await run_omp_code_loop(context, session, "Instructions", 5, "test/model", complete=complete)

    prompt = calls[0]["prompt"]
    assert "The user attached these:\n- folder Songs: /Users/me/Songs (read and write files there with Python)\n" in prompt
    assert "- image cover.png: /runs/r/attachments/1-cover.png" in prompt
    assert "display(PIL.Image.open(path))" in prompt
    assert calls[0]["image_path"] == "/runs/r/attachments/1-cover.png"
    assert prompt.endswith("The attached image is cover.png, which the user attached to the request.")
    assert NO_IMAGE_NOTE not in prompt
    assert calls[1]["image_path"] is None


async def test_an_image_sent_with_a_follow_up_is_shown_on_the_next_turn():
    image = {"kind": "image", "path": "/runs/r/attachments/0-map.png", "name": "map.png"}
    added = [{"mode": "add", "message": "Use this map.", "attachments": [image]}]
    context, session, complete, calls = harness(code("pyautogui.press('space')"), final(), steers=[[], added])
    await run_omp_code_loop(context, session, "Instructions", 5, "test/model", complete=complete)

    assert calls[1]["image_path"] == "/runs/r/attachments/0-map.png"
    assert "The attached image is map.png, which the user attached to their latest message." in calls[1]["prompt"]
    assert "- image map.png: /runs/r/attachments/0-map.png" in calls[1]["prompt"]


def test_look_is_a_parsed_action():
    assert parse_omp_action('{"action":"look"}') == {"action": "look"}
    assert parse_omp_action('{"action":"look"} {"action":"code","code":"pyautogui.click(1, 2)"}')["action"] == "code"


@pytest.mark.parametrize(
    "source",
    [
        "display(pyautogui.screenshot())",
        "import time\n# look\nshot = pyautogui.screenshot()\ndisplay(shot)\ntime.sleep(1)",
        "w, h = pyautogui.size()\nlog(w, h)\nlog(pyautogui.position())\npyautogui.sleep(0.5)",
        "pyautogui.screenshot()",
    ],
)
def test_screen_only_observation_is_look_only(source):
    assert only_looks_at_screen(source)


@pytest.mark.parametrize(
    "source",
    [
        "display(web.screenshot())",
        "log(read('https://example.com'))",
        "display(pyautogui.screenshot())\npyautogui.click(1, 2)",
        "shot = web.screenshot()\ndisplay(shot)",
        "display(pyautogui.screenshot(region=pyautogui.click()))",
        "display(",
    ],
)
def test_acting_or_other_instruments_are_not_look_only(source):
    assert not only_looks_at_screen(source)


def test_contract_points_at_instruments_only_when_the_cloud_browser_runs():
    assert "web and read instruments" in omp_action_contract(web=True)
    assert "web" not in omp_action_contract(web=False)
    assert "Start with display" not in omp_action_contract(web=True)
    assert "exec_py" not in instrument_lines(web=True)[0], "instrument text must not contradict the omp 'no exec_py' rule"
