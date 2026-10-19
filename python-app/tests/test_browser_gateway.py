import asyncio
from urllib.parse import urlsplit

from app.browser_gateway import BrowserGateway
from app.lab_catalog import instructions
from app.processes import child_environment


async def fake_upstream(handler):
    received: list[bytes] = []

    async def handle(reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        received.append(head)
        await handler(head, reader, writer)
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1], received


async def open_gateway(port):
    return await BrowserGateway.start("ACC", "TOKEN", upstream_host="127.0.0.1", upstream_port=port, upstream_tls=False)


async def test_post_is_forwarded_with_token():
    async def respond(head, reader, writer):
        length = int(next(line.split(b":")[1] for line in head.split(b"\r\n") if line.lower().startswith(b"content-length")))
        body = await reader.readexactly(length)
        payload = b'{"success":true,"result":"' + body.replace(b'"', b"'") + b'"}'
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(payload) + payload)
        await writer.drain()

    server, port, received = await fake_upstream(respond)
    gateway = await open_gateway(port)
    try:
        parts = urlsplit(gateway.base_url)
        reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
        body = b'{"url":"https://example.com"}'
        writer.write(
            f"POST {parts.path}/markdown?browser=kitesurf HTTP/1.1\r\nHost: {parts.netloc}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body
        )
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        head = received[0].decode()
        assert head.startswith("POST /client/v4/accounts/ACC/browser-run/markdown?browser=kitesurf HTTP/1.1\r\n")
        assert "\r\nAuthorization: Bearer TOKEN\r\n" in head
        assert f"\r\nHost: 127.0.0.1:{port}\r\n" in head
        assert parts.netloc not in head
        assert "Connection: close" in head
        assert response.startswith(b"HTTP/1.1 200 OK")
        assert response.endswith(b"""{"success":true,"result":"{'url':'https://example.com'}"}""")
    finally:
        await gateway.close()
        server.close()


async def test_wrong_secret_is_404_and_never_reaches_upstream():
    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")

    server, port, received = await fake_upstream(respond)
    gateway = await open_gateway(port)
    try:
        parts = urlsplit(gateway.base_url)
        reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
        writer.write(b"GET /wrong-secret/markdown HTTP/1.1\r\nHost: x\r\n\r\n")
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        assert response.startswith(b"HTTP/1.1 404")
        assert received == []
        assert "TOKEN" not in repr(gateway)
    finally:
        await gateway.close()
        server.close()


async def test_paths_that_could_climb_out_of_browser_run_never_reach_upstream():
    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")

    server, port, received = await fake_upstream(respond)
    gateway = await open_gateway(port)
    secret_path = urlsplit(gateway.base_url).path
    try:
        for rest in ("../../../user/tokens", "%2e%2e/%2e%2e/user/tokens", "markdown//x", "markdown?u=a%0d%0aX:y", ""):
            parts = urlsplit(gateway.base_url)
            reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
            writer.write(f"GET {secret_path}/{rest} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), 5)
            writer.close()
            assert response.startswith(b"HTTP/1.1 404"), rest
        assert received == []
    finally:
        await gateway.close()
        server.close()


async def test_websocket_upgrade_keeps_headers_and_pipes_both_ways():
    async def respond(head, reader, writer):
        writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
        await writer.drain()
        frame = await reader.readexactly(4)
        writer.write(b"echo:" + frame)
        await writer.drain()

    server, port, received = await fake_upstream(respond)
    gateway = await open_gateway(port)
    try:
        parts = urlsplit(gateway.base_url)
        reader, writer = await asyncio.open_connection(parts.hostname, parts.port)
        writer.write(
            f"GET {parts.path}/devtools/browser?keep_alive=600000 HTTP/1.1\r\nHost: {parts.netloc}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc==\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        await writer.drain()
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        assert head.startswith(b"HTTP/1.1 101")
        writer.write(b"ping")
        await writer.drain()
        assert await asyncio.wait_for(reader.readexactly(9), 5) == b"echo:ping"
        writer.close()
        upstream_head = received[0].decode()
        assert upstream_head.startswith("GET /client/v4/accounts/ACC/browser-run/devtools/browser?keep_alive=600000 HTTP/1.1")
        assert "\r\nUpgrade: websocket" in upstream_head
        assert "\r\nConnection: Upgrade" in upstream_head
        assert "\r\nSec-WebSocket-Key: abc==" in upstream_head
        assert "Authorization: Bearer TOKEN" in upstream_head
        assert "Connection: close" not in upstream_head
    finally:
        await gateway.close()
        server.close()


def test_child_environment_drops_cloudflare_credentials(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "secret")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acc")
    environment = child_environment()
    assert "CLOUDFLARE_API_TOKEN" not in environment
    assert "CLOUDFLARE_ACCOUNT_ID" not in environment


def test_any_task_instructions_send_lookups_to_the_background_browser():
    local = instructions("any-task", "desktop://primary", platform="darwin", web=True)
    cloud = instructions("any-task", "desktop://primary", platform="darwin", web=True, cloud=True)
    for text in (local, cloud):
        assert "web.goto(url)" in text and "read(url)" in text
        assert "Never use it to browse the web." in text  # pyautogui is not for lookups
    assert "headless Chromium on this computer" in local and "Cloudflare" not in local.split("Background instruments")[1]
    assert "Cloudflare's cloud" in cloud
    # Only the local browser keeps the user's logins, so only it points them at the Settings sign-in.
    assert "Settings → Connections → Sign in to websites" in local and "do not try credentials" in local
    assert "Sign in to websites" not in cloud
    without_web = instructions("any-task", "desktop://primary", platform="darwin")
    assert "web.goto(url)" not in without_web and "read(url)" not in without_web
