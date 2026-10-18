import base64
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.desktop.app_session import DesktopAppSession


async def test_desktop_screenshot_uses_the_worker_image(tmp_path: Path):
    png = b"\x89PNG\r\n\x1a\n" + b"rest"
    encoded = base64.b64encode(png).decode()
    execution = SimpleNamespace(execute=AsyncMock(return_value={
        "output": [
            {"type": "input_text", "text": "12 8"},
            {"type": "input_image", "image_url": f"data:image/png;base64,{encoded}"},
        ],
    }))
    session = DesktopAppSession(execution, tmp_path)
    snapshot = await session.capture_screenshot("desktop loaded")
    assert session.viewport == {"width": 12, "height": 8}
    assert session.desktop_app is True
    assert Path(snapshot["path"]).read_bytes() == png
    assert snapshot["currentUrl"] == "desktop://primary"
    execution.execute.assert_awaited_once()
