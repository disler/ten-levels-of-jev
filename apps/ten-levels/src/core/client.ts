/**
 * JevClient — a provider and credential snapshot, with no runtime fallback.
 * Auto-selection prefers TypeSafe, then OpenRouter. Mock requires an explicit
 * selection or node:test isolation; missing production credentials fail closed.
 */
import { MockJev } from "./mock.ts";
import { LayaJev } from "./laya.ts";
import {
  QuestionValidationError,
  validateRequest,
  type Questions,
  type State,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./types.ts";

export type JevProvider = "mock" | "laya" | "openrouter" | "typesafe";

const ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/alpha/decisions",
  typesafe: "https://api.typesafe.ai/v1/systemone",
} as const;

const DEFAULT_MODELS = {
  openrouter: "~typesafe/jev-latest",
  typesafe: "jev-latest",
} as const;

const KEY_ENV = {
  openrouter: "OPENROUTER_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
} as const;

const RETRY_STATUSES = new Set([429, 502, 503, 529]);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Caller-supplied USD prices; no assumed provider/model rates. */
export interface JevPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export type JevCost =
  | { amount: number; source: "reported" | "estimated" | "mock" }
  | { amount: null; source: "unknown" };

export interface JevClientOptions {
  /** Overrides test isolation, JEV_BACKEND, and automatic key-based selection. */
  provider?: JevProvider;
  /** Requires opts.provider to explicitly name a live provider. */
  apiKey?: string;
  /** Full endpoint URL (not an origin). Redirects are refused. */
  baseUrl?: string;
  /** Pin a versioned model ID instead of the moving alias. */
  model?: string;
  /** Total budget including retries and response bodies. Default: 30,000 ms. */
  timeoutMs?: number;
  /** Exponential backoff base, plus up to 20% jitter. Default: 500 ms; 0 is allowed. */
  retryDelayMs?: number;
  /** Used only when usage.cost is not a valid reported cost. Snapshotted at construction. */
  pricing?: JevPricing;
}

export interface JevRawExchange {
  /** Snapshot of the JSON sent; no credentials or headers. */
  request: SystemOneRequest;
  requestText: string;
  /** Unenriched provider payload, including unknown fields. */
  response: SystemOneResponse;
  /** Exact response body text; mock responses use synthetic JSON. */
  responseText: string;
}

export interface SystemOneResult extends SystemOneResponse {
  raw: JevRawExchange;
  meta: {
    provider: JevProvider;
    requestedModel: string;
    resolvedModel: string;
    elapsedMs: number;
    attempts: number;
    /** USD, or null when no trustworthy cost is available. */
    cost: JevCost;
  };
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** Live observation of every call — the web layer streams these to the UI. */
export type JevEvent =
  | { kind: "request"; provider: JevProvider; model: string; state: State; questions: Questions }
  | { kind: "response"; result: SystemOneResult };

export class JevClient {
  readonly provider: JevProvider;
  private readonly apiKey?: string;
  private readonly endpoint?: string;
  private readonly mock = new MockJev();
  private readonly laya = new LayaJev();
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly pricing?: JevPricing;
  private listeners: ((event: JevEvent) => void)[] = [];
  /** Count of validated systemOne calls, for the demo's cost story. */
  calls = 0;

  constructor(opts: JevClientOptions = {}) {
    if (opts.apiKey !== undefined && opts.provider !== "typesafe" && opts.provider !== "openrouter") {
      throw new Error("apiKey requires an explicit live opts.provider (typesafe or openrouter).");
    }
    this.provider = selectProvider(opts.provider);
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error("timeoutMs must be a positive integer no greater than 2147483647.");
    }
    if (!isNonnegative(this.retryDelayMs)) throw new Error("retryDelayMs must be finite and nonnegative.");
    if (opts.pricing !== undefined) {
      if (!opts.pricing || !isNonnegative(opts.pricing.inputPerMillion) || !isNonnegative(opts.pricing.outputPerMillion)) {
        throw new Error("pricing requires finite, nonnegative inputPerMillion and outputPerMillion USD rates.");
      }
      this.pricing = { ...opts.pricing };
    }
    if (this.provider === "mock") return;
    if (this.provider === "laya") return; // local engine: no key, no endpoint
    this.apiKey = (opts.apiKey ?? process.env[KEY_ENV[this.provider]])?.trim();
    this.endpoint = opts.baseUrl ?? ENDPOINTS[this.provider];
    if (!this.apiKey) {
      throw new Error(`Provider "${this.provider}" needs a nonblank apiKey or ${KEY_ENV[this.provider]}.`);
    }
  }

