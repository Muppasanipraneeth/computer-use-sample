"""Images and folders the user attaches to a run or a follow-up, and how the model learns about them."""
import base64
import re
import shutil
from pathlib import Path
from typing import Any

from .errors import RunnerCoreError

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
# Inline model images stay under the strictest provider limit (Claude, 5 MB); larger ones are still reachable via display().
MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024
LOOK_HINT = ("To look at an attached image, run `import PIL.Image` and `display(PIL.Image.open(path))`; "
             "the next turn shows it to you.")


def _invalid(message: str) -> RunnerCoreError:
    return RunnerCoreError(message, code="invalid_attachment", status_code=400,
                           hint="Attach PNG, JPEG, GIF, or WebP images up to 20 MB, or folders, by their full path on this computer.")


def resolve_attachments(items: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Validate request attachments; returns {"kind", "source" (resolved Path), "name"} in request order."""
    resolved = []
    for item in items:
        raw = Path(item["path"])
        if not raw.is_absolute():
            raise _invalid(f"Attachment path must be a full path: {item['path']}")
        try:
            # Resolving follows symlinks, so the checks below apply to the real file or folder.
            source = raw.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise _invalid(f"Attachment not found: {item['path']}") from error
        if item["kind"] == "image":
            if not source.is_file() or source.suffix.lower() not in IMAGE_TYPES:
                raise _invalid(f"Attached image must be a PNG, JPEG, GIF, or WebP file: {item['path']}")
            if source.stat().st_size > MAX_IMAGE_BYTES:
                raise _invalid(f"Attached image is larger than 20 MB: {item['path']}")
        elif not source.is_dir():
            raise _invalid(f"Attached folder is not a folder: {item['path']}")
        resolved.append({"kind": item["kind"], "source": source, "name": raw.name or source.name})
    return resolved


def plan_attachments(resolved: list[dict[str, Any]], directory: Path, start: int) -> list[dict[str, str]]:
    """Run-record entries: images point at their copy in the run directory, folders at the original."""
    planned = []
    for offset, item in enumerate(resolved):
        if item["kind"] == "image":
            safe = re.sub(r"[^A-Za-z0-9._-]", "_", item["name"])[-80:]
            path = str(directory / f"{start + offset}-{safe}")
        else:
            path = str(item["source"])
        planned.append({"kind": item["kind"], "path": path, "name": item["name"]})
    return planned


def copy_images(resolved: list[dict[str, Any]], planned: list[dict[str, str]]) -> None:
    """Copy so the run stays reproducible even if the user later moves or deletes the original."""
    for item, entry in zip(resolved, planned, strict=True):
        if item["kind"] != "image":
            continue
        target = Path(entry["path"])
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item["source"], target)
        except OSError as error:
            raise _invalid(f"Attached image could not be copied: {item['source']} ({error.strerror or error})") from error


def attachment_lines(attachments: list[dict[str, str]]) -> str:
    if not attachments:
        return ""
    lines = ["The user attached these:"]
    for item in attachments:
        if item["kind"] == "image":
            lines.append(f"- image {item['name']}: {item['path']}")
        else:
            lines.append(f"- folder {item['name']}: {item['path']} (read and write files there with Python)")
    if any(item["kind"] == "image" for item in attachments):
        lines.append(LOOK_HINT)
    return "\n".join(lines)


def task_text(run: dict[str, Any]) -> str:
    """The original request as every model loop states it: the user's words plus what they attached."""
    return "\n\n".join(part for part in (run["prompt"].strip(), attachment_lines(run.get("attachments", []))) if part)


def first_image(attachments: list[dict[str, str]]) -> dict[str, str] | None:
    return next((item for item in attachments if item["kind"] == "image"), None)


def inline_image(attachments: list[dict[str, str]]) -> dict[str, str] | None:
    """The first attached image as a model input item, or None when there is none small enough to send inline."""
    image = first_image(attachments)
    if image is None:
        return None
    path = Path(image["path"])
    try:
        if path.stat().st_size > MAX_INLINE_IMAGE_BYTES:
            return None
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError:
        return None
    return {"type": "input_image", "image_url": f"data:{IMAGE_TYPES[path.suffix.lower()]};base64,{encoded}"}
