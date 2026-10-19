"""The model a run's loop calls: Auto's escalation one tier up (quick → fast → strong), and the tokens every call used.

Every loop (omp, Responses, Claude/compatible) asks RunModel.next() for the model before each call and reports back
what happened: replied() after each call, stepped() after each code step, unusable() for a reply it could not act on,
requested() when the model asked for a stronger model itself. A switch is applied to the run record (model,
modelSwitches) and announced before the next call; the conversation carries over because each loop keeps its own
history and only the model it names changes. Each model starts with fresh trigger counts."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .model_selection import ModelSelection, parse_model_selection
from .models import timestamp
from .processes import await_active

ESCALATE_TOOL_NAME = "escalate"
ESCALATE_GUIDANCE = (
    "Use it when the task needs careful multi-step reasoning or you are stuck: a stronger model takes over with "
    "everything so far."
)
SWITCH_MESSAGE = "Switched to a stronger model."
# Auto switches one tier up, before the next call, after any of these on the current model.
TURN_LIMIT = 10
FAILED_STEP_LIMIT = 2
UNUSABLE_REPLY_LIMIT = 2
TRACEBACK_START = "Traceback (most recent call last):"
DEADLINE_NOTE_START = "This code was still running after"
SWITCHING_NOTE = "A stronger model takes over from the next turn with everything so far."
NOT_SWITCHING_NOTE = "No stronger model is available. Carry on."


def token_count(value: Any) -> int:
    """A provider's token count; anything missing or garbled counts as 0."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def call_usage(*, input_tokens: Any = 0, output_tokens: Any = 0, cached_tokens: Any = 0, cost_usd: Any = None) -> dict[str, Any]:
    """One model call's usage in RunRecord.usage terms; a cost the provider did not report stays unknown (None)."""
    cost = cost_usd if isinstance(cost_usd, (int, float)) and not isinstance(cost_usd, bool) and cost_usd >= 0 else None
    return {"inputTokens": token_count(input_tokens), "outputTokens": token_count(output_tokens),
            "cachedTokens": token_count(cached_tokens), "costUsd": float(cost) if cost is not None else None}


def add_usage(total: dict[str, Any], usage: dict[str, Any]) -> None:
    """Add one call's usage into a running total; the cost stays unknown until some call reports one."""
    for key in ("inputTokens", "outputTokens", "cachedTokens"):
        total[key] += usage[key]
    if usage["costUsd"] is not None:
        total["costUsd"] = round((total["costUsd"] or 0.0) + usage["costUsd"], 6)


def empty_usage() -> dict[str, Any]:
    return {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "costUsd": None, "turns": 0}


def escalate_tool_definition() -> dict[str, Any]:
    """escalate in the Responses function-tool shape; the Claude and compatible loops reuse its name and schema."""
    return {
        "type": "function",
        "name": ESCALATE_TOOL_NAME,
        "strict": True,
        "description": f"Hand this task to a stronger model. {ESCALATE_GUIDANCE}",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["reason"],
            "properties": {"reason": {"type": "string", "description": "Why a stronger model is needed, in one line."}},
        },
    }


def parse_escalate(value: Any) -> str:
    """The reason of an escalate request; ValueError says what the model got wrong."""
    reason = value.get("reason") if isinstance(value, dict) else None
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("escalate needs a nonempty reason string.")
    return reason.strip()[:300]


def step_failed(output: list[dict[str, Any]]) -> bool:
    """True when a code step raised (the worker returns the traceback) or overran its deadline."""
    return any(
        item.get("type") == "input_text"
        and isinstance(item.get("text"), str)
        and (TRACEBACK_START in item["text"] or item["text"].startswith(DEADLINE_NOTE_START))
        for item in output
    )


class RunModel:
    def __init__(self, context: Any, model: str, stronger_models: Sequence[str] = ()) -> None:
        self.context = context
        self.model = model
        # The models Auto may still switch to, weakest first; each switch takes the next one.
        self.stronger_models = [candidate for candidate in dict.fromkeys(stronger_models) if candidate != model]
        # Whether the run offers the model a way to ask for a stronger model; stays true once the last switch is made
        # so replayed history that used it stays valid.
        self.offers_escalation = bool(self.stronger_models)
        self._reason: str | None = None
        self._turns = 0
        self._failed_steps = 0
        self._unusable = 0

    @property
    def selection(self) -> ModelSelection:
        return parse_model_selection(self.model)

    @property
    def can_switch(self) -> bool:
        return bool(self.stronger_models)

    def replied(self, usage: dict[str, Any] | None) -> None:
        """After every model call: count the turn and add its usage to the run record."""
        self._turns += 1
        total = self.context.detail["run"].setdefault("usage", empty_usage())
        total["turns"] += 1
        if usage is not None:
            add_usage(total, usage)

    def stepped(self, output: list[dict[str, Any]]) -> None:
        self._failed_steps = self._failed_steps + 1 if step_failed(output) else 0
        if self._failed_steps >= FAILED_STEP_LIMIT:
            self._want(f"{FAILED_STEP_LIMIT} code steps in a row failed")

    def unusable(self) -> None:
        self._unusable += 1
        if self._unusable >= UNUSABLE_REPLY_LIMIT:
            self._want(f"{UNUSABLE_REPLY_LIMIT} replies were not usable")

    def requested(self, reason: str) -> str:
        """The model asked for a stronger model; returns what to tell it."""
        if not self.can_switch:
            return NOT_SWITCHING_NOTE
        self._want(f"the model asked: {reason}")
        return SWITCHING_NOTE

    def _want(self, reason: str) -> None:
        if self.can_switch and self._reason is None:
            self._reason = reason

    async def next(self) -> ModelSelection:
        """Before every model call: switch one tier up if a trigger fired, then name the model to call."""
        if self.can_switch and self._reason is None and self._turns >= TURN_LIMIT:
            self._reason = f"no final answer after {TURN_LIMIT} turns"
        if self.can_switch and self._reason is not None:
            previous, self.model = self.model, self.stronger_models.pop(0)
            reason, self._reason = self._reason, None
            self._turns = self._failed_steps = self._unusable = 0
            run = self.context.detail["run"]
            run["model"] = self.model
            run.setdefault("modelSwitches", []).append({"at": timestamp(), "from": previous, "to": self.model, "reason": reason})
            await await_active(
                self.context.emit_event({
                    "type": "run_progress", "level": "warn", "message": SWITCH_MESSAGE, "detail": f"{self.model} · {reason}",
                }),
                self.context.signal,
            )
        return self.selection
