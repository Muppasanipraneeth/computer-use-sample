"""Command and authentication state for the desktop operator window.

The window is a local process. It never returns API key values to the screen.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from app.omp_client import parse_omp_catalog

ENV_KEYS = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JARVIS_COMPATIBLE_API_KEY", "JARVIS_COMPATIBLE_BASE_URL")
DEFAULT_SCENARIO = "any-task"


def parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        values[key.strip()] = _unquote(raw.strip())
    return values


def _unquote(raw: str) -> str:
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        inner = raw[1:-1]
        if raw[0] == "'":
            return inner
        return inner.replace("\\\\", "\\").replace('\\"', '"')
    return raw


def quote_env(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise ValueError("A saved value cannot contain a line break.")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def upsert_env(text: str, updates: dict[str, str]) -> str:
    lines = text.splitlines()
    seen: set[str] = set()
    rewritten: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            rewritten.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in updates:
            rewritten.append(f"{key}={quote_env(updates[key])}")
            seen.add(key)
        else:
            rewritten.append(line)
    for key, value in updates.items():
        if key not in seen:
            rewritten.append(f"{key}={quote_env(value)}")
    body = "\n".join(rewritten)
    return f"{body}\n" if body else ""


def read_auth_env(path: Path, environ: dict[str, str] | None = None) -> dict[str, str]:
    source = environ if environ is not None else {}
    values = {key: source.get(key, "").strip() for key in ENV_KEYS}
    if path.is_file():
        parsed = parse_env(path.read_text(encoding="utf-8"))
        for key in ENV_KEYS:
            if parsed.get(key, "").strip():
                values[key] = parsed[key].strip()
    return values


def auth_snapshot(env: dict[str, str], accounts: list[dict[str, str]], omp_detail: str | None = None) -> dict[str, Any]:
    return {
        "openai": bool(env.get("OPENAI_API_KEY")),
        "anthropic": bool(env.get("ANTHROPIC_API_KEY")),
        "compatible": bool(env.get("JARVIS_COMPATIBLE_API_KEY") and env.get("JARVIS_COMPATIBLE_BASE_URL")),
        "accounts": accounts,
        "ompDetail": omp_detail,
    }


def accounts_from_omp_stdout(stdout: str) -> list[dict[str, str]]:
    start, end = stdout.find("{"), stdout.rfind("}")
    if start < 0 or end <= start:
        return []
    try:
        listed = parse_omp_catalog(json.loads(stdout[start : end + 1]))
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
    unique: dict[str, dict[str, str]] = {}
    for account in listed:
        unique.setdefault(account["selector"], account)
    return sorted(unique.values(), key=lambda item: (item["provider"], item["name"]))


def omp_login_command() -> list[str]:
    if sys.platform == "darwin":
        return ["osascript", "-e", 'tell application "Terminal" to do script "omp login"']
    return ["omp", "login"]


def preferred_model(accounts: list[dict[str, str]]) -> str | None:
    for account in accounts:
        if account["selector"] == "openai-codex/gpt-6-astra":
            return f"omp:{account['selector']}"
    if accounts:
        return f"omp:{accounts[0]['selector']}"
    return None


def model_choices(accounts: list[dict[str, str]], env: dict[str, str]) -> list[tuple[str, str]]:
    choices = [(f"{account['name']} · {account['provider']}", f"omp:{account['selector']}") for account in accounts]
    if env.get("OPENAI_API_KEY"):
        choices.append(("OpenAI API key", "gpt-6-astra"))
    if env.get("ANTHROPIC_API_KEY"):
        choices.append(("Claude API key", "anthropic:claude-sonnet-4-5"))
    if env.get("JARVIS_COMPATIBLE_API_KEY") and env.get("JARVIS_COMPATIBLE_BASE_URL"):
        choices.append(("Other API", "compatible:"))
    return choices


def preferred_scenario(scenarios: list[dict[str, Any]]) -> str:
    ids = [str(item.get("id", "")) for item in scenarios]
    if DEFAULT_SCENARIO in ids:
        return DEFAULT_SCENARIO
    return ids[0] if ids else ""


def start_run_body(scenario_id: str, prompt: str, model: str) -> dict[str, Any]:
    command = prompt.strip()
    if not scenario_id:
        raise ValueError("Choose a scenario first.")
    if not command:
        raise ValueError("Enter a command first.")
    if not model.strip() or model.endswith(":"):
        raise ValueError("Choose a signed-in model first.")
    return {
        "scenarioId": scenario_id,
        "prompt": command,
        "model": model.strip(),
        "browserMode": "headful",
        "maxResponseTurns": None,
    }


def format_event(event: dict[str, Any]) -> str:
    kind = str(event.get("type") or "update")
    message = str(event.get("message") or kind)
    if kind == "screenshot_captured":
        return "Agent: captured the screen."
    if kind == "function_call_requested":
        return f"Agent: {message}"
    if kind in {"run_failed", "run_cancelled", "run_completed"}:
        return f"Agent: {message}"
    return f"Agent: {message}"


def project_run(detail: dict[str, Any] | None, seen: set[str]) -> tuple[list[str], str | None, str | None, str]:
    if not detail:
        return [], None, None, "idle"
    raw_run = detail.get("run")
    run: dict[str, Any] = raw_run if isinstance(raw_run, dict) else {}
    lines: list[str] = []
    for event in detail.get("events") or []:
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id") or "")
        if not event_id or event_id in seen:
            continue
        seen.add(event_id)
        lines.append(format_event(event))
    browser = detail.get("browser")
    screenshots = browser.get("screenshots") if isinstance(browser, dict) else None
    url = None
    if isinstance(screenshots, list) and screenshots and isinstance(screenshots[-1], dict):
        raw_url = screenshots[-1].get("url")
        url = str(raw_url) if isinstance(raw_url, str) and raw_url else None
    status = str(run.get("status") or "unknown")
    run_id = str(run["id"]) if run.get("id") else None
    return lines, url, run_id, status


def runner_error_text(payload: Any) -> str:
    if isinstance(payload, dict):
        error = str(payload.get("error") or "The runner rejected the command.")
        hint = payload.get("hint")
        return f"{error} {hint}" if isinstance(hint, str) and hint else error
    return "The runner rejected the command."
