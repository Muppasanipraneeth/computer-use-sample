"""Persistent local PyAutoGUI REPL. The app owns browser setup and artifact retention."""

import base64
import contextlib
import ctypes
import io
import json
import os
import signal
import sys
import threading
import time
import traceback
from typing import Any

from PIL import Image


def emit(payload):
    if sys.__stdout__ is None:
        raise RuntimeError("Worker stdout is unavailable.")
    sys.__stdout__.write(json.dumps(payload) + "\n")
    sys.__stdout__.flush()


def enable_dpi_awareness() -> None:
    """Make Windows clicks use the same pixel grid as the screenshot on a scaled display."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        ctypes.windll.user32.SetProcessDPIAware()


def check_desktop(pyautogui):
    width, height = pyautogui.size()
    if width <= 0 or height <= 0:
        raise RuntimeError("No local desktop is available. Start the runner in a graphical desktop session.")
    if sys.platform == "darwin":
        services = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        services.AXIsProcessTrusted.restype = ctypes.c_bool
        if not services.AXIsProcessTrusted():
            raise RuntimeError(
                "macOS Accessibility permission is required to use the mouse and keyboard. Turn on Jarvis in System Settings > Privacy & Security > Accessibility (or the Terminal app, if you started the runner yourself), then retry."
            )
        import Quartz

        if not Quartz.CGPreflightScreenCaptureAccess():
            raise RuntimeError(
                "macOS Screen Recording permission is required to see the screen. Turn on Jarvis in System Settings > Privacy & Security > Screen Recording (or the Terminal app, if you started the runner yourself), then quit and reopen Jarvis."
            )
    return width, height


def normalize_screenshots(pyautogui):
    # Retina screenshots use physical pixels while input uses logical points.
    # Return images in the same coordinate system as click/moveTo/dragTo.
    capture = pyautogui.screenshot

    def screenshot(imageFilename=None, region=None, **kwargs):
        image = capture(**kwargs)
        size = tuple(pyautogui.size())
        if image.size != size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        if region is not None:
            x, y, width, height = region
            image = image.crop((x, y, x + width, y + height))
        if imageFilename is not None:
            image.save(imageFilename)
        return image

    pyautogui.screenshot = screenshot


def execute(code, namespace):
    output: list[dict[str, Any]] = []
    text_bytes = 0
    image_bytes = 0

    def log(*values):
        nonlocal text_bytes
        text = " ".join(str(value) for value in values)
        text_bytes += len(text.encode("utf-8"))
        if text_bytes > 60 * 1024 or len(output) >= 250:
            raise ValueError("Python text output exceeds its size limit.")
        output.append({"type": "input_text", "text": text})

    def display(value):
        nonlocal image_bytes
        if isinstance(value, Image.Image):
            buffer = io.BytesIO()
            value.save(buffer, format="PNG")
            value = buffer.getvalue()
        if not isinstance(value, bytes) or not value.startswith(b"\x89PNG\r\n\x1a\n"):
            raise TypeError("display expects a Pillow image or PNG bytes.")
        image_bytes += len(value)
        if image_bytes > 8 * 1024 * 1024 or len(output) >= 250:
            raise ValueError("Python image output exceeds its size limit.")
        output.append(
            {
                "type": "input_image",
                "detail": "original",
                "image_url": "data:image/png;base64," + base64.b64encode(value).decode("ascii"),
            }
        )

    class Writer:
        def write(self, text):
            if text.strip():
                log(text)
            return len(text)

        def flush(self):
            pass

    namespace.update(log=log, display=display)
    # The runner interrupts code that overruns its deadline (SIGINT → KeyboardInterrupt), so only this exec can be
    # interrupted; outside it the signal is ignored, and an interrupt racing a finished step can't kill the worker.
    if os.name != "nt":
        signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        with contextlib.redirect_stdout(Writer()), contextlib.redirect_stderr(Writer()):
            exec(compile(code, "<exec_py>", "exec"), namespace)  # noqa: S102 - Deliberate isolated model-code worker.
    except BaseException as error:  # noqa: BLE001 - Report arbitrary model errors and retain the REPL.
        failsafe = getattr(namespace.get("pyautogui"), "FailSafeException", ())
        if isinstance(error, failsafe):
            return {"error": {"code": "python_failsafe", "message": "Desktop fail-safe activated."}}
        # Preserve partial output and globals so the model can correct its code.
        output.append({"type": "input_text", "text": traceback.format_exc()[-4000:]})
    finally:
        if os.name != "nt":
            signal.signal(signal.SIGINT, signal.SIG_IGN)
    return {"output": output or [{"type": "input_text", "text": "exec_py completed with no output."}]}


def serve_requests(namespace, stream):
    terminal_error = None
    for line in stream:
        if len(line.encode("utf-8")) > 512 * 1024:
            raise ValueError("Python request exceeds its size limit.")
        request = json.loads(line)
        if not isinstance(request, dict):
            raise TypeError("Python request must be an object.")
        operation = request.get("operation")
        if terminal_error is not None:
            emit({"id": request.get("id"), "error": terminal_error})
            continue
        if operation != "execute":
            emit(
                {
                    "id": request.get("id"),
                    "error": {
                        "code": "unsupported_python_operation",
                        "message": "Only the execute operation is supported.",
                    },
                }
            )
            continue
        code = request.get("code")
        if not isinstance(code, str) or not code.strip() or len(code.encode("utf-8")) > 64 * 1024:
            raise ValueError("Python code must be nonempty and at most 64 KiB.")
        result = execute(code, namespace)
        terminal_error = result.get("error")
        emit({"id": request.get("id"), **result})


def check_screenshot(pyautogui, expected_size):
    image = pyautogui.screenshot()
    if tuple(pyautogui.size()) != expected_size or image.size != expected_size:
        raise RuntimeError("Desktop screenshot dimensions changed. Start a new run.")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    if len(buffer.getvalue()) > 8 * 1024 * 1024:
        raise RuntimeError("Desktop screenshot exceeds 8 MiB.")


def load_instrument(name):
    """Instrument modules sit beside this file; the worker runs as a plain script, not as part of the app package."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, os.path.join(os.path.dirname(os.path.abspath(__file__)), f"{name}.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if os.name != "nt":
        signal.signal(signal.SIGINT, signal.SIG_IGN)  # see execute: only model code is interruptible
    enable_dpi_awareness()
    import pyautogui

    width, height = check_desktop(pyautogui)
    normalize_screenshots(pyautogui)
    check_screenshot(pyautogui, (width, height))
    namespace = {"__builtins__": __builtins__, "pyautogui": pyautogui}
    if os.environ.get("JARVIS_WEB_INSTRUMENTS") == "1":
        web_instruments = load_instrument("web_instruments")
        namespace.update(read=web_instruments.read, web=web_instruments.web)
    if os.environ.get("JARVIS_APPS_GATEWAY"):
        namespace.update(apps=load_instrument("apps_instrument").apps)
    if os.environ.get("JARVIS_MEMORY_FILE"):
        memory = load_instrument("memory_instrument")
        namespace.update(remember=memory.remember, forget=memory.forget)
    emit({"ready": True, "platform": sys.platform})
    if "--check" in sys.argv:
        return
    if os.name != "nt":
        parent = os.getppid()

        def watch_parent():
            while True:
                time.sleep(1)
                if os.getppid() != parent:
                    os.killpg(os.getpgrp(), signal.SIGKILL)

        threading.Thread(target=watch_parent, daemon=True).start()
    serve_requests(namespace, sys.stdin)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:  # noqa: BLE001 - The parent requires a protocol error for any startup failure.
        emit({"error": f"{type(error).__name__}: {error}"[:4000]})
        sys.exit(1)
