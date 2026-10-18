"""Provider prefix on the run model string. Unprefixed models stay on OpenAI."""

from dataclasses import dataclass

PROVIDERS = ("openai", "anthropic", "compatible", "omp")


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
