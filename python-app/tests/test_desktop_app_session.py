import base64
import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from PIL import Image

from app.desktop.app_session import DesktopAppSession
from app.storage import model_image_path


async def test_desktop_screenshot_uses_the_worker_image(tmp_path: Path):
    buffer = io.BytesIO()
    Image.new("RGB", (12, 8), "white").save(buffer, "PNG")
    png = buffer.getvalue()
    encoded = base64.b64encode(png).decode()
    execution = SimpleNamespace(execute=AsyncMock(return_value={
        "output": [
            {"type": "input_text", "text": "12 8"},
            {"type": "input_image", "image_url": f"data:image/png;base64,{encoded}"},
        ],
    }))
    session = DesktopAppSession(execution, tmp_path / "screenshots")
    snapshot = await session.capture_screenshot("desktop loaded")
    assert session.viewport == {"width": 12, "height": 8}
    assert session.desktop_app is True
    assert Path(snapshot["path"]).read_bytes().startswith(b"\xff\xd8")
    assert snapshot["mimeType"] == "image/jpeg"
    # The model gets the worker's exact PNG back, not the stored JPEG.
    assert Path(model_image_path(snapshot["path"])).read_bytes() == png
    assert snapshot["currentUrl"] == "desktop://primary"
    execution.execute.assert_awaited_once()
