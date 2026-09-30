/**
 * Level 6 on Claude Code: guardrail hooks. Claude never knows Jev is here.
 *
 *   PreToolUse   Bash: gateBashCommand, deny irreversible or destructive commands
 *                Write, Edit: gateWriteCall, deny paths outside the repo (code) and credentials (Jev)
 *   PostToolUse  Read, Bash: screenToolResult, add a warning as context when the output carries instructions
 *
 * Claude Code cannot rewrite a built-in tool's output, so option C adds the banner as additionalContext
 * instead of prepending it. Any error fails open: the tool runs as if the hook were not there.
 */
import { BLOCK_NOTICE, gateBashCommand, gateWriteCall, screenToolResult } from "../src/levels/level06/index.ts";
import { decide, emit, readStdinJson } from "./jev.ts";

/** Claude's tool_response shapes differ per tool; the screen only needs the text. */
function resultText(r: any): string {
  if (typeof r === "string") return r;
  if (r?.file?.content) return String(r.file.content);
  if (r?.stdout !== undefined || r?.stderr !== undefined) return [r.stdout, r.stderr].filter(Boolean).join("\n");
  return JSON.stringify(r ?? "");
}

async function main() {
  const input = await readStdinJson();
  const tool: string = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const cwd: string = input.cwd ?? process.cwd();
  const ask = (source: string) => (s: any, q: any) => decide(source, s, q);

  if (input.hook_event_name === "PreToolUse") {
    const d =
      tool === "Bash" ? await gateBashCommand(String(ti.command ?? ""), cwd, ask("PreToolUse Bash"))
      : tool === "Write" || tool === "Edit"
        ? await gateWriteCall(String(ti.file_path ?? ""), String(ti.content ?? ti.new_string ?? ""), cwd, ask(`PreToolUse ${tool}`))
        : null;
    if (d?.block) {
      emit({
        systemMessage: `jev-guard blocked ${tool}: ${d.reason}`,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `jev-guard blocked this ${tool}: ${d.reason}. ${BLOCK_NOTICE}`,
        },
      });
    }
    return;
  }

  if (input.hook_event_name === "PostToolUse" && (tool === "Read" || tool === "Bash")) {
    const d = await screenToolResult(tool.toLowerCase(), resultText(input.tool_response), ask(`PostToolUse ${tool}`));
    if (d.flag && d.banner) {
      emit({
        systemMessage: `jev-guard flagged ${tool} output (${d.noul.toFixed(2)})`,
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: d.banner },
      });
    }
  }
}

main().catch((err) => process.stderr.write(`jev-guard: ${err?.message ?? err}\n`)); // fail open
