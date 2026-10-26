/**
 * Silent misses, measured. A broken extractor (0 dishes) is easy to catch; one that quietly
 * drops a few dishes looks like a normal menu change. For each fixture site (true menu known)
 * we take its working extractor, make it silently drop the last K dishes, and run one fleet
 * check — in two situations:
 *
 *   removal  — the last run still had every dish, so K dishes "disappear" today.
 *              The fleet must not record them as removed: it re-reads the page, sees they are
 *              still there, and rewrites the code.
 *   weekly   — the loss is old: the baseline already has the shorter list, nothing changes
 *              today. Only the weekly coverage check (a fresh Nemotron reading) can find it.
 *
 * Score = does the fleet heal, and does the final extractor match the TRUE menu?
 *
 *   MENUSMITH_LIBRARY=.cache/coverage-bench MENUSMITH_CACHE=.cache/coverage-bench-cache npx tsx bench/coverage.ts
 *
 * Starts from a copy of .cache/showcase-library each case; never touches the real library.
 * Writes bench/results/coverage.json.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../src/config.ts';
import { checkExtractor } from '../src/fleet/fleet.ts';
import { fetchPage, setFixtureRedesigned } from '../src/html/fetch.ts';
import { listExtractors } from '../src/library/store.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
import { itemsHash, scoreAgainstOracle } from '../src/agent/evaluate.ts';
import type { MenuItem } from '../src/types.ts';

const SOURCE = resolve(ROOT, '.cache/showcase-library');
if (config.libraryDir === resolve(ROOT, 'library') || config.libraryDir === SOURCE) {
  console.error('Set MENUSMITH_LIBRARY to a scratch folder (see the header).');
  process.exit(1);
}
const lib = config.libraryDir;

const fixtures = listFixtures();
function listFixtures(): string[] {
  rmSync(lib, { recursive: true, force: true });
  cpSync(SOURCE, lib, { recursive: true });
  return listExtractors()
    .filter((x) => x.meta.url.startsWith('fixture://'))
    .map((x) => x.meta.id);
}

async function setup(id: string, drop: number, scenario: 'removal' | 'weekly') {
  rmSync(lib, { recursive: true, force: true });
  cpSync(SOURCE, lib, { recursive: true });
  const metaFile = resolve(lib, 'extractors', id, 'meta.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const codeFile = resolve(lib, 'extractors', id, `v${meta.version}.js`);
  // The bug: the extractor silently loses its last `drop` dishes.
  const lossy = `${readFileSync(codeFile, 'utf8')}\n;{ const __orig = extract; extract = function (a, c) { return __orig(a, c).slice(0, -${drop}); }; }\n`;
  writeFileSync(codeFile, lossy);
  const page = await fetchPage(meta.url);
  const full = await runExtractor(readFileSync(codeFile, 'utf8').replace(/\n;\{ const __orig[\s\S]*$/, ''), page.html, meta.url);
  const short = await runExtractor(lossy, page.html, meta.url);
  const snapshot = scenario === 'removal' ? full.items : short.items;
  writeFileSync(resolve(lib, 'snapshots', `${id}.json`), JSON.stringify(snapshot));
  meta.baselineHash = itemsHash(snapshot);
  meta.baselineCount = snapshot.length;
  meta.createdAt = '2026-01-01T00:00:00.000Z'; // old enough that the weekly check is due
  delete meta.lastAudit;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return { url: meta.url as string, before: short.items.length, truth: full.items.length };
}

const rows: Record<string, unknown>[] = [];
for (const id of fixtures) {
  const slug = id.replace(/-fixture$/, '');
  setFixtureRedesigned(slug, false);
  const truth = (JSON.parse(readFileSync(resolve(ROOT, 'fixtures/sites', slug, 'expected.json'), 'utf8')) as { items: MenuItem[] }).items;
  for (const [scenario, drop] of [
    ['removal', 2],
    ['weekly', 2],
    ['weekly', 5],
  ] as const) {
    const s = await setup(id, drop, scenario);
    const e = await checkExtractor(id, { heal: true, audit: 'auto', maxUsd: 0.2 });
    const x = listExtractors().find((q) => q.meta.id === id)!;
    const page = await fetchPage(s.url);
    const after = await runExtractor(x.code, page.html, s.url);
    const f1 = scoreAgainstOracle(truth, after.items, '').f1;
    const row = { site: slug, scenario, dropped: drop, of: s.truth, status: e?.status, f1AfterVsTruth: f1, costUsd: e?.costUsd ?? 0, detail: e?.detail };
    rows.push(row);
    console.log(`${f1 === 1 ? '✓' : '✗'} ${slug.padEnd(16)} ${scenario.padEnd(7)} −${drop}/${s.truth}  → ${e?.status} · F1 ${f1} · $${e?.costUsd}`);
  }
}

const by = (sc: string, d: number) => rows.filter((r) => r.scenario === sc && r.dropped === d);
const stat = (rs: Record<string, unknown>[]) => ({
  cases: rs.length,
  healed: rs.filter((r) => r.status === 'healed').length,
  correctAfter: rs.filter((r) => r.f1AfterVsTruth === 1).length,
});
const summary = {
  removal2: stat(by('removal', 2)),
  weekly2: stat(by('weekly', 2)),
  weekly5: stat(by('weekly', 5)),
  totalCostUsd: Math.round(rows.reduce((a, r) => a + (r.costUsd as number), 0) * 1e4) / 1e4,
};
mkdirSync(resolve(ROOT, 'bench/results'), { recursive: true });
writeFileSync(resolve(ROOT, 'bench/results/coverage.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\n' + JSON.stringify(summary));
