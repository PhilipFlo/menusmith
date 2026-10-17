/**
 * Ground-truth accuracy on our synthetic fixture sites, where the true menu is
 * known (fixtures/sites/<slug>/expected.json). Scores every committed fixture
 * extractor against the TRUTH (not the oracle), and also scores the oracle itself
 * against the truth — showing whether written code beats re-reading with an LLM.
 *
 *   npx tsx bench/fixtures.ts            # extractors vs truth (no LLM calls)
 *   npx tsx bench/fixtures.ts --oracle   # also re-read each page with the oracle
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { fetchPage } from '../src/html/fetch.ts';
import { pageText } from '../src/html/simplify.ts';
import { listExtractors } from '../src/library/store.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
import { scoreAgainstOracle, itemsHash } from '../src/agent/evaluate.ts';
import { readMenu } from '../src/agent/oracle.ts';
import { Ledger } from '../src/llm/client.ts';
import type { MenuItem } from '../src/types.ts';

const withOracle = process.argv.includes('--oracle');
const rows: Record<string, unknown>[] = [];
for (const x of listExtractors().filter((x) => x.meta.url.startsWith('fixture://'))) {
  const slug = x.meta.url.replace('fixture://', '').replace(/\/.*$/, '');
  const exp = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/sites', slug, 'expected.json'), 'utf8')) as { items: MenuItem[]; redesignItems: MenuItem[] };
  const page = await fetchPage(x.meta.url);
  const redesigned = page.html.includes('') && readFileSync(resolve(ROOT, 'fixtures/sites', slug, 'redesign.html'), 'utf8') === page.html;
  const truth = redesigned ? exp.redesignItems : exp.items;
  const runs = await Promise.all([1, 2, 3].map(() => runExtractor(x.code, page.html, x.meta.url)));
  const r = runs[0]!;
  const s = scoreAgainstOracle(truth, r.items, '');
  const row: Record<string, unknown> = {
    site: slug,
    version: x.meta.version,
    serving: redesigned ? 'redesign' : 'original',
    truth: truth.length,
    extracted: r.items.length,
    precision: s.precision,
    recall: s.recall,
    f1: s.f1,
    deterministic: new Set(runs.map((q) => itemsHash(q.items))).size === 1,
  };
  if (withOracle) {
    const o = await readMenu(pageText(page.html), { url: x.meta.url }, new Ledger());
    const so = scoreAgainstOracle(truth, o.items, '');
    row.oracleF1 = so.f1;
    row.oracleItems = o.items.length;
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
const avg = (k: string) => Math.round((rows.reduce((a, r) => a + (r[k] as number), 0) / Math.max(1, rows.length)) * 1000) / 1000;
const summary = {
  sites: rows.length,
  avgF1VsTruth: avg('f1'),
  perfect: rows.filter((r) => r.f1 === 1).length,
  deterministic: rows.filter((r) => r.deterministic).length,
  ...(withOracle ? { avgOracleF1VsTruth: avg('oracleF1') } : {}),
};
console.log(summary);
mkdirSync(resolve(ROOT, 'bench/results'), { recursive: true });
writeFileSync(resolve(ROOT, 'bench/results/fixtures.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
