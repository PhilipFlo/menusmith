/**
 * Why is precision against nearBite 0.74? For every benchmark site with a committed
 * extractor, take exactly the scorer's false positives against nearBite's stored menu
 * (the dishes that pull precision down) and sort them into causes. Offline, no model calls.
 *
 *   MENUSMITH_LIBRARY=.cache/bench-library-final npx tsx bench/precision.ts
 *
 * Writes bench/results/precision.json (counts per cause and per site only).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { listExtractors, loadSnapshot } from '../src/library/store.ts';
import { nameSimilarity, normName, scoreAgainstOracle } from '../src/agent/evaluate.ts';
import type { MenuItem } from '../src/types.ts';

type Site = { name: string; url: string; website?: string; reference?: MenuItem[] };
const sites = JSON.parse(readFileSync(resolve(ROOT, 'bench/private/sites.json'), 'utf8')) as Site[];
const byUrl = new Map(sites.map((s) => [s.url, s]));

const DRINKS_EXTRAS =
  /\b(drikke|drinks?|beverages?|brus|øl|beer|wine|vin|cocktails?|kaffe|coffee|tea|te|juice|smoothies?|mineralvann|soda|alkoholfri|tilbehør|extras?|ekstra|add[- ]?ons?|sides?|dip|sauce|saus|dressing|toppings?)\b/i;

// Exactly the scorer's false positives (the dishes behind the precision number):
// same dish at another price, duplicates, and extracted dishes with no match at all.
const causes = { repriced: 0, duplicate: 0, drinksOrExtras: 0, sectionNotInReference: 0, unexplained: 0 };
const rows: Record<string, unknown>[] = [];
let extracted = 0;
let correct = 0;
for (const x of listExtractors()) {
  const site = byUrl.get(x.meta.url) ?? sites.find((s) => s.website === x.meta.url);
  const ref = site?.reference;
  const items = loadSnapshot(x.meta.id);
  if (!ref?.length || !items?.length) continue;
  const score = scoreAgainstOracle(ref, items, '', { uncapped: true });
  const refSections = [...new Set(ref.map((r) => normName(r.section || '')))].filter(Boolean);
  const local = { repriced: score.wrongPrice.length, duplicate: score.duplicates, drinksOrExtras: 0, sectionNotInReference: 0, unexplained: 0 };
  for (const e of score.extra) {
    if (/\(duplicate\)$/.test(e.name)) continue;
    if (DRINKS_EXTRAS.test(`${e.section ?? ''} ${e.name}`)) local.drinksOrExtras++;
    else if (e.section && !refSections.some((s) => nameSimilarity(s, normName(e.section!)) >= 0.5)) local.sectionNotInReference++;
    else local.unexplained++;
  }
  for (const k of Object.keys(causes) as (keyof typeof causes)[]) causes[k] += local[k];
  extracted += items.length;
  correct += score.matched;
  rows.push({ site: x.meta.domain, extracted: items.length, reference: ref.length, precision: score.precision, ...local });
}

const total = Object.values(causes).reduce((a, b) => a + b, 0);
const pct = (n: number) => Math.round((1000 * n) / Math.max(1, total)) / 10;
const summary = {
  sites: rows.length,
  falsePositives: total,
  avgPrecision: Math.round((rows.reduce((a, r) => a + (r.precision as number), 0) / Math.max(1, rows.length)) * 1000) / 1000,
  pooledPrecision: Math.round((correct / Math.max(1, extracted)) * 1000) / 1000,
  /** Counting "same dish, price changed since nearBite scraped" as found. */
  pooledPrecisionIfRepricedCounts: Math.round(((correct + causes.repriced) / Math.max(1, extracted)) * 1000) / 1000,
  pctRepriced: pct(causes.repriced),
  pctDuplicates: pct(causes.duplicate),
  pctDrinksOrExtras: pct(causes.drinksOrExtras),
  pctSectionNearBiteDoesNotHave: pct(causes.sectionNotInReference),
  pctUnexplained: pct(causes.unexplained),
};
writeFileSync(resolve(ROOT, 'bench/results/precision.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
