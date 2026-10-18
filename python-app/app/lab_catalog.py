import copy
import json
import sys
from functools import lru_cache

from .config import DEFAULT_MODEL_DISPLAY_NAME, REPO_ROOT
from .desktop.input_rules import shortcut_instruction
from .desktop.unreal_editor import unreal_editor_card
from .models import ScenarioManifest, validate_wire


@lru_cache(maxsize=1)
def catalog() -> dict:
    return json.loads((REPO_ROOT / "labs" / "catalog.json").read_text(encoding="utf-8"))


def list_scenarios() -> list[dict]:
    scenarios = [validate_wire(ScenarioManifest, {**item, "workspaceTemplatePath": str(REPO_ROOT / "labs" / item["templateDirectory"])})
                 for item in catalog()["scenarios"]]
    # The Python console drives a real desktop app; offer that target first.
    return sorted(scenarios, key=lambda item: item["labId"] != "desktop")


def instructions(
    lab_id: str,
    current_url: str,
    model_label: str = DEFAULT_MODEL_DISPLAY_NAME,
    *,
    platform: str | None = None,
) -> str:
    definition = next(item for item in catalog()["scenarios"] if item["labId"] == lab_id)
    host = platform or sys.platform
    if lab_id == "desktop":
        return "\n".join([
            f"You are operating the real desktop for a {model_label} computer-use session.",
            "You must use the exec_py tool before you answer.",
            "No practice web lab is open. Unreal Editor is already visible on the primary display.",
            "Start with display(pyautogui.screenshot()). Use PyAutoGUI only inside Unreal Editor.",
            shortcut_instruction(host),
            unreal_editor_card(host),
            "Coordinates refer to the full desktop screenshot on both Windows and macOS.",
            *copy.deepcopy(definition["instructions"]),
        ])
    return "\n".join([
        f"You are operating a persistent Python/PyAutoGUI desktop session for a {model_label} CUA demo harness.",
        "You must use the exec_py tool before you answer.",
        "Observe the current interface with pyautogui.screenshot(), then use PyAutoGUI mouse and keyboard controls. Coordinates refer to the full desktop screenshot.",
        f"The lab is already open at {current_url}.", *copy.deepcopy(definition["instructions"]),
    ])