  get isLive(): boolean {
    return this.provider === "laya" || this.provider === "openrouter" || this.provider === "typesafe";
  }

  /** Observe every request and response this client makes. */
  on(listener: (event: JevEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: JevEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async systemOne(
    state: State,
    questions: Questions,
    opts: { model?: string; signal?: AbortSignal } = {}
  ): Promise<SystemOneResult> {
    opts.signal?.throwIfAborted();
    const requestedModel = opts.model ?? this.model ??
      (this.provider === "mock" ? this.mock.model : this.provider === "laya" ? this.laya.model : DEFAULT_MODELS[this.provider]);
    const body: SystemOneRequest = { model: requestedModel, state, questions };
    validateRequest(body);
    let requestText: string;
    try {
      requestText = JSON.stringify(body);
    } catch {
      throw new QuestionValidationError("Request must be JSON-serializable (no cycles or BigInt).");
    }
    const request: SystemOneRequest = JSON.parse(requestText);
    // Validate the actual wire snapshot too (e.g. user-defined toJSON methods).
    validateRequest(request);
    this.calls++;
    const started = performance.now();
    this.emit({ kind: "request", provider: this.provider, model: requestedModel, state, questions });

    if (this.provider === "mock") {
      opts.signal?.throwIfAborted();
      const response = this.mock.systemOne(request);
      const raw = { request, requestText, response, responseText: JSON.stringify(response) };
      const out = withMeta(raw, this.provider, requestedModel, started, 1, this.pricing);
      this.emit({ kind: "response", result: out });
      return out;
    }

    if (this.provider === "laya") {
      opts.signal?.throwIfAborted();
      const response = await this.laya.systemOne(request);
      const responseText = JSON.stringify(response);
      validateResponse(JSON.parse(responseText), request.questions);
      const raw = { request, requestText, response, responseText };
      const out = withMeta(raw, this.provider, requestedModel, started, 1, undefined);
      this.emit({ kind: "response", result: out });
      return out;
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new DOMException("Jev request timed out.", "TimeoutError"));
    }, this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        signal.throwIfAborted();
        const res = await fetch(this.endpoint!, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: requestText,
          signal,
          redirect: "error",
        });
        signal.throwIfAborted();
        if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
          const backoff = this.retryDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
          const delay = Math.min(8000, Math.max(backoff, retryAfterMs(res.headers.get("retry-after"))));
          await res.body?.cancel();
          await sleep(delay, signal);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          const hint = res.status === 401 ? ` Check the ${KEY_ENV[this.provider]} key.`
            : res.status === 402 ? " Check account credits." : "";
          throw new Error(`${this.provider} HTTP ${res.status}.${hint}`);
        }
        const responseText = await res.text();
        signal.throwIfAborted();
        let response: unknown;
        try {
          response = JSON.parse(responseText);
        } catch {
          throw new ContractError("Invalid response JSON.");
        }
        validateResponse(response, request.questions);
        const raw = { request, requestText, response, responseText };
        const out = withMeta(raw, this.provider, requestedModel, started, attempt, this.pricing);
        this.emit({ kind: "response", result: out });
        return out;
      }
      throw new Error(`${this.provider} retries exhausted`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function selectProvider(explicit?: JevProvider): JevProvider {
  // node:test cannot accidentally use ambient live credentials/overrides.
  // Explicit opts.provider or the existing JEV_LIVE=1 opt-in bypass isolation.
  const isolated = process.env.NODE_TEST_CONTEXT && process.env.JEV_LIVE !== "1";
  const selected = explicit ?? (isolated ? "mock" : process.env.JEV_BACKEND?.trim() || undefined);
  if (selected !== undefined) {
    if (selected === "mock" || selected === "laya" || selected === "typesafe" || selected === "openrouter") return selected;
    throw new Error(`Unknown JEV backend "${selected}"; use mock, laya, openrouter, or typesafe.`);
  }
  if (process.env.TYPESAFE_API_KEY?.trim()) return "typesafe";
  if (process.env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  throw new Error("No Jev credentials: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or explicitly select provider: mock / laya (local) / JEV_BACKEND=mock for offline use.");
}

function resultCost(response: SystemOneResponse, provider: JevProvider, pricing?: JevPricing): JevCost {
  if (provider === "mock") return { amount: 0, source: "mock" };
  if (provider === "laya") return { amount: 0, source: "estimated" }; // local inference: no metered cost
  if (isNonnegative(response.usage.cost)) return { amount: response.usage.cost, source: "reported" };
  if (pricing) {
    const amount = response.usage.input_tokens / 1_000_000 * pricing.inputPerMillion +
      response.usage.output_tokens / 1_000_000 * pricing.outputPerMillion;
    if (isNonnegative(amount)) return { amount, source: "estimated" };
  }
  return { amount: null, source: "unknown" };
}

function withMeta(
  raw: JevRawExchange,
  provider: JevProvider,
  requestedModel: string,
  started: number,
  attempts: number,
  pricing?: JevPricing
): SystemOneResult {
  return {
    // Separate nested answers/usage from raw; enrichment never edits provider data.
    ...structuredClone(raw.response),
    raw,
    meta: {
      provider,
      requestedModel,
      resolvedModel: raw.response.model,
      elapsedMs: Math.round(performance.now() - started),
      attempts,
      cost: resultCost(raw.response, provider, pricing),
    },
  };
}

/** Ignore malformed/negative values instead of letting NaN erase the backoff. */
function retryAfterMs(header: string | null): number {
  if (!header?.trim()) return 0;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }
  // HTTP-date forms begin with a weekday; Date.parse alone also accepts "-1".
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const isNonnegative = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
const isUnit = (x: unknown): x is number => isNonnegative(x) && x <= 1;
const isTokenCount = (x: unknown): x is number => isNonnegative(x) && Number.isSafeInteger(x);

/** Strict live contract; unknown payload fields are deliberately retained. */
export function validateResponse(response: unknown, questions: Questions): asserts response is SystemOneResponse {
  if (!isObject(response) || !isObject(response.answers) || typeof response.model !== "string" || !response.model.trim()) {
    throw new ContractError("Invalid response envelope: expected model and answers.");
  }
  if (!isObject(response.usage) || !isTokenCount(response.usage.input_tokens) || !isTokenCount(response.usage.output_tokens)) {
    throw new ContractError("Invalid response usage: expected nonnegative integer input_tokens and output_tokens.");
  }
  for (const [id, q] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!Object.hasOwn(response.answers, id) || !isObject(answer) || answer.type !== q.type) {
      throw new ContractError(`Missing or mismatched answer: ${id}`);
    }
    if (q.type === "noul") {
      if (!isUnit(answer.noul)) throw new ContractError(`Invalid noul: ${id}`);
      continue;
    }
    if (!isUnit(answer.confidence) || !isObject(answer.probabilities)) {
      throw new ContractError(`Invalid distribution: ${id}`);
    }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const probs = answer.probabilities;
    if (Object.keys(probs).length !== keys.length || !keys.every((k) => Object.hasOwn(probs, k) && isUnit(probs[k]))) {
      throw new ContractError(`Distribution keys must match the declared criteria: ${id}`);
    }
    const sum = keys.reduce((acc, k) => acc + (probs[k] as number), 0);
    if (Math.abs(sum - 1) > 0.025) throw new ContractError(`Distribution does not sum to one: ${id} (${sum})`);
    if (q.type === "choice" && (typeof answer.choice !== "string" || !keys.includes(answer.choice))) {
      throw new ContractError(`Undeclared choice returned: ${id}`);
    }
    if (q.type === "score") {
      if (!isNonnegative(answer.score) || answer.score > keys.length - 1) {
        throw new ContractError(`Score out of range: ${id}`);
      }
      const legend = answer.legend;
      if (!isObject(legend) || Object.keys(legend).length !== keys.length ||
        !keys.every((k, i) => Object.hasOwn(legend, k) && legend[k] === q.criteria[i])) {
        throw new ContractError(`Score legend must match the declared criteria: ${id}`);
      }
    }
  }
}

let _shared: JevClient | undefined;

/** Lazily constructed; provider and credentials resolve only on first use. */
export function sharedJev(): JevClient {
  if (!_shared) _shared = new JevClient();
  return _shared;
}

/** Shared client for every level. Use JEV_BACKEND=mock for an offline demo. */
export const jev = new Proxy({} as JevClient, {
  get(_target, prop) {
    const value = (sharedJev() as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(sharedJev()) : value;
  },
});
