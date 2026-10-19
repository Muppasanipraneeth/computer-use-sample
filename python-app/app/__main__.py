import asyncio
import logging
import os
import socket
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from .api import create_app
from .config import Settings, load_environment, log_dir

logger = logging.getLogger(__name__)
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
LOG_HANDLER = "jarvis-runner"


def configure_logging(directory: Path | None = None) -> Path | None:
    """Console plus rotating file logging (runner.log, 5 × 2 MB) at INFO. Returns the log file, or None when the folder
    can't be written: the runner still works, logging to the console only."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in [handler for handler in root.handlers if handler.get_name() == LOG_HANDLER]:
        root.removeHandler(handler)
        handler.close()
    formatter = logging.Formatter(LOG_FORMAT)
    console = logging.StreamHandler()
    console.set_name(LOG_HANDLER)
    console.setFormatter(formatter)
    root.addHandler(console)
    path = (directory or log_dir()) / "runner.log"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        file = RotatingFileHandler(path, maxBytes=2 * 1024 * 1024, backupCount=4, encoding="utf-8")
    except OSError:
        logger.warning("Could not open the log file %s; logging to the console only.", path, exc_info=True)
        return None
    file.set_name(LOG_HANDLER)
    file.setFormatter(formatter)
    root.addHandler(file)
    return path


def main() -> None:
    load_environment()
    configure_logging()
    settings = Settings.from_environment()
    app = create_app(settings=settings)

    class Server(uvicorn.Server):
        """Stop owned execution before Uvicorn waits for long-lived SSE clients."""
        stopping: asyncio.Task | None = None
        parent_input: asyncio.Task | None = None

        async def startup(self, sockets: list[socket.socket] | None = None) -> None:
            await super().startup(sockets)
            if os.environ.get("JARVIS_MANAGED_LAUNCH") == "1" and self.started:
                # Start only after binding: failed startup must not wait on stdin.
                self.parent_input = asyncio.create_task(self.watch_parent())

        async def watch_parent(self) -> None:
            # The launcher closes this private pipe to stop us, including on Windows
            # where sending SIGTERM would forcibly terminate Python without cleanup.
            await asyncio.to_thread(sys.stdin.buffer.read, 1)
            self.handle_exit(0, None)

        async def serve(self, sockets: list[socket.socket] | None = None) -> None:
            try:
                await super().serve(sockets)
            finally:
                if self.parent_input is not None:
                    self.parent_input.cancel()
                    await asyncio.gather(self.parent_input, return_exceptions=True)

        def handle_exit(self, sig: int, frame: object) -> None:
            if self.stopping is not None:
                return
            async def stop() -> None:
                try:
                    await app.state.manager.shutdown()
                except Exception:
                    logger.exception("Runner shutdown failed")
                finally:
                    app.state.shutdown.set()
                    self.should_exit = True
            self.stopping = asyncio.create_task(stop())

    server = Server(uvicorn.Config(app, host=settings.host, port=settings.port, log_level="info",
                                   timeout_graceful_shutdown=5))
    server.run()


if __name__ == "__main__":
    main()
