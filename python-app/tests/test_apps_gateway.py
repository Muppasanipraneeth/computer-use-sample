import asyncio
import importlib.util
import json
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from app import config
from app.apps_gateway import COMPOSIO_USER_ID, AppsGateway
from app.instruments import instrument_lines
from app.lab_catalog import instructions
from app.omp_client import omp_action_contract
from app.processes import child_environment
from app.responses_loop import build_code_tool_definitions

INSTRUMENT = Path(__file__).resolve().parents[1] / "app" / "desktop" / "apps_instrument.py"


def load_instrument():
    spec = importlib.util.spec_from_file_location("apps_instrument_under_test", INSTRUMENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def fake_composio(routes):
    """An HTTP server standing in for backend.composio.dev: routes map "METHOD /path" to (status, payload)."""
    received: list[dict] = []

    async def handle(reader, writer):
        head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
        lines = head.split("\r\n")
        method, target, _ = lines[0].split(" ")
        headers = {name.strip().lower(): value.strip() for name, _, value in (line.partition(":") for line in lines[1:] if line)}
        body = await reader.readexactly(int(headers.get("content-length", "0")))
        parts = urlsplit(target)
        received.append({"method": method, "path": parts.path, "query": parse_qs(parts.query), "headers": headers,
                         "body": json.loads(body) if body else None})
        status, payload = routes.get(f"{method} {parts.path}", (404, {"error": {"message": "unknown"}}))
        data = json.dumps(payload).encode()
        writer.write(b"HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (status, len(data)) + data)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, f"http://127.0.0.1:{port}/api/v3.1", received


def call(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


async def test_connected_accounts_are_pinned_to_the_local_user_with_the_key_injected():
    server, upstream, received = await fake_composio({"GET /api/v3.1/connected_accounts": (200, {"items": []})})
    gateway = await AppsGateway.start("ck_secret", upstream=upstream)
    try:
        status, payload = await asyncio.to_thread(call, f"{gateway.base_url}/connected_accounts?user_ids=someone-else")
        assert (status, payload) == (200, {"items": []})
        [request] = received
        assert request["headers"]["x-api-key"] == "ck_secret"
        assert request["query"]["user_ids"] == [COMPOSIO_USER_ID] == ["jarvis-local"]
        assert request["query"]["statuses"] == ["ACTIVE"]
        assert "ck_secret" not in gateway.base_url and "ck_secret" not in repr(gateway)
    finally:
        await gateway.close()
        server.close()


async def test_execute_forwards_only_arguments_as_the_local_user():
    server, upstream, received = await fake_composio(
        {"POST /api/v3.1/tools/execute/GMAIL_SEND_EMAIL": (200, {"data": {"id": "m1"}, "error": None, "successful": True})}
    )
    gateway = await AppsGateway.start("ck_secret", upstream=upstream)
    try:
        body = {"arguments": {"recipient_email": "a@b.c"}, "user_id": "victim", "custom_auth_params": {"base_url": "https://evil"},
                "connected_account_id": "ca_other"}
        status, payload = await asyncio.to_thread(call, f"{gateway.base_url}/tools/execute/gmail_send_email", "POST", body)
        assert status == 200 and payload["data"] == {"id": "m1"}
        assert received[0]["path"] == "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL"
        assert received[0]["body"] == {"user_id": "jarvis-local", "arguments": {"recipient_email": "a@b.c"}}
    finally:
        await gateway.close()
        server.close()


async def test_search_passes_only_query_toolkit_and_limit():
    server, upstream, received = await fake_composio({"GET /api/v3.1/tools": (200, {"items": []})})
    gateway = await AppsGateway.start("ck", upstream=upstream)
    try:
        url = f"{gateway.base_url}/tools?query=send+email&toolkit_slug=gmail,slack&limit=500&include_deprecated=true&tool_slugs=X"
        assert (await asyncio.to_thread(call, url))[0] == 200
        assert received[0]["query"] == {"query": ["send email"], "toolkit_slug": ["gmail,slack"], "limit": ["50"]}
    finally:
        await gateway.close()
        server.close()


@pytest.mark.parametrize(("method", "path"), [
    ("POST", "/auth_configs"),
    ("GET", "/auth_configs"),
    ("POST", "/connected_accounts/link"),
    ("DELETE", "/connected_accounts/ca_1"),
    ("GET", "/connected_accounts/ca_1"),
    ("POST", "/tools/execute/proxy"),
    ("POST", "/tools/execute/proxy/../../auth_configs"),
    ("POST", "/tools/execute/GMAIL_SEND_EMAIL/input"),
    ("GET", "/tools/execute/GMAIL_SEND_EMAIL"),
    ("GET", "/toolkits"),
])
async def test_everything_else_is_404_and_never_reaches_composio(method, path):
    server, upstream, received = await fake_composio({})
    gateway = await AppsGateway.start("ck", upstream=upstream)
    try:
        status, _ = await asyncio.to_thread(call, f"{gateway.base_url}{path}", method, {} if method == "POST" else None)
        assert status == 404
        wrong_secret = gateway.base_url.rsplit("/", 1)[0] + "/not-the-secret/connected_accounts"
        assert (await asyncio.to_thread(call, wrong_secret))[0] == 404
        assert received == []
    finally:
        await gateway.close()
        server.close()


async def test_rejected_key_is_reported_without_composio_text():
    server, upstream, _ = await fake_composio({"GET /api/v3.1/connected_accounts": (401, {"error": {"message": "key ck_bad invalid"}})})
    gateway = await AppsGateway.start("ck_bad", upstream=upstream)
    try:
        status, payload = await asyncio.to_thread(call, f"{gateway.base_url}/connected_accounts")
        assert status == 401
        assert "ck_bad" not in json.dumps(payload) and "Jarvis Settings" in payload["error"]["message"]
    finally:
        await gateway.close()
        server.close()


async def test_apps_instrument_lists_searches_and_runs_through_the_gateway():
    long_text = "x" * 5000
    server, upstream, received = await fake_composio({
        "GET /api/v3.1/connected_accounts": (200, {"items": [
            {"status": "ACTIVE", "toolkit": {"slug": "slack"}}, {"status": "ACTIVE", "toolkit": {"slug": "gmail"}},
            {"status": "ACTIVE", "toolkit": {"slug": "gmail"}},
        ]}),
        "GET /api/v3.1/tools": (200, {"items": [{
            "slug": "GMAIL_SEND_EMAIL", "toolkit": {"slug": "gmail"}, "description": "Send an email.\n  Supports HTML.",
            "input_parameters": {"type": "object", "required": ["recipient_email"], "properties": {
                "recipient_email": {"type": "string", "description": "Who gets it"}, "is_html": {"type": "boolean"}}},
        }]}),
        "POST /api/v3.1/tools/execute/GMAIL_FETCH_EMAILS": (200, {
            "data": {"messages": [{"body": long_text}] * 3, "ids": list(range(40))}, "successful": True}),
        "POST /api/v3.1/tools/execute/SLACK_SEND_MESSAGE": (200, {"data": {}, "error": "channel_not_found", "successful": False}),
    })
    gateway = await AppsGateway.start("ck", upstream=upstream)
    try:
        apps = load_instrument().ConnectedApps(gateway.base_url)
        assert await asyncio.to_thread(apps.connected) == ["gmail", "slack"]
        hits = await asyncio.to_thread(apps.search, "send email")
        assert received[-1]["query"]["toolkit_slug"] == ["gmail,slack"], "search defaults to the connected apps"
        assert hits == [{"tool": "GMAIL_SEND_EMAIL", "app": "gmail", "description": "Send an email. Supports HTML.",
                         "inputs": {"recipient_email": "string, required: Who gets it", "is_html": "boolean"}}]
        data = await asyncio.to_thread(apps.run, "GMAIL_FETCH_EMAILS", {"max_results": 40})
        assert len(data["ids"]) == 26 and data["ids"][-1] == "… 15 more"
        assert data["messages"][0]["body"].endswith("… (trimmed)") and len(json.dumps(data)) <= 20_000
        with pytest.raises(RuntimeError, match="SLACK_SEND_MESSAGE failed: channel_not_found"):
            await asyncio.to_thread(apps.run, "SLACK_SEND_MESSAGE", {"channel": "#nope", "text": "hi"})
        with pytest.raises(RuntimeError, match="apps: Not Found"):
            await asyncio.to_thread(apps.run, "../auth_configs", {})
    finally:
        await gateway.close()
        server.close()


def test_run_result_is_cut_to_the_limit_when_trimming_is_not_enough():
    module = load_instrument()
    apps = module.ConnectedApps("http://127.0.0.1:9/unused")
    apps._call = lambda *args: {"data": {f"k{index}": "y" * 1500 for index in range(40)}, "successful": True}
    result = apps.run("GMAIL_FETCH_EMAILS")
    assert isinstance(result, str) and len(result) <= module.RESULT_LIMIT + 20 and result.endswith("… (trimmed)")


def test_child_environment_drops_the_composio_key(monkeypatch):
    monkeypatch.setenv("COMPOSIO_API_KEY", "ck_secret")
    assert "COMPOSIO_API_KEY" not in child_environment()


def test_composio_key_comes_from_the_shell_or_a_fresh_read_of_env(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    assert config.composio_api_key() == ""
    (tmp_path / ".env").write_text('COMPOSIO_API_KEY=" ck_file "\n', encoding="utf-8")
    assert config.composio_api_key() == "ck_file"
    monkeypatch.setenv("COMPOSIO_API_KEY", "ck_shell")
    assert config.composio_api_key() == "ck_shell"


def test_instructions_mention_apps_only_when_configured():
    without = instructions("any-task", "desktop://primary", platform="darwin", web=True)
    with_apps = instructions("any-task", "desktop://primary", platform="darwin", web=True, apps=True)
    assert "apps." not in without and "Composio" not in without
    assert "apps.run(" in with_apps and "apps.search(" in with_apps and "apps.connected()" in with_apps
    assert "with web instead" in with_apps, "falls back to the browser"
    assert "confirm" in with_apps and "explicitly asked you to send" in with_apps
    assert not any("apps" in line for line in instrument_lines(web=False, apps=True)), "no web instruments, no apps text"
    tool_text = build_code_tool_definitions("darwin", desktop_app=True, web=True, apps=True)[0]["parameters"]["properties"]["code"]["description"]
    assert "apps.run(" in tool_text
    assert "web, read and apps instruments" in omp_action_contract(web=True, apps=True)
    assert "apps" not in omp_action_contract(web=True)
