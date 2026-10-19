# Python / PyAutoGUI Sample App

The model calls `exec_py` to run Python in a persistent process. PyAutoGUI lets it inspect the desktop and act through mouse input and keystrokes. The server, agent loop, and execution worker are all written in Python.

## Quickstart

Follow the [Python quickstart](../README.md#python--pyautogui-quickstart) in the root guide. Before launching, set up desktop access:

- **macOS:** enable Accessibility and Screen Recording for the app launching the runner in System Settings → Privacy & Security, then restart that app. Menu shortcuts use the command key.
- **Windows:** use a normal graphical desktop session, not a service. Menu shortcuts use the ctrl key. Display scaling is aligned to the screenshot before the first click.
- **Linux:** use an X11 desktop with PyAutoGUI's screenshot and Tk dependencies installed. If Chromium needs system libraries, run `uv run --project python-app playwright install --with-deps chromium` from the repository root.

`pnpm desktop` from the repository root opens the Electron operator window, a chat with a live step timeline, a screen panel, and sign-in controls. The Python runner from `pnpm dev:python` still has to be running behind it. Runs started there send `maxResponseTurns: null`, which means no turn limit: the loop continues until the model gives a final answer or you stop the run. An omitted budget still defaults to 24.

Use a dedicated desktop session and keep the lab window in front on your primary monitor. Python controls your real mouse and keyboard; it requires a visible browser. The quickstart's `--check` command tests desktop access before you start.

## Code Walkthrough

Both this app and the [JavaScript sample](../javascript-app/README.md#code-walkthrough) follow the same five stages:

1. **Define the tool.** [`build_code_tool_definitions`](app/responses_loop.py#L43) declares `exec_py`, a function that accepts a `code` string, and describes the available PyAutoGUI operations and output helpers.
2. **Request a response.** [`run_responses_code_loop`](app/responses_loop.py#L207) sends the task, instructions, and tool definition to the Responses API. The model can return generated Python in a `function_call`.
3. **Execute the code.** The [worker](app/desktop/worker.py#L66) runs it with `pyautogui` available. The worker keeps Python globals between calls while PyAutoGUI operates the same desktop. Each run gets a new worker. Screenshots use mouse-input coordinates, including on Retina displays.
4. **Return observations.** `log()` produces text and `display()` produces images. The [loop](app/responses_loop.py#L267) returns these as `function_call_output` with the original `call_id`, so the model can inspect the result and choose its next action.
5. **Continue or finish.** The next request includes those results and `previous_response_id`. Commentary continues the loop; a final answer finishes it when no tool calls remain. The worker preserves execution state independently of the API conversation.

For example, to inspect the current desktop, the model might return:

```json
{
  "type": "function_call",
  "name": "exec_py",
  "call_id": "call_1",
  "arguments": "{\"code\":\"display(pyautogui.screenshot())\"}"
}
```

After executing the code, the runner sends this item in the next request's `input` array. The PNG bytes are abbreviated here:

```json
{
  "type": "function_call_output",
  "call_id": "call_1",
  "output": [
    {
      "type": "input_image",
      "image_url": "data:image/png;base64,<PNG_BYTES>",
      "detail": "original"
    }
  ]
}
```

Playwright handles browser setup and preview screenshots; PyAutoGUI handles the model's desktop actions. Follow the [architecture guide](docs/architecture.md#supporting-modules) for the HTTP server, worker connection, and run lifecycle.

## Any task (cloud browser and web reading)

The **Any task** scenario (`any-task`, the Jarvis app's default) picks an instrument per step: PyAutoGUI for this computer's apps, a Cloudflare [Browser Run](https://developers.cloudflare.com/browser-run/) cloud Chromium (`web`, a Playwright page over CDP) for websites it must click or type in, and `read(url)` ([Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/) markdown) for fast lookups.

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (an API token with the **Browser Rendering - Edit** permission) in `.env`, then restart the runner. Without them `web` and `read()` use one headless Chromium on this computer, on Jarvis's browser profile, which the runner shares between all running tasks. While the desktop app's sign-in window is open, tasks browse in that window instead (in background tabs), and a sign-in requested while tasks browse makes the runner hand the profile over after the current model step. On macOS both browsers use the real Keychain (**Chromium Safe Storage**; click **Always Allow** when macOS asks once).

`read()` uses the Kitesurf engine first: it is cheaper and faster for reading, but cannot play video or WebGL, pass bot challenges, or keep logged-in sessions, so `read()` retries once on default Chromium and `web` always uses default Chromium.

Model code never sees the token: the worker environment drops both variables, and the runner starts a per-run gateway on `127.0.0.1` behind a random secret path that adds the token to each request.

Any-task runs also get `remember(text)` and `forget(text)`. They edit `memory.json` in the desktop app's data folder (next to `profile.json`; `JARVIS_MEMORY_FILE` overrides the path), the same list shown in Settings → You. Saved memories, newest last and capped at about 2,000 characters, go into the run instructions beside the profile.

## Several tasks at once

Up to three runs work at the same time (`JARVIS_MAX_CONCURRENT_RUNS` changes the limit); a fourth Start gets HTTP 409 `run_limit_reached`. `GET /api/runs/running` lists the running runs in start order, and `GET /api/runs/active` returns the most recently started one. Steps that use the mouse, keyboard or screen take turns: a run waiting for another run's step shows "Waiting for the screen…", and that wait doesn't count toward its 60-second deadline. Background steps (`read()`, `web`, `apps`, plain Python) run alongside.

## Disk use

Screenshots are stored as JPEG (quality 85, at most 1920 px wide). The model still sees full-size PNGs: they are kept in `runs/<id>/model-frames/` until a day after the run ends.

At startup and every 6 hours the runner deletes finished runs older than `JARVIS_KEEP_DAYS` (default 30) and all but the newest `JARVIS_KEEP_RUNS` (default 50) finished runs. Running runs are never touched. A run's workspace copy is deleted a day after the run finishes, and pasted images in the desktop app's `attachments` folder are deleted after 7 days.

## Interruption and Recovery

**Stop** interrupts the run, attempts to release held input, and waits for the worker, browser, and lab server to close. Moving the pointer into a PyAutoGUI failsafe corner stops every running run, starting with the one whose next PyAutoGUI action hits the corner. Ordinary Python exceptions return to the model so it can correct them. Each code call has a 60-second deadline.

Refreshing the console reconnects to an active run. If a Start response is unconfirmed, **Check again** checks for an active run without submitting another. **Ctrl+C** stops the app and every running run; wait for shutdown before launching either backend again. Do not use Uvicorn reload or multiple workers.

If the runner reports an input-cleanup failure, it blocks new runs, stops the other runs that have used the screen, and refuses further screen steps. Release held keys and mouse buttons, check desktop permissions, then restart. After a crash, check for held input and leftover processes before starting again.

See [contributing](docs/contributing.md) for tests and production startup, and the root guide for [safety and limitations](../README.md#safety-and-limitations).
