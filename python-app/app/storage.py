"""Run artifacts with one atomically replaced replay as the committed snapshot."""
import asyncio
import copy
import io
import json
import logging
import os
import re
import shutil
import time
from collections.abc import Collection
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from PIL import Image

from .errors import RunnerCoreError
from .models import ReplayBundle, validate_wire


async def run_in_thread(function):
    """Do not release admission/write locks while cancelled filesystem work runs."""
    task = asyncio.create_task(asyncio.to_thread(function))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError:
            cancelled = True
            if task.done():
                result = await task
                break
    if cancelled:
        raise asyncio.CancelledError
    return result


def validate_run_id(run_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
        raise RunnerCoreError("Invalid run ID.", code="invalid_request", status_code=400,
                              hint="Use the run ID returned when starting a run.")
    return run_id


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(f"{path.name}.{uuid4()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


# Stored screenshots are for people (replay, console); the model gets full-fidelity PNG frames (see store_screenshot).
SCREENSHOT_MAX_WIDTH = 1920
SCREENSHOT_QUALITY = 85
MODEL_FRAMES = "model-frames"


def store_screenshot(directory: Path, stem: str, png: bytes) -> Path:
    """Write a screenshot as a JPEG no wider than 1920 px, plus the untouched PNG as the model's copy.

    The model clicks in the coordinates of the image it sees, so it must never get the downscaled one. The PNG lives in
    <run>/model-frames and is deleted with the workspace a day after the run finishes."""
    directory.mkdir(parents=True, exist_ok=True)
    frames = directory.parent / MODEL_FRAMES
    frames.mkdir(parents=True, exist_ok=True)
    (frames / f"{stem}.png").write_bytes(png)
    with Image.open(io.BytesIO(png)) as image:
        picture = image.convert("RGB")
    if picture.width > SCREENSHOT_MAX_WIDTH:
        size = (SCREENSHOT_MAX_WIDTH, max(1, round(picture.height * SCREENSHOT_MAX_WIDTH / picture.width)))
        picture = picture.resize(size, Image.Resampling.LANCZOS)
    path = directory / f"{stem}.jpg"
    picture.save(path, "JPEG", quality=SCREENSHOT_QUALITY, optimize=True)
    return path


def model_image_path(stored: str) -> str:
    """The full-fidelity copy of a stored screenshot for the model, or the stored file itself (older runs, PNG artifacts)."""
    path = Path(stored)
    frame = path.parent.parent / MODEL_FRAMES / f"{path.stem}.png"
    return str(frame) if frame.is_file() else stored


logger = logging.getLogger(__name__)
DAY = 86400.0


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _finished_at(run_dir: Path) -> float | None:
    """When a run finished (epoch seconds), or None while it is running. A run without a readable record counts as
    finished when its folder was last touched: it can only be a run that failed before or while saving."""
    try:
        record = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return run_dir.stat().st_mtime
    if not isinstance(record, dict) or record.get("status") == "running":
        return None
    try:
        return datetime.fromisoformat(str(record["completedAt"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError):
        return (run_dir / "run.json").stat().st_mtime


def prune_storage(data_root: Path, *, keep_runs: int, keep_days: float, active: Collection[str] = (),
                  attachments: Path | None = None, now: float | None = None) -> dict[str, int]:
    """Delete finished runs past the age limit or beyond the newest `keep_runs`, workspaces (and model frames) of runs
    finished over a day ago, and pasted attachments older than a week. Running runs and `active` IDs are never touched."""
    now = time.time() if now is None else now
    removed = {"runs": 0, "workspaces": 0, "attachments": 0, "bytes": 0}

    def delete(path: Path, kind: str | None) -> None:
        try:
            size = _size(path)
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        except OSError:
            logger.warning("Could not delete %s", path, exc_info=True)
            return
        if kind:
            removed[kind] += 1
        removed["bytes"] += size

    finished: dict[str, float] = {}
    runs = data_root / "runs"
    for run_dir in (runs.iterdir() if runs.is_dir() else ()):
        if run_dir.is_dir() and run_dir.name not in active and (at := _finished_at(run_dir)) is not None:
            finished[run_dir.name] = at
    newest_first = sorted(finished, key=finished.__getitem__, reverse=True)
    expired = {run_id for index, run_id in enumerate(newest_first)
               if index >= keep_runs or now - finished[run_id] > keep_days * DAY}
    for run_id in expired:
        delete(runs / run_id, "runs")
    for run_id, at in finished.items():
        frames = runs / run_id / MODEL_FRAMES
        if run_id not in expired and now - at > DAY and frames.exists():
            delete(frames, None)
    workspaces = data_root / "workspaces"
    for workspace in (workspaces.iterdir() if workspaces.is_dir() else ()):
        if workspace.name in active or not workspace.is_dir():
            continue
        if workspace.name in finished or not (runs / workspace.name).exists():
            # A workspace whose run record is gone is an orphan: it gets the same day, counted from its last change.
            at = finished.get(workspace.name, workspace.stat().st_mtime)
            if now - at > DAY:
                delete(workspace, "workspaces")
    for item in (attachments.iterdir() if attachments is not None and attachments.is_dir() else ()):
        if item.is_file() and now - item.stat().st_mtime > 7 * DAY:
            delete(item, "attachments")
    if removed["bytes"]:
        logger.info("Storage cleanup removed %d runs, %d workspaces and %d attachments (%d bytes).",
                    removed["runs"], removed["workspaces"], removed["attachments"], removed["bytes"])
    return removed


class RunStorage:
    def __init__(self, data_root: Path):
        self.root = data_root.resolve()

    def run_dir(self, run_id: str) -> Path:
        return self.root / "runs" / validate_run_id(run_id)

    def workspace(self, run_id: str) -> Path:
        return self.root / "workspaces" / validate_run_id(run_id)

    async def prepare(self, run_id: str, template: str) -> None:
        def prepare() -> None:
            for name in ("runs", "workspaces"):
                (self.root / name).mkdir(parents=True, exist_ok=True)
            target = self.workspace(run_id)
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(template, target)
            run_dir = self.run_dir(run_id)
            (run_dir / "screenshots").mkdir(parents=True, exist_ok=True)
            (run_dir / "events.jsonl").write_text("", encoding="utf-8")
        await run_in_thread(prepare)

    def replay(self, detail: dict) -> dict:
        run_dir = self.run_dir(detail["run"]["id"])
        return {
            "version": 3,
            "artifacts": {"eventsPath": str(run_dir / "events.jsonl"),
                          "replayPath": str(run_dir / "replay.json"),
                          "runPath": str(run_dir / "run.json"),
                          "screenshotsDirectory": str(run_dir / "screenshots"),
                          "workspacePath": detail["workspacePath"]},
            "events": copy.deepcopy(detail["events"]), "run": copy.deepcopy(detail["run"]),
            "scenario": copy.deepcopy(detail["scenario"]),
            **({"browser": copy.deepcopy(detail["browser"])} if "browser" in detail else {}),
        }

    async def persist(self, detail: dict, event: dict | None = None) -> None:
        snapshot = self.replay(detail)
        run_dir = self.run_dir(detail["run"]["id"])

        def write() -> None:
            run_dir.mkdir(parents=True, exist_ok=True)
            if event is not None:
                with (run_dir / "events.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(event, ensure_ascii=False) + "\n")
            atomic_json(run_dir / "run.json", snapshot["run"])
            # Published last: readers never combine an old record with newer events.
            atomic_json(run_dir / "replay.json", snapshot)
        await run_in_thread(write)

    async def read_replay(self, run_id: str) -> dict:
        path = self.run_dir(run_id) / "replay.json"
        try:
            text = await asyncio.to_thread(path.read_text, encoding="utf-8")
            value = json.loads(text)
            if not isinstance(value, dict):
                raise TypeError("Malformed replay bundle.")
            if value.get("version") != 3:
                raise RunnerCoreError(
                    f"Replay version {value.get('version', 'missing')} is not supported by this app.",
                    code="unsupported_replay_version", status_code=409,
                    hint="This app reads replay version 3. Keep the original file and use the matching app version to inspect it.",
                )
            return validate_wire(ReplayBundle, value)
        except (OSError, ValueError, TypeError) as error:
            raise RunnerCoreError(f"Run {run_id} was not found.", code="run_not_found", status_code=404,
                                  hint="Start a new run or check that the replay artifacts still exist on disk.") from error
