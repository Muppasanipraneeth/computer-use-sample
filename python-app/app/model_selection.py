"""Provider prefix on the run model string. Unprefixed models stay on OpenAI."""

from dataclasses import dataclass

PROVIDERS = ("openai", "anthropic", "compatible", "omp")
# A start request's model "auto" picks a tier from the task (model_routing.route_task) and escalates a tier at a time
# if the run struggles (run_model.RunModel). Settings/env override each tier's model.
AUTO_MODEL = "auto"
QUICK_MODEL = "omp:anthropic/claude-haiku-5-5"
FAST_MODEL = "omp:anthropic/claude-sonnet-5-5"
STRONG_MODEL = "omp:anthropic/claude-opus-5-5"


@dataclass(frozen=True)
class ModelSelection:
    provider: str
    model_id: str


def parse_model_selection(model: str) -> ModelSelection:
    trimmed = model.strip()
    separator = trimmed.find(":")
    if separator > 0:
        prefix = trimmed[:separator]
        model_id = trimmed[separator + 1 :].strip()
        if prefix in PROVIDERS and model_id:
            return ModelSelection(prefix, model_id)
    return ModelSelection("openai", trimmed)
