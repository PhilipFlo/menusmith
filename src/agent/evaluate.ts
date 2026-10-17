import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { MenuItem, Score } from '../types.ts';

const require = createRequire(import.meta.url);
const { normName } = require('../sandbox/helpers.cjs') as { normName: (s: unknown) => string };
export { normName };

/** What counts as a passing extractor. Tuned on fixtures; see tests/evaluate.test.ts. */
export const PASS = {
  minF1: 0.9,
  minRecall: 0.85,
  /** Share of extractor items that must carry a price (when the oracle's menu is priced). */
  minPricedRatio: 0.6,
};

/** Lists are kept long enough for arbitration; prompts and the UI slice them further. */
const MAX_LISTED = 150;

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity of two normalised dish names in [0,1]. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 0.9;
  return jaccard(tokens(a), tokens(b));
}

export function samePrice(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Math.max(0.5, Math.abs(a) * 0.005);
}

/**
 * Score extractor output against the oracle.
 *
 * The oracle is the model's own reading of the page — a strong reference, not
 * ground truth. On long menus it can miss items, so an extractor item the oracle
 * doesn't know is only counted against precision when its name does NOT occur in
 * the page text ("ungrounded"). Grounded extras are reported, not penalised.
 */
export function scoreAgainstOracle(
  oracle: MenuItem[],
  extracted: MenuItem[],
  pageText = '',
  opts: { rejected?: Set<string> } = {},
): Score {
  const page = normName(pageText);
  const o = oracle.map((it) => ({ it, n: normName(it.name), used: false }));
  const e = extracted.map((it) => ({ it, n: normName(it.name) }));

  let correct = 0;
  let nameMatched = 0;
  const wrongPrice: Score['wrongPrice'] = [];
  const extra: MenuItem[] = [];
  const grounded: MenuItem[] = [];
  let groundedExtras = 0;
  let duplicates = 0;

  for (const ex of e) {
    // Best unused oracle item by name, preferring one whose price also agrees.
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < o.length; i++) {
      const cand = o[i]!;
      if (cand.used) continue;
      const sim = nameSimilarity(ex.n, cand.n);
      if (sim < 0.6) continue;
      const s = sim + (samePrice(ex.it.price, cand.it.price) ? 0.5 : 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best >= 0) {
      const cand = o[best]!;
      cand.used = true;
      nameMatched++;
      if (samePrice(ex.it.price, cand.it.price)) correct++;
      else if (wrongPrice.length < MAX_LISTED)
        wrongPrice.push({ name: cand.it.name, expected: cand.it.price, got: ex.it.price });
    } else if (o.some((c) => c.used && nameSimilarity(ex.n, c.n) >= 0.9)) {
      // A second copy of a dish we already matched (mobile + desktop copies, or a
      // container matched as if it were an item) — always an error.
      duplicates++;
      if (extra.length < MAX_LISTED) extra.push({ ...ex.it, name: `${ex.it.name} (duplicate)` });
    } else if (ex.n && page.includes(ex.n) && !opts.rejected?.has(ex.n)) {
      // On the page but not in the reference: the oracle may have missed it.
      groundedExtras++;
      if (grounded.length < MAX_LISTED) grounded.push(ex.it);
    } else if (extra.length < MAX_LISTED) {
      extra.push(ex.it);
    }
  }

  const ungrounded = e.length - nameMatched - groundedExtras;
  const judged = e.length - groundedExtras; // items we can actually grade
  const precision = judged > 0 ? correct / judged : e.length > 0 ? 1 : 0;
  const recall = o.length > 0 ? correct / o.length : e.length === 0 ? 1 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const priced = extracted.filter((it) => it.price != null).length;
  const pricedRatio = extracted.length ? priced / extracted.length : 0;
  const oraclePriced = oracle.length ? oracle.filter((it) => it.price != null).length / oracle.length : 0;

  const missing = o.filter((x) => !x.used).map((x) => x.it).slice(0, MAX_LISTED);

  const pass =
    extracted.length > 0 &&
    f1 >= PASS.minF1 &&
    recall >= PASS.minRecall &&
    (oraclePriced < 0.5 || pricedRatio >= PASS.minPricedRatio) &&
    ungrounded <= Math.max(2, Math.floor(e.length * 0.05));

  return {
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    pricedRatio: round(pricedRatio),
    matched: correct,
    oracleCount: oracle.length,
    extractorCount: extracted.length,
    missing,
    extra,
    grounded,
    duplicates,
    wrongPrice,
    pass,
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Order-insensitive fingerprint of an item list — used for determinism and drift checks. */
export function itemsHash(items: MenuItem[]): string {
  const lines = items
    .map((it) => `${normName(it.section ?? '')}|${normName(it.name)}|${it.price ?? ''}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}
