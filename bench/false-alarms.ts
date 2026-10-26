/**
 * The other side of the coverage check: how often does the weekly Nemotron check flag a
 * HEALTHY extractor? Runs the check (no healing) on real-site extractors whose output is
 * unchanged, and counts how many it would have sent for repair.
 *
 *   MENUSMITH_LIBRARY=.cache/false-alarm-bench MENUSMITH_CACHE=.cache/false-alarm-cache npx tsx bench/false-alarms.ts [--limit 20]
 *
 * Copies .cache/bench-library-final first (never touches the real library).
 * Writes bench/results/false-alarms.json.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../src/config.ts';
import { checkExtractor } from '../src/fleet/fleet.ts';
import { listExtractors } from '../src/library/store.ts';

const SOURCE = resolve(ROOT, '.cache/bench-library-final');
if (config.libraryDir === resolve(ROOT, 'library') || config.libraryDir === SOURCE) {
  console.error('Set MENUSMITH_LIBRARY to a scratch folder (see the header).');
  process.exit(1);
}
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 20;
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? process.argv[onlyArg + 1]!.split(',') : null;

rmSync(config.libraryDir, { recursive: true, force: true });
cpSync(SOURCE, config.libraryDir, { recursive: true });

const rows: Record<string, unknown>[] = [];
for (const x of listExtractors().filter((e) => (e.meta.source?.kind ?? 'html') === 'html' && /^https?:/.test(e.meta.url) && (!only || only.includes(e.meta.domain)))) {
  if (rows.length >= limit) break;
  // heal off + audit forced: report what the weekly check concludes, change nothing.
  const e = await checkExtractor(x.meta.id, { heal: false, audit: 'force', maxUsd: 0.05 });
  if (!e || !e.audit) {
    console.log(`skip ${x.meta.id}: ${e?.status} — ${e?.detail}`);
    continue;
  }
  if (e.status !== 'stable' && e.status !== 'review') {
    console.log(`skip ${x.meta.id}: page changed since the benchmark (${e.status})`);
    continue;
  }
  const flagged = !e.audit.pass && e.audit.conclusive;
  rows.push({ site: x.meta.domain, flagged, regressed: e.audit.regressed, recall: e.audit.recall, acceptedRecall: x.meta.score?.recall, missing: e.audit.missing.length, missed: e.audit.missing.slice(0, 10).map((m) => `${m.section ?? ''} / ${m.name} ${m.price ?? ''}`), detail: e.detail, costUsd: e.costUsd });
  console.log(`${flagged ? '⚑' : '✓'} ${x.meta.domain} — recall ${e.audit.recall} (accepted at ${x.meta.score?.recall})${flagged ? ' → would be sent for repair' : ''}`);
}
const flagged = rows.filter((r) => r.flagged).length;
const summary = { healthyExtractorsChecked: rows.length, flagged, falseAlarmRatePct: Math.round((1000 * flagged) / Math.max(1, rows.length)) / 10 };
mkdirSync(resolve(ROOT, 'bench/results'), { recursive: true });
writeFileSync(resolve(ROOT, 'bench/results', only ? 'false-alarms-detail.json' : 'false-alarms.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\n' + JSON.stringify(summary));
