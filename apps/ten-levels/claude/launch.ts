/**
 * `just claude`: levels 6 to 10 on Claude Code, in a fresh copy of the sandbox.
 *
 * Copies sandbox/ to .sandboxes/claude-<time> with a git baseline (as server/agent-session.mjs does for pi),
 * writes .claude/settings.json (Level 6 guard, Level 7 compact hook) and .mcp.json (Levels 8 to 10 tools)
 * into the copy, then starts `claude` there with any arguments you passed. The pristine sandbox keeps its bug.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const dir = join(APP, ".sandboxes", `claude-${Date.now()}`);
const fwd = (p: string) => p.replaceAll("\\", "/"); // hook commands run through bash, even on Windows
const node = fwd(process.execPath);
const script = (f: string) => fwd(join(APP, "claude", f));

cpSync(join(APP, "sandbox"), dir, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("-c", "user.name=lab", "-c", "user.email=lab@local", "commit", "-qm", "sandbox baseline");
appendFileSync(join(dir, ".git", "info", "exclude"), "\n.jev-log.jsonl\n.claude/\n.mcp.json\n");

const hook = (f: string) => ({ type: "command", command: `"${node}" "${script(f)}"`, timeout: 20 });
mkdirSync(join(dir, ".claude"));
writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: "Bash|Write|Edit", hooks: [hook("guard.ts")] }],
    PostToolUse: [{ matcher: "Read|Bash", hooks: [hook("guard.ts")] }],
    Stop: [{ hooks: [hook("compact.ts")] }],
  },
  enabledMcpjsonServers: ["jev"],
}, null, 2));
writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
  mcpServers: { jev: { command: node, args: [script("mcp.ts")], env: { JEV_REPO: fwd(dir) } } },
}, null, 2));

console.log(`Claude sandbox: ${dir}\nJev decisions log to .jev-log.jsonl there.`);
const r = spawnSync("claude", process.argv.slice(2), { cwd: dir, stdio: "inherit" });
process.exit(r.status ?? 0);
