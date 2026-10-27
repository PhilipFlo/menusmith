import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import OpenAI from 'openai';
import { config, costUsd, ROOT, MODELS, type Role } from '../config.ts';
import type { Emit } from '../types.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  role: Role;
  messages: ChatMessage[];
  /** Ask for a JSON object back (response_format json_object) and parse it. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * Nemotron 3 reasons before answering by default. Off for fast, mechanical calls
   * (triage, reading a menu); on for writing and repairing code.
   * Sent as chat_template_kwargs.enable_thinking (per the NVIDIA model cards).
   */
  thinking?: boolean;
  /** Label for the event stream / ledger, e.g. "oracle", "forge#2". */
  label?: string;
}

export interface ChatResult {
  text: string;
  /** The model's reasoning, when it returns it separately (shown in the live trace). */
  reasoning?: string;
  json?: unknown;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  ms: number;
  cached: boolean;
}

/** Running token/cost total for one job (one forge, one fleet run …). */
export class Ledger {
  promptTokens = 0;
  completionTokens = 0;
  /** Money actually spent (replayed recordings cost nothing). */
  costUsd = 0;
  /** What the work costs at list price, including replayed calls — used for reporting. */
  listCostUsd = 0;
  calls = 0;
  byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number; costUsd: number }> = {};
  constructor(
    /** Hard cap: no new model call starts once real spend reaches this. */
    readonly limitUsd = Number(process.env.MENUSMITH_MAX_JOB_USD || 1),
    /** Abort (e.g. the visitor closed the page) — no new model call starts. */
    readonly signal?: AbortSignal,
  ) {}
  add(r: ChatResult) {
    this.calls++;
    this.promptTokens += r.promptTokens;
    this.completionTokens += r.completionTokens;
    this.listCostUsd += r.costUsd;
    if (!r.cached) this.costUsd += r.costUsd;
    const m = (this.byModel[r.model] ||= { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    m.calls++;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.costUsd += r.costUsd;
  }
  /** Fold another job's ledger into this one (fleet heals). */
  merge(o: Ledger) {
    this.calls += o.calls;
    this.promptTokens += o.promptTokens;
    this.completionTokens += o.completionTokens;
    this.costUsd += o.costUsd;
    this.listCostUsd += o.listCostUsd;
    for (const [k, v] of Object.entries(o.byModel)) {
      const m = (this.byModel[k] ||= { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
      m.calls += v.calls;
      m.promptTokens += v.promptTokens;
      m.completionTokens += v.completionTokens;
      m.costUsd += v.costUsd;
    }
  }
  check() {
    if (this.signal?.aborted) throw new LlmError('cancelled', 499);
    if (this.costUsd >= this.limitUsd) throw new LlmError(`budget for this job ($${this.limitUsd}) reached`, 402);
  }
}

/**
 * Project-wide spend meter, persisted on disk across every run (CLI, benchmark,
 * server). Live calls add their cost; once MENUSMITH_TOTAL_BUDGET_USD is reached no
 * new model call starts until the owner raises it. Separate from per-job ledgers.
 */
// Fixed location (not the per-run cache dir), so a benchmark with its own cache can't
// start a fresh meter and slip past the project budget.
const spendFile = () => resolve(process.env.MENUSMITH_SPEND_FILE || resolve(ROOT, '.cache', 'spend.json'));
export function totalSpend(): { usd: number; calls: number; since: string } {
  if (!existsSync(spendFile())) return { usd: 0, calls: 0, since: new Date().toISOString() };
  try {
    return JSON.parse(readFileSync(spendFile(), 'utf8'));
  } catch {
    // A corrupt meter must fail CLOSED, never read back as $0.
    return { usd: Number.POSITIVE_INFINITY, calls: 0, since: '' };
  }
}
function addTotalSpend(usd: number) {
  const t = totalSpend();
  if (!Number.isFinite(t.usd)) return;
  mkdirSync(dirname(spendFile()), { recursive: true });
  const tmp = `${spendFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ usd: Math.round((t.usd + usd) * 1e6) / 1e6, calls: t.calls + 1, since: t.since }));
  renameSync(tmp, spendFile()); // atomic: a kill mid-write can't corrupt the meter
}
const TOTAL_BUDGET_USD = Number(process.env.MENUSMITH_TOTAL_BUDGET_USD || 0);

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!config.nebiusApiKey) {
    throw new LlmError(
      'NEBIUS_API_KEY is not set. Add it to .env (see .env.example), or run with MENUSMITH_LLM=replay for the recorded demo.',
    );
  }
  client ||= new OpenAI({ baseURL: config.nebiusBaseUrl, apiKey: config.nebiusApiKey, maxRetries: 0, timeout: 150_000 });
  return client;
}

/** Benchmark-only temperature override (bench/variance.ts); ignored unless a number in [0, 2]. */
function envTemperature(): number | undefined {
  const v = process.env.MENUSMITH_TEMPERATURE;
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : undefined;
}

function cassetteKey(model: string, o: ChatOptions): string {
  const t = envTemperature();
  return createHash('sha256')
    // The override is part of the key (only when set, so existing recordings stay valid):
    // a temperature-0 run must never replay answers recorded at the default temperature.
    .update(JSON.stringify({ model, messages: o.messages, json: !!o.json, maxTokens: o.maxTokens ?? null, thinking: !!o.thinking, ...(t !== undefined ? { temperature: t } : {}) }))
    .digest('hex')
    .slice(0, 24);
}

/** Pull the JSON value out of a model reply that may include reasoning, prose or code fences. */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  // First balanced {...} or [...] block.
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = t.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new LlmError('model reply contained no parseable JSON');
}

/** Strip reasoning blocks so only the answer remains. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callLive(model: string, o: ChatOptions): Promise<Omit<ChatResult, 'json' | 'cached' | 'costUsd'>> {
  const c = getClient();
  const t0 = Date.now();
  let lastErr: unknown;
  let useJsonMode = !!o.json;
  // Hard wall-clock budget for one call including retries: a slow or flaky endpoint must not
  // keep a visitor waiting for many minutes.
  const deadline = t0 + Number(process.env.MENUSMITH_CALL_BUDGET_MS || 180_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0 && Date.now() > deadline) throw new LlmError(`${model}: no answer within the time budget`, 504);
    try {
      const body = {
        model,
        messages: o.messages,
        max_tokens: o.maxTokens ?? 4096,
        temperature: o.temperature ?? envTemperature() ?? (o.thinking ? 0.6 : 0.2),
        top_p: 0.95,
        chat_template_kwargs: { enable_thinking: !!o.thinking },
        ...(useJsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      };
      // chat_template_kwargs is a Token Factory / vLLM extension the SDK types don't know.
      const left = Math.max(10_000, deadline - Date.now());
      const res = await c.chat.completions.create(body as Parameters<typeof c.chat.completions.create>[0] & { stream?: false }, { timeout: Math.min(150_000, left) });
      const choice = res.choices[0];
      const msg = choice?.message as (OpenAI.Chat.Completions.ChatCompletionMessage & { reasoning?: string; reasoning_content?: string }) | undefined;
      let text = (msg?.content ?? '').toString();
      // Token Factory returns Nemotron's reasoning in `message.reasoning`.
      let reasoning = msg?.reasoning || msg?.reasoning_content || undefined;
      if (!text.trim() && choice?.finish_reason === 'length') {
        // Billed even though unusable — count it.
        addTotalSpend(costUsd(model, res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0));
        throw new LlmError(`${model}: ran out of output tokens${reasoning ? ' while reasoning' : ''} (max_tokens=${o.maxTokens ?? 4096})`, 413);
      }
      // Some deployments inline the reasoning as <think>…</think> in content.
      const think = text.match(/<think>([\s\S]*?)<\/think>/i);
      if (think) {
        reasoning = reasoning || think[1]!.trim();
        text = stripReasoning(text);
      } else if (text.includes('</think>')) {
        const [r, rest] = text.split('</think>');
        reasoning = reasoning || r!.trim();
        text = (rest || '').trim();
      }
      return {
        text,
        reasoning,
        model,
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
        ms: Date.now() - t0,
      };
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      // Retry rate limits and transient server errors with backoff; give up fast on the rest.
      // If the endpoint rejects JSON mode for this model, retry once without it —
      // the prompt still asks for JSON and extractJson() copes with prose around it.
      if (status === 400 && useJsonMode && /response_format|json/i.test((e as Error).message)) {
        useJsonMode = false;
        continue;
      }
      // A timed-out call already waited minutes — don't multiply that by retrying.
      if (/timeout|timed out/i.test(String((e as Error).name) + ' ' + (e as Error).message)) {
        throw new LlmError(`${model}: request timed out`, 504);
      }
      if (status === 429 || (status && status >= 500) || status === undefined) {
        await sleep(1500 * 2 ** attempt + Math.random() * 500);
        continue;
      }
      throw new LlmError(`${model}: ${(e as Error).message}`, status);
    }
  }
  throw new LlmError(`${model}: ${(lastErr as Error)?.message ?? 'failed after retries'}`);
}

/**
 * One chat call with role-based model routing, fallback, JSON parsing, cost
 * accounting, and record/replay cassettes.
 */
export async function chat(o: ChatOptions, ledger?: Ledger, emit?: Emit): Promise<ChatResult> {
  ledger?.check();
  if (TOTAL_BUDGET_USD > 0 && config.llmMode !== 'replay' && totalSpend().usd >= TOTAL_BUDGET_USD) {
    throw new LlmError(`project budget of $${TOTAL_BUDGET_USD} reached ($${totalSpend().usd.toFixed(2)} spent) — ask the owner before spending more`, 402);
  }
  const chain = MODELS[o.role];
  let lastErr: unknown;
  for (const model of chain) {
    const key = cassetteKey(model, o);
    const file = resolve(config.cassetteDir, `${key}.json`);
    let raw: Omit<ChatResult, 'json' | 'cached' | 'costUsd'> | null = null;
    let cached = false;

    // replay: recorded responses only · record: reuse a recording when one exists, else call live and save.
    if (config.llmMode === 'replay' || (config.llmMode === 'record' && existsSync(file))) {
      if (!existsSync(file)) {
        lastErr = new LlmError(
          `this server runs in offline replay mode and has no recorded model answer for this website (cassette ${key}) — only the demo restaurants are recorded. Use a demo restaurant, or run with MENUSMITH_LLM=live`,
        );
        continue; // maybe the fallback model was recorded
      }
      raw = JSON.parse(readFileSync(file, 'utf8'));
      cached = true;
    } else {
      try {
        raw = await callLive(model, o);
      } catch (e) {
        lastErr = e;
        const status = (e as LlmError).status;
        // A missing / unauthorised model → try the next one in the chain.
        if (status === 402) throw e; // out of credit — no point trying another model
        if (status === 404 || status === 400 || status === 403 || status === 429 || status === 504 || status === undefined) continue;
        throw e;
      }
      if (config.llmMode === 'record') {
        mkdirSync(config.cassetteDir, { recursive: true });
        // A short preview of the request, so recordings can be audited/filtered before committing.
        const preview = (o.messages.find((m) => m.role === 'user')?.content || '').slice(0, 160);
        writeFileSync(file, JSON.stringify({ ...raw, label: o.label || o.role, preview }, null, 2));
      }
    }

    const result: ChatResult = {
      ...raw!,
      costUsd: costUsd(raw!.model, raw!.promptTokens, raw!.completionTokens),
      cached,
    };
    if (!cached) addTotalSpend(result.costUsd);
    if (o.json) {
      try {
        result.json = extractJson(result.text);
      } catch (e) {
        lastErr = e;
        // Count the spend even when the reply was unusable.
        ledger?.add(result);
        continue;
      }
    }
    ledger?.add(result);
    emit?.({
      type: 'llm',
      role: o.label || o.role,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      ms: result.ms,
    });
    return result;
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}
