#!/usr/bin/env node
// Shared agent skills live in .agents/skills/ (read directly by Codex, Cursor, Gemini/Antigravity CLI and omp).
// Claude Code only reads .claude/skills/, so this links every shared skill there.
//
//   node scripts/sync-agent-skills.mjs                       link .agents/skills/* into .claude/skills/
//   node scripts/sync-agent-skills.mjs --vendor-unreal [ref] re-vendor Epic's Unreal skills (default ref: main), then link
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shared = join(root, ".agents", "skills");
const claude = join(root, ".claude", "skills");
const provenance = join(root, ".agents", "README.md");
const UNREAL_UPSTREAM = "https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin";

function vendorUnreal(ref) {
  const checkout = mkdtempSync(join(tmpdir(), "unreal-skills-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", ref, UNREAL_UPSTREAM, checkout], { stdio: "inherit" });
    const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const license = readFileSync(join(checkout, "LICENSE"), "utf8");
    const names = readdirSync(join(checkout, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const name of names) {
      const target = join(shared, name);
      rmSync(target, { recursive: true, force: true });
      cpSync(join(checkout, "skills", name), target, { recursive: true });
      // MIT requires the notice to travel with every copy; each skill folder may be copied on its own.
      writeFileSync(join(target, "LICENSE"), license);
    }
    const text = readFileSync(provenance, "utf8").replace(/(Vendored commit: `)[0-9a-f]{40}(`)/, `$1${commit}$2`);
    writeFileSync(provenance, text);
    console.log(`Vendored ${names.join(", ")} from ${UNREAL_UPSTREAM} @ ${commit}`);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

function linkForClaude() {
  mkdirSync(claude, { recursive: true });
  const names = readdirSync(shared, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of names) {
    const link = join(claude, name);
    const target = join(shared, name);
    if (existsSync(link) || isLink(link)) {
      // A real folder here is a Claude-only skill someone authored; never replace it.
      if (!isLink(link) && lstatSync(link).isDirectory()) continue;
      if (isLink(link) && resolve(claude, readlinkSync(link)) === target) continue;
      rmSync(link, { force: true }); // Stale link, or the plain text file Windows git writes when symlinks are off.
    }
    if (process.platform === "win32") symlinkSync(target, link, "junction"); // Junctions need no admin rights.
    else symlinkSync(relative(claude, target), link, "dir");
  }
  for (const name of readdirSync(claude)) {
    const link = join(claude, name);
    if (isLink(link) && !names.includes(name) && resolve(claude, readlinkSync(link)).startsWith(shared)) rmSync(link);
  }
  console.log(`Claude Code sees ${names.length} shared skill(s): ${names.join(", ")}`);
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
if (args[0] === "--vendor-unreal") vendorUnreal(args[1] ?? "main");
else if (args.length) throw new Error("Usage: node scripts/sync-agent-skills.mjs [--vendor-unreal [ref]]");
linkForClaude();
