/**
 * Levels 8 to 10 on Claude Code: the pi tools as one stdio MCP server named "jev".
 *
 *   L8  ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score   a judgment about one file, never the file
 *   L9  ask_jev_files, pick_first_file                                  many files, one call each, in parallel
 *   L10 ask_jev                                                         own state + paths + a command, one call
 *
 * The level functions do the work; this file is only the wire. The server instructions carry the
 * Level 10 nudge. ask_jev commands go through the Level 6 bash gate first, as in pi.
 */
import { exec } from "node:child_process";
import { createInterface } from "node:readline";
import { BLOCK_NOTICE, gateBashCommand } from "../src/levels/level06/index.ts";
import { askFileBool, askFileChoice, askFileScore, FileStateError } from "../src/levels/level08/index.ts";
import { askFiles, pickFirstFile } from "../src/levels/level09/index.ts";
import { ASK_JEV_DESCRIPTION, AskStateError, assembleState, parseQuestions, type CommandOutput } from "../src/levels/level10/index.ts";
import { decide, repoDir } from "./jev.ts";

const NUDGE =
  "You have the jev tools. When you need a classification, a risk score, or a yes or no with a confidence, " +
  "prefer them over reasoning it out yourself or reading whole files. Give them paths or a command instead of pasting content. " +
  "They answer in about 300 ms and cost almost nothing.";

const WHEN =
  "Use this for a judgment about what a file does or contains, without reading it into your context. " +
  "Write the question against `content`, which is the file's text. Use Read instead when you need the code itself, to edit or quote it. " +
  "Exact lookups belong to Grep, not here.";

// Copied from extensions/ask-jev-files.ts, which imports pi's typebox.
const QUESTION_SCHEMA =
  'questions_json is a JSON object keyed by question id. Three types. ' +
  'noul: {"type":"noul","instructions":"Does `content` ...?","criteria":{"true":"...","false":"..."}} returns a probability of yes. ' +
  'choice: {"type":"choice","instructions":"Which ... is `content`?","criteria":{"option_a":"when it applies","option_b":"...","other":"none of the above"}} returns one of your keys plus confidence, up to 255 options. ' +
  'score: {"type":"score","instructions":"How ... is `content`?","criteria":["lowest situation","...","highest situation"]} returns a position on your levels, two to ten of them. ' +
  "Write every question against `content`, the file's text; `path` is also in the state. Ask every question you might need in one block, it is one call per file either way.";

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const via = (source: string) => (s: any, q: any) => decide(source, s, q);

function runCommand(command: string, cwd: string): Promise<CommandOutput> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 800_000, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? null : 0;
      resolve({ command, exit_code: code, stdout: String(stdout).slice(0, 200_000), stderr: String(stderr).slice(0, 200_000) });
    });
  });
}

const TOOLS: { name: string; description: string; inputSchema: object; run: (a: any, cwd: string) => Promise<unknown> }[] = [
  {
    name: "ask_jev_file_bool",
    description: `Yes or no about one file. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. ${WHEN}`,
    inputSchema: obj({ path: str("File path, relative to the repo"), question: str("A yes or no question about `content`"), yes: str("What counts as yes"), no: str("What counts as no") }, ["path", "question"]),
    run: (a, cwd) => askFileBool(a.path, a.question, cwd, { yes: a.yes, no: a.no }, via("ask_jev_file_bool")),
  },
  {
    name: "ask_jev_file_choice",
    description: `Pick one option about one file. Returns { path, choice, confidence, probabilities }. The choice is always one of your options; an "other" option is added if you leave none. ${WHEN}`,
    inputSchema: obj({ path: str("File path, relative to the repo"), question: str("The question, for example: Which layer is `content`?"), options: { type: "object", additionalProperties: { type: "string" }, description: "Option name to a one line description of when it applies. Up to 255." } }, ["path", "question", "options"]),
    run: (a, cwd) => askFileChoice(a.path, a.question, a.options, cwd, via("ask_jev_file_choice")),
  },
  {
    name: "ask_jev_file_score",
    description: `A position on a scale you define, about one file. Returns { path, score, top, nearest, confidence, legend }. Levels are ordered low to high, two to ten of them, each a described situation. ${WHEN}`,
    inputSchema: obj({ path: str("File path, relative to the repo"), question: str("The question, for example: How risky is a refactor of `content`?"), levels: { type: "array", items: { type: "string" }, description: "Ordered low to high, each level a situation" } }, ["path", "question", "levels"]),
    run: (a, cwd) => askFileScore(a.path, a.question, a.levels, cwd, via("ask_jev_file_score")),
  },
  {
    name: "ask_jev_files",
    description:
      "Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, drops node_modules, .git, binaries, " +
      "and files over the budget, caps the list at 255, then makes one Jev call per file in parallel. Returns { results: [{ path, answers }], skipped, calls }. " + QUESTION_SCHEMA,
    inputSchema: obj({ paths_or_globs: { type: "array", items: { type: "string" }, description: 'Files, directories, or globs, relative to the repo, for example ["src/**/*.ts"]' }, questions_json: str("The question block as a JSON string"), recursive: { type: "boolean", description: "For directories: include every file below them. Default false." } }, ["paths_or_globs", "questions_json"]),
    run: (a, cwd) => askFiles(a.paths_or_globs, a.questions_json, cwd, { recursive: a.recursive ?? false, decide: via("ask_jev_files") }),
  },
  {
    name: "pick_first_file",
    description: "After ask_jev_files, choose which of a list of files to open first for a goal. One Choice keyed by path, so the pick is always a real file. Returns { path | null, confidence, probabilities }.",
    inputSchema: obj({ question: str("The goal, for example: Which file should I open first to fix the proration bug?"), candidates: { type: "array", items: obj({ path: { type: "string" }, note: { type: "string" } }, ["path"]), description: "Paths, with an optional one line note each" } }, ["question", "candidates"]),
    run: (a) => pickFirstFile(a.question, a.candidates, via("pick_first_file")),
  },
  {
    name: "ask_jev",
    description: ASK_JEV_DESCRIPTION,
    inputSchema: obj({ questions_json: str("The question block, a JSON object keyed by question id"), state: str("Your own state: plain text, or a JSON object as a string. Short. Not for pasting files or output."), paths: { type: "array", items: { type: "string" }, description: 'Files or globs for code to read into files["path"]. Up to 20 files.' }, command: str("A command for code to run in the repo; its result goes into output. Runs through the bash gate.") }, ["questions_json"]),
    run: async (a, cwd) => {
      const questions = parseQuestions(a.questions_json);
      const run = async (command: string, dir: string) => {
        const gate = await gateBashCommand(command, dir, via("ask_jev command gate"));
        if (gate.block) throw new AskStateError(`ask_jev: the command was refused by the bash gate: ${gate.reason}. ${BLOCK_NOTICE} ask_jev commands should only read.`);
        return runCommand(command, dir);
      };
      const { state, summary } = await assembleState({ state: a.state, paths: a.paths, command: a.command }, cwd, run);
      const r = await decide("ask_jev", state, questions);
      return { answers: r.answers, state_summary: summary, usage: r.usage, model: r.model };
    },
  },
];

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications need no reply
  const reply = (result: object) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "jev", version: "1.0.0" }, instructions: NUDGE });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return send({ id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } });
      try {
        return reply({ content: [{ type: "text", text: JSON.stringify(await tool.run(msg.params.arguments ?? {}, repoDir()), null, 2) }] });
      } catch (err: any) {
        const text = err instanceof FileStateError || err instanceof AskStateError ? err.message : `error: ${err?.message ?? err}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
