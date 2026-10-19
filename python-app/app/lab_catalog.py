import copy
import json
import sys
from functools import lru_cache

from .config import DEFAULT_MODEL_DISPLAY_NAME, labs_root
from .desktop.input_rules import shortcut_instruction
from .desktop.unreal_editor import unreal_editor_card
from .instruments import instrument_lines
from .models import ScenarioManifest, validate_wire
from .user_profile import about_user_lines, memory_lines


@lru_cache(maxsize=1)
def catalog() -> dict:
    return json.loads((labs_root() / "catalog.json").read_text(encoding="utf-8"))


def list_scenarios() -> list[dict]:
    root = labs_root()
    scenarios = [validate_wire(ScenarioManifest, {**item, "workspaceTemplatePath": str(root / item["templateDirectory"])})
                 for item in catalog()["scenarios"]]
    # The Python console drives a real desktop app; offer that target first.
    return sorted(scenarios, key=lambda item: item["labId"] != "desktop")


def target_app(scenario_id: str) -> str | None:
    """Catalog-only app the desktop scenario is bound to; None means any app."""
    return next(item for item in catalog()["scenarios"] if item["id"] == scenario_id).get("targetApp")


def uses_cloud_browser(scenario_id: str) -> bool:
    """Catalog-only flag: the desktop scenario may also use Cloudflare Browser Run."""
    return bool(next(item for item in catalog()["scenarios"] if item["id"] == scenario_id).get("cloudBrowser"))


def workspace_lines(workspace: dict[str, str] | None) -> list[str]:
    """The user's workspace section; [] for a run started outside one."""
    if not workspace:
        return []
    lines = [f'Workspace "{workspace["name"]}"']
    if text := workspace.get("instructions", ""):
        lines += ["The user set these instructions for every task in this workspace; follow them unless the task says otherwise:", text]
    return lines


def instructions(
    scenario_id: str,
    current_url: str,
    model_label: str = DEFAULT_MODEL_DISPLAY_NAME,
    *,
    platform: str | None = None,
    web: bool = False,
    cloud: bool = False,
    apps: bool = False,
    profile: dict[str, str] | None = None,
    memories: list[str] | None = None,
    workspace: dict[str, str] | None = None,
) -> str:
    definition = next(item for item in catalog()["scenarios"] if item["id"] == scenario_id)
    host = platform or sys.platform
    if definition["labId"] == "desktop":
        unreal = definition.get("targetApp") == "Unreal Editor"
        return "\n".join([
            f"You are operating the real desktop for a {model_label} computer-use session.",
            "You must use the exec_py tool before you answer.",
            "No practice web lab is open.",
            *(["Unreal Editor is already visible on the primary display.", "Use PyAutoGUI only inside Unreal Editor."] if unreal else []),
            shortcut_instruction(host),
            *([unreal_editor_card(host)] if unreal else []),
            "Coordinates refer to the full desktop screenshot on both Windows and macOS.",
            *copy.deepcopy(definition["instructions"]),
            *(instrument_lines(web=web, cloud=cloud, apps=apps) if definition.get("cloudBrowser") else []),
            *about_user_lines(profile),
            # Memories go with the profile; remember() exists only in workers given instruments (web runs).
            *(memory_lines(memories, can_remember=web) if memories is not None else []),
            *workspace_lines(workspace),
        ])
    return "\n".join([
        f"You are operating a persistent Python/PyAutoGUI desktop session for a {model_label} Jarvis demo harness.",
        "You must use the exec_py tool before you answer.",
        "Observe the current interface with pyautogui.screenshot(), then use PyAutoGUI mouse and keyboard controls. Coordinates refer to the full desktop screenshot.",
        f"The lab is already open at {current_url}.", *copy.deepcopy(definition["instructions"]), *workspace_lines(workspace),
    ])
