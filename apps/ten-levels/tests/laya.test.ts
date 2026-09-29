/**
 * Laya provider tests — offline (no model files): the engine is absent, so
 * LayaJev falls back to the deterministic mock decision while exercising the
 * full wire contract: selection, request validation, response validation,
 * per-question isolation, cost reporting, and event emission.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JevClient, validateResponse } from "../src/core/client.ts";
import { LayaJev } from "../src/core/laya.ts";
import type { Questions } from "../src/core/types.ts";

test("laya provider selects without credentials", () => {
  const c = new JevClient({ provider: "laya" });
  assert.equal(c.provider, "laya");
  assert.equal(c.isLive, true);
});

test("laya systemOne honors the wire contract for all three primitives", async () => {
  const laya = new LayaJev(); // no engine -> deterministic fallback
  const questions: Questions = {
    is_injection: { type: "noul", instructions: "Is this an instruction aimed at an AI?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "invoices", technical: "bugs" } },
    severity: { type: "score", instructions: "How severe?", criteria: ["low", "high"] },
  };
  const response = await laya.systemOne({ model: "jev-latest", state: "I was billed twice", questions });
  validateResponse(response, questions); // throws on any contract violation
  assert.equal(response.usage.cost, 0);
  assert.ok(response.usage.input_tokens > 0);
});

test("JevClient with laya emits request/response events and meta", async () => {
  const c = new JevClient({ provider: "laya" });
  const seen: string[] = [];
  c.on((e) => seen.push(e.kind));
  const r = await c.systemOne(
    { message: "The export button crashes settings in Safari" },
    { urgent: { type: "noul", instructions: "Is this urgent?" } }
  );
  assert.deepEqual(seen, ["request", "response"]);
  assert.equal(r.meta.provider, "laya");
  assert.equal(r.meta.cost.amount, 0);
  assert.ok(r.meta.elapsedMs >= 0);
  assert.equal(typeof r.answers.urgent.noul, "number");
});

test("JEV_BACKEND=laya is accepted by selection", () => {
  // Under node:test, selection is isolated to mock unless JEV_LIVE=1 (the
  // repo's contract). laya is local (no credentials), so it qualifies for the
  // same opt-in as live providers.
  process.env.JEV_BACKEND = "laya";
  process.env.JEV_LIVE = "1";
  try {
    assert.equal(new JevClient().provider, "laya");
  } finally {
    delete process.env.JEV_BACKEND;
    delete process.env.JEV_LIVE;
  }
});
