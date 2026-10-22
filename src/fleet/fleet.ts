import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { jsonMenuLines } from '../html/jsonview.ts';
import { reacquire } from '../agent/acquire.ts';
import { priceDensity } from '../agent/discover.ts';
import { pageText } from '../html/simplify.ts';
import { Ledger } from '../llm/client.ts';
import { listExtractors, loadSnapshot, saveSnapshot, updateBaseline, updateDocumentSource, updateImageSource, type StoredExtractor } from '../library/store.ts';
import { fetchPdf, pdfText } from '../agent/document.ts';
import { fetchImage, findMenuImages, readMenuImages } from '../agent/vision.ts';
import { renderPage } from '../html/render.ts';
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

/** review = output looks off but a fresh reading didn't confirm a break — left for a human. */
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
}

export interface FleetReport {
  startedAt: string;
  finishedAt: string;
  entries: FleetEntry[];
  totals: { extractors: number; stable: number; changed: number; healed: number; review: number; broken: number; error: number; tokens: number; costUsd: number; ms: number };
}

const reportDir = () => resolve(config.libraryDir, 'fleet');

export function diffItems(prev: MenuItem[], next: MenuItem[]): PriceChange[] {
  // Group by section+name; a group can hold several items (sizes listed separately),
  // which are paired by equal price first, then in order — never collapsed.
  const key = (i: MenuItem) => `${normName(i.section ?? '')}|${normName(i.name)}`;
  const group = (xs: MenuItem[]) => {
    const m = new Map<string, MenuItem[]>();
    for (const i of xs) m.set(key(i), [...(m.get(key(i)) || []), i]);
    return m;
  };
  const a = group(prev);
  const b = group(next);
  const out: PriceChange[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const olds = [...(a.get(k) || [])];
    const news = [...(b.get(k) || [])];
    for (let i = news.length - 1; i >= 0; i--) {
      const j = olds.findIndex((o) => samePrice(o.price, news[i]!.price));
      if (j >= 0) {
        olds.splice(j, 1);
        news.splice(i, 1);
      }
    }
    const pairs = Math.min(olds.length, news.length);
    for (let i = 0; i < pairs; i++)
      out.push({ name: news[i]!.name, section: news[i]!.section, kind: 'price', oldPrice: olds[i]!.price, newPrice: news[i]!.price });
    for (const n of news.slice(pairs)) out.push({ name: n.name, section: n.section, kind: 'added', newPrice: n.price });
    for (const o of olds.slice(pairs)) out.push({ name: o.name, section: o.section, kind: 'removed', oldPrice: o.price });
  }
  return out;
}

/**
 * Structural health check: does this output look like the same extractor working?
 * Broken extractors typically return nothing, a fraction of the menu, or lose prices.
 */
export function looksBroken(items: MenuItem[], baselineCount: number, baselinePriced = 1): string | null {
  if (!items.length) return 'returned no items';
  if (baselineCount >= 5 && items.length < baselineCount * 0.6)
    return `returned ${items.length} items, down from ${baselineCount}`;
  const priced = items.filter((i) => i.price != null).length / items.length;
  // Only a DROP in priced share is suspicious — some menus never show prices.
  if (baselinePriced >= 0.5 && priced < Math.min(0.4, baselinePriced * 0.6)) return `only ${Math.round(priced * 100)}% of items have a price`;
  return null;
}

/**
 * Not clearly broken, but different enough that we shouldn't silently accept it as
 * a menu change (a slowly degrading extractor would otherwise ratchet its baseline
 * down week by week): count fell by >15%, or most dish names are new.
 */
export function looksSuspicious(items: MenuItem[], prev: MenuItem[], baselineCount: number): string | null {
  if (baselineCount >= 8 && items.length < baselineCount * 0.85) return `item count fell from ${baselineCount} to ${items.length}`;
  if (prev.length >= 8) {
    const before = new Set(prev.map((i) => normName(i.name)));
    const overlap = items.filter((i) => before.has(normName(i.name))).length / Math.max(1, items.length);
    if (overlap < 0.6) return `only ${Math.round(overlap * 100)}% of dish names match last run`;
  }
  return null;
}

interface Budget {
  left(): number;
  spend(usd: number): void;
}

