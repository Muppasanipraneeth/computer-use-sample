import json
from pathlib import Path

import pytest

from app.desktop.memory_instrument import MAX_MEMORIES, forget, read_memories, remember
from app.lab_catalog import instructions
from app.user_profile import load_memories


def stored(path: Path) -> list[str]:
    return [item["text"] for item in json.loads(path.read_text(encoding="utf-8"))["memories"]]


def test_remember_dedupes_case_insensitively_and_keeps_the_newest_100(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    assert remember("  I prefer   metric units ", str(path)) == "Remembered: I prefer metric units"
    assert remember("i PREFER metric units", str(path)).startswith("Already remembered")
    assert stored(path) == ["I prefer metric units"]
    for index in range(MAX_MEMORIES):
        remember(f"fact {index}", str(path))
    assert len(stored(path)) == MAX_MEMORIES and stored(path)[-1] == "fact 99" and "I prefer metric units" not in stored(path)
    assert remember("x" * 400, str(path)) == f"Remembered: {'x' * 300}"
    # Atomic writes leave no temporary files behind.
    assert [item.name for item in tmp_path.iterdir()] == ["memory.json"]


def test_forget_removes_every_memory_containing_the_text(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    for text in ("Sister is Anna", "Anna likes jazz", "Works at Acme"):
        remember(text, str(path))
    assert forget("anna", str(path)) == 2
    assert stored(path) == ["Works at Acme"]
    assert forget("nobody", str(path)) == 0


@pytest.mark.parametrize("content", [None, "not json", '{"memories": "nope"}', '[1]', '{"memories": [{"text": 3}, {"text": " ok "}]}'])
def test_missing_or_corrupt_memory_file_reads_as_no_memories(tmp_path: Path, content: str | None) -> None:
    path = tmp_path / "memory.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    assert [item["text"] for item in read_memories(str(path))] == (["ok"] if content and "ok" in content else [])


def test_remember_without_a_memory_file_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JARVIS_MEMORY_FILE", raising=False)
    assert remember("anything") == "Memory is not available in this session."


def test_instructions_list_memories_newest_last_within_the_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "memory.json"
    monkeypatch.setenv("JARVIS_MEMORY_FILE", str(path))
    for index in range(30):
        remember(f"memory {index:02d} " + "y" * 90, str(path))
    text = instructions("any-task", "desktop://primary", platform="darwin", web=True, memories=load_memories())
    section = text.split("Things the user asked you to remember:\n", 1)[1]
    bullets = [line for line in section.splitlines() if line.startswith("- memory")]
    assert bullets[-1].startswith("- memory 29") and not any(line.startswith("- memory 00") for line in bullets)
    assert sum(len(line) + 1 for line in bullets) <= 2000
    assert "remember('...')" in text and "Settings → You" in text


def test_no_memories_still_explains_remember_but_lists_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JARVIS_MEMORY_FILE", str(tmp_path / "missing.json"))
    text = instructions("any-task", "desktop://primary", platform="darwin", web=True, memories=load_memories())
    assert "Things the user asked you to remember" not in text and "remember('...')" in text
