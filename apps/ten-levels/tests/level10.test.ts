import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import * as l10 from "../src/levels/level10/index.ts";

const Q = JSON.stringify({
  kind: { type: "choice", instructions: "What kind of failure is this?", criteria: { bug_in_code: "The code is wrong", wrong_test: "The test is wrong", other: "None" } },
  flaky: { type: "noul", instructions: "Is this failure intermittent?" },
});

test("L10 A: JSON text becomes structured state, other text stays text", () => {
  assert.deepEqual(l10.parseState('{"diff": "+x"}'), { diff: "+x" });
  assert.equal(l10.parseState("not ok 3 - proration"), "not ok 3 - proration");
  assert.equal(l10.parseState("{broken"), "{broken");
});

test("L10 A: empty state and bad questions are refused before any call", async () => {
  await assert.rejects(l10.askJev("   ", Q), /state is empty/);
  await assert.rejects(l10.askJev("{}", Q), /state is empty/);
  await assert.rejects(l10.askJev("x", "nope"), /not valid JSON/);
  await assert.rejects(l10.askJev("x", JSON.stringify({ q: { type: "score", instructions: "x", criteria: ["one"] } })), /between 2 and 10 levels/);
});

test("L10 A: on the mock, a failing test output gets a declared kind", async () => {
  const r = await l10.askJev("not ok 3 - proration rounds to the nearest cent\nAssertionError: 1264 !== 1265", Q);
  assert.ok(["bug_in_code", "wrong_test", "other"].includes((r.answers.kind as any).choice));
  assert.equal(typeof (r.answers.flaky as any).noul, "number");
});

test("L10 B: the description teaches the three types and the boundaries", () => {
  assert.match(l10.ASK_JEV_DESCRIPTION, /noul/);
  assert.match(l10.ASK_JEV_DESCRIPTION, /choice/);
  assert.match(l10.ASK_JEV_DESCRIPTION, /score/);
  assert.match(l10.ASK_JEV_DESCRIPTION, /Not for: exact lookups/);
  assert.match(l10.ASK_JEV_DESCRIPTION, /`other` option/);
});

test("L10 C: the ledger counts calls, questions, tokens, and dollars", () => {
  let l = l10.emptyLedger();
  l = l10.record(l, { input_tokens: 500, output_tokens: 40 }, 2);
  l = l10.record(l, { input_tokens: 300, output_tokens: 20, cost: 0.00001 }, 1);
  assert.equal(l.calls, 2);
  assert.equal(l.questions, 3);
  assert.equal(l.inputTokens, 800);
  assert.ok(Math.abs(l.usd - (500 * 0.042 / 1e6 + 0.00001)) < 1e-12);
  assert.match(l10.summarize(l, 0.012), /^2 Jev calls, 3 questions, \$0\.0000/);
  assert.match(l10.summarize(l, 0.012), /agent's own spend was \d+x/);
  assert.equal(l10.summarize(l10.emptyLedger(), 1), "No Jev calls this session.");
});

test("L10: assembleState merges own state, files, and a command's output, and never truncates", async () => {
  const { assembleState } = l10;
  const SANDBOX = fileURLToPath(new URL("../sandbox/", import.meta.url));
  const run = async (command: string) => ({ command, exit_code: 1, stdout: "not ok 3 - proration", stderr: "" });
  const a = await assembleState({ state: '{"report": "export is broken"}', paths: ["src/domain/billing.ts"], command: "npm test" }, SANDBOX, run);
  assert.equal(a.state.report, "export is broken");
  assert.match((a.state.files as any)["src/domain/billing.ts"], /prorate/);
  assert.equal((a.state.output as any).exit_code, 1);
  assert.deepEqual(a.summary.own_fields, ["report"]);
  assert.match(a.summary.output!, /npm test, exit 1/);
});

test("L10: plain text state becomes text, nothing at all is refused, pasted content is refused", async () => {
  const SANDBOX = fileURLToPath(new URL("../sandbox/", import.meta.url));
  const run = async () => { throw new Error("must not run"); };
  const a = await l10.assembleState({ state: "customer says export fails" }, SANDBOX, run);
  assert.equal(a.state.text, "customer says export fails");
  await assert.rejects(l10.assembleState({}, SANDBOX, run), /nothing to judge/);
  await assert.rejects(l10.assembleState({ state: "x".repeat(9000) }, SANDBOX, run), /Do not paste/);
});

test("L10: too many files points at ask_jev_files, too many tokens names the parts and a split", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "jev10-"));
  for (let i = 0; i < 22; i++) await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i};`);
  const run = async (command: string) => ({ command, exit_code: 0, stdout: "", stderr: "" });
  await assert.rejects(l10.assembleState({ paths: ["*.ts"] }, dir, run), /more than 20 files.*ask_jev_files/);
  await writeFile(join(dir, "big1.txt"), "a".repeat(150_000));
  await writeFile(join(dir, "big2.txt"), "b".repeat(150_000));
  await assert.rejects(l10.assembleState({ paths: ["big1.txt", "big2.txt"] }, dir, run), /Split into 2 calls with the same questions_json: call 1: paths \[big[12]\.txt\]/);
  const huge = async (command: string) => ({ command, exit_code: 0, stdout: "z".repeat(260_000), stderr: "" });
  await assert.rejects(l10.assembleState({ command: "cat log" }, dir, huge), /Too large for any single call: output of `cat log`/);
});

test("L10: suggestSplit packs largest first under the budget", () => {
  const groups = l10.suggestSplit([{ name: "a", tokens: 30, kind: "file" }, { name: "b", tokens: 25, kind: "file" }, { name: "c", tokens: 20, kind: "file" }, { name: "d", tokens: 5, kind: "own" }], 50);
  assert.deepEqual(groups.map((g) => g.map((p) => p.name)), [["a", "c"], ["b", "d"]]);
});