async function checkOne(x: StoredExtractor, emit: Emit, opts: { heal: boolean; budget?: Budget }): Promise<FleetEntry> {
  const t0 = Date.now();
  const ledger = new Ledger(opts.budget ? Math.max(0, opts.budget.left()) : undefined);
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
    opts.budget?.spend(ledger.costUsd);
    const entry: FleetEntry = {
      ...base,
      ...e,
      ms: Date.now() - t0,
      tokens: ledger.promptTokens + ledger.completionTokens,
      costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
    };
    emit({ type: 'log', message: `[fleet] ${entry.id}: ${entry.status} — ${entry.detail}` });
    return entry;
  };

  const kind = x.meta.source?.kind ?? 'html';
  if (kind === 'image') return checkImages(x, ledger, done, emit, opts);
  if (kind === 'document') return checkDocument(x, ledger, done, emit, opts);
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

  const broken = run.ok ? looksBroken(run.items, x.meta.baselineCount, x.meta.baselinePriced ?? 1) : `crashed: ${run.error}`;
  const suspicious = !broken && run.ok ? looksSuspicious(run.items, prev, x.meta.baselineCount) : null;
  if (!broken && !suspicious) {
    // Plausible output that differs from last time → the menu itself changed.
    const changes = diffItems(prev, run.items);
    saveSnapshot(x.meta.id, run.items);
    updateBaseline(x.meta.id, itemsHash(run.items), run.items.length);
    return done({ status: 'changed', detail: `menu updated: ${summarise(changes)}`, items: run.items.length, changes });
  }

  const problem = (broken || suspicious)!;
  if (!opts.heal || (opts.budget && opts.budget.left() <= 0))
    return done({ status: broken ? 'broken' : 'review', detail: `${problem}${opts.heal ? ' (fleet budget used up — not healed)' : ''}`, items: run.items.length, changes: [] });

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

  if (!broken) {
    // Suspicious but not broken, and the oracle did not confirm it: don't rewrite working code
    // on a hunch — flag it for review instead.
    return done({ status: 'review', detail: `${suspicious}; a fresh reading did not confirm it — flagged for review`, items: run.items.length, changes: [] });
  }
  emit({ type: 'log', message: `[fleet] ${x.meta.id}: ${broken} — healing` });
  const tagged: Emit = (e) => emit({ ...e, target: x.meta.id } as typeof e);
  const healLedger = new Ledger(opts.budget ? Math.max(0, opts.budget.left() - ledger.costUsd) : undefined);
  const healed = await forge(
    { url: x.meta.url, restaurant: x.meta.restaurant ?? undefined, noDiscover: true, repairOf: { code: x.code, reason: broken }, oracle: freshOracle, ledger: healLedger },
    tagged,
  );
  ledger.merge(healed.ledger);
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

/**
 * Image menus: compare each picture's fingerprint. Unchanged → stable at zero tokens.
 * Changed (or moved) → re-read just those pictures with Nemotron 3.5 Super VL and diff.
 */
async function checkImages(
  x: StoredExtractor,
  ledger: Ledger,
  done: (e: Pick<FleetEntry, 'status' | 'detail' | 'items' | 'changes'> & { version?: number }) => FleetEntry,
  emit: Emit,
  opts: { heal: boolean; budget?: Budget },
): Promise<FleetEntry> {
  const stored = x.meta.source?.request?.images ?? [];
  const prev = loadSnapshot(x.meta.id) || [];
  const now: { url: string; sha256: string | null }[] = [];
  for (const im of stored) {
    try {
      now.push({ url: im.url, sha256: (await fetchImage(im.url)).sha256 });
    } catch {
      now.push({ url: im.url, sha256: null });
    }
  }
  if (stored.length && now.every((n, i) => n.sha256 === stored[i]!.sha256))
    return done({ status: 'stable', detail: `${stored.length} menu image(s) unchanged (fingerprints match)`, items: prev.length, changes: [] });

  if (!opts.heal || (opts.budget && opts.budget.left() <= 0))
    return done({ status: 'review', detail: 'menu image(s) changed — not re-read (healing off or budget used up)', items: prev.length, changes: [] });

  // Some picture changed or disappeared: look for the menu images on the page again.
  let urls = now.filter((n) => n.sha256).map((n) => n.url);
  if (now.some((n) => !n.sha256)) {
    try {
      const r = await renderPage(x.meta.url);
      const found = findMenuImages(r.html, r.finalUrl);
      if (found.length) urls = found;
    } catch {
      /* keep what still loads */
    }
  }
  if (!urls.length) return done({ status: 'broken', detail: 'menu images are gone from the page', items: 0, changes: [] });
  emit({ type: 'log', message: `[fleet] ${x.meta.id}: menu image changed — re-reading with Nemotron 3.5 Super VL` });
  const v = await readMenuImages(urls, ledger, emit);
  if (v.items.length < 3) return done({ status: 'broken', detail: 'changed menu images could not be read', items: 0, changes: [] });
  const changes = diffItems(prev, v.items);
  saveSnapshot(x.meta.id, v.items);
  updateImageSource(x.meta.id, v.images, itemsHash(v.items), v.items.length);
  return done({ status: 'changed', detail: `menu image changed: ${summarise(changes)}`, items: v.items.length, changes });
}

