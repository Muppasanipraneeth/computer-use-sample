"""Auto: which model tier a task starts on, from its wording alone (no model call, no latency), and which models it
may escalate to (run_model.RunModel switches one tier up at a time).

Every keyword list lives here. Each tier exists for a reason:
- quick: one short answer (a fact, a lookup, a sum). The smallest model answers these as well as the others, faster
  and cheaper. Misrouting here costs the most (a weak model on a real task), so quick needs every signal at once.
- strong: work where one wrong step derails the run: driving desktop apps or the real screen, code, multi-step work
  across several apps or sites, attached images or folders to analyse, long requests, practice labs and Unreal.
- fast: everything else (web research, drafting through connected apps, filling a form): the middle model's speed
  with enough judgment, and escalation covers the cases it can't handle.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Any

from .errors import RunnerCoreError
from .lab_catalog import target_app
from .model_selection import parse_model_selection

TIERS = ("quick", "fast", "strong")
QUICK_MAX_CHARS = 160
LONG_PROMPT_CHARS = 400

# Strong — the real screen: anything here means looking at or driving what the user sees.
SCREEN_TERMS = (
    "on my screen", "on the screen", "my screen", "screenshot", "click", "double-click", "right-click", "drag", "mouse",
    "cursor", "keyboard shortcut", "type into", "type in the", "window", "menu bar", "the dock", "desktop", "full screen",
    "fullscreen",
)
# Strong — desktop apps (not websites). Named together with one of CONTROL_VERBS they mean driving that app.
DESKTOP_APPS = (
    "spotify", "finder", "unreal", "blender", "photoshop", "illustrator", "figma", "excel", "keynote", "powerpoint",
    "microsoft word", "ms word", "xcode", "terminal", "system settings", "system preferences", "apple music",
    "music app", "imessage", "messages app", "notes app", "pages app", "numbers app", "preview app", "zoom", "vs code",
    "vscode", "garageband", "final cut", "logic pro", "davinci", "quicktime", "app store",
)
CONTROL_VERBS = (
    "open", "launch", "start", "play", "pause", "skip", "click", "type", "close", "quit", "move", "drag", "select",
    "create", "make", "add", "export", "import", "save", "rename", "delete", "edit", "set", "turn", "switch", "resize",
    "draw", "build", "change", "put", "record", "arrange", "organize", "organise", "sort", "install",
)
# Strong — writing or fixing code. "code" alone skips zip/promo/discount codes.
CODE_PATTERNS = (
    r"(?<!zip )(?<!promo )(?<!discount )(?<!coupon )(?<!postal )(?<!area )(?<!qr )(?<!country )\bcode\b",
    r"\bscripts?\b", r"\bbugs?\b", r"\bdebug", r"\brefactor", r"\bcompil", r"\bstack ?trace", r"\btraceback\b",
    r"\b(?:python|javascript|typescript|golang|java|kotlin|sql|regex|bash)\b",
    r"\b(?:repo|repository|pull request|unit tests?|failing tests?|github)\b", r"\bfunctions?\b",
)
# Strong — services a multi-step workflow hops between (desktop apps and domains like acme.com count too).
SERVICES = (
    "gmail", "google docs", "google doc", "google sheets", "google sheet", "spreadsheet", "notion", "slack", "linear",
    "jira", "github", "calendar", "google drive", "dropbox", "trello", "asana", "airtable", "hubspot", "salesforce",
    "outlook", "twitter", "linkedin", "amazon", "whatsapp", "discord", "confluence", "zendesk", "stripe", "shopify",
    "youtube",
)
DOMAIN = re.compile(r"\b[a-z0-9-]+\.(?:com|org|net|io|co|ai|dev|app|edu|gov)\b")
SEQUENCE = re.compile(r"\b(?:and then|then|after that|afterwards|finally|once (?:that'?s|it'?s|you'?ve) done)\b")
NUMBERED_STEPS = re.compile(r"(?m)^\s*\d+[.)]\s")
# Quick — a question asking for one fact. Matched at the start of the request.
QUESTION_STARTS = (
    "what", "who", "when", "where", "which", "how many", "how much", "how long", "how far", "how old", "how tall",
    "how big", "is ", "are ", "does ", "do ", "did ", "was ", "were ", "can you tell", "tell me", "define", "convert",
    "calculate", "translate", "spell",
)
# Not quick — words that turn a question into a task to carry out.
ACTION_WORDS = (
    "send", "email", "e-mail", "draft", "reply", "book", "order", "buy", "fill", "schedule", "post", "summarize",
    "summarise", "research", "compare", "find me", "plan", "write", "remind", "set up", "sign up", "download", "upload",
    "subscribe", "cancel", "unsubscribe", "list all", "every", "each",
)
# Not quick — the user's own data lives in connected apps or files, which takes a few steps to read.
PERSONAL_DATA = ("my calendar", "my inbox", "my email", "my mail", "my files", "my notes", "my messages", "my documents", "my drive")
# Quick — a sum, carrying no words beyond ARITHMETIC_WORDS (so "move 3 x 4 tiles" is not one).
ARITHMETIC = re.compile(
    r"\d\s*(?:[-+*/×÷^x]|times|plus|minus|divided by|multiplied by|percent of|% of)\s*\d|\d\s*(?:squared|cubed)|"
    r"\b(?:square root|sqrt)\b"
)
ARITHMETIC_WORDS = frozenset({
    "what", "whats", "what's", "is", "calculate", "compute", "times", "plus", "minus", "divided", "by", "multiplied",
    "squared", "cubed", "percent", "of", "square", "root", "sqrt", "the", "equals", "how", "much", "x",
})


def _has(text: str, words: Collection[str]) -> str | None:
    """The first of words found in text as a whole word or phrase, allowing a plural or -ed/-ing ending."""
    return next((word for word in words if re.search(rf"(?<![a-z]){re.escape(word)}(?:s|es|ed|ing)?(?![a-z])", text)), None)


def _services(text: str) -> set[str]:
    named = {word for word in (*SERVICES, *DESKTOP_APPS) if _has(text, (word,))}
    return named | set(DOMAIN.findall(text))


def _arithmetic(text: str) -> bool:
    return ARITHMETIC.search(text) is not None and all(word in ARITHMETIC_WORDS for word in re.findall(r"[a-z][a-z']*", text))


def route_task(prompt: str, attachments: Collection[Mapping[str, Any]], scenario: Mapping[str, Any],
               workspace_instructions: str = "") -> tuple[str, str]:
    """(tier, reason) for an Auto run; the reason reads after the model name in "Chose a model for this task."."""
    text = " ".join(prompt.lower().split())
    if scenario.get("labId") != "desktop":
        return "strong", "practice lab"
    app = target_app(str(scenario["id"]))
    if app:
        return "strong", f"{app} task"
    kinds = {item.get("kind") for item in attachments}
    if kinds:
        return "strong", "attached image to analyse" if kinds == {"image"} else "attached files to analyse"
    if len(prompt.strip()) > LONG_PROMPT_CHARS:
        return "strong", "long request"
    if _has(text, SCREEN_TERMS):
        return "strong", "controls the screen"
    controlled = _has(text, DESKTOP_APPS)
    if controlled and _has(text, CONTROL_VERBS):
        return "strong", f"controls {controlled.title()}"
    if any(re.search(pattern, text) for pattern in CODE_PATTERNS):
        return "strong", "writing or fixing code"
    steps = len(SEQUENCE.findall(text)) + len(NUMBERED_STEPS.findall(prompt))
    services = len(_services(text))
    if services >= 3 or (services >= 2 and steps >= 1) or steps >= 2:
        return "strong", "multi-step workflow"
    # A workspace about a desktop app (e.g. "level design in Unreal") makes its tasks work in that app.
    workspace_app = _has(" ".join(workspace_instructions.lower().split()), DESKTOP_APPS)
    if workspace_app and _has(text, CONTROL_VERBS):
        return "strong", f"controls {workspace_app.title()} (workspace)"
    if len(text) <= QUICK_MAX_CHARS and not steps and not _has(text, ACTION_WORDS) and not _has(text, PERSONAL_DATA):
        if _arithmetic(text):
            return "quick", "arithmetic"
        if text.startswith(QUESTION_STARTS):
            return "quick", "quick question"
    return "fast", "everyday task"


@dataclass(frozen=True)
class AutoPlan:
    model: str
    tier: str
    reason: str
    # The models escalation may switch to, one tier up at a time.
    stronger_models: tuple[str, ...]


def plan_auto(models: Mapping[str, str], tier: str, reason: str, omp_selectors: Collection[str]) -> AutoPlan:
    """Resolve a routed tier to a model: the nearest available tier above it, then below. An omp model counts as
    available only when omp lists it; models of other providers are taken as configured. Escalation stays within the
    starting model's provider, because a switch keeps the loop and its conversation."""
    def available(model: str) -> bool:
        selection = parse_model_selection(model)
        return selection.provider != "omp" or selection.model_id in omp_selectors

    index = TIERS.index(tier)
    order = [*TIERS[index:], *reversed(TIERS[:index])]
    chosen = next((candidate for candidate in order if available(models[candidate])), None)
    if chosen is None:
        names = ", ".join(model_name(models[candidate]) for candidate in TIERS)
        raise RunnerCoreError(
            f"Auto needs one of {names}, and none is available in your omp accounts.",
            code="model_unavailable",
            status_code=400,
            hint="Run `omp login` for an account with these models, set JARVIS_QUICK_MODEL, JARVIS_FAST_MODEL and "
            "JARVIS_STRONG_MODEL, or pick a model instead of Auto.",
        )
    model = models[chosen]
    if chosen != tier:
        reason = f"{reason}; {model_name(models[tier])} isn't available"
    provider = parse_model_selection(model).provider
    stronger: list[str] = []
    for candidate in TIERS[TIERS.index(chosen) + 1:]:
        upgrade = models[candidate]
        if available(upgrade) and parse_model_selection(upgrade).provider == provider and upgrade not in (model, *stronger):
            stronger.append(upgrade)
    return AutoPlan(model=model, tier=chosen, reason=reason, stronger_models=tuple(stronger))


def model_name(model: str) -> str:
    """The bare model name people read: omp:anthropic/claude-haiku-5-5 → claude-haiku-5-5."""
    return parse_model_selection(model).model_id.rsplit("/", 1)[-1]
