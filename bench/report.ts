/**
 * Print the README "Results" section from the benchmark files — numbers come straight
 * from bench/results/*.json, never typed by hand.
 *
 *   npx tsx bench/report.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';

type Row = Record<string, any>;
const load = (f: string) => (existsSync(resolve(ROOT, f)) ? JSON.parse(readFileSync(resolve(ROOT, f), 'utf8')) : null);
const fx = load('bench/results/fixtures.json');
const real = load('bench/results/latest.json');

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
const usd = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

const lines: string[] = ['## Results', ''];
if (fx) {
  const s = fx.summary;
  lines.push(
    `**Ground truth — 10 fictional restaurant sites** (\`fixtures/sites\`, true menus known): ` +
      `average F1 **${s.avgF1VsTruth}** against the truth, ${s.perfect}/${s.sites} perfect, ${s.deterministic}/${s.sites} deterministic.`,
    '',
  );
}
if (real) {
  const rows: Row[] = real.rows;
  const n = rows.length;
  const ok = rows.filter((r) => r.ok);
  const rescued = rows.filter((r) => !r.ok && r.rescue?.ok);
  const kinds: Record<string, number> = {};
  for (const r of [...ok, ...rescued]) {
    const k = r.ok ? r.sourceKind : r.rescue.sourceKind;
    kinds[k || '?'] = (kinds[k || '?'] || 0) + 1;
  }
  const costs = ok.map((r) => r.costUsd as number);
  const rounds = ok.filter((r) => r.mode === 'forged').map((r) => r.rounds as number);
  lines.push(
    `**Real restaurant websites — ${n} sites in Oslo and Palo Alto** (sampled across WordPress, Squarespace, Wix, Webflow, hosted ordering systems and custom sites):`,
    '',
    '| Metric | Result |',
    '|---|---|',
    `| Extractor committed, starting from the stored menu URL | **${ok.length}/${n} (${pct(ok.length, n)})** |`,
    rescued.length || real.summary.rescue
      ? `| …including the homepage rescue pass (discovery + vision) | **${ok.length + rescued.length}/${n} (${pct(ok.length + rescued.length, n)})** |`
      : '',
    `| Passed on the first attempt | ${pct(rounds.filter((r) => r === 1).length, rounds.length)} of forged extractors |`,
    `| Adopted from the library (zero new code) | ${ok.filter((r) => r.mode === 'reused').length} sites |`,
    `| Deterministic on re-run (3 runs, identical output) | ${pct(ok.filter((r) => r.deterministic === true).length, ok.filter((r) => r.deterministic != null).length)} (${ok.filter((r) => r.deterministic === true).length}/${ok.filter((r) => r.deterministic != null).length} measured) |`,
    `| Median one-time cost per site | ${usd(median(costs))} |`,
    `| Median re-run time | ${median(ok.filter((r) => r.rerunMs != null).map((r) => r.rerunMs))} ms, **$0** |`,
    `| Precision vs. nearBite's independently scraped menus | ${real.summary.avgPrecisionVsNearBite} |`,
    `| Source mix of successes | ${Object.entries(kinds).map(([k, v]) => `${k}: ${v}`).join(' · ')} |`,
    '',
  );
  const fails: Record<string, number> = {};
  for (const r of rows) if (!r.ok && !r.rescue?.ok) fails[r.category || 'other'] = (fails[r.category || 'other'] || 0) + 1;
  lines.push(`Remaining failures: ${Object.entries(fails).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}.`, '');
  lines.push(
    '_Recall against nearBite is lower by design: nearBite merges several pages of a site, Menusmith extracts one menu page._',
    '',
  );
}
console.log(lines.filter((l) => l !== null).join('\n'));
