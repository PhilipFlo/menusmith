import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { jsonMenuLines } from '../html/jsonview.ts';
import { reacquire } from '../agent/acquire.ts';
import { priceDensity } from '../agent/discover.ts';
import { pageText } from '../html/simplify.ts';
import { Ledger } from '../llm/client.ts';
import { listExtractors, loadSnapshot, saveSnapshot, updateBaseline, type StoredExtractor } from '../library/store.ts';
import { runExtractor } from '../sandbox/runner.ts';
import type { Emit, MenuItem } from '../types.ts';
import { itemsHash, normName, samePrice, scoreAgainstOracle } from '../agent/evaluate.ts';
import { readMenu } from '../agent/oracle.ts';
import { forge, groundOracle } from '../agent/pipeline.ts';

/**
 * The FLEET: re-run every extractor in the library against the live page.
 * Healthy runs cost zero tokens. Only when an extractor looks broken does an LLM
 * get involved — first to tell "the menu changed" from "the extractor broke",
 * then to heal the code.
 */

export type FleetStatus = 'stable' | 'changed' | 'healed' | 'broken' | 'error';

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
}

export interface FleetReport {
  startedAt: string;
  finishedAt: string;
  entries: FleetEntry[];
  totals: { extractors: number; stable: number; changed: number; healed: number; broken: number; error: number; tokens: number; costUsd: number; ms: number };
}

const reportDir = () => resolve(config.libraryDir, 'fleet');

export function diffItems(prev: MenuItem[], next: MenuItem[]): PriceChange[] {
  const key = (i: MenuItem) => `${normName(i.section ?? '')}|${normName(i.name)}`;
  const a = new Map(prev.map((i) => [key(i), i]));
  const b = new Map(next.map((i) => [key(i), i]));
  const out: PriceChange[] = [];
  for (const [k, n] of b) {
    const o = a.get(k);
    if (!o) out.push({ name: n.name, section: n.section, kind: 'added', newPrice: n.price });
    else if (!samePrice(o.price, n.price)) out.push({ name: n.name, section: n.section, kind: 'price', oldPrice: o.price, newPrice: n.price });
  }
  for (const [k, o] of a) if (!b.has(k)) out.push({ name: o.name, section: o.section, kind: 'removed', oldPrice: o.price });
  return out;
}

/**
 * Structural health check: does this output look like the same extractor working?
 * Broken extractors typically return nothing, a fraction of the menu, or lose prices.
 */
export function looksBroken(items: MenuItem[], baselineCount: number): string | null {
  if (!items.length) return 'returned no items';
  if (baselineCount >= 5 && items.length < baselineCount * 0.6)
    return `returned ${items.length} items, down from ${baselineCount}`;
  const priced = items.filter((i) => i.price != null).length / items.length;
  if (priced < 0.4) return `only ${Math.round(priced * 100)}% of items have a price`;
  return null;
}

