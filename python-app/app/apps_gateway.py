"""Per-run local gateway that adds the Composio key so model code can use connected apps without ever seeing it.

The worker knows only ``{base_url}`` (127.0.0.1, random port, secret first path segment). Three routes exist; each is
rebuilt into a fixed Composio REST v3.1 request (https://docs.composio.dev/reference) with ``x-api-key`` injected and
the user pinned to the desktop app's single Composio user (desktop/connections.mjs COMPOSIO_USER_ID):

  GET  {base}/connected_accounts          → GET  /connected_accounts?user_ids=jarvis-local&statuses=ACTIVE
  GET  {base}/tools?query=&toolkit_slug=  → GET  /tools?…   (tool search; only query, toolkit_slug and limit pass)
  POST {base}/tools/execute/{TOOL_SLUG}   → POST /tools/execute/{TOOL_SLUG} with {"user_id", "arguments"} only

Anything else answers 404 without reaching Composio, so model code cannot create auth configs, delete connections,
run tools as another user, or send custom credentials.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus

COMPOSIO_API = "https://backend.composio.dev/api/v3.1"
COMPOSIO_USER_ID = "jarvis-local"
UPSTREAM_TIMEOUT = 25.0  # below the worker's own 30 s, so Composio's error comes back instead of a bare timeout

_MAX_HEAD = 64 * 1024
_MAX_BODY = 1024 * 1024
_MAX_RESPONSE = 4 * 1024 * 1024
# Tool slugs are TOOLKIT_ACTION; requiring the underscore also keeps /tools/execute/proxy (raw API calls) unreachable.
_TOOL_SLUG = re.compile(r"[A-Za-z0-9]+_[A-Za-z0-9_]{1,127}")
_TOOLKITS = re.compile(r"[a-z0-9_-]{1,64}(?:,[a-z0-9_-]{1,64}){0,31}")
_SEARCH_LIMIT = 50


class _Rejected(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _error_body(message: str) -> bytes:
    return json.dumps({"error": {"message": message}}).encode()


class AppsGateway:
    def __init__(self, server: asyncio.base_events.Server, secret: str, api_key: str, upstream: str) -> None:
        self._server = server
        self._secret = secret
        self._api_key = api_key
        self._upstream = upstream.rstrip("/")
        self._connections: set[asyncio.Task] = set()
        port = server.sockets[0].getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}/{secret}"

    def __repr__(self) -> str:  # Never expose the key.
        return f"AppsGateway({self.base_url!r})"

    @classmethod
    async def start(cls, api_key: str, *, upstream: str = COMPOSIO_API) -> AppsGateway:
        holder: list[AppsGateway] = []

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
        gateway = cls(server, secrets.token_urlsafe(24), api_key, upstream)
        holder.append(gateway)
        return gateway

    def _route(self, method: str, path: str, raw_query: str, body: bytes) -> tuple[str, str, bytes | None]:
        """The Composio request for one allowed local route; anything else is rejected before the network."""
        if method == "GET" and path == "connected_accounts":
            query = urllib.parse.urlencode({"user_ids": COMPOSIO_USER_ID, "statuses": "ACTIVE", "limit": 100})
            return "GET", f"{self._upstream}/connected_accounts?{query}", None
        if method == "GET" and path == "tools":
            given = urllib.parse.parse_qs(raw_query, keep_blank_values=False)
            search: dict[str, str] = {}
            text = given.get("query", [""])[-1].strip()
            if text:
                search["query"] = text[:200]
            toolkits = given.get("toolkit_slug", [""])[-1].strip().lower()
            if toolkits:
                if not _TOOLKITS.fullmatch(toolkits):
                    raise _Rejected(400, "toolkit_slug must be app slugs like gmail or gmail,slack.")
                search["toolkit_slug"] = toolkits
            if not search:
                raise _Rejected(400, "Give a search query or an app.")
            try:
                limit = int(given.get("limit", ["10"])[-1])
            except ValueError:
                limit = 10
            search["limit"] = str(max(1, min(limit, _SEARCH_LIMIT)))
            return "GET", f"{self._upstream}/tools?{urllib.parse.urlencode(search)}", None
        if method == "POST" and path.startswith("tools/execute/"):
            slug = path[len("tools/execute/"):]
            if not _TOOL_SLUG.fullmatch(slug):
                raise _Rejected(404, "Not Found")
            try:
                payload = json.loads(body or b"{}")
            except ValueError:
                raise _Rejected(400, "The request body must be JSON.") from None
            arguments = payload.get("arguments", {}) if isinstance(payload, dict) else None
            if not isinstance(arguments, dict):
                raise _Rejected(400, "arguments must be a JSON object.")
            upstream_body = json.dumps({"user_id": COMPOSIO_USER_ID, "arguments": arguments}).encode()
            return "POST", f"{self._upstream}/tools/execute/{slug.upper()}", upstream_body
        raise _Rejected(404, "Not Found")

    def _forward(self, method: str, url: str, data: bytes | None) -> tuple[int, bytes]:
        headers = {"x-api-key": self._api_key, "accept": "application/json"}
        if data is not None:
            headers["content-type"] = "application/json"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
                status, body = response.status, response.read(_MAX_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read(_MAX_RESPONSE + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            return 502, _error_body(f"Could not reach Composio: {reason}")
        if len(body) > _MAX_RESPONSE:
            return 502, _error_body("Composio's answer was larger than 4 MiB.")
        if status in (401, 403):
            # Composio's own text may echo key details; the model needs only what to tell the user.
            return status, _error_body("Composio rejected the API key. Ask the user to check it in Jarvis Settings.")
        return status, body

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            try:
                head = await reader.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
                return
            lines = head[:-4].decode("latin-1").split("\r\n")
            parts = lines[0].split(" ")
            prefix = f"/{self._secret}/"
            try:
                if (
                    len(parts) != 3
                    or not parts[1].startswith(prefix)
                    or not secrets.compare_digest(parts[1][: len(prefix)], prefix)
                ):
                    raise _Rejected(404, "Not Found")
                method, target = parts[0], parts[1]
                path, _, raw_query = target[len(prefix):].partition("?")
                length = 0
                for line in lines[1:]:
                    name, _, value = line.partition(":")
                    if name.strip().lower() == "content-length":
                        length = int(value.strip()) if value.strip().isdigit() else -1
                if length < 0 or length > _MAX_BODY:
                    raise _Rejected(413, "The request body is too large.")
                body = await reader.readexactly(length) if length else b""
                request = self._route(method, path, raw_query, body)
            except _Rejected as rejected:
                status, payload = rejected.status, _error_body(str(rejected))
            else:
                status, payload = await asyncio.to_thread(self._forward, *request)
            try:
                phrase = HTTPStatus(status).phrase
            except ValueError:
                phrase = "Status"
            writer.write(
                f"HTTP/1.1 {status} {phrase}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
                "Connection: close\r\n\r\n".encode("latin-1") + payload
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def close(self) -> None:
        self._server.close()
        for task in list(self._connections):
            task.cancel()
        await asyncio.gather(*self._connections, return_exceptions=True)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._server.wait_closed(), 2)
