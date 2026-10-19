from app.desktop.operator import (
    accounts_from_omp_stdout,
    auth_snapshot,
    model_choices,
    omp_login_command,
    preferred_model,
    preferred_scenario,
    project_run,
    read_auth_env,
    runner_error_text,
    start_run_body,
    upsert_env,
)


def test_auth_snapshot_reports_presence_without_the_key() -> None:
    snapshot = auth_snapshot(
        {"OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "", "JARVIS_COMPATIBLE_API_KEY": "key", "JARVIS_COMPATIBLE_BASE_URL": "https://example.test/v1"},
        [{"provider": "cursor", "id": "gpt", "selector": "cursor/gpt", "name": "GPT"}],
    )
    assert snapshot["openai"] is True
    assert snapshot["anthropic"] is False
    assert snapshot["compatible"] is True
    assert "sk-secret" not in str(snapshot)


def test_env_round_trip_updates_one_key_and_keeps_comments(tmp_path) -> None:
    path = tmp_path / ".env"
    path.write_text("# local\nOPENAI_API_KEY=\"old\"\nHOST=\"127.0.0.1\"\n", encoding="utf-8")
    path.write_text(upsert_env(path.read_text(encoding="utf-8"), {"ANTHROPIC_API_KEY": 'quoted"key'}), encoding="utf-8")
    env = read_auth_env(path, {})
    assert env["OPENAI_API_KEY"] == "old"
    assert env["ANTHROPIC_API_KEY"] == 'quoted"key'
    assert 'HOST="127.0.0.1"' in path.read_text(encoding="utf-8")


def test_omp_accounts_are_deduped_and_a_command_needs_a_model() -> None:
    stdout = '{"models":[{"kind":"chat","input":["text","image"],"provider":"openai-codex","id":"gpt-6-astra","selector":"openai-codex/gpt-6-astra","name":"GPT 6 Astra"},{"kind":"chat","input":["text","image"],"provider":"openai-codex","id":"gpt-6-astra","selector":"openai-codex/gpt-6-astra","name":"GPT 6 Astra"},{"kind":"chat","input":["text"],"provider":"text","id":"only","selector":"text/only","name":"Text"}]}'
    accounts = accounts_from_omp_stdout(stdout)
    assert accounts == [{"provider": "openai-codex", "id": "gpt-6-astra", "selector": "openai-codex/gpt-6-astra", "name": "GPT 6 Astra"}]
    assert preferred_model(accounts) == "omp:openai-codex/gpt-6-astra"
    choices = model_choices(accounts, {})
    assert choices[0][1] == "omp:openai-codex/gpt-6-astra"
    body = start_run_body("desktop-cad-engine", "Place a cube", choices[0][1])
    assert body["model"] == "omp:openai-codex/gpt-6-astra"
    assert body["browserMode"] == "headful"
    assert body["maxResponseTurns"] is None


def test_activity_projection_does_not_repeat_events() -> None:
    detail = {
        "run": {"id": "run-1", "status": "running"},
        "events": [
            {"id": "e1", "type": "run_started", "message": "Run run-1 started."},
            {"id": "e2", "type": "screenshot_captured", "message": "Browser screenshot captured."},
        ],
        "browser": {"screenshots": [{"url": "/api/runs/run-1/artifacts/screenshots/frame.png"}]},
    }
    seen: set[str] = set()
    lines, url, run_id, status = project_run(detail, seen)
    assert lines == ["Agent: Run run-1 started.", "Agent: captured the screen."]
    assert url == "/api/runs/run-1/artifacts/screenshots/frame.png"
    assert (run_id, status) == ("run-1", "running")
    assert project_run(detail, seen)[0] == []
    assert preferred_scenario([{"id": "paint"}, {"id": "any-task"}]) == "any-task"
    assert runner_error_text({"error": "A run is already active.", "hint": "Stop it first."}) == "A run is already active. Stop it first."
    assert omp_login_command()