async function checkOne(x: StoredExtractor, emit: Emit, opts: { heal: boolean }): Promise<FleetEntry> {
  const t0 = Date.now();
  const ledger = new Ledger();
  const base: Omit<FleetEntry, 'status' | 'detail' | 'items' | 'changes'> = {
    id: x.meta.id,
    domain: x.meta.domain,
    restaurant: x.meta.restaurant,
    baselineItems: x.meta.baselineCount,
    ms: 0,
    tokens: 0,
    costUsd: 0,
    version: x.meta.version,
  };
  const done = (e: Pick<FleetEntry, 'status' | 'detail' | 'items' | 'changes'> & { version?: number }): FleetEntry => {
    const entry: FleetEntry = {
      ...base,
      ...e,
      ms: Date.now() - t0,
      tokens: ledger.promptTokens + ledger.completionTokens,
      costUsd: Math.round(ledger.costUsd * 1e6) / 1e6,
    };
    emit({ type: 'log', message: `[fleet] ${entry.id}: ${entry.status} — ${entry.detail}` });
    return entry;
  };

  const kind = x.meta.source?.kind ?? 'html';
  const mode = kind === 'json' ? 'json' : 'html';
  let src: { payload: string; html: string; via: string };
  try {
    src = await reacquire({ kind, url: x.meta.url, request: x.meta.source?.request });
  } catch (e) {
    return done({ status: 'error', detail: (e as Error).message, items: 0, changes: [] });
  }
  const run = await runExtractor(x.code, src.payload, x.meta.url, mode);
  const prev = loadSnapshot(x.meta.id) || [];

  if (run.ok && itemsHash(run.items) === x.meta.baselineHash) {
    if (!prev.length) saveSnapshot(x.meta.id, run.items);
    return done({ status: 'stable', detail: `${run.items.length} items, unchanged`, items: run.items.length, changes: [] });
  }

  const broken = run.ok ? looksBroken(run.items, x.meta.baselineCount) : `crashed: ${run.error}`;
  if (!broken) {
    // Plausible output that differs from last time → the menu itself changed.
    const changes = diffItems(prev, run.items);
    saveSnapshot(x.meta.id, run.items);
    updateBaseline(x.meta.id, itemsHash(run.items), run.items.length);
    return done({ status: 'changed', detail: `menu updated: ${summarise(changes)}`, items: run.items.length, changes });
  }

  if (!opts.heal) return done({ status: 'broken', detail: broken, items: run.items.length, changes: [] });

  // Suspected breakage. Ask the oracle what the page says now.
  let freshOracle: MenuItem[] | undefined;
  let text = src.html ? pageText(src.html) : '';
  if (mode === 'json' && (!src.html || priceDensity(src.html) < 5)) {
    try {
      text = jsonMenuLines(JSON.parse(src.payload));
    } catch {
      /* keep page text */
    }
  }
  try {
    const o = await readMenu(text, { url: x.meta.url, restaurant: x.meta.restaurant }, ledger, emit);
    const oracle = groundOracle(o.items, text).kept;
    freshOracle = oracle.length >= 3 ? oracle : undefined;
    if (run.ok && oracle.length && scoreAgainstOracle(oracle, run.items, text).pass) {
      // The extractor agrees with a fresh reading — the restaurant really shrank its menu.
      const changes = diffItems(prev, run.items);
      saveSnapshot(x.meta.id, run.items);
      updateBaseline(x.meta.id, itemsHash(run.items), run.items.length);
      return done({ status: 'changed', detail: `menu really changed (confirmed by Nemotron): ${summarise(changes)}`, items: run.items.length, changes });
    }
  } catch (e) {
    emit({ type: 'log', message: `[fleet] oracle check failed for ${x.meta.id}: ${(e as Error).message}` });
  }

  emit({ type: 'log', message: `[fleet] ${x.meta.id}: ${broken} — healing` });
  const tagged: Emit = (e) => emit({ ...e, target: x.meta.id } as typeof e);
  const healed = await forge({ url: x.meta.url, restaurant: x.meta.restaurant ?? undefined, noDiscover: true, repairOf: { code: x.code, reason: broken }, oracle: freshOracle }, tagged);
  for (const [m, v] of Object.entries(healed.ledger.byModel)) {
    ledger.byModel[m] = v;
  }
  ledger.promptTokens += healed.ledger.promptTokens;
  ledger.completionTokens += healed.ledger.completionTokens;
  ledger.costUsd += healed.ledger.costUsd;
  if (healed.ok && healed.items) {
    const changes = diffItems(prev, healed.items);
    saveSnapshot(x.meta.id, healed.items);
    return done({
      status: 'healed',
      detail: `${broken} → rewrote extractor v${healed.meta!.version} in ${healed.rounds} round(s)${changes.length ? `; ${summarise(changes)}` : ''}`,
      items: healed.items.length,
      changes,
      version: healed.meta!.version,
    });
  }
  return done({ status: 'broken', detail: `${broken}; heal failed: ${healed.reason}`, items: run.items.length, changes: [] });
}

function summarise(changes: PriceChange[]): string {
  if (!changes.length) return 'no item-level changes';
  const p = changes.filter((c) => c.kind === 'price').length;
  const a = changes.filter((c) => c.kind === 'added').length;
  const r = changes.filter((c) => c.kind === 'removed').length;
  return [p && `${p} price change(s)`, a && `${a} added`, r && `${r} removed`].filter(Boolean).join(', ');
}

export async function runFleet(opts: { heal?: boolean; only?: string[]; concurrency?: number } = {}, emit: Emit = () => {}): Promise<FleetReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let xs = listExtractors();
  if (opts.only?.length) xs = xs.filter((x) => opts.only!.includes(x.meta.id));
  const entries: FleetEntry[] = [];
  const queue = [...xs];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    while (queue.length) {
      const x = queue.shift()!;
      entries.push(await checkOne(x, emit, { heal: opts.heal !== false }));
    }
  });
  await Promise.all(workers);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const count = (s: FleetStatus) => entries.filter((e) => e.status === s).length;
  const report: FleetReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    entries,
    totals: {
      extractors: entries.length,
      stable: count('stable'),
      changed: count('changed'),
      healed: count('healed'),
      broken: count('broken'),
      error: count('error'),
      tokens: entries.reduce((s, e) => s + e.tokens, 0),
      costUsd: Math.round(entries.reduce((s, e) => s + e.costUsd, 0) * 1e6) / 1e6,
      ms: Date.now() - t0,
    },
  };
  mkdirSync(reportDir(), { recursive: true });
  writeFileSync(resolve(reportDir(), `${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  return report;
}

export function fleetHistory(limit = 30): FleetReport[] {
  if (!existsSync(reportDir())) return [];
  return readdirSync(reportDir())
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => JSON.parse(readFileSync(resolve(reportDir(), f), 'utf8')) as FleetReport);
}
