"""Native operator window: a command box, run activity, and account sign-in."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from tkinter import BOTH, END, LEFT, RIGHT, StringVar, Tk, Toplevel, X, ttk
from tkinter.scrolledtext import ScrolledText
from typing import Any

from app.config import REPO_ROOT
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

RUNNER_URL = os.environ.get("RUNNER_BASE_URL", "http://127.0.0.1:4041").rstrip("/")


def request_json(method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 20) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        f"{RUNNER_URL}{path}",
        data=data,
        method=method,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw.decode()) if raw else {}
        except json.JSONDecodeError:
            payload = {"error": "The runner returned a response that was not JSON."}
        return error.code, payload


def fetch_bytes(path: str, timeout: float = 20) -> bytes:
    with urllib.request.urlopen(f"{RUNNER_URL}{path}", timeout=timeout) as response:
        return response.read()


class OperatorWindow:
    def __init__(self, env_path: Path | None = None) -> None:
        self.env_path = env_path or (REPO_ROOT / ".env")
        self.seen_events: set[str] = set()
        self.scenarios: list[dict[str, Any]] = []
        self.accounts: list[dict[str, str]] = []
        self.model_by_label: dict[str, str] = {}
        self.scenario_by_label: dict[str, str] = {}
        self.active_run_id: str | None = None
        self.screenshot_url: str | None = None
        self.polling = False
        self.busy = False
        self.photo: Any = None
        self.root = Tk()
        self.root.title("Jarvis")
        self.root.geometry("1080x740")
        self.root.minsize(880, 620)
        self.status = StringVar(value="Checking the runner…")
        self._build()
        self.root.after(200, self.refresh_auth)
        self.root.after(400, self.refresh_scenarios)
        self.root.after(800, self.poll)

    def _build(self) -> None:
        frame = ttk.Frame(self.root, padding=16)
        frame.pack(fill=BOTH, expand=True)
        ttk.Label(frame, textvariable=self.status).pack(anchor="w", pady=(0, 10))
        body = ttk.Panedwindow(frame, orient="horizontal")
        body.pack(fill=BOTH, expand=True)

        auth = ttk.Frame(body, padding=8)
        command = ttk.Frame(body, padding=8)
        body.add(auth, weight=1)
        body.add(command, weight=3)

        ttk.Label(auth, text="Authentication", font=("Helvetica", 16, "bold")).pack(anchor="w")
        ttk.Label(auth, text="Keys stay in the local .env file. This window only shows whether one is saved.", wraplength=280).pack(anchor="w", pady=(4, 12))
        self.openai_state = StringVar(value="OpenAI: checking")
        self.claude_state = StringVar(value="Claude: checking")
        self.other_state = StringVar(value="Other API: checking")
        self.omp_state = StringVar(value="Saved accounts: checking")
        for label, action, fields in (
            (self.openai_state, "Set OpenAI key", (("API key", "OPENAI_API_KEY"),)),
            (self.claude_state, "Set Claude key", (("API key", "ANTHROPIC_API_KEY"),)),
            (self.other_state, "Set other API", (("Base URL", "JARVIS_COMPATIBLE_BASE_URL"), ("API key", "JARVIS_COMPATIBLE_API_KEY"))),
        ):
            row = ttk.Frame(auth)
            row.pack(fill=X, pady=4)
            ttk.Label(row, textvariable=label).pack(side=LEFT)
            def open_editor(spec: tuple[tuple[str, str], ...] = fields) -> None:
                self._edit_keys(spec)

            ttk.Button(row, text=action, command=open_editor).pack(side=RIGHT)
        ttk.Label(auth, textvariable=self.omp_state, wraplength=300).pack(anchor="w", pady=(12, 6))
        buttons = ttk.Frame(auth)
        buttons.pack(fill=X)
        ttk.Button(buttons, text="Refresh accounts", command=self.refresh_auth).pack(side=LEFT)
        ttk.Button(buttons, text="Log in with omp", command=self._login_omp).pack(side=LEFT, padx=8)

        ttk.Label(command, text="Command", font=("Helvetica", 16, "bold")).pack(anchor="w")
        pickers = ttk.Frame(command)
        pickers.pack(fill=X, pady=8)
        ttk.Label(pickers, text="Scenario").pack(side=LEFT)
        self.scenario_box = ttk.Combobox(pickers, state="readonly", width=28)
        self.scenario_box.pack(side=LEFT, padx=(6, 16))
        ttk.Label(pickers, text="Model").pack(side=LEFT)
        self.model_box = ttk.Combobox(pickers, state="readonly", width=36)
        self.model_box.pack(side=LEFT, padx=6)

        self.transcript = ScrolledText(command, height=16, wrap="word", state="disabled")
        self.transcript.pack(fill=BOTH, expand=True, pady=(4, 8))
        composer = ttk.Frame(command)
        composer.pack(fill=X)
        self.command = ttk.Entry(composer)
        self.command.pack(side=LEFT, fill=X, expand=True)
        def send_on_return(_event: object) -> None:
            self.send_command()

        self.command.bind("<Return>", send_on_return)
        ttk.Button(composer, text="Send", command=self.send_command).pack(side=LEFT, padx=8)
        ttk.Button(composer, text="Stop", command=self.stop_run).pack(side=LEFT)
        self.preview = ttk.Label(command, text="The latest screenshot appears here after a command.")
        self.preview.pack(fill=X, pady=(10, 0))

    def _say(self, text: str) -> None:
        self.transcript.configure(state="normal")
        self.transcript.insert(END, f"{text}\n")
        self.transcript.see(END)
        self.transcript.configure(state="disabled")

    def _worker(self, work: Callable[[], Any], done: Callable[[Any, BaseException | None], None]) -> None:
        def run() -> None:
            try:
                result = work()
            except (OSError, urllib.error.URLError, subprocess.SubprocessError, ValueError, json.JSONDecodeError, RuntimeError) as error:
                def report_error(failure: BaseException = error) -> None:
                    done(None, failure)

                self.root.after(0, report_error)
                return

            def report_result(value: Any = result) -> None:
                done(value, None)

            self.root.after(0, report_result)

        threading.Thread(target=run, daemon=True).start()

    def refresh_auth(self) -> None:
        self.omp_state.set("Saved accounts: checking")

        def work() -> dict[str, Any]:
            env = read_auth_env(self.env_path, dict(os.environ))
            detail = None
            accounts: list[dict[str, str]] = []
            try:
                completed = subprocess.run(["omp", "models", "--json", "--no-extensions"], capture_output=True, text=True, timeout=25, check=False)
                if completed.returncode == 0:
                    accounts = accounts_from_omp_stdout(completed.stdout)
                else:
                    detail = (completed.stderr or completed.stdout or "omp could not list accounts.").strip().splitlines()[-1]
            except (OSError, subprocess.TimeoutExpired) as error:
                detail = str(error)
            return {"env": env, "snapshot": auth_snapshot(env, accounts, detail)}

        def done(result: Any, error: BaseException | None) -> None:
            if error is not None or not isinstance(result, dict):
                self.omp_state.set("Saved accounts: unavailable")
                return
            env = result["env"]
            snapshot = result["snapshot"]
            self.accounts = snapshot["accounts"]
            self.openai_state.set(f"OpenAI: {'key saved' if snapshot['openai'] else 'not signed in'}")
            self.claude_state.set(f"Claude: {'key saved' if snapshot['anthropic'] else 'not signed in'}")
            self.other_state.set(f"Other API: {'key saved' if snapshot['compatible'] else 'not signed in'}")
            count = len(self.accounts)
            extra = f" {snapshot['ompDetail']}" if snapshot.get("ompDetail") else ""
            self.omp_state.set(f"Saved accounts: {count} image model{'s' if count != 1 else ''}.{extra}")
            labels = []
            self.model_by_label = {}
            for label, model in model_choices(self.accounts, env):
                if label in self.model_by_label:
                    continue
                self.model_by_label[label] = model
                labels.append(label)
            self.model_box.configure(values=labels)
            preferred = preferred_model(self.accounts)
            current = self.model_by_label.get(self.model_box.get())
            if preferred and current != preferred and not current:
                for label, model in self.model_by_label.items():
                    if model == preferred:
                        self.model_box.set(label)
                        break
            elif labels and not self.model_box.get():
                self.model_box.set(labels[0])

        self._worker(work, done)

    def refresh_scenarios(self) -> None:
        def work() -> tuple[int, Any]:
            return request_json("GET", "/api/scenarios")

        def done(result: Any, error: BaseException | None) -> None:
            if error is not None or not isinstance(result, tuple) or result[0] != 200 or not isinstance(result[1], list):
                self.status.set("Runner offline. Start it with pnpm dev:python, then send a command.")
                return
            self.scenarios = [item for item in result[1] if isinstance(item, dict)]
            self.scenario_by_label = {str(item.get("title") or item.get("id")): str(item["id"]) for item in self.scenarios if item.get("id")}
            labels = list(self.scenario_by_label)
            self.scenario_box.configure(values=labels)
            preferred = preferred_scenario(self.scenarios)
            for label, scenario_id in self.scenario_by_label.items():
                if scenario_id == preferred:
                    self.scenario_box.set(label)
                    break
            self.status.set("Runner online. Type a command and send it.")

        self._worker(work, done)

    def _edit_keys(self, fields: tuple[tuple[str, str], ...]) -> None:
        dialog = Toplevel(self.root)
        dialog.title("Save sign-in")
        dialog.resizable(False, False)
        entries: dict[str, ttk.Entry] = {}
        for index, (label, key) in enumerate(fields):
            ttk.Label(dialog, text=label).grid(row=index, column=0, padx=12, pady=8, sticky="w")
            entry = ttk.Entry(dialog, show="*" if "key" in label.lower() else "", width=42)
            entry.grid(row=index, column=1, padx=12, pady=8)
            entries[key] = entry

        def save() -> None:
            updates = {key: widget.get().strip() for key, widget in entries.items()}
            if any(not value for value in updates.values()):
                return
            current = self.env_path.read_text(encoding="utf-8") if self.env_path.is_file() else ""
            self.env_path.write_text(upsert_env(current, updates), encoding="utf-8")
            dialog.destroy()
            self._say("You: saved the sign-in locally. Restart the runner before a key-based model can use it.")
            self.refresh_auth()

        ttk.Button(dialog, text="Save", command=save).grid(row=len(fields), column=1, padx=12, pady=12, sticky="e")
        dialog.transient(self.root)
        dialog.grab_set()

    def _login_omp(self) -> None:
        subprocess.Popen(omp_login_command())
        self._say("You: opened omp login. Finish it in Terminal, then press Refresh accounts.")

    def _selected_model(self) -> str:
        return self.model_by_label.get(self.model_box.get(), "")

    def _selected_scenario(self) -> str:
        return self.scenario_by_label.get(self.scenario_box.get(), "")

    def send_command(self) -> None:
        if self.busy:
            return
        command = self.command.get().strip()
        try:
            body = start_run_body(self._selected_scenario(), command, self._selected_model())
        except ValueError as error:
            self._say(f"Agent: {error}")
            return
        self.busy = True
        self.command.delete(0, END)
        self._say(f"You: {command}")

        def work() -> tuple[int, Any]:
            return request_json("POST", "/api/runs", body, timeout=60)

        def done(result: Any, error: BaseException | None) -> None:
            self.busy = False
            if error is not None or not isinstance(result, tuple):
                self._say(f"Agent: the command did not reach the runner. {error}")
                return
            status, payload = result
            if status != 202 or not isinstance(payload, dict):
                self._say(f"Agent: {runner_error_text(payload)}")
                return
            detail = payload.get("detail") if isinstance(payload.get("detail"), dict) else None
            self._apply_detail(detail)
            self.status.set("Run active. The agent is using the desktop.")

        self._worker(work, done)

    def stop_run(self) -> None:
        run_id = self.active_run_id
        if not run_id:
            self._say("Agent: there is no active run to stop.")
            return

        def work() -> tuple[int, Any]:
            return request_json("POST", f"/api/runs/{run_id}/stop")

        def done(result: Any, error: BaseException | None) -> None:
            if error is not None or not isinstance(result, tuple) or result[0] >= 400:
                payload = result[1] if isinstance(result, tuple) else None
                self._say(f"Agent: {runner_error_text(payload)}")
                return
            self._say("Agent: stop requested.")

        self._worker(work, done)

    def poll(self) -> None:
        self.root.after(1500, self.poll)
        if self.polling:
            return
        self.polling = True

        def work() -> tuple[int, Any]:
            return request_json("GET", "/api/runs/active", timeout=8)

        def done(result: Any, error: BaseException | None) -> None:
            self.polling = False
            if error is not None or not isinstance(result, tuple):
                self.status.set("Runner offline. Start it with pnpm dev:python.")
                return
            status, payload = result
            if status != 200:
                self.status.set("Runner offline. Start it with pnpm dev:python.")
                return
            if payload is None:
                finished = self.active_run_id
                if finished:
                    self.active_run_id = None

                    def load() -> tuple[int, Any]:
                        return request_json("GET", f"/api/runs/{finished}")

                    def loaded(final: Any, final_error: BaseException | None) -> None:
                        if final_error is None and isinstance(final, tuple) and final[0] == 200 and isinstance(final[1], dict):
                            self._apply_detail(final[1])
                        self.status.set("Runner online. The last command finished.")

                    self._worker(load, loaded)
                elif self.scenarios:
                    self.status.set("Runner online. Type a command and send it.")
                return
            if isinstance(payload, dict):
                self._apply_detail(payload)
                run_status = str((payload.get("run") or {}).get("status") or "")
                self.status.set("Run active. The agent is using the desktop." if run_status == "running" else f"Run {run_status}.")

        self._worker(work, done)

    def _apply_detail(self, detail: dict[str, Any] | None) -> None:
        lines, url, run_id, status = project_run(detail, self.seen_events)
        if run_id and status == "running":
            self.active_run_id = run_id
        elif status in {"completed", "failed", "cancelled"}:
            self.active_run_id = None
        for line in lines:
            self._say(line)
        if url and url != self.screenshot_url:
            self.screenshot_url = url
            self._worker(lambda: fetch_bytes(url), self._show_screenshot)

    def _show_screenshot(self, payload: Any, error: BaseException | None) -> None:
        if error is not None or not isinstance(payload, bytes):
            self.preview.configure(text="The screenshot could not be shown.")
            return
        try:
            from io import BytesIO

            from PIL import Image, ImageTk

            image = Image.open(BytesIO(payload))
            image.thumbnail((640, 360))
            self.photo = ImageTk.PhotoImage(image)
            self.preview.configure(image=self.photo, text="")
        except (OSError, ImportError, ValueError):
            self.preview.configure(text="A screenshot was captured.")

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    OperatorWindow().run()


if __name__ == "__main__":
    main()
