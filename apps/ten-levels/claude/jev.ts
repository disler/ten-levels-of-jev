/**
 * The Claude Code side channel: the one way a Claude hook or tool calls Jev.
 * Same job as extensions/report.ts `decide`, minus pi. Every call is appended to .jev-log.jsonl
 * in the repo so you can see what Jev decided; the lab window does not watch Claude sessions.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { JevClient } from "../src/core/client.ts";
import { validateQuestions, type Answer, type Questions, type State } from "../src/core/types.ts";

let client: JevClient | undefined;

export async function decide(source: string, state: State, questions: Questions) {
  validateQuestions(questions);
  const started = performance.now();
  const r = await (client ??= new JevClient()).systemOne(state, questions); // typesafe if TYPESAFE_API_KEY, else openrouter
  const out = { answers: r.answers as Record<string, Answer>, usage: r.usage, model: r.model, ms: Math.round(performance.now() - started) };
  try {
    appendFileSync(join(repoDir(), ".jev-log.jsonl"), JSON.stringify({ at: Date.now(), source, state, questions, ...out }) + "\n");
  } catch { /* the log is optional */ }
  return out;
}

export const repoDir = () => process.env.JEV_REPO ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

export async function readStdinJson(): Promise<any> {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  return JSON.parse(raw || "{}");
}

export const emit = (payload: unknown) => process.stdout.write(JSON.stringify(payload));
