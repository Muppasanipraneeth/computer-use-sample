"""remember()/forget() for model code, and the shared reader of the user's memory.json.

The desktop app writes the same file (Settings → You), so both sides keep to one shape:
{"memories": [{"id", "text", "createdAt"}]}, newest last. Stdlib only: the worker loads this file as a plain script.
"""
import json
import os
import uuid
from datetime import datetime, timezone

MAX_TEXT = 300
MAX_MEMORIES = 100


def memory_file():
    """The worker gets the path from the runner; without it there is nowhere to remember to."""
    return os.environ.get("JARVIS_MEMORY_FILE", "").strip()


def read_memories(path):
    """Valid entries in file order; a missing or corrupt file means no memories."""
    try:
        with open(path, encoding="utf-8") as stream:
            stored = json.load(stream)
    except (OSError, ValueError):
        return []
    items = stored.get("memories") if isinstance(stored, dict) else None
    if not isinstance(items, list):
        return []
    memories = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip():
            memories.append({"id": str(item.get("id") or uuid.uuid4()), "text": " ".join(item["text"].split())[:MAX_TEXT],
                             "createdAt": str(item.get("createdAt") or "")})
    return memories[-MAX_MEMORIES:]


def write_memories(path, memories):
    """Temp file + rename, so the desktop app never reads half a file."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f".memory.{uuid.uuid4().hex}.tmp")
    try:
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump({"memories": memories[-MAX_MEMORIES:]}, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def remember(text, path=None):
    """Save one thing about the user for future tasks; repeating a saved memory changes nothing."""
    path = path or memory_file()
    text = " ".join(str(text).split())[:MAX_TEXT]
    if not path:
        return "Memory is not available in this session."
    if not text:
        return "Nothing to remember: the text was empty."
    memories = read_memories(path)
    if any(item["text"].casefold() == text.casefold() for item in memories):
        return f"Already remembered: {text}"
    created = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    write_memories(path, [*memories, {"id": str(uuid.uuid4()), "text": text, "createdAt": created}])
    return f"Remembered: {text}"


def forget(text, path=None):
    """Remove every memory containing the text (case-insensitive); returns how many were removed."""
    path = path or memory_file()
    needle = " ".join(str(text).split()).casefold()
    if not path or not needle:
        return 0
    memories = read_memories(path)
    kept = [item for item in memories if needle not in item["text"].casefold()]
    if len(kept) != len(memories):
        write_memories(path, kept)
    return len(memories) - len(kept)
