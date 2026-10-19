import json
from pathlib import Path

import pytest

from app import config
from app.lab_catalog import instructions
from app.user_profile import load_profile, profile_path


def any_task(profile: dict[str, str] | None) -> str:
    return instructions("any-task", "desktop://primary", platform="darwin", web=True, profile=profile)


def test_any_task_instructions_carry_the_saved_profile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "profile.json"
    path.write_text(json.dumps({"name": " Praneeth ", "callMe": "P", "location": "Austin, TX", "about": "Vegetarian.\nPrefers metric."}),
                    encoding="utf-8")
    monkeypatch.setenv("JARVIS_PROFILE_PATH", str(path))

    text = any_task(load_profile())

    assert "About the user (from their Jarvis profile" in text
    assert "- Name: Praneeth" in text
    assert "- Call them: P" in text
    assert "- They live in: Austin, TX. Use it for weather" in text
    assert "- Notes from them: Vegetarian. Prefers metric." in text
    assert text.endswith("- Notes from them: Vegetarian. Prefers metric.")


def test_only_filled_fields_appear(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "profile.json"
    path.write_text(json.dumps({"name": "", "callMe": "", "location": "Pune", "about": 5}), encoding="utf-8")
    monkeypatch.setenv("JARVIS_PROFILE_PATH", str(path))

    assert load_profile() == {"location": "Pune"}
    text = any_task(load_profile())
    assert "- They live in: Pune." in text
    assert "Name:" not in text and "Call them" not in text and "Notes from them" not in text


@pytest.mark.parametrize("content", [None, "{ not json", "[]", json.dumps({"name": "  ", "location": ""})])
def test_missing_or_unusable_profile_adds_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str | None) -> None:
    path = tmp_path / "profile.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    monkeypatch.setenv("JARVIS_PROFILE_PATH", str(path))

    assert load_profile() is None
    assert any_task(load_profile()) == any_task(None)
    assert "About the user" not in any_task(None)


def test_profile_lives_in_the_desktop_apps_data_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JARVIS_PROFILE_PATH", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(config.sys, "platform", "darwin")
    assert profile_path() == tmp_path / "Library" / "Application Support" / "Jarvis" / "profile.json"
    monkeypatch.setattr(config.sys, "platform", "linux")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    assert profile_path() == tmp_path / ".config" / "Jarvis" / "profile.json"
    monkeypatch.setattr(config.sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    assert profile_path() == tmp_path / "Roaming" / "Jarvis" / "profile.json"
