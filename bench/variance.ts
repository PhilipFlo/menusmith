/**
 * The premise, measured: is "ask the LLM to read the menu every time" noisy, and is a
 * written extractor not? For real restaurant pages with a committed extractor, fetch the
 * page ONCE, then on that identical text:
 *   - run the extractor 3× (plain JavaScript, no model),
 *   - read the menu 3× with the Nemotron oracle (exactly what an LLM-per-scrape pipeline does).
 * Any difference between the three LLM readings is noise a price index would record as change.
 *
 *   MENUSMITH_LIBRARY=.cache/bench-library-final npx tsx bench/variance.ts [--limit 20]
 *   MENUSMITH_TEMPERATURE=0 … bench/variance.ts   → variance-t0.json (is it just sampling noise?)
 *
 * Writes bench/results/variance.json (names, counts and agreement metrics only).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { fetchPage } from '../src/html/fetch.ts';
import { pageText } from '../src/html/simplify.ts';
import { listExtractors } from '../src/library/store.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
import { itemsHash, normName, samePrice } from '../src/agent/evaluate.ts';
import { readMenu } from '../src/agent/oracle.ts';
import { Ledger } from '../src/llm/client.ts';
import type { MenuItem } from '../src/types.ts';

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 20;

const names = (items: MenuItem[]) => new Set(items.map((i) => normName(i.name)).filter(Boolean));
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return a.size + b.size - inter ? inter / (a.size + b.size - inter) : 1;
};
/** Of the dishes two readings share, how many got a different price? Only names listed
 *  once in both readings count, so a dish sold in two sizes is never a false "flip". */
const priceFlips = (a: MenuItem[], b: MenuItem[]) => {
  const once = (xs: MenuItem[]) => {
    const n = new Map<string, number>();
    for (const i of xs) n.set(normName(i.name), (n.get(normName(i.name)) ?? 0) + 1);
    return new Map(xs.filter((i) => n.get(normName(i.name)) === 1).map((i) => [normName(i.name), i.price]));
  };
  const pa = once(a);
  const pb = once(b);
  const shared = [...pa].filter(([k]) => pb.has(k)).map(([name, price]) => ({ name, price }));
  return { shared: shared.length, flipped: shared.filter((i) => !samePrice(i.price, pb.get(i.name))).length };
};
const pairs = <T>(xs: T[]) => xs.flatMap((x, i) => xs.slice(i + 1).map((y) => [x, y] as const));
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

const xs = listExtractors()
  .filter((x) => (x.meta.source?.kind ?? 'html') === 'html' && /^https?:/.test(x.meta.url))
  .slice(0, limit);

const rows: Record<string, unknown>[] = [];
for (const x of xs) {
  let html: string;
  try {
    html = (await fetchPage(x.meta.url)).html;
  } catch (e) {
    console.log(`skip ${x.meta.id}: ${(e as Error).message}`);
    continue;
  }
  const code = await Promise.all([0, 1, 2].map(() => runExtractor(x.code, html, x.meta.url)));
  if (!code[0]!.ok || !code[0]!.items.length) {
    console.log(`skip ${x.meta.id}: extractor no longer matches the live page`);
    continue;
  }
  const text = pageText(html);
  const reads: MenuItem[][] = [];
  for (let i = 0; i < 3; i++) {
    try {
      reads.push((await readMenu(text, { url: x.meta.url, restaurant: x.meta.restaurant }, new Ledger())).items);
    } catch (e) {
      console.log(`  read ${i + 1} failed: ${(e as Error).message}`);
    }
  }
  if (reads.length < 2) continue;
  const counts = reads.map((r) => r.length);
  const jac = pairs(reads).map(([a, b]) => jaccard(names(a), names(b)));
  const flips = pairs(reads).map(([a, b]) => priceFlips(a, b));
  const shared = flips.reduce((n, f) => n + f.shared, 0);
  const row = {
    site: x.meta.domain,
    extractorItems: code[0]!.items.length,
    extractorIdentical: new Set(code.map((r) => itemsHash(r.items))).size === 1,
    llmCounts: counts,
    llmCountSpreadPct: round((100 * (Math.max(...counts) - Math.min(...counts))) / Math.max(1, Math.max(...counts)), 1),
    llmIdenticalNameSets: jac.every((j) => j === 1),
    llmMinJaccard: round(Math.min(...jac)),
    llmPriceFlipPct: round((100 * flips.reduce((n, f) => n + f.flipped, 0)) / Math.max(1, shared), 1),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const n = rows.length;
const avg = (k: string) => round(rows.reduce((a, r) => a + (r[k] as number), 0) / Math.max(1, n), 2);
const summary = {
  sites: n,
  extractorIdentical: rows.filter((r) => r.extractorIdentical).length,
  llmAllThreeIdentical: rows.filter((r) => r.llmIdenticalNameSets && (r.llmCountSpreadPct as number) === 0 && (r.llmPriceFlipPct as number) === 0).length,
  llmSitesWithCountChange: rows.filter((r) => (r.llmCountSpreadPct as number) > 0).length,
  avgLlmCountSpreadPct: avg('llmCountSpreadPct'),
  medianLlmCountSpreadPct: [...rows.map((r) => r.llmCountSpreadPct as number)].sort((a, b) => a - b)[Math.floor(n / 2)] ?? 0,
  sitesWithAnEmptyRead: rows.filter((r) => (r.llmCounts as number[]).includes(0)).length,
  avgLlmMinJaccard: avg('llmMinJaccard'),
  avgLlmPriceFlipPct: avg('llmPriceFlipPct'),
};
mkdirSync(resolve(ROOT, 'bench/results'), { recursive: true });
const outName = process.env.MENUSMITH_TEMPERATURE === '0' ? 'variance-t0.json' : 'variance.json';
writeFileSync(resolve(ROOT, 'bench/results', outName), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\n' + JSON.stringify(summary));
