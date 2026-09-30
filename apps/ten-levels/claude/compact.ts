/**
 * Level 7 on Claude Code, option A: should I compact. A Stop hook.
 *
 * At the end of every turn: build the CompactState from the transcript in code, one Jev call with the
 * four Level 7 questions, decideTier in code. Claude cannot compact itself, so any tier above silent
 * goes to you as a one-line message telling you when /compact is worth it. Options B and C
 * (compact_now, pick the cut point) need an agent-side compact call and have no Claude equivalent.
 */
import { readFileSync } from "node:fs";
import { COMPACT_QUESTIONS, decideTier, type CompactAnswers, type CompactState, type Lines } from "../src/levels/level07/index.ts";
import type { Questions } from "../src/core/types.ts";
import { decide, emit, readStdinJson } from "./jev.ts";

// ponytail: fixed lines for real Claude sessions (the pi lab uses 6k/10k/14k); a fresh session with many plugins already
// sits near 77k, so the lines start above that. Override with JEV_COMPACT_LINES='{"notice":...}'
const LINES: Lines = { notice: 150_000, recommend: 300_000, request: 500_000, ...JSON.parse(process.env.JEV_COMPACT_LINES || "{}") };
const WINDOW = Number(process.env.JEV_CONTEXT_WINDOW || 200_000);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const blocks = (m: any): any[] => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : m?.content ?? []);
const textOf = (m: any) => blocks(m).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

/** A message you typed: not meta, not a tool result, not a slash-command wrapper. */
const isTyped = (e: any) =>
  e.type === "user" && !e.isMeta && !e.isCompactSummary &&
  !blocks(e.message).some((b) => b.type === "tool_result") && textOf(e.message) && !textOf(e.message).startsWith("<");

export function buildState(entries: any[]): { state: CompactState; tokens: number } | null {
  const lastTyped = entries.findLastIndex(isTyped);
  if (lastTyped < 0) return null;
  const turn = entries.slice(lastTyped + 1).filter((e) => e.type === "assistant");
  const summary = entries.findLast((e) => e.isCompactSummary);
  const earlier = entries.slice(0, lastTyped).filter(isTyped).map((e) => clip(textOf(e.message), 200));
  const tools = [...new Set(turn.flatMap((e) => blocks(e.message).filter((b) => b.type === "tool_use").map((b) => b.name)))];
  const lastText = turn.map((e) => textOf(e.message)).filter(Boolean).pop() ?? "";
  const u = entries.findLast((e) => e.type === "assistant" && e.message?.usage)?.message.usage ?? {};
  return {
    state: {
      current_request: clip(textOf(entries[lastTyped].message), 600),
      previous_work: [...earlier, summary ? `Summary so far: ${clip(textOf(summary.message), 400)}` : ""].filter(Boolean).join("\n"),
      recent_turn: clip(lastText || `(tool calls only: ${tools.join(", ") || "none"})`, 600),
      tools_this_turn: tools,
    },
    tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  };
}

async function main() {
  const input = await readStdinJson();
  const entries = readFileSync(input.transcript_path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const built = buildState(entries);
  if (!built || built.tokens < LINES.notice) return; // below the notice line: skip the call entirely
  const { answers } = await decide("Stop compact", built.state as any, COMPACT_QUESTIONS as Questions);
  const usage = { tokens: built.tokens, pct: (built.tokens / WINDOW) * 100 };
  const d = decideTier(answers as unknown as CompactAnswers, usage, true, LINES, built.state);
  if (d.tier === "silent") return;
  const verb = { notice: "Optional", recommend: "Recommended", request: "Strongly recommended" }[d.tier];
  emit({ systemMessage: `Jev /compact ${d.tier}: ${verb}. Context ${Math.round(built.tokens / 1000)}k tokens. ${d.reason}` });
}

if (process.argv[2] === "--selftest") {
  const assert = await import("node:assert/strict");
  const e = [
    { type: "user", message: { content: "fix the proration bug" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Fixed, tests pass." }, { type: "tool_use", name: "Edit" }], usage: { input_tokens: 5, cache_read_input_tokens: 70_000 } } },
    { type: "user", message: { content: [{ type: "tool_result" }] } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "user", message: { content: "now write the README" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }], usage: { input_tokens: 1, cache_read_input_tokens: 80_000 } } },
  ];
  const b = buildState(e)!;
  assert.equal(b.state.current_request, "now write the README");
  assert.equal(b.state.previous_work, "fix the proration bug");
  assert.deepEqual(b.state.tools_this_turn, ["Read"]);
  assert.equal(b.tokens, 80_001);
  console.log("ok");
} else {
  main().catch((err) => process.stderr.write(`jev-compact: ${err?.message ?? err}\n`)); // fail open
}
