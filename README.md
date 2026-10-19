# Jarvis

Computer-use agents are AI systems that operate software to complete a task. They inspect an interface, choose an action, execute it, and check the result. At OpenAI, we build this loop around models that write code to interact with software. Code lets the model combine actions, process observations, and choose when to look again.

A persistent runtime keeps useful state and helper functions available between calls. The model can write a loop to fill several fields, check that each change took effect, and return only the text or screenshots it needs. This can reduce model round trips and repeated input context while giving the model feedback to correct mistakes.

This repository contains two computer-use agents: one runs JavaScript with **Playwright** to control a browser; the other runs Python with **PyAutoGUI** to control a desktop through screenshots, mouse input, and keystrokes. Both use the Responses API and the same console and labs. They show how to build this pattern with standard libraries; OpenAI products use their own runtimes and additional controls.

## First Run

You need **Node.js 22.20.0** and an **[OpenAI API key](https://platform.openai.com/api-keys)** with access to the configured model. Corepack uses the repository's pinned **pnpm 10.26.0**. Run these commands in your terminal, replacing the API key placeholder:

```bash
git clone https://github.com/Muppasanipraneeth/jarvis.git
cd jarvis
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
export OPENAI_API_KEY="your_api_key_here"
```

Both apps read the root `.env`; shell variables take precedence. You can save the key in `.env` to use it in later sessions.

The model looks at the lab and returns the next code action. OpenAI is the default (`OPENAI_API_KEY`). Claude uses `ANTHROPIC_API_KEY` and a model id prefixed with `anthropic:`. Any OpenAI-compatible chat API uses `JARVIS_COMPATIBLE_BASE_URL`, `JARVIS_COMPATIBLE_API_KEY`, and a model id prefixed with `compatible:`. Pick the provider under **Advanced settings**, or set `JARVIS_DEFAULT_MODEL`. The model must accept images.

Run either quickstart below from the repository root. Once it starts, open the [console](http://127.0.0.1:3000), choose a scenario, edit its prompt, and select **Start Run**. Runs make real API calls. Use **Stop** to interrupt a run; use **Ctrl+C** and wait for shutdown before switching apps.

## JavaScript / Playwright Quickstart

The JavaScript agent uses Playwright locators, screenshots, and browser controls in a persistent session, with a TypeScript server and agent loop. See the [JavaScript README](javascript-app/README.md) for the code walkthrough and recovery guidance.

```bash
pnpm playwright:install
pnpm dev:js
```

## Python / PyAutoGUI Quickstart

The Python agent runs its server, agent loop, and persistent PyAutoGUI worker in Python, controlling a visible browser on your desktop. Install **uv**, use **Python 3.10+** (the repo pins 3.12), and follow the [Python README](python-app/README.md#quickstart) for desktop permissions, platform setup, and a code walkthrough.

```bash
pnpm python:install
pnpm python:playwright:install
uv run --project python-app python -m app.desktop.worker --check
pnpm dev:python
```

`pnpm desktop` opens **Jarvis**, the desktop app. It starts the Python runner itself if none is running (or uses the one you started with `pnpm dev:python`). Pick a workspace in the sidebar and a signed-in model under the prompt, then type a command. The chat shows each step as the agent works: its notes, a readable label for every click, keystroke, drag, browser action, and page read (with the code behind it), and a thumbnail of every screenshot. The **Screen** panel follows the live view. Desktop runs have no turn limit. The agent works until it answers or you stop it. To stop early, move the mouse into a screen corner (PyAutoGUI's fail-safe), or open the window and press **Stop** (⌘. on macOS, Ctrl+. on Windows). The chat survives restarts, **Settings → Models** saves API keys to `.env` or opens `omp login`, and you get a system notification when a run finishes. With Voice on, Jarvis also says the result out loud, for typed requests too; for a question it says the answer itself.

**While it works.** Keep typing into the same box. Jarvis reads what you wrote against the running task and decides: an extra detail ("also set the volume to 30%") or a change of plan ("no, play Runaway instead") reaches the agent before its next step; an unrelated request ("then check the weather") waits under **Up next** and starts when the task ends (stopping the task drops it); "stop" stops it; a question ("what are you doing?") gets an answer from the progress so far. The follow-up shows in the steps as your words. **Pause** holds the agent before its next step (a step already running finishes) until you press play; you can still change the plan while it's paused. The same works by voice. **Attach** images (screenshots, photos) or a folder with the paperclip, by dropping them on the box, or by pasting a screenshot: images are copied into the run and the agent can look at them; a folder is used where it is, so the agent can read and write its files. **New chat** doesn't stop anything: the old chat keeps working, shows a spinner under **Chats**, gets a dot and a notification when it finishes, and you can open it again any time. Up to three tasks run at once; steps that use the real mouse, keyboard or screen take turns, so two tasks never fight over the pointer.

**Install it like a Mac app.** `pnpm desktop:install` builds `Jarvis.app` and puts it in `/Applications` (or `~/Applications`), so Jarvis opens from Spotlight, Launchpad or the Dock with its own name and icon. The installed app starts the Python runner from this repo by itself when none is running, and uses the repo's `.env`, so no terminal is needed. It records where the repo is, so run the command again after pulling changes or moving the folder. In development, `pnpm desktop` runs the same way from a Jarvis-branded copy of Electron in `desktop/.dev/` (macOS reads the menu-bar name and Dock icon from the running app bundle). Because Jarvis starts the runner, macOS asks for permissions for **Jarvis**: microphone once, plus **Accessibility** (mouse and keyboard) and **Screen Recording** for desktop tasks. A banner in the app opens each System Settings page; reopen Jarvis after turning on Screen Recording. Both apps are signed with a self-signed "Jarvis Local Signing" certificate, kept in a keychain of its own under `~/Library/Application Support/Jarvis/signing/` (your login keychain isn't touched), so macOS recognises Jarvis across rebuilds and the permissions stick.

**Settings** (⌘,) has five tabs:
- **Voice:** pick Jarvis's voice from 28 offline voices (American and British, women and men) with a Preview button. The switches cover listening for "Hey Jarvis", speaking replies, reading task results aloud, confirming before a task, the follow-up window and pausing music. Personality can be witty and sarcastic, friendly, or straight to the point.
- **You:** your name, what Jarvis should call you, where you live and anything else it should know. It's kept in `profile.json` in the app's data folder and used both by the voice and by the agent's tasks, so "what's the weather?" means your city.
- **Connections:** apps and websites, described below.
- **Look:** System, Light or Dark theme, and the Live view.
- **Models:** omp accounts and API keys.

**Background first.** You can keep using the computer while Jarvis works. Questions and web tasks run in a background browser that never appears on your screen, and apps are driven through AppleScript where possible, so a request like "what are today's top tech stories?" finishes without touching your mouse, keyboard or windows (measured: 3 page reads, 0 screenshots, 0 clicks). The **Screen** panel shows the page the background browser is on after each step (labelled "Background browser" in the chat); the model never sees these pictures. Jarvis takes the real mouse and keyboard only when a task needs an app's interface that nothing else can drive; only then does its window minimize so the agent sees your screen, and it comes back when the run ends. With an omp account the agent also takes a screenshot only when it needs to find something on screen or check a result. A step that runs longer than 60 seconds is stopped and the agent is told to try smaller steps; the run continues.

**Voice.** Turn on **Voice** under the prompt, then say **“Hey Jarvis”** and your request. A chime confirms it heard the wake phrase. Jarvis then works out what you meant and answers out loud, in a natural female voice with a dry, friendly sense of humor (no jokes when something failed or you ask it to stop):

- **A task** ("Hey Jarvis, put Runway on in Spotify"): it says what it's about to do, ends with "Proceeding", and starts the run. While it says that, talk over it, press Esc, or click the message box to stop it from starting. When the task finishes, it tells you how it went.
- **A question** ("Hey Jarvis, are you there?"): it just answers; no desktop run.
- **Stop / cancel**: "Hey Jarvis, stop" stops the running task, even while the window is minimized; "never mind" drops a request.
- **While a task runs**, anything else you say is a follow-up, judged the same way as typed ones: add to it, change it, do it next, stop, or answer.

**Hold Control to talk (macOS).** Instead of saying "Hey Jarvis" every time, hold the **Control** key, say your request, and let go; pauses don't cut you off, letting go does. It works from any app while Voice is on. A hold only counts after a quarter of a second with no other key, so Ctrl+C, Ctrl+click and quick taps never open the microphone, and what you said during that quarter second is kept. A small helper, `desktop/native/control-key.swift`, watches the key (Electron's shortcuts can't register a lone modifier); `pnpm desktop` and `pnpm desktop:install` compile it with Xcode's command line tools (`xcode-select --install` if they're missing). It sees keys through Jarvis's Accessibility permission. Turn it off, or turn off "Hey Jarvis" and use only the key, in **Settings → Voice**.

The conversation is duplex-style: the microphone stays open while Jarvis talks, so you can interrupt it mid-sentence, and for a few seconds after it finishes you can reply without saying "Hey Jarvis" again. Echo cancellation keeps Jarvis from hearing its own voice. Listening, speech-to-text and the voice run on this computer with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): a keyword spotter for the wake phrase, Silero VAD for the end of your sentence, Moonshine for speech-to-text, and Kokoro ("Heart") for Jarvis's voice. Understanding a request uses the fastest model in your omp accounts (Claude Haiku when available, about 2 seconds); if none is available, Jarvis runs your words as spoken. The first time, about 400 MB of models download into the app's data folder and are checked against SHA-256 hashes; no audio leaves the machine and nothing is recorded. macOS asks for microphone access once.

Music from another app (Spotify, a browser) is not removed by echo cancellation, which only cancels sound Jarvis plays itself. "Hey Jarvis" is tuned to wake with music about as loud as your voice. When music is louder, press **⌘⇧Space** (Windows: **Ctrl+Shift+Space**) and just talk; no wake phrase is needed. During a voice exchange Jarvis pauses Spotify and Apple Music and resumes them afterwards; other sound (a browser video) has its system volume lowered to a quarter while Jarvis listens (macOS), unless you change the volume yourself in the meantime. A laptop's own speakers at high volume overload its built-in microphone, so nothing can be heard over them; use headphones or keep the volume moderate if you want the wake phrase to work during music. Start the app with `JARVIS_VOICE_DEBUG=1` to log the microphone level, wake events, barge-ins, transcripts and what Jarvis says.

## Jarvis

Jarvis does tasks on your computer. Its default workspace, **Any task**, takes any request. Prompts that don't fit the selected practice lab or Unreal workspace move to **Any task** automatically; the chat says so and the sidebar follows. At each step the model picks an instrument in the Python it writes:

- `pyautogui` controls this computer's real screen and apps (Spotify, Finder, Unreal Editor). The agent uses it only for interfaces nothing below can drive.
- `web` is a background Chromium session (Playwright), for websites the agent must click or type in. It never appears on your screen.
- `read(url)` returns a page as markdown-like text, for looking things up.

Both run in a headless Chromium on this computer by default. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (permission **Browser Rendering – Edit**) under **Accounts → Cloudflare Browser Run** or in `.env`, then restart the runner, to run them in [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) instead: `web` becomes a cloud Chromium session over CDP, and `read(url)` uses a Browser Run Quick Action with the [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/) engine (free beta, much lighter), retrying on Chromium if Kitesurf fails. Model code never receives the token. The runner starts a per-run gateway on `127.0.0.1` that adds the token and forwards only `/browser-run/` paths, and the worker gets just the gateway URL.

The local browser keeps a persistent profile at `<app data>/Jarvis/browser-profile` (`~/Library/Application Support/Jarvis/browser-profile` on macOS, `%APPDATA%\Jarvis\browser-profile` on Windows, `~/.config/Jarvis/browser-profile` on Linux; the runner honours `JARVIS_BROWSER_PROFILE` to point elsewhere). **Settings → Connections → Sign in to websites** opens a visible Chromium on that profile (Playwright's own Chromium, the runner's revision when installed) so you can log in to Gmail, Slack, X and other sites once; later background runs reuse those cookies. Only one browser can use the profile at a time: the sign-in window refuses to open while a task is browsing, and a task asks you to close the sign-in window if it is still open. Both browsers use Playwright's mock keychain, so the saved cookies are not protected by the macOS Keychain. Sites may still challenge the headless browser; when one asks to log in, Jarvis tells you to sign in from Settings instead of trying credentials.

**Settings → Connections → Apps** connects Gmail, Google Calendar, Slack, X, GitHub, Notion, Google Drive and LinkedIn through [Composio](https://docs.composio.dev) with one project API key (`COMPOSIO_API_KEY`, saved to `.env`; the runner re-reads it per run, so no restart is needed). **Connect** opens Composio's hosted sign-in page in your default browser (Composio-managed OAuth, so no developer app of your own), under one fixed Composio user id, `jarvis-local`. X is the exception: Composio dropped its managed X app in February 2026, so add an X auth config with your own X developer credentials at [platform.composio.dev](https://platform.composio.dev) first; Jarvis reuses any enabled auth config it finds. During a run the agent gets an `apps` instrument (`apps.connected()`, `apps.search(query, app=None)`, `apps.run(tool_slug, arguments)`) and prefers it for connected apps, falling back to the website in `web`; it asks before sending messages or posting publicly unless you asked it to send. Model code never receives the key: a per-run gateway on `127.0.0.1` adds it and forwards only connected-account listing, tool search and tool execution, always as `jarvis-local`.

The app's look comes from `desktop/renderer/tokens.css`. In light mode it's warm cream paper with ink, in dark mode a calm deep-green charcoal. It uses flat brand colours (forest for actions, lilac for highlights, orange for the spark), the EB Garamond serif for headings with Figtree for the interface, Geist Mono for code (all SIL OFL, licences in `desktop/renderer/fonts/`), and two-tone [Phosphor](https://phosphoricons.com) icons (MIT). The logo, `desktop/renderer/logo.svg`, is "the Professor": an original Notion-style drawing of a wise old genius with a twinkle in the eye. The app icon is `desktop/assets/icon.svg`, rendered to `icon.png`.

## Unreal property view

The practice labs are browser pages. Real-estate work happens in Unreal Editor, the desktop window you already opened, on Windows or macOS. This repo does not contain the engine. Install it from the Epic Games Launcher, open the property project, and leave Unreal Editor in front on the primary display. Start the Python app, choose **Unreal property view**, and edit the prompt if you want a change other than one camera aimed at the property. **Start Run** screenshots that window and clicks inside it. It does not open the web lab. Viewport keys (W, E, R, F, and right-mouse fly) match on both systems. Menu shortcuts use command on macOS and ctrl on Windows. On macOS, do not use command+space; that opens Spotlight. The JavaScript app cannot drive Unreal Editor; start `pnpm dev:python` instead. On macOS, grant Accessibility and Screen Recording first. On Windows, start it from a normal desktop session.

## Repository Layout

```text
.
|-- .agents/skills/                    Shared agent skills (Epic's Unreal MCP skills); see AGENTS.md
|-- console/                           Shared web console
|-- desktop/                           Electron operator window
|-- contracts/                         Shared request, event, and replay types
|-- javascript-app/
|   |-- src/
|   |   |-- responses-loop.ts          Core agent loop: model, code, feedback
|   |   |-- javascript-worker.ts       Persistent JavaScript execution worker
|   |   |-- browser/                   Browser session and worker communication
|   |   |-- runner-manager.ts          Run lifecycle and saved artifacts
|   |   `-- lab-catalog.ts             Shared lab catalog access
|   |-- docs/                          Architecture and contributing guides
|   `-- tests/                         JavaScript tests
|-- labs/
|   |-- catalog.json                   Scenario defaults and task prompts
|   |-- kanban-lab-template/           Project board: cards, columns, and tasks
|   |-- paint-lab-template/            Drawing canvas: shapes, layers, and tools
|   |-- booking-lab-template/          Hotel search and mock reservations
|   |-- docs/                          Task examples and lab guides
|   `-- tests/                         Lab and integration tests
|-- python-app/
|   |-- app/
|   |   |-- responses_loop.py          Core agent loop: model, code, feedback
|   |   |-- desktop/
|   |   |   |-- worker.py              Persistent Python execution worker
|   |   |   `-- runtime.py             Worker lifecycle and interruption
|   |   |-- runner.py                  Run lifecycle and saved artifacts
|   |   `-- lab_catalog.py             Shared lab catalog access
|   |-- docs/                          Architecture and contributing guides
|   `-- tests/                         Python tests
`-- scripts/
    `-- launch.mjs                     Starts one app and the shared console
```

Each run gets a fresh copy of a lab template. Workspaces, screenshots, and replays stay in the selected app's ignored `data/` directory. Use **Replay JSON** to inspect the recorded trace and the screenshot timeline to review earlier environment states. Generated dependencies, builds, and caches are omitted above. See the [lab guide](labs/docs/README.md) for task examples.

**Run finished** means the agent loop and cleanup ended normally. Inspect the screenshots, recorded trace, and model response to judge whether the requested task was accomplished.

## Safety and Limitations

- Generated code runs with your user permissions. These samples do not provide an operating-system sandbox or OpenAI's production action-review controls. Use the labs or other environments you control.
- Python controls your real mouse and keyboard, and screenshots may include other windows. Use a dedicated desktop session and keep the lab window in front on your primary monitor.
- A final answer does not prove the task succeeded. Inspect the result before relying on it.
- Keep API keys and run artifacts private. Environment files and generated run data are excluded from Git; keep services on their default loopback addresses.
- A crash can leave desktop input held down. Read the Python app's [interruption and recovery notes](python-app/README.md#interruption-and-recovery) before using it.

Licensed under the [MIT License](LICENSE).
