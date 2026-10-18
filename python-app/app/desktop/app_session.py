"""Screenshot the real desktop when the target is Unreal Editor."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ..errors import RunnerCoreError
from .input_rules import desktop_permission_hint


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class DesktopAppSession:
    """PyAutoGUI target. No lab browser is opened."""

    desktop_app = True
    mode = "headful"
    target_label = "Unreal Editor"

    def __init__(self, execution: Any, screenshot_dir: Path) -> None:
        self.execution = execution
        self.screenshot_dir = screenshot_dir
        self.viewport = {"width": 1, "height": 1}
        self.page = SimpleNamespace(url="desktop://primary")
        self._count = 0

    async def frontmost(self) -> None:
        return None

    async def read_state(self) -> dict[str, str]:
        return {"currentUrl": "desktop://primary", "pageTitle": self.target_label}

    async def close(self) -> None:
        return None

    async def capture_screenshot(self, label: str) -> dict[str, Any]:
        result = await self.execution.execute(
            "image = pyautogui.screenshot()\nlog('%d %d' % image.size)\ndisplay(image)\n"
        )
        output = result.get("output") if isinstance(result, dict) else None
        hint = desktop_permission_hint(getattr(self.execution, "platform", ""))
        if not isinstance(output, list):
            raise RunnerCoreError("Desktop screenshot returned no image.", code="desktop_unavailable", status_code=400, hint=hint)
        text = next((item.get("text") for item in output if item.get("type") == "input_text"), "")
        image = next((item for item in output if item.get("type") == "input_image"), None)
        parts = str(text).split()
        if image is None or len(parts) != 2 or not all(part.isdigit() for part in parts):
            raise RunnerCoreError("Desktop screenshot returned no image.", code="desktop_unavailable", status_code=400, hint=hint)
        width, height = int(parts[0]), int(parts[1])
        encoded = str(image["image_url"]).split(",", 1)[1]
        self._count += 1
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        safe = "".join(char if char.isalnum() else "-" for char in label)[:40] or "frame"
        path = self.screenshot_dir / f"{self._count:03d}-{safe}.png"
        path.write_bytes(base64.b64decode(encoded))
        self.viewport = {"width": width, "height": height}
        return {
            "id": f"screenshot-{self._count}",
            "label": label,
            "path": str(path),
            "mimeType": "image/png",
            "capturedAt": _timestamp(),
            "currentUrl": self.page.url,
            "pageTitle": self.target_label,
        }
