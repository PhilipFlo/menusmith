/**
 * Why is precision against nearBite 0.74? For every benchmark site with a committed
 * extractor, take the dishes the extractor returned that nearBite's stored menu does not
 * have, and sort them into causes. Offline, no model calls.
 *
 *   MENUSMITH_LIBRARY=.cache/bench-library-final npx tsx bench/precision.ts
 *
 * Writes bench/results/precision.json (counts per cause and per site only).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { listExtractors, loadSnapshot } from '../src/library/store.ts';
import { nameSimilarity, normName, samePrice, scoreAgainstOracle } from '../src/agent/evaluate.ts';
import type { MenuItem } from '../src/types.ts';

type Site = { name: string; url: string; website?: string; reference?: MenuItem[] };
const sites = JSON.parse(readFileSync(resolve(ROOT, 'bench/private/sites.json'), 'utf8')) as Site[];
const byUrl = new Map(sites.map((s) => [s.url, s]));

const DRINKS_EXTRAS =
  /\b(drikke|drinks?|beverages?|brus|øl|beer|wine|vin|cocktails?|kaffe|coffee|tea|te|juice|smoothies?|mineralvann|soda|alkoholfri|tilbehør|extras?|ekstra|add[- ]?ons?|sides?|dip|sauce|saus|dressing|toppings?)\b/i;

const causes = { otherSection: 0, drinksOrExtras: 0, renamedOrRepriced: 0, notInReference: 0 };
const rows: Record<string, unknown>[] = [];
for (const x of listExtractors()) {
  const site = byUrl.get(x.meta.url) ?? sites.find((s) => s.website === x.meta.url);
  const ref = site?.reference;
  const items = loadSnapshot(x.meta.id);
  if (!ref?.length || !items?.length) continue;
  const score = scoreAgainstOracle(ref, items, '');
  const refSections = [...new Set(ref.map((r) => normName(r.section || '')))].filter(Boolean);
  const refNames = ref.map((r) => ({ n: normName(r.name), p: r.price }));
  const local = { otherSection: 0, drinksOrExtras: 0, renamedOrRepriced: 0, notInReference: 0 };
  const extras = items.filter((i) => !ref.some((r) => normName(r.name) === normName(i.name) && samePrice(r.price, i.price)));
  for (const e of extras) {
    const k = normName(e.name);
    if (refNames.some((r) => r.n === k || nameSimilarity(r.n, k) >= 0.6)) local.renamedOrRepriced++;
    else if (DRINKS_EXTRAS.test(`${e.section ?? ''} ${e.name}`)) local.drinksOrExtras++;
    else if (e.section && !refSections.some((s) => nameSimilarity(s, normName(e.section!)) >= 0.5)) local.otherSection++;
    else local.notInReference++;
  }
  for (const k of Object.keys(causes) as (keyof typeof causes)[]) causes[k] += local[k];
  rows.push({ site: x.meta.domain, extracted: items.length, reference: ref.length, precision: score.precision, unmatched: extras.length, ...local });
}

const total = Object.values(causes).reduce((a, b) => a + b, 0);
const pct = (n: number) => Math.round((1000 * n) / Math.max(1, total)) / 10;
const summary = {
  sites: rows.length,
  unmatchedDishes: total,
  pctSameDishRenamedOrRepriced: pct(causes.renamedOrRepriced),
  pctDrinksOrExtras: pct(causes.drinksOrExtras),
  pctSectionNearBiteDoesNotHave: pct(causes.otherSection),
  pctOther: pct(causes.notInReference),
};
writeFileSync(resolve(ROOT, 'bench/results/precision.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
