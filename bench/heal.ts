/**
 * Self-healing, measured. For each fictional fixture site (true menus known):
 *   1. forge an extractor from scratch for the original website,
 *   2. switch the site to its redesign (new markup, plus real price/dish changes),
 *   3. run the fleet with healing on,
 *   4. score what the fleet ends up with against the TRUE redesigned menu.
 *
 *   MENUSMITH_LIBRARY=.cache/heal-bench/library MENUSMITH_CACHE=.cache/heal-bench npx tsx bench/heal.ts [slugs…]
 *
 * Uses its own library/cache (never the real one). Writes bench/results/heal.json.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../src/config.ts';
import { forge } from '../src/agent/pipeline.ts';
import { runFleet } from '../src/fleet/fleet.ts';
import { fetchPage, setFixtureRedesigned } from '../src/html/fetch.ts';
import { listExtractors } from '../src/library/store.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
import { scoreAgainstOracle } from '../src/agent/evaluate.ts';
import type { MenuItem } from '../src/types.ts';

if (config.libraryDir === resolve(ROOT, 'library')) {
  console.error('Refusing to run against the real library — set MENUSMITH_LIBRARY (see the header).');
  process.exit(1);
}

const all = readdirSync(resolve(ROOT, 'fixtures/sites'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : all;

const truthF1 = async (url: string, truth: MenuItem[]) => {
  const x = listExtractors().find((e) => e.meta.url === url);
  if (!x) return { f1: 0, items: 0, version: 0 };
  const page = await fetchPage(url);
  const r = await runExtractor(x.code, page.html, url);
  return { f1: scoreAgainstOracle(truth, r.items, '').f1, items: r.items.length, version: x.meta.version };
};

const rows: Record<string, unknown>[] = [];
for (const slug of slugs) {
  const url = `fixture://${slug}/`;
  const exp = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/sites', slug, 'expected.json'), 'utf8')) as { items: MenuItem[]; redesignItems: MenuItem[] };
  setFixtureRedesigned(slug, false);
  const t0 = Date.now();
  const built = await forge({ url, noReuse: true }, () => {});
  const before = await truthF1(url, exp.items);
  const forgeCost = built.ledger.listCostUsd;
  if (!built.ok) {
    rows.push({ site: slug, forged: false, reason: built.reason });
    console.log(`✗ ${slug}: forge failed — ${built.reason}`);
    continue;
  }
  setFixtureRedesigned(slug, true);
  try {
    const t1 = Date.now();
    const report = await runFleet({ heal: true, only: [built.meta!.id], maxUsd: 0.3 });
    const e = report.entries[0]!;
    const after = await truthF1(url, exp.redesignItems);
    const row = {
      site: slug,
      forged: true,
      forgeF1VsTruth: before.f1,
      forgeCostUsd: Math.round(forgeCost * 1e5) / 1e5,
      fleetStatus: e.status,
      fleetDetail: e.detail,
      healedF1VsTruth: after.f1,
      redesignTruth: exp.redesignItems.length,
      extracted: after.items,
      versions: `v${before.version} → v${after.version}`,
      healCostUsd: e.costUsd,
      healSeconds: Math.round((Date.now() - t1) / 100) / 10,
      totalSeconds: Math.round((Date.now() - t0) / 100) / 10,
    };
    rows.push(row);
    console.log(`${after.f1 === 1 ? '✓' : after.f1 >= 0.9 ? '~' : '✗'} ${slug}: ${e.status} · F1 vs truth ${after.f1} · ${row.versions} · $${e.costUsd} · ${row.healSeconds}s`);
  } finally {
    setFixtureRedesigned(slug, false);
  }
}

const done = rows.filter((r) => r.forged) as { fleetStatus: string; healedF1VsTruth: number; healCostUsd: number; healSeconds: number }[];
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const healed = done.filter((r) => r.fleetStatus === 'healed');
const summary = {
  sites: rows.length,
  forged: done.length,
  healed: healed.length,
  stillCorrectWithoutHeal: done.filter((r) => r.fleetStatus !== 'healed' && r.healedF1VsTruth === 1).length,
  correctAfterRedesign: done.filter((r) => r.healedF1VsTruth === 1).length,
  avgF1AfterRedesign: Math.round((done.reduce((a, r) => a + r.healedF1VsTruth, 0) / Math.max(1, done.length)) * 1000) / 1000,
  medianHealCostUsd: med(healed.map((r) => r.healCostUsd)),
  medianHealSeconds: med(healed.map((r) => r.healSeconds)),
};
mkdirSync(resolve(ROOT, 'bench/results'), { recursive: true });
writeFileSync(resolve(ROOT, 'bench/results/heal.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\n' + JSON.stringify(summary));
