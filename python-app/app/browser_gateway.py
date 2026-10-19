"""Per-run local proxy that adds the Cloudflare token so model code never sees it.

A request to ``{base_url}/{rest}`` is forwarded to
``/client/v4/accounts/{account_id}/browser-run/{rest}`` on the Cloudflare API with
``Authorization: Bearer`` injected. After the request head, bytes are piped both
ways, which serves both Quick Action POSTs and the CDP WebSocket.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import secrets
import ssl

_MAX_HEAD = 64 * 1024
_DROPPED = {"host", "authorization", "connection", "proxy-authorization"}
# Browser Run paths are plain segments (devtools/browser/<session>/page/<target>, markdown, json, …). Rejecting
# dots, percent-escapes and empty segments keeps `..` (raw or encoded) from climbing out of /browser-run/.
_REST_PATH = re.compile(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*")
_REST_QUERY = re.compile(r"[A-Za-z0-9_=&.-]*")


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        with contextlib.suppress(Exception):
            if writer.can_write_eof():
                writer.write_eof()


class BrowserGateway:
    def __init__(self, server: asyncio.base_events.Server, secret: str, account_id: str, api_token: str,
                 upstream_host: str, upstream_port: int, upstream_tls: bool) -> None:
        self._server = server
        self._secret = secret
        self._account_id = account_id
        self._api_token = api_token
        self._upstream_host = upstream_host
        self._upstream_port = upstream_port
        self._upstream_tls = upstream_tls
        self._connections: set[asyncio.Task] = set()
        port = server.sockets[0].getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}/{secret}"

    def __repr__(self) -> str:  # Never expose the token.
        return f"BrowserGateway({self.base_url!r})"

    @classmethod
    async def start(cls, account_id: str, api_token: str, *, upstream_host: str = "api.cloudflare.com",
                    upstream_port: int = 443, upstream_tls: bool = True) -> BrowserGateway:
        holder: list[BrowserGateway] = []

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            gateway = holder[0]
            task = asyncio.current_task()
            if task is not None:
                gateway._connections.add(task)
            try:
                await gateway._handle(reader, writer)
            finally:
                if task is not None:
                    gateway._connections.discard(task)

        server = await asyncio.start_server(handle, "127.0.0.1", 0, limit=_MAX_HEAD)
        gateway = cls(server, secrets.token_urlsafe(24), account_id, api_token, upstream_host, upstream_port, upstream_tls)
        holder.append(gateway)
        return gateway

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        upstream_writer: asyncio.StreamWriter | None = None
        try:
            try:
                head = await reader.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
                return
            lines = head[:-4].decode("latin-1").split("\r\n")
            parts = lines[0].split(" ")
            prefix = f"/{self._secret}/"
            rest_path, _, rest_query = parts[1][len(prefix):].partition("?") if len(parts) == 3 else ("", "", "")
            if (
                len(parts) != 3
                or not parts[1].startswith(prefix)
                or not secrets.compare_digest(parts[1][: len(prefix)], prefix)
                or not _REST_PATH.fullmatch(rest_path)
                or not _REST_QUERY.fullmatch(rest_query)
            ):
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found")
                await writer.drain()
                return
            method, target, version = parts
            rest = target[len(prefix):]
            headers = []
            upgrade = False
            for line in lines[1:]:
                name, _, value = line.partition(":")
                key = name.strip().lower()
                if key == "upgrade":
                    upgrade = True
                if key in _DROPPED:
                    if key == "connection" and "upgrade" in value.lower():
                        headers.append(f"{name}:{value}")
                    continue
                headers.append(line)
            path = f"/client/v4/accounts/{self._account_id}/browser-run/{rest}"
            host = self._upstream_host if self._upstream_port in (80, 443) else f"{self._upstream_host}:{self._upstream_port}"
            out = [f"{method} {path} {version}", f"Host: {host}", f"Authorization: Bearer {self._api_token}", *headers]
            if not upgrade:
                out.append("Connection: close")
            context = ssl.create_default_context() if self._upstream_tls else None
            upstream_reader, upstream_writer = await asyncio.open_connection(
                self._upstream_host, self._upstream_port, ssl=context,
                server_hostname=self._upstream_host if context else None,
            )
            upstream_writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
            await upstream_writer.drain()
            sending = asyncio.create_task(_pipe(reader, upstream_writer))
            if upgrade:
                # A WebSocket client leaving ends the upstream browser session too.
                upstream = upstream_writer

                def close_upstream(_: asyncio.Task[None]) -> None:
                    upstream.close()

                sending.add_done_callback(close_upstream)
            try:
                await _pipe(upstream_reader, writer)
            finally:
                sending.cancel()
                await asyncio.gather(sending, return_exceptions=True)
        except (ConnectionError, OSError, ssl.SSLError):
            with contextlib.suppress(Exception):
                if upstream_writer is None:
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        finally:
            for item in (upstream_writer, writer):
                if item is not None:
                    item.close()
                    with contextlib.suppress(Exception):
                        await item.wait_closed()

    async def close(self) -> None:
        self._server.close()
        for task in list(self._connections):
            task.cancel()
        await asyncio.gather(*self._connections, return_exceptions=True)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._server.wait_closed(), 2)