/** PDF menus: compare the file fingerprint; re-read only a changed PDF. */
async function checkDocument(
  x: StoredExtractor,
  ledger: Ledger,
  done: (e: Pick<FleetEntry, 'status' | 'detail' | 'items' | 'changes'> & { version?: number }) => FleetEntry,
  emit: Emit,
  opts: { heal: boolean; budget?: Budget },
): Promise<FleetEntry> {
  const stored = x.meta.source?.request?.document;
  const prev = loadSnapshot(x.meta.id) || [];
  if (!stored) return done({ status: 'error', detail: 'no PDF recorded for this menu', items: prev.length, changes: [] });
  let pdf: Awaited<ReturnType<typeof fetchPdf>>;
  try {
    pdf = await fetchPdf(stored.url);
  } catch (e) {
    return done({ status: 'broken', detail: `PDF menu unavailable: ${(e as Error).message}`, items: 0, changes: [] });
  }
  if (pdf.sha256 === stored.sha256) return done({ status: 'stable', detail: 'PDF menu unchanged (fingerprint matches)', items: prev.length, changes: [] });
  if (!opts.heal || (opts.budget && opts.budget.left() <= 0))
    return done({ status: 'review', detail: 'PDF menu changed — not re-read (healing off or budget used up)', items: prev.length, changes: [] });
  emit({ type: 'log', message: `[fleet] ${x.meta.id}: PDF changed — re-reading` });
  const { text } = await pdfText(pdf.bytes);
  const o = await readMenu(text, { url: stored.url, restaurant: x.meta.restaurant }, ledger, emit);
  const items = groundOracle(o.items, text).kept;
  if (items.length < 3) return done({ status: 'broken', detail: 'the changed PDF has no readable menu', items: 0, changes: [] });
  const changes = diffItems(prev, items);
  saveSnapshot(x.meta.id, items);
  updateDocumentSource(x.meta.id, { url: pdf.finalUrl, sha256: pdf.sha256 }, itemsHash(items), items.length);
  return done({ status: 'changed', detail: `PDF menu changed: ${summarise(changes)}`, items: items.length, changes });
}

function summarise(changes: PriceChange[]): string {
  if (!changes.length) return 'no item-level changes';
  const p = changes.filter((c) => c.kind === 'price').length;
  const a = changes.filter((c) => c.kind === 'added').length;
  const r = changes.filter((c) => c.kind === 'removed').length;
  return [p && `${p} price change(s)`, a && `${a} added`, r && `${r} removed`].filter(Boolean).join(', ');
}

export async function runFleet(
  opts: { heal?: boolean; only?: string[]; concurrency?: number; maxUsd?: number } = {},
  emit: Emit = () => {},
): Promise<FleetReport> {
  let spent = 0;
  const budget: Budget | undefined = opts.maxUsd == null ? undefined : { left: () => opts.maxUsd! - spent, spend: (u) => (spent += u) };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let xs = listExtractors();
  if (opts.only?.length) xs = xs.filter((x) => opts.only!.includes(x.meta.id));
  const entries: FleetEntry[] = [];
  const queue = [...xs];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    while (queue.length) {
      const x = queue.shift()!;
      entries.push(await checkOne(x, emit, { heal: opts.heal !== false, budget }));
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
      review: count('review'),
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
