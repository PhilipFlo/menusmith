/** One dish as Menusmith understands it. Prices are numbers in the menu's own currency. */
export interface MenuItem {
  section?: string | null;
  name: string;
  description?: string | null;
  price: number | null;
  currency?: string | null;
}

/** Result of running an extractor in the sandbox. */
export interface RunResult {
  ok: boolean;
  items: MenuItem[];
  error?: string;
  ms: number;
}

/** How well an extractor's output agrees with the oracle (the model's own reading of the page). */
export interface Score {
  precision: number;
  recall: number;
  f1: number;
  pricedRatio: number;
  matched: number;
  oracleCount: number;
  extractorCount: number;
  /** Oracle items the extractor missed (name + price), capped for prompts/UI. */
  missing: MenuItem[];
  /** Extractor items the oracle doesn't recognise and that aren't on the page (or were judged not to be dishes). */
  extra: MenuItem[];
  /** Extractor items not in the reference but present in the page text — the oracle may have missed them. */
  grounded: MenuItem[];
  /** Second copies of an already-matched dish. */
  duplicates: number;
  /** Same name, different price. */
  wrongPrice: { name: string; expected: number | null; got: number | null }[];
  pass: boolean;
}

/** Where an extractor's input comes from. */
export type SourceKind = 'html' | 'rendered' | 'json';

/** A captured API request that returns the menu as JSON — replayed on every re-run. */
export interface SourceRequest {
  url: string;
  method: string;
  body?: string | null;
  headers?: Record<string, string>;
}

/** Website builder or hosted ordering system ("wordpress", "squarespace", "winorder", …) or "unknown". */
export type Platform = string;

/** Metadata stored next to every committed extractor. */
export interface ExtractorMeta {
  id: string; // domain-based slug, e.g. "villaparadiso-no"
  version: number;
  url: string;
  domain: string;
  restaurant?: string | null;
  platform: Platform;
  /** html: plain GET · json: replay a captured menu API request · rendered: headless browser. */
  source: { kind: SourceKind; request?: SourceRequest | null };
  createdAt: string;
  model: string;
  rounds: number;
  score: Pick<Score, 'precision' | 'recall' | 'f1' | 'pricedRatio' | 'oracleCount' | 'extractorCount'>;
  /** Tokens spent creating this version (oracle + forge + repairs). */
  tokens: { prompt: number; completion: number };
  costUsd: number;
  /** Hash of the item list the extractor produced when committed — the drift baseline. */
  baselineHash: string;
  baselineCount: number;
  /** If this extractor was adopted from the library instead of forged. */
  reusedFrom?: string | null;
  history?: { version: number; reason: string; at: string }[];
}

/** Events streamed to the UI while the agent works. */
export type AgentEvent =
  | { type: 'step'; step: string; status: 'start' | 'done' | 'fail' | 'skip'; detail?: string; data?: unknown }
  | { type: 'log'; message: string }
  | { type: 'llm'; role: string; model: string; promptTokens: number; completionTokens: number; costUsd: number; ms: number }
  | { type: 'code'; version: number; round: number; code: string }
  | { type: 'test'; round: number; score: Score; run: Omit<RunResult, 'items'> & { count: number } }
  | { type: 'oracle'; items: MenuItem[] }
  | { type: 'result'; ok: boolean; meta?: ExtractorMeta; items?: MenuItem[]; reason?: string }
  | { type: 'error'; message: string };

/** Events may carry `target` (the extractor id) when emitted inside a fleet run. */
export type Emit = (e: AgentEvent & { target?: string }) => void;
