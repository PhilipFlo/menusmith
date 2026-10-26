import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { jsonMenuLines } from '../html/jsonview.ts';
import { reacquire } from '../agent/acquire.ts';
import { priceDensity } from '../agent/discover.ts';
import { pageText } from '../html/simplify.ts';
import { Ledger } from '../llm/client.ts';
import { writePersisted } from '../library/persist.ts';
import { patchMeta, listExtractors, loadSnapshot, saveSnapshot, updateBaseline, updateDocumentSource, updateImageSource, type StoredExtractor } from '../library/store.ts';
import { fetchPdf } from '../agent/document.ts';
import { fetchImage, findMenuImages, readMenuImages } from '../agent/vision.ts';
import { renderPage } from '../html/render.ts';
import { fetchPage } from '../html/fetch.ts';
import { runExtractor } from '../sandbox/runner.ts';
import type { Emit, MenuItem } from '../types.ts';
import { itemsHash, nameSimilarity, normName, PASS, samePrice, scoreAgainstOracle } from '../agent/evaluate.ts';
import { readMenu } from '../agent/oracle.ts';
import { forge, groundOracle, readPdfMenu } from '../agent/pipeline.ts';
import { arbitrate } from '../agent/judge.ts';

/**
 * The FLEET: re-run every extractor in the library against the live page.
 * Healthy runs cost zero tokens. Only when an extractor looks broken does an LLM
 * get involved — first to tell "the menu changed" from "the extractor broke",
 * then to heal the code.
 */

/** review = output looks off but a fresh reading didn't confirm a break — left for a human. */
/**
 * Errors produced by the RUNNER itself (process killed at the wall-clock deadline,
 * could not spawn) — not by the extractor. The vm's own "Script execution timed out"
 * and crashes caused by the extractor's code are real breakage and get healed.
 */
const INFRA_ERROR = /^(timed out after \d+ ms|spawn failed)/;

export type FleetStatus = 'stable' | 'changed' | 'healed' | 'review' | 'broken' | 'error';

export interface PriceChange {
  name: string;
  section?: string | null;
  kind: 'price' | 'added' | 'removed';
  oldPrice?: number | null;
  newPrice?: number | null;
}

