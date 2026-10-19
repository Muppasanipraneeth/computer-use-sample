import pytest

from app.errors import RunnerCoreError
from app.lab_catalog import list_scenarios
from app.model_routing import model_name, plan_auto, route_task
from app.model_selection import FAST_MODEL, QUICK_MODEL, STRONG_MODEL
from app.models import RunRecord, validate_wire

SCENARIOS = {scenario["id"]: scenario for scenario in list_scenarios()}
ANY_TASK = SCENARIOS["any-task"]
TIERS = {"quick": QUICK_MODEL, "fast": FAST_MODEL, "strong": STRONG_MODEL}
ALL = {"anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"}


@pytest.mark.parametrize("prompt,tier,reason", [
    ("What's the weather in Paris?", "quick", "quick question"),
    ("what is 17% of 240", "quick", "arithmetic"),
    ("12*37", "quick", "arithmetic"),
    ("Who won the 2022 World Cup?", "quick", "quick question"),
    ("convert 5 miles to km", "quick", "quick question"),
    ("What time is it in Tokyo right now?", "quick", "quick question"),
    ("How much is Spotify Premium a month?", "quick", "quick question"),
    ("Find three well-reviewed Thai restaurants near Union Square that are open tonight", "fast", "everyday task"),
    ("Draft a reply to Sam's last email saying I'll be there Thursday", "fast", "everyday task"),
    ("Fill in the contact form on acme.com with my details", "fast", "everyday task"),
    ("Enter my zip code on the shipping form at ups.com", "fast", "everyday task"),
    ("Summarize the top stories on Hacker News today", "fast", "everyday task"),
    ("What's on my calendar tomorrow?", "fast", "everyday task"),
    ("What is the best laptop to buy under $1000?", "fast", "everyday task"),
    ("Move 3 x 4 tiles", "fast", "everyday task"),
    ("Open Spotify and play my Discover Weekly playlist", "strong", "controls Spotify"),
    ("Click the blue Submit button on my screen", "strong", "controls the screen"),
    ("In Finder, move all the screenshots into a new folder called Shots", "strong", "controls the screen"),
    ("In Finder, move all the PDFs into a new folder called Papers", "strong", "controls Finder"),
    ("Fix the failing unit test in my repo", "strong", "writing or fixing code"),
    ("Write a Python script that renames my photos by date", "strong", "writing or fixing code"),
    ("Get the Q3 numbers from the Google Sheet, then put them in a Notion page and then post a summary in Slack",
     "strong", "multi-step workflow"),
    ("Copy the attendee list from Airtable into a Notion page and share it on Slack", "strong", "multi-step workflow"),
    ("Book a table for two at Nopa " + "and mention it is an anniversary, with a window seat if possible. " * 7,
     "strong", "long request"),
])
def test_route_task_table(prompt, tier, reason):
    assert route_task(prompt, [], ANY_TASK) == (tier, reason)


def test_attachments_labs_and_unreal_route_to_strong():
    assert route_task("What's in this?", [{"kind": "image"}], ANY_TASK) == ("strong", "attached image to analyse")
    assert route_task("Tidy this", [{"kind": "folder"}], ANY_TASK) == ("strong", "attached files to analyse")
    assert route_task("What is 2+2", [], SCENARIOS["kanban-reprioritize-sprint"]) == ("strong", "practice lab")
    assert route_task("What is 2+2", [], SCENARIOS["desktop-cad-engine"]) == ("strong", "Unreal Editor task")


def test_a_workspace_about_a_desktop_app_makes_its_tasks_app_work():
    workspace = "We do level design in Unreal for the Harbor project."
    assert route_task("Add a point light above the table", [], ANY_TASK, workspace) == ("strong", "controls Unreal (workspace)")
    assert route_task("What is 2+2", [], ANY_TASK, workspace) == ("quick", "arithmetic")


@pytest.mark.parametrize("tier,listed,expected", [
    ("quick", ALL, (QUICK_MODEL, "quick", (FAST_MODEL, STRONG_MODEL))),
    ("fast", ALL, (FAST_MODEL, "fast", (STRONG_MODEL,))),
    ("strong", ALL, (STRONG_MODEL, "strong", ())),
    ("quick", ALL - {"anthropic/claude-haiku-5-5"}, (FAST_MODEL, "fast", (STRONG_MODEL,))),
    ("fast", {"anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5"}, (STRONG_MODEL, "strong", ())),
    ("strong", {"anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"}, (FAST_MODEL, "fast", ())),
], ids=["quick", "fast", "strong", "quick-missing-goes-up", "fast-missing-goes-up", "strong-missing-goes-down"])
def test_plan_auto_uses_the_nearest_available_tier_above_then_below(tier, listed, expected):
    plan = plan_auto(TIERS, tier, "why", listed)
    assert (plan.model, plan.tier, plan.stronger_models) == expected
    assert plan.reason == ("why" if plan.tier == tier else f"why; {model_name(TIERS[tier])} isn't available")


def test_plan_auto_without_any_model_is_refused():
    with pytest.raises(RunnerCoreError) as caught:
        plan_auto(TIERS, "fast", "why", set())
    assert (caught.value.code, caught.value.status_code) == ("model_unavailable", 400)


def test_escalation_stays_within_the_starting_provider():
    models = {"quick": QUICK_MODEL, "fast": "anthropic:claude-fast", "strong": STRONG_MODEL}
    assert plan_auto(models, "quick", "why", ALL).stronger_models == (STRONG_MODEL,)


RECORD = {"id": "run-1", "scenarioId": "any-task", "labId": "desktop", "browserMode": "headful", "model": "gpt-6-astra",
          "maxResponseTurns": 24, "prompt": "Do it.", "status": "completed", "startedAt": "2026-01-01T00:00:00.000Z"}


def test_records_from_before_auto_and_usage_still_load_without_them():
    loaded = validate_wire(RunRecord, RECORD)
    assert not {"usage", "modelSwitches", "modelChoice"} & set(loaded)


def test_usage_choice_and_switches_round_trip():
    usage = {"inputTokens": 10, "outputTokens": 2, "cachedTokens": 0, "costUsd": None, "turns": 1}
    choice = {"model": QUICK_MODEL, "tier": "quick", "reason": "quick question"}
    switch = {"at": "2026-01-01T00:00:05.000Z", "from": QUICK_MODEL, "to": FAST_MODEL, "reason": "2 code steps in a row failed"}
    loaded = validate_wire(RunRecord, {**RECORD, "usage": usage, "modelChoice": choice, "modelSwitches": [switch]})
    assert (loaded["usage"], loaded["modelChoice"], loaded["modelSwitches"]) == (usage, choice, [switch])
    assert validate_wire(RunRecord, {**RECORD, "modelChoice": None})["modelChoice"] is None
