import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from app.storage import DAY, MODEL_FRAMES, model_image_path, prune_storage, store_screenshot

NOW = 1_800_000_000.0


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def make_run(root: Path, run_id: str, *, age_days: float | None, workspace: bool = False) -> Path:
    """age_days None makes a run that is still running."""
    run_dir = root / "runs" / run_id
    (run_dir / "screenshots").mkdir(parents=True)
    (run_dir / MODEL_FRAMES).mkdir()
    (run_dir / MODEL_FRAMES / "001.png").write_bytes(b"x" * 10)
    record = {"id": run_id, "status": "running"} if age_days is None else \
        {"id": run_id, "status": "completed", "completedAt": iso(NOW - age_days * DAY)}
    (run_dir / "run.json").write_text(json.dumps(record), encoding="utf-8")
    if workspace:
        (root / "workspaces" / run_id).mkdir(parents=True)
        (root / "workspaces" / run_id / "file.txt").write_text("w", encoding="utf-8")
    return run_dir


def remaining(root: Path) -> set[str]:
    return {path.name for path in (root / "runs").iterdir()}


def test_retention_drops_old_runs_and_keeps_the_newest_count(tmp_path: Path):
    for index in range(5):
        make_run(tmp_path, f"recent-{index}", age_days=index * 0.1)
    make_run(tmp_path, "old", age_days=31)
    make_run(tmp_path, "running-old", age_days=None)
    make_run(tmp_path, "active", age_days=40)
    removed = prune_storage(tmp_path, keep_runs=3, keep_days=30, active={"active"}, now=NOW)
    # Count keeps the 3 newest finished; age removes "old"; running and active runs are never counted or touched.
    assert remaining(tmp_path) == {"recent-0", "recent-1", "recent-2", "running-old", "active"}
    assert removed["runs"] == 3
    assert removed["bytes"] > 0


def test_age_limit_wins_when_it_removes_more(tmp_path: Path):
    make_run(tmp_path, "fresh", age_days=1)
    make_run(tmp_path, "stale", age_days=3)
    prune_storage(tmp_path, keep_runs=50, keep_days=2, now=NOW)
    assert remaining(tmp_path) == {"fresh"}


def test_workspace_and_model_frames_go_a_day_after_the_run_finishes(tmp_path: Path):
    day_old = make_run(tmp_path, "day-old", age_days=1.01, workspace=True)
    young = make_run(tmp_path, "young", age_days=0.9, workspace=True)
    running = make_run(tmp_path, "running", age_days=None, workspace=True)
    removed = prune_storage(tmp_path, keep_runs=50, keep_days=30, now=NOW)
    assert not (tmp_path / "workspaces" / "day-old").exists()
    assert not (day_old / MODEL_FRAMES).exists()
    assert (day_old / "run.json").exists() and (day_old / "screenshots").exists()
    assert (tmp_path / "workspaces" / "young").exists() and (young / MODEL_FRAMES).exists()
    assert (tmp_path / "workspaces" / "running").exists() and (running / MODEL_FRAMES).exists()
    assert removed["workspaces"] == 1


def test_attachments_older_than_a_week_are_pruned(tmp_path: Path):
    attachments = tmp_path / "attachments"
    attachments.mkdir()
    old, new = attachments / "old.png", attachments / "new.png"
    old.write_bytes(b"o")
    new.write_bytes(b"n")
    os.utime(old, (NOW - 7.1 * DAY, NOW - 7.1 * DAY))
    os.utime(new, (NOW - 6.9 * DAY, NOW - 6.9 * DAY))
    removed = prune_storage(tmp_path / "data", keep_runs=50, keep_days=30, attachments=attachments, now=NOW)
    assert (removed["attachments"], old.exists(), new.exists()) == (1, False, True)


def png(width: int, height: int, mode: str = "RGB") -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, (width, height), "white").save(buffer, "PNG")
    return buffer.getvalue()


def test_screenshots_are_stored_as_jpeg_and_downscaled_past_1920(tmp_path: Path):
    wide, small = png(3024, 1964, "RGBA"), png(800, 600)
    wide_path = store_screenshot(tmp_path / "screenshots", "001-wide", wide)
    small_path = store_screenshot(tmp_path / "screenshots", "002-small", small)
    with Image.open(wide_path) as image:
        assert (image.format, image.size) == ("JPEG", (1920, 1247))
    with Image.open(small_path) as image:
        assert (image.format, image.size) == ("JPEG", (800, 600))
    # The model's copy is the untouched PNG.
    assert Path(model_image_path(str(wide_path))).read_bytes() == wide


def test_model_image_path_falls_back_to_the_stored_file(tmp_path: Path):
    stored = tmp_path / "screenshots" / "001-old.png"
    assert model_image_path(str(stored)) == str(stored)
