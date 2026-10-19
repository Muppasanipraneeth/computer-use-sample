"""apps: the Gmail, Slack, X and other accounts the user connected in Jarvis Settings, through Composio's tools. Only the
runner's local gateway URL is known here (JARVIS_APPS_GATEWAY), never the Composio key. Standard library only: the
worker loads this file directly."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

RESULT_LIMIT = 20_000
TIMEOUT = 30  # above the gateway's 25 s upstream deadline, and well inside the runner's 60 s step limit
_DESCRIPTION_LIMIT = 240
_INPUT_LIMIT = 120
_STRING_LIMIT = 2_000
_LIST_LIMIT = 25


def _trim(value: Any) -> Any:
    """Long strings and lists shortened in place of the whole result, so the structure stays usable from code."""
    if isinstance(value, str):
        return value if len(value) <= _STRING_LIMIT else value[:_STRING_LIMIT] + "… (trimmed)"
    if isinstance(value, list):
        items = [_trim(item) for item in value[:_LIST_LIMIT]]
        return items + ([f"… {len(value) - _LIST_LIMIT} more"] if len(value) > _LIST_LIMIT else [])
    if isinstance(value, dict):
        return {key: _trim(item) for key, item in value.items()}
    return value


def _summary(schema: Any) -> dict[str, str]:
    """{"to": "string, required: Recipient email", …} from a tool's JSON-schema input_parameters."""
    if not isinstance(schema, dict):
        return {}
    required = set(schema.get("required") or [])
    inputs = {}
    for name, spec in (schema.get("properties") or {}).items():
        spec = spec if isinstance(spec, dict) else {}
        kind = spec.get("type") or ("one of " + "/".join(map(str, spec["enum"])) if spec.get("enum") else "any")
        text = f"{kind}{', required' if name in required else ''}"
        description = " ".join(str(spec.get("description") or "").split())
        inputs[name] = f"{text}: {description[:_INPUT_LIMIT]}" if description else text
    return inputs


class ConnectedApps:
    def __init__(self, gateway: str) -> None:
        self._gateway = gateway.rstrip("/")

    def __repr__(self) -> str:
        return "apps: apps.connected(), apps.search(query, app=None), apps.run(tool_slug, arguments)"

    def _call(self, method: str, path: str, body: dict | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"content-type": "application/json"} if data is not None else {}
        request = urllib.request.Request(self._gateway + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                problem = json.loads(raw).get("error")
            except (ValueError, AttributeError):
                problem = None
            message = problem.get("message") if isinstance(problem, dict) else problem
            raise RuntimeError(f"apps: {message or f'HTTP {error.code}'}") from None
        except (urllib.error.URLError, TimeoutError) as error:
            raise RuntimeError(f"apps: the connection gateway did not answer ({getattr(error, 'reason', error)}).") from None
        return json.loads(raw or b"{}")

    def connected(self) -> list[str]:
        """Slugs of the apps with a working connection, e.g. ["gmail", "slack"]."""
        items = self._call("GET", "/connected_accounts").get("items") or []
        return sorted({item["toolkit"]["slug"] for item in items if item.get("status") == "ACTIVE" and item.get("toolkit")})

    def search(self, query: str, app: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
        """Tools matching what you want to do, in the given app or else across connected apps:
        [{"tool": "GMAIL_SEND_EMAIL", "app": "gmail", "description": …, "inputs": {name: "type, required: …"}}]."""
        toolkits = app.strip().lower() if app else ",".join(self.connected())
        if not toolkits:
            raise RuntimeError("apps: no apps are connected. Use web (the browser) for this site instead.")
        params = urllib.parse.urlencode({"query": query, "toolkit_slug": toolkits, "limit": limit})
        items = self._call("GET", f"/tools?{params}").get("items") or []
        return [
            {
                "tool": item.get("slug"),
                "app": (item.get("toolkit") or {}).get("slug"),
                "description": " ".join(str(item.get("description") or "").split())[:_DESCRIPTION_LIMIT],
                "inputs": _summary(item.get("input_parameters")),
            }
            for item in items
        ]

    def run(self, tool_slug: str, arguments: dict | None = None) -> Any:
        """Run one tool as the user and return its data; raises with Composio's message when it fails."""
        result = self._call("POST", f"/tools/execute/{urllib.parse.quote(str(tool_slug), safe='')}", {"arguments": arguments or {}})
        if not result.get("successful", True) or result.get("error"):
            raise RuntimeError(f"apps: {tool_slug} failed: {result.get('error') or 'no detail'}")
        data = _trim(result.get("data"))
        text = json.dumps(data, default=str)
        # Still too big after trimming long fields: hand back the start of the JSON text rather than flood the model.
        return data if len(text) <= RESULT_LIMIT else text[:RESULT_LIMIT] + "… (trimmed)"


apps = ConnectedApps(os.environ.get("JARVIS_APPS_GATEWAY", ""))