/** Result of comparing the extractor's output with a fresh Nemotron reading of the page. */
export interface AuditResult {
  at: string;
  pass: boolean;
  /** False when the fresh reading itself looks unreliable (< 3 dishes) — then nothing is concluded. */
  conclusive: boolean;
  recall: number;
  precision: number;
  f1: number;
  oracleCount: number;
  extractorCount: number;
  missing: MenuItem[];
  /** Dishes that dropped out of the output since the last run but are still on the page. */
  stillOnPage: string[];
  /** Catches clearly fewer of the page's dishes than when the extractor was accepted. */
  regressed: boolean;
  /** Dishes a repair has to bring back. */
  mustInclude: string[];
  wrongPrice: { name: string; expected: number | null; got: number | null }[];
  extra: MenuItem[];
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
  /** Present when this check included a coverage audit against a fresh reading. */
  audit?: AuditResult;
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

function sourceText(src: { payload: string; html: string }, mode: 'html' | 'json'): string {
  let text = src.html ? pageText(src.html) : '';
  if (mode === 'json' && (!src.html || priceDensity(src.html) < 5)) {
    try {
      text = jsonMenuLines(JSON.parse(src.payload));
    } catch {
      /* keep page text */
    }
  }
  return text;
}

/**
 * COVERAGE AUDIT: does the extractor still catch everything on the menu? Nemotron reads
 * the current page (double read), the extractor's output is scored against it, and
 * disputed items are arbitrated by Nano. A dish that is still on the page but missing
 * from the output is a silent miss — exactly what a plain re-run can't notice.
 */
type Named = { name: string; price?: number | null };
/**
 * Of the dishes a fresh reading sees but the code missed, which ones were in the last run's
 * output? Same normalised name, or a close name at the same price. Dishes that only moved to
 * another section (still in `current`) don't count as vanished.
 */
export function stillListed(missedNow: Named[], vanished: Named[], current: Named[] = []): string[] {
  const present = new Set(current.map((i) => normName(i.name)));
  const gone = vanished.filter((v) => normName(v.name) && !present.has(normName(v.name)));
  return missedNow
    .filter((m) => {
      const k = normName(m.name);
      return !!k && gone.some((g) => normName(g.name) === k || (nameSimilarity(normName(g.name), k) >= 0.6 && samePrice(g.price, m.price)));
    })
    .map((m) => m.name);
}

async function coverageAudit(
  x: StoredExtractor,
  items: MenuItem[],
  text: string,
  ledger: Ledger,
  emit: Emit,
  /** Dishes that were in the last snapshot but not in this run's output. */
  vanished: Named[] = [],
): Promise<{ audit: AuditResult; oracle: MenuItem[] }> {
  const accepted = x.meta.score?.recall ?? 0;

  /** One independent reading of the page, judged on coverage only. */
  async function judge() {
    const o = await readMenu(text, { url: x.meta.url, restaurant: x.meta.restaurant }, ledger, emit);
    const rawOracle = groundOracle(o.items, text).kept;
    const raw = scoreAgainstOracle(rawOracle, items, text, { uncapped: true });
    let oracle = rawOracle;
    let score = raw;
    if (raw.recall < PASS.minRecall && raw.f1 >= 0.6 && raw.missing.length) {
      // Low coverage: let Nano check whether the "missing" items are really dishes.
      const a = await arbitrate([...raw.grounded, ...raw.extra], raw.missing, text, ledger, emit);
      if (a.disputed) {
        oracle = [...rawOracle.filter((i) => !a.rejected.has(normName(i.name))), ...a.accepted];
        score = scoreAgainstOracle(oracle, items, text, { rejected: a.rejected });
      }
    }
    // A dish that dropped out of the output but is still on the page is a code bug, not a
    // menu change — however high overall recall is. Judged on the reading BEFORE arbitration:
    // the extractor itself used to return these items, so they count (drinks and add-ons are
    // exactly what an "is this a dish?" tie-break tends to discard).
    const stillOnPage = stillListed(raw.missing, vanished, items);
    // Regression against the extractor's own acceptance, compared like with like:
    // (a) its output covers a clearly smaller share of a fresh reading than it did when it was
    //     accepted — a share, so a menu that really shrank (output and reading both shorter)
    //     does not count; or
    // (b) after arbitration it catches clearly less of the menu than when it was accepted.
    const was = x.meta.score;
    const wasShare = was?.extractorCount && was.oracleCount ? Math.min(1.2, was.extractorCount / was.oracleCount) : 0;
    const nowShare = raw.oracleCount ? items.length / raw.oracleCount : 1;
    const shrunk = wasShare > 0 && wasShare - nowShare >= 0.05 && Math.round(wasShare * raw.oracleCount) - items.length >= 2;
    const expectedMisses = Math.round((1 - accepted) * score.oracleCount);
    const lostCoverage = accepted > 0 && score.recall <= accepted - 0.05 && score.missing.length - expectedMisses >= 2;
    const regressed = shrunk || lostCoverage;
    // Coverage only — precision rules were settled when the extractor was accepted.
    const lowCoverage = score.recall < Math.min(PASS.minRecall, accepted - 0.05);
    return { rawOracle, raw, oracle, score, stillOnPage, regressed, lowCoverage, conclusive: rawOracle.length >= 3 };
  }

  let r = await judge();
  let second: Awaited<ReturnType<typeof judge>> | null = null;
  /** Dishes BOTH independent readings list as missed (set when a regression is confirmed). */
  let confirmedMissing: string[] = [];
  // Dishes are about to be recorded as removed: one reading not listing them is weak evidence
  // (readings disagree on add-ons and drinks — bench/variance.ts), so ask a second time.
  if (r.conclusive && vanished.length && !r.stillOnPage.length) {
    second = await judge();
    if (second.conclusive && second.stillOnPage.length) {
      emit({ type: 'log', message: `[fleet] ${x.meta.id}: a second reading still lists ${second.stillOnPage.join(', ')} — not a menu change` });
      r = second;
    }
  }
  // One reading is noisy (bench/variance.ts): before calling working code broken on coverage
  // alone, a second independent reading has to agree. Vanished dishes seen on the page are
  // specific evidence and need no second opinion.
  if (r.conclusive && !r.stillOnPage.length && (r.regressed || r.lowCoverage)) {
    emit({ type: 'log', message: `[fleet] ${x.meta.id}: coverage looks low (recall ${r.raw.recall}) — confirming with a second reading` });
    const other = second && second !== r ? second : await judge(); // reuse a reading already taken
    if (!(other.regressed || other.lowCoverage) || !other.conclusive) {
      emit({ type: 'log', message: `[fleet] ${x.meta.id}: second reading disagrees (recall ${other.raw.recall}) — treated as reading noise` });
      r = { ...other, regressed: false, lowCoverage: false };
    } else {
      const inOther = new Set(other.raw.missing.map((m) => normName(m.name)));
      confirmedMissing = r.raw.missing.filter((m) => inOther.has(normName(m.name))).map((m) => m.name);
      if (other.raw.recall < r.raw.recall) r = other;
    }
  }
  const { raw, score, stillOnPage, regressed, lowCoverage } = r;
  // What a repair must bring back: dishes the code itself used to return, and — for an
  // extractor that was accepted catching (nearly) the whole menu — dishes that two independent
  // readings both list as missed. A single reading's misses may be add-ons it rightly skips;
  // failed repairs are capped (failedHeals), so this can't turn into a nightly cost loop.
  const mustInclude = [...new Set([...stillOnPage, ...(regressed && accepted >= 0.98 ? confirmedMissing : [])])];
  const audit: AuditResult = {
    at: new Date().toISOString(),
    conclusive: r.conclusive,
    pass: !lowCoverage && !regressed && stillOnPage.length === 0,
    stillOnPage,
    regressed,
    mustInclude,
    recall: score.recall,
    precision: score.precision,
    f1: score.f1,
    oracleCount: score.oracleCount,
    extractorCount: score.extractorCount,
    missing: score.missing.slice(0, 25),
    wrongPrice: score.wrongPrice.slice(0, 15),
    extra: score.extra.slice(0, 15),
  };
  if (!audit.conclusive) {
    emit({ type: 'log', message: `[fleet] ${x.meta.id}: coverage check inconclusive — the fresh reading found only ${r.rawOracle.length} dish(es)` });
    return { audit, oracle: r.oracle };
  }
  // A repair is graded against the full reading when the arbitrated one dropped the very
  // dishes that are missing.
  const oracle = stillOnPage.length || regressed ? r.rawOracle : r.oracle;
  patchMeta(x.meta.id, { lastAudit: { at: audit.at, pass: audit.pass, recall: audit.recall, f1: audit.f1, missing: score.missing.length } });
  emit({ type: 'log', message: `[fleet] ${x.meta.id}: coverage check — recall ${audit.recall}, ${score.missing.length} dish(es) on the page not extracted` });
  return { audit, oracle };
}

export interface CheckOptions {
  heal: boolean;
  budget?: Budget;
  /** never: no LLM coverage check · auto: weekly + when dishes disappear · force: always */
  audit?: 'never' | 'auto' | 'force';
  /** For audit:'auto' — re-verify a stable extractor at most every N days. */
  auditDays?: number;
}

/** Thrown when a check fails after it already spent money — carries what it cost. */
export class CheckError extends Error {
  constructor(message: string, readonly costUsd: number) {
    super(message);
  }
}

// Heals run one at a time: each one sees the budget the previous one left, so parallel
// fleet workers can't all spend the same remaining dollars.
let healLock: Promise<unknown> = Promise.resolve();

async function checkOne(x: StoredExtractor, emit: Emit, opts: CheckOptions): Promise<FleetEntry> {
  const ledger = new Ledger(opts.budget ? Math.max(0, opts.budget.left()) : undefined);
  let recorded = false;
  try {
    return await checkWith(x, emit, opts, ledger, () => (recorded = true));
  } catch (e) {
    if (!recorded) opts.budget?.spend(ledger.costUsd);
    throw new CheckError((e as Error).message, Math.round(ledger.listCostUsd * 1e6) / 1e6);
  }
}

async function checkWith(x: StoredExtractor, emit: Emit, opts: CheckOptions, ledger: Ledger, onRecorded: () => void): Promise<FleetEntry> {
  const t0 = Date.now();
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
  const done = (e: Pick<FleetEntry, 'status' | 'detail' | 'items' | 'changes'> & { version?: number; audit?: AuditResult }): FleetEntry => {
    opts.budget?.spend(ledger.costUsd);
    onRecorded();
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
  let run = await runExtractor(x.code, src.payload, x.meta.url, mode);
  // Runner-level failures (wall-clock kill, spawn failure) can be the host, not the
  // site — retry once before drawing conclusions.
  if (!run.ok && INFRA_ERROR.test(run.error || '')) run = await runExtractor(x.code, src.payload, x.meta.url, mode);
  const prev = loadSnapshot(x.meta.id) || [];

  /** Rewrite the extractor from its old code + the current page (+ a fresh reading if we have one). */
  async function heal(reason: string, freshOracle?: MenuItem[], audit?: AuditResult): Promise<FleetEntry> {
    const turn = healLock.then(() => healNow(reason, freshOracle, audit));
    healLock = turn.catch(() => {});
    return turn;
  }
  async function healNow(reason: string, freshOracle?: MenuItem[], audit?: AuditResult): Promise<FleetEntry> {
    if (!opts.heal || (opts.budget && opts.budget.left() - ledger.costUsd <= 0))
      return done({
        status: 'review',
        detail: `${reason} — flagged for repair (${opts.heal ? 'budget used up' : 'not rewritten from here'}; the next fleet run re-checks it)`,
        items: run.items.length,
        changes: [],
        audit,
      });
    const fh = x.meta.failedHeals;
    if (fh && fh.count >= 2 && Date.now() - Date.parse(fh.at) < 7 * 86_400_000)
      return done({
        status: 'review',
        detail: `${reason} — not rewritten: the last ${fh.count} repairs failed, retrying after a week (or open it and check by hand)`,
        items: run.items.length,
        changes: [],
        audit,
      });
    emit({ type: 'log', message: `[fleet] ${x.meta.id}: ${reason} — healing` });
    const tagged: Emit = (e) => emit({ ...e, target: x.meta.id } as typeof e);
    const left = opts.budget ? Math.max(0, opts.budget.left() - ledger.costUsd) : Infinity;
    const cap = Math.min(left, Number(process.env.MENUSMITH_MAX_JOB_USD) || Infinity); // hard ceiling for one heal
    const healLedger = new Ledger(Number.isFinite(cap) ? cap : undefined);
    let healed: Awaited<ReturnType<typeof forge>>;
    try {
      healed = await forge(
        {
          url: x.meta.url,
          restaurant: x.meta.restaurant ?? undefined,
          noDiscover: true,
          repairOf: { code: x.code, reason },
          oracle: freshOracle,
          mustInclude: audit?.mustInclude?.length ? audit.mustInclude : undefined,
          ledger: healLedger,
        },
        tagged,
      );
    } finally {
      ledger.merge(healLedger); // count the spend even if the rewrite threw
    }
    if (healed.ok && healed.items) {
      const changes = diffItems(prev, healed.items);
      saveSnapshot(x.meta.id, healed.items);
      return done({
        status: 'healed',
        detail: `${reason} → rewrote extractor v${healed.meta!.version} in ${healed.rounds} round(s)${changes.length ? `; ${summarise(changes)}` : ''}`,
        items: healed.items.length,
        changes,
        version: healed.meta!.version,
        audit,
      });
    }
    patchMeta(x.meta.id, { failedHeals: { count: (fh?.count ?? 0) + 1, at: new Date().toISOString() } });
    return done({ status: 'broken', detail: `${reason}; heal failed: ${healed.reason}`, items: run.items.length, changes: [], audit });
  }

  const auditMode = opts.audit ?? 'never';
  // An explicit check ('force') may spend on the reading even when healing is off;
  // automatic checks only run in fleets that are allowed to spend (heal on).
  const canSpend = (opts.heal || auditMode === 'force') && (!opts.budget || opts.budget.left() > 0);
  const auditDue = () => {
    if (auditMode === 'force') return true;
    if (auditMode !== 'auto') return false;
    if (x.meta.lastAudit && !x.meta.lastAudit.pass) return true; // failed last time → re-check until fixed
    const last = x.meta.lastAudit?.at ? Date.parse(x.meta.lastAudit.at) : Date.parse(x.meta.createdAt);
    return Date.now() - last > (opts.auditDays ?? 7) * 86_400_000;
  };

  if (run.ok && itemsHash(run.items) === x.meta.baselineHash) {
    if (!prev.length) saveSnapshot(x.meta.id, run.items);
    if (auditDue() && canSpend) {
      const text = sourceText(src, mode);
      try {
        const { audit, oracle } = await coverageAudit(x, run.items, text, ledger, emit);
        if (!audit.conclusive)
          return done({ status: 'stable', detail: `${run.items.length} items, unchanged — Nemotron check inconclusive (fresh reading found too few dishes)`, items: run.items.length, changes: [], audit });
        if (audit.pass) return done({ status: 'stable', detail: `${run.items.length} items, unchanged — verified against a fresh reading`, items: run.items.length, changes: [], audit });
        return heal(
          audit.regressed
            ? `coverage check: catches fewer of the page's dishes than when it was written (returns ${run.items.length} now, ${x.meta.score?.extractorCount ?? '?'} then; a fresh reading lists ${audit.oracleCount})`
            : `coverage check: ${audit.oracleCount - Math.round(audit.recall * audit.oracleCount)} dish(es) on the page are not extracted`,
          oracle,
          audit,
        );
      } catch (e) {
        emit({ type: 'log', message: `[fleet] coverage check failed for ${x.meta.id}: ${(e as Error).message}` });
      }
    }
    return done({ status: 'stable', detail: `${run.items.length} items, unchanged`, items: run.items.length, changes: [] });
  }

  // A sandbox timeout / crash says nothing about the website — never "heal" code
  // because the host was slow or overloaded.
  if (!run.ok && INFRA_ERROR.test(run.error || '')) {
    return done({ status: 'error', detail: `sandbox: ${run.error} (infrastructure, not a site change — not healed)`, items: 0, changes: [] });
  }
  const broken = run.ok ? looksBroken(run.items, x.meta.baselineCount, x.meta.baselinePriced ?? 1) : `crashed: ${run.error}`;
  const suspicious = !broken && run.ok ? looksSuspicious(run.items, prev, x.meta.baselineCount) : null;
  if (!broken && !suspicious) {
    // Plausible output that differs from last time → probably the menu itself changed.
    const changes = diffItems(prev, run.items);
    // A dish that only moved to another section (a renamed heading) is not a removal — but
    // count per name: menus repeat names across sections (lunch/dinner), and losing one copy
    // of a repeated dish is still a loss.
    const lost = lostNames(prev, run.items);
    const isLost = (c: PriceChange) => c.kind === 'removed' && lost.has(normName(c.name));
    const removed = changes.filter(isLost).length;
    // Dishes that "disappeared" may really be dishes the code now silently misses —
    // verify removals against a fresh reading before recording them.
    if (removed > 0 || auditDue()) {
      if (auditMode !== 'never' && canSpend) {
        try {
          const vanished = changes.filter(isLost).map((c) => ({ name: c.name, price: c.oldPrice }));
          const { audit, oracle } = await coverageAudit(x, run.items, sourceText(src, mode), ledger, emit, vanished);
          if (!audit.conclusive) {
            if (removed > 0)
              return done({ status: 'review', detail: `${removed} dish(es) disappeared — the Nemotron check was inconclusive, kept the last good data`, items: run.items.length, changes, audit });
          } else if (!audit.pass)
            return heal(
              audit.stillOnPage.length
                ? `coverage check: ${audit.stillOnPage.length} dish(es) dropped out of the output but are still on the page (${audit.stillOnPage.slice(0, 3).join(', ')})`
                : `coverage check: dishes on the page are missing from the output (recall ${audit.recall})`,
              oracle,
              audit,
            );
          saveSnapshot(x.meta.id, run.items);
          updateBaseline(x.meta.id, itemsHash(run.items), run.items.length);
          return done({ status: 'changed', detail: `menu updated (verified against a fresh reading): ${summarise(changes)}`, items: run.items.length, changes, audit });
        } catch (e) {
          emit({ type: 'log', message: `[fleet] coverage check failed for ${x.meta.id}: ${(e as Error).message}` });
        }
      }
      // Without a check we can't tell "the restaurant removed these" from "the code now
      // misses these" — keep the last good data rather than recording a guess.
      if (removed > 0)
        return done({
          status: 'review',
          detail: `${removed} dish(es) disappeared — not recorded until a Nemotron check confirms they are really gone`,
          items: run.items.length,
          changes,
        });
    }
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
    const gone = diffItems(prev, run.items)
      .filter((c) => c.kind === 'removed')
      .map((c) => ({ name: c.name, price: c.oldPrice }));
    const score = run.ok && oracle.length >= 3 ? scoreAgainstOracle(oracle, run.items, text) : null;
    const stillThere = score ? stillListed(score.missing, gone, run.items) : [];
    if (score && stillThere.length && !broken)
      return heal(`${suspicious}; ${stillThere.length} of the missing dishes are still on the page (${stillThere.slice(0, 3).join(', ')})`, freshOracle);
    if (score?.pass && !stillThere.length) {
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
  return heal(broken, freshOracle);
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

  // Some picture changed or could not be loaded. If any failed to load, look for the
  // menu images on the page again (plain HTML first — no browser needed).
  let urls = now.map((n) => n.url);
  if (now.some((n) => !n.sha256)) {
    let found: string[] = [];
    try {
      const p = await fetchPage(x.meta.url, { maxAgeMs: 0 });
      found = findMenuImages(p.html, p.finalUrl);
      if (!found.length && process.env.MENUSMITH_RENDER !== 'off') {
        const r = await renderPage(x.meta.url);
        found = findMenuImages(r.html, r.finalUrl);
      }
    } catch {
      /* page unreachable */
    }
    // Never overwrite a good reading with a partial one: if the pictures can't all be
    // accounted for, leave it for review.
    if (!found.length)
      return done({ status: 'review', detail: `${now.filter((n) => !n.sha256).length} menu image(s) failed to load and the page couldn't be re-scanned — kept the last reading`, items: prev.length, changes: [] });
    urls = found;
  }
  emit({ type: 'log', message: `[fleet] ${x.meta.id}: menu image changed — re-reading with Nemotron 3.5 Super VL` });
  const v = await readMenuImages(urls, ledger, emit);
  if (v.failed > 0)
    return done({ status: 'review', detail: `${v.failed} of ${urls.length} menu image(s) could not be read — kept the last reading`, items: prev.length, changes: [] });
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
    // A timeout / network failure says nothing about the menu — only a missing file (4xx) does.
    const msg = (e as Error).message;
    const gone = /\b(404|410|403)\b|not a PDF/i.test(msg);
    return done({ status: gone ? 'broken' : 'error', detail: `PDF menu unavailable: ${msg}`, items: gone ? 0 : prev.length, changes: [] });
  }
  if (pdf.sha256 === stored.sha256) return done({ status: 'stable', detail: 'PDF menu unchanged (fingerprint matches)', items: prev.length, changes: [] });
  if (!opts.heal || (opts.budget && opts.budget.left() <= 0))
    return done({ status: 'review', detail: 'PDF menu changed — not re-read (healing off or budget used up)', items: prev.length, changes: [] });
  emit({ type: 'log', message: `[fleet] ${x.meta.id}: PDF changed — re-reading` });
  let items: MenuItem[];
  try {
    // Same reader as the forge: text layer, then the pages as images if the text doesn't read.
    items = (await readPdfMenu(pdf.bytes, stored.url, x.meta.restaurant, ledger, emit)).items;
  } catch (e) {
    return done({ status: 'error', detail: `PDF changed but could not be re-read: ${(e as Error).message}`, items: prev.length, changes: [] });
  }
  if (items.length < 3) return done({ status: 'broken', detail: 'the changed PDF has no readable menu', items: 0, changes: [] });
  const changes = diffItems(prev, items);
  saveSnapshot(x.meta.id, items);
  updateDocumentSource(x.meta.id, { url: pdf.finalUrl, sha256: pdf.sha256 }, itemsHash(items), items.length);
  return done({ status: 'changed', detail: `PDF menu changed: ${summarise(changes)}`, items: items.length, changes });
}

const countNames = (xs: { name: string }[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(normName(x.name), (m.get(normName(x.name)) ?? 0) + 1);
  return m;
};

/** Names that appear fewer times in the new output than in the old one. */
export function lostNames(prev: { name: string }[], next: { name: string }[]): Set<string> {
  const before = countNames(prev);
  const after = countNames(next);
  return new Set([...before].filter(([n, k]) => (after.get(n) ?? 0) < k).map(([n]) => n));
}

function summarise(changes: PriceChange[]): string {
  if (!changes.length) return 'no item-level changes';
  const p = changes.filter((c) => c.kind === 'price').length;
  // A removed + added pair with the same name is a dish that moved to another section
  // (counted per name, so the numbers can't go negative).
  const addedBy = countNames(changes.filter((c) => c.kind === 'added'));
  const removedBy = countNames(changes.filter((c) => c.kind === 'removed'));
  let moved = 0;
  for (const [n, k] of removedBy) moved += Math.min(k, addedBy.get(n) ?? 0);
  const a = changes.filter((c) => c.kind === 'added').length - moved;
  const r = changes.filter((c) => c.kind === 'removed').length - moved;
  return [p && `${p} price change(s)`, a && `${a} added`, r && `${r} removed`, moved && `${moved} moved to another section`].filter(Boolean).join(', ');
}

/** Check one extractor (the "Re-scrape now" / "Check against Nemotron" buttons). */
export async function checkExtractor(id: string, opts: CheckOptions & { maxUsd?: number }, emit: Emit = () => {}): Promise<FleetEntry | null> {
  const x = listExtractors().find((e) => e.meta.id === id);
  if (!x) return null;
  let spent = 0;
  const budget: Budget | undefined = opts.maxUsd == null ? undefined : { left: () => opts.maxUsd! - spent, spend: (u) => (spent += u) };
  return checkOne(x, emit, { ...opts, budget });
}

export async function runFleet(
  opts: { heal?: boolean; only?: string[]; concurrency?: number; maxUsd?: number; audit?: 'never' | 'auto' | 'force'; auditDays?: number } = {},
  emit: Emit = () => {},
): Promise<FleetReport> {
  let spent = 0;
  const budget: Budget | undefined = opts.maxUsd == null ? undefined : { left: () => opts.maxUsd! - spent, spend: (u) => (spent += u) };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let xs = listExtractors();
  // `only` given (even empty) is a filter: an empty list runs nothing, never everything.
  if (opts.only) xs = xs.filter((x) => opts.only!.includes(x.meta.id));
  const entries: FleetEntry[] = [];
  const queue = [...xs];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? Number(process.env.MENUSMITH_FLEET_CONCURRENCY || 4)) }, async () => {
    while (queue.length) {
      const x = queue.shift()!;
      try {
        entries.push(await checkOne(x, emit, { heal: opts.heal !== false, budget, audit: opts.audit ?? (budget ? 'auto' : 'never'), auditDays: opts.auditDays }));
      } catch (e) {
        // One extractor's failure must never lose the whole run's report.
        entries.push({
          id: x.meta.id,
          domain: x.meta.domain,
          restaurant: x.meta.restaurant,
          status: 'error',
          detail: `check failed: ${(e as Error).message}`,
          items: 0,
          baselineItems: x.meta.baselineCount,
          ms: 0,
          tokens: 0,
          costUsd: e instanceof CheckError ? e.costUsd : 0,
          changes: [],
          version: x.meta.version,
        });
      }
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
  writePersisted(resolve(reportDir(), `${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  return report;
}

/**
 * Reports listed in state/hidden-fleet-runs.json are kept but not shown: runs that should
 * never have reached the shared store (replayed local demos), with the reason recorded.
 */
function hiddenRuns(): Set<string> {
  try {
    const f = resolve(config.libraryDir, 'state', 'hidden-fleet-runs.json');
    return new Set((JSON.parse(readFileSync(f, 'utf8')) as { runs: string[] }).runs);
  } catch {
    return new Set();
  }
}

export function fleetHistory(limit = 30): FleetReport[] {
  if (!existsSync(reportDir())) return [];
  const hidden = hiddenRuns();
  return readdirSync(reportDir())
    .filter((f) => f.endsWith('.json') && !hidden.has(f))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => JSON.parse(readFileSync(resolve(reportDir(), f), 'utf8')) as FleetReport)
    // Runs that checked nothing carry no information.
    .filter((r) => r.totals.extractors > 0);
}
