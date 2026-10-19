"""The user's "About you" profile, saved by the desktop app (desktop/profile.mjs) in its data folder.

Read at the start of a general desktop run so typed tasks ("what's the weather") know who and where the user is.
It goes into the model instructions only, never into the desktop worker's environment.
"""
import json
import os
from pathlib import Path

from .config import desktop_user_data

# Same caps the desktop app enforces when saving; a hand-edited file is trimmed to them, never trusted beyond them.
LIMITS = {"name": 500, "callMe": 500, "location": 500, "about": 2000}


def profile_path() -> Path:
    """profile.json in the desktop app's userData folder; JARVIS_PROFILE_PATH overrides it (tests, custom setups)."""
    override = os.environ.get("JARVIS_PROFILE_PATH", "").strip()
    return Path(override) if override else desktop_user_data() / "profile.json"


def load_profile() -> dict[str, str] | None:
    """The saved fields that are set, or None when the file is missing, unreadable, or empty."""
    try:
        stored = json.loads(profile_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(stored, dict):
        return None
    profile = {key: " ".join(value.split())[:limit] for key, limit in LIMITS.items() if isinstance(value := stored.get(key), str)}
    profile = {key: value for key, value in profile.items() if value}
    return profile or None


def about_user_lines(profile: dict[str, str] | None) -> list[str]:
    """An "About the user" section from only the fields they filled in; [] when there is nothing to say."""
    if not profile:
        return []
    name, call_me = profile.get("name", ""), profile.get("callMe", "")
    lines = []
    if name:
        lines.append(f"- Name: {name}")
    if call_me and call_me != name:
        lines.append(f"- Call them: {call_me}")
    if location := profile.get("location", ""):
        lines.append(f"- They live in: {location}. Use it for weather, time, nearby places and other local questions unless the task names another place.")
    if about := profile.get("about", ""):
        lines.append(f"- Notes from them: {about}")
    if not lines:
        return []
    return ["About the user (from their Jarvis profile; use only what is written here, never guess other details):", *lines]
