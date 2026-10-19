# Shared agent skills

`skills/` holds one folder per skill (`SKILL.md` plus references). Every coding agent in this repo uses the same copy:

| Agent | Reads skills from | Unreal MCP config |
| --- | --- | --- |
| Codex | `.agents/skills/` | `.codex/config.toml` (trusted projects) |
| Cursor | `.agents/skills/` | `.cursor/mcp.json` |
| Gemini / Antigravity CLI | `.agents/skills/` (alias of `.gemini/skills/`) | `.gemini/settings.json` |
| omp | `.agents/skills/` | any of the files in this column |
| VS Code / Copilot | — | `.vscode/mcp.json` |
| Claude Code | `.claude/skills/` (symlinks to the folders here) | `.mcp.json` |

Add or edit skills here only, then run `pnpm skills:sync` so Claude Code picks them up. On Windows checkouts without git symlink support, run the same command once to replace the placeholder files with junctions.

## Unreal Engine skills (vendored)

`unreal-mcp`, `unreal-skill`, and `create-toolset` come from Epic Games' [unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) under the MIT license (a copy sits in each folder). They are unmodified.

Vendored commit: `a6aa73ada02a9fb1f5415bec491f9942c519b297`

Update with `pnpm skills:sync --vendor-unreal` (or pass a tag/branch after the flag). The plugin's Claude-only SessionStart hook is not vendored; it only fires inside a folder with a `.uproject`, and the repo's `AGENTS.md` carries the same guidance for every agent.
