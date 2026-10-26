import type { AgentEvent, ExtractorMeta, MenuItem } from '../../src/types.ts';

export type { AgentEvent, ExtractorMeta, MenuItem };
export type { Score } from '../../src/types.ts';

// ---- Response shapes (mirrors src/server + src/fleet; kept local so the UI only depends on src/types.ts) ----

export interface Health {
  ok: boolean;
  llmMode: 'live' | 'record' | 'replay' | string;
  /** False on hosts without a headless browser (e.g. the free-tier slim image). */
  browser?: boolean;
  slowBrowser?: boolean;
  /** True when the library is mirrored to a durable store. */
  store?: boolean;
  nebius: boolean;
  tavily: boolean;
  models: Partial<Record<'triage' | 'oracle' | 'forge' | 'escalate' | 'vision', string>>;
}

export interface ForgeSummary {
  ok: boolean;
  reason?: string;
  mode?: 'forged' | 'reused' | 'healed';
  rounds: number;
  ms: number;
  costUsd: number;
  tokens: number;
  byModel?: Record<string, unknown>;
  id?: string;
}

export interface Fixture {
  slug: string;
  url: string;
  restaurant?: string | null;
  platform?: string | null;
  items: number | null;
  redesigned: boolean;
}

export type FleetStatus = 'stable' | 'changed' | 'healed' | 'review' | 'broken' | 'error';

export interface PriceChange {
  name: string;
  section?: string | null;
  kind: 'price' | 'added' | 'removed';
  oldPrice?: number | null;
  newPrice?: number | null;
}

export interface FleetEntry {
  id: string;
  domain: string;
  restaurant?: string | null;
  status: FleetStatus;
  detail: string;
  items: number;
  baselineItems: number;
  ms: number;
  tokens: number;
  costUsd: number;
  changes: PriceChange[];
  version: number;
  audit?: AuditResult;
}

export interface AuditResult {
  at: string;
  pass: boolean;
  recall: number;
  precision: number;
  f1: number;
  oracleCount: number;
  extractorCount: number;
  missing: MenuItem[];
  stillOnPage?: string[];
  wrongPrice: { name: string; expected: number | null; got: number | null }[];
  extra: MenuItem[];
}

export interface CheckResult {
  entry: FleetEntry;
  items: MenuItem[];
}

export interface FleetReport {
  startedAt: string;
  finishedAt: string;
  entries: FleetEntry[];
  totals: { extractors: number; stable: number; changed: number; healed: number; review?: number; broken: number; error: number; tokens: number; costUsd: number; ms: number };
}

export interface LibraryDetail {
  meta: ExtractorMeta;
  code: string;
  versions: { version: number; code: string | null }[];
  items: MenuItem[] | null;
}

export type FleetStreamEvent = AgentEvent | { type: 'report'; report: FleetReport };

// ---- Fetch helpers ----

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  health: () => getJson<Health>('/api/health'),
  library: () => getJson<ExtractorMeta[]>('/api/library'),
  extractor: (id: string) => getJson<LibraryDetail>(`/api/library/${encodeURIComponent(id)}`),
  fleetHistory: () => getJson<FleetReport[]>('/api/fleet/history'),
  fixtures: () => getJson<Fixture[]>('/api/fixtures'),
  bench: () => getJson<unknown>('/api/bench'),
  measured: () => getJson<Measured>('/api/bench/measured'),
  rescrape: (id: string) => getJson<CheckResult>(`/api/library/${encodeURIComponent(id)}/rescrape`, { method: 'POST' }),
  audit: (id: string) => getJson<CheckResult>(`/api/library/${encodeURIComponent(id)}/audit`, { method: 'POST' }),
  redesign: (slug: string, on: boolean) =>
    getJson<{ redesigned: string[] }>(`/api/fixtures/${encodeURIComponent(slug)}/redesign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on }),
    }),
};

type Summary = Record<string, number> | null;
export interface Measured {
  heal: Summary;
  variance: Summary;
  varianceT0?: Summary;
  tavily: Summary;
  tavilyHoldout: Summary;
  precision: Summary;
  coverage?: Record<string, { cases: number; healed: number; correctAfter: number } | number> | null;
  falseAlarms?: Summary;
}
