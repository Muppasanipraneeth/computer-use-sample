# Agent guide

## Skills

Shared skills live in `.agents/skills/`. Codex, Cursor, Gemini/Antigravity CLI, and omp read them there; `.claude/skills/` links the same folders for Claude Code. Add or change skills only in `.agents/skills/`, then run `pnpm skills:sync`. Provenance and per-agent paths: `.agents/README.md`.

## Unreal Editor

This repo drives Unreal Editor (the `desktop-cad-engine` and `any-task` scenarios in `labs/catalog.json`; the desktop app is called Jarvis). When a task changes or queries a live Unreal project — actors, Blueprints, materials, Niagara, Sequencer, Control Rigs, GAS, automation tests — use the `unreal-mcp` skill instead of describing manual editor steps. Use `create-toolset` to add AI-callable tools to an Unreal toolset, and `unreal-skill` to author skills for Unreal's in-editor agent.

The skill needs Unreal Editor running with the `ModelContextProtocol` and `AllToolsets` plugins enabled and the server started (`ModelContextProtocol.StartServer`). Every agent here is configured for `http://127.0.0.1:8000/mcp` in `.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, and `.vscode/mcp.json`. If the editor uses another port, change all five. Until the editor is running, agents report the `unreal-mcp` server as unreachable; that is expected.

The server can run arbitrary Python inside the editor and edit assets tracked by source control. Save and commit the Unreal project before long sessions, and keep the port on loopback.
