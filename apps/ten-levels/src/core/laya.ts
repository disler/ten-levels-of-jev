/**
 * LayaJev — a local, offline System One provider.
 *
 * Runs Laya (convaiinnovations/laya), the open-weight Jev-compatible decision
 * model, in-process via ONNX Runtime. Same three primitives as the hosted API
 * (noul / choice / score), calibrated probabilities, zero network, zero key,
 * zero data egress: the state never leaves the machine.
 *
 * Answers follow the exact wire contract of types.ts, so validateResponse()
 * accepts them unchanged. Requires `@receptron/laya` (onnxruntime-node +
 * @huggingface/tokenizers) and the model files on disk; falls back to a
 * word-overlap mock decision when either is missing, so JEV_BACKEND=laya
 * stays deterministic in CI without the 500 MB model.
 */
import { MockJev, flattenState } from "./mock.ts";
import {
  type Answer,
  type ChoiceQuestion,
  type NoulQuestion,
  type Question,
  type Questions,
  type ScoreQuestion,
  type State,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./types.ts";

export interface LayaJevOptions {
  /** Directory containing model.onnx, tokenizer, and rl_agent_config.json. */
  modelDir?: string;
  /** Loaded engine from @receptron/laya; when absent a mock decision is used. */
  engine?: LayEngine | undefined;
}

/** Structural type of @receptron/laya's engine; import is dynamic and optional. */
export interface LayEngine {
  decide(req: unknown): Promise<unknown>;
}

const MODEL_DIR_ENV = "LAYA_MODEL_DIR";
const DEFAULT_MODEL_ID = "laya-local";

export class LayaJev {
  readonly model = DEFAULT_MODEL_ID;
  private readonly mock = new MockJev();
  private readonly engine: LayEngine | undefined;
  private readonly modelDir: string;

  constructor(opts: LayaJevOptions = {}) {
    this.engine = opts.engine;
    this.modelDir = opts.modelDir ?? process.env[MODEL_DIR_ENV] ?? "";
  }

  get available(): boolean {
    return this.engine !== undefined;
  }

  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    const started = performance.now();
    const answers: Record<string, Answer> = {};
    let inputTokens = 0;

    // One isolated sequence per question (parallel in one batch inside the
    // engine). Concatenating questions into one sequence measurably degrades
    // calibration — see issue #4.
    const jobs: Array<Promise<void>> = [];
    for (const [id, q] of Object.entries(request.questions)) {
      jobs.push(
        (async () => {
          answers[id] = await this.answerOne(request.state, q);
        })()
      );
      inputTokens += this.countTokens(request.state, q);
    }
    await Promise.all(jobs);

    return {
      model: this.model,
      answers,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0, // ponytail: local model, output side is free/unmetered
        cost: 0,
      },
      // Local extensions retained for observability parity with live providers.
      provider: "laya",
      elapsed_ms: Math.round(performance.now() - started),
    } as SystemOneResponse;
  }

  private async answerOne(state: State, q: Question): Promise<Answer> {
    const text = flattenState(state);
    if (!this.engine) {
      // Deterministic offline fallback: reuse the mock's shape-correct decision.
      const single: Questions = { q: q };
      const r = this.mock.systemOne({ state, questions: single });
      return r.answers.q;
    }
    const raw = await this.engine.decide(this.toLayaRequest(text, q));
    return this.fromLayaAnswer(raw, q);
  }

  /** Map a wire question onto laya's { type, question, options } shape. */
  private toLayaRequest(text: string, q: Question): Record<string, unknown> {
    const instructions = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
    const base = { state: text, question: instructions };
    if (q.type === "noul") {
      const nq = q as NoulQuestion;
      return { ...base, type: "noul", options: { true: nq.criteria?.true ?? "yes", false: nq.criteria?.false ?? "no" } };
    }
    if (q.type === "choice") {
      return { ...base, type: "choice", options: (q as ChoiceQuestion).criteria };
    }
    const levels = (q as ScoreQuestion).criteria;
    const options: Record<string, string> = {};
    levels.forEach((desc, i) => { options[String(i)] = desc; });
    return { ...base, type: "score", options };
  }

  /** Map laya's per-option probabilities back onto the wire contract. */
  private fromLayaAnswer(raw: unknown, q: Question): Answer {
    const probs = (raw as { probabilities?: Record<string, number> })?.probabilities ?? {};
    if (q.type === "noul") {
      const yes = Number(probs["true"] ?? 0.5);
      return { type: "noul", noul: clamp01(yes) };
    }
    if (q.type === "choice") {
      const criteria = (q as ChoiceQuestion).criteria;
      const probabilities = normalize(Object.keys(criteria), probs);
      const choice = topKey(probabilities);
      return { type: "choice", choice, probabilities, confidence: confidenceOf(probabilities) };
    }
    const levels = (q as ScoreQuestion).criteria;
    const probabilities = normalize(levels.map((_, i) => String(i)), probs);
    const score = levels.reduce((acc, _, i) => acc + (probabilities[String(i)] ?? 0) * i, 0);
    const legend: Record<string, string> = {};
    levels.forEach((desc, i) => { legend[String(i)] = desc; });
    return { type: "score", score, legend, probabilities, confidence: confidenceOf(probabilities) };
  }

  /** Rough token accounting so usage stays plausible without a real tokenizer pass. */
  private countTokens(state: State, q: Question): number {
    const chars = flattenState(state).length + JSON.stringify(q).length;
    return Math.ceil(chars / 4);
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Renormalize engine probabilities so distributions sum to 1 (validation requires ±0.025). */
function normalize(keys: string[], probs: Record<string, number>): Record<string, number> {
  const values = keys.map((k) => Math.max(1e-9, Number(probs[k] ?? 0)));
  const sum = values.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = sum > 0 ? values[i] / sum : 1 / keys.length; });
  return out;
}

function topKey(probs: Record<string, number>): string {
  return Object.keys(probs).reduce((a, b) => (probs[a] >= probs[b] ? a : b));
}

/** Peaked-ness confidence, same definition as the mock's. */
function confidenceOf(probs: Record<string, number>): number {
  const values = Object.values(probs);
  const sorted = [...values].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const rest = sorted[1] ?? 0;
  return clamp01(top - rest);
}
