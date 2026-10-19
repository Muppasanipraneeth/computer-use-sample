"""How every model loop asks the user a question or for approval, and how the answer reads back to the model.

The runner holds the question on the run record until the user answers (RunnerManager._ask); model loops only parse
the model's request here and turn the answer into that provider's next input."""

from __future__ import annotations

from typing import Any

ASK_TOOL_NAME = "ask_user"
APPROVAL_OPTIONS = ["approve", "deny"]
_TEXT_LIMIT = 1000
_DETAIL_LIMIT = 4000
_OPTION_LIMIT = 120
_OPTIONS_MAX = 8

ASK_GUIDANCE = (
    "Ask the user only when a choice cannot be inferred from the request, the screen or what you already know, or "
    "before an irreversible action online or on this computer that the user did not explicitly request: sending a "
    "message or email, posting publicly, a purchase or payment, or deleting files or data. For those actions use kind "
    '"approval" with a one-line description as the question and the exact content (recipient, text, amount, files) '
    "as detail; if the user declines, do not do it and say so in your final answer. Otherwise use kind \"question\", "
    "with options when there are a few clear choices. Asking waits until the user answers."
)


def ask_tool_definition() -> dict[str, Any]:
    """ask_user in the Responses function-tool shape; the Claude and compatible loops reuse its name and schema."""
    return {
        "type": "function",
        "name": ASK_TOOL_NAME,
        "strict": True,
        "description": f"Ask the user a question, or for approval, and wait for the answer. {ASK_GUIDANCE}",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["question", "kind", "options", "detail"],
            "properties": {
                "question": {"type": "string", "description": "The question, or a one-line description of the action."},
                "kind": {"type": "string", "enum": ["question", "approval"]},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Suggested answers for a question; empty for free text or for an approval.",
                },
                "detail": {
                    "type": ["string", "null"],
                    "description": "For an approval, the exact content that would be sent, posted, paid or deleted.",
                },
            },
        },
    }


def parse_ask(value: Any) -> dict[str, Any]:
    """{"text", "kind", "options", "detail"} for RunExecutionContext.ask; ValueError says what the model got wrong."""
    if not isinstance(value, dict):
        raise ValueError("ask needs a JSON object.")  # noqa: TRY004 - callers handle one error type for any malformed ask
    question = value.get("question")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("ask needs a nonempty question string.")
    kind = value.get("kind") or "question"
    if kind not in ("question", "approval"):
        raise ValueError('ask kind must be "question" or "approval".')
    options = value.get("options") or []
    if not isinstance(options, list) or not all(isinstance(option, str) for option in options):
        raise ValueError("ask options must be a list of strings.")
    detail = value.get("detail")
    if detail is not None and not isinstance(detail, str):
        raise ValueError("ask detail must be a string.")
    cleaned = [option.strip()[:_OPTION_LIMIT] for option in options if option.strip()][:_OPTIONS_MAX]
    return {
        "text": question.strip()[:_TEXT_LIMIT],
        "kind": kind,
        # The answer to an approval is exactly one of these, whatever the model suggested.
        "options": list(APPROVAL_OPTIONS) if kind == "approval" else cleaned,
        "detail": (detail.strip()[:_DETAIL_LIMIT] or None) if detail is not None else None,
    }


def answer_text(question: dict[str, Any], answer: str) -> str:
    """The user's answer as the model reads it on its next turn."""
    if question["kind"] == "approval":
        if answer == "approve":
            return f"You asked for approval: {question['text']}\nThe user approved. Go ahead."
        return f"You asked for approval: {question['text']}\nThe user declined. Do not do it."
    return f"You asked: {question['text']}\nThe user answered: {answer}"


async def ask_user(context: Any, question: dict[str, Any]) -> str:
    """Wait for the user's answer to a parsed question (Stop ends the wait) and return it as the model's next input."""
    answer = await context.ask(question["text"], kind=question["kind"], options=question["options"], detail=question["detail"])
    return answer_text(question, answer)
