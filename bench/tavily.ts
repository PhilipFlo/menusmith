/**
 * How well does "just a restaurant name" work? For benchmark sites with a known official
 * website, ask Tavily (via findOfficialSite) to find it from name + city alone, and check
 * whether it lands on the same domain.
 *
 *   npx tsx bench/tavily.ts [--limit 40] [--offset 40]
 *
 * Writes bench/results/tavily.json (or tavily-holdout.json with --offset — sites that were not
 * used while tuning the ranking): names, domains and outcome only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { findOfficialSite, tavilyEnabled } from '../src/tools/tavily.ts';

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 40;
const offsetArg = process.argv.indexOf('--offset');
const offset = offsetArg > 0 ? Number(process.argv[offsetArg + 1]) : 0;
const out = offset ? `bench/results/tavily-holdout.json` : 'bench/results/tavily.json';

type Site = { name: string; city: string; website?: string };
const sites = (JSON.parse(readFileSync('bench/private/sites.json', 'utf8')) as Site[]).filter((s) => s.website).slice(offset, offset + limit);

const domain = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
  } catch {
    return '';
  }
};

if (!tavilyEnabled()) {
  console.error('TAVILY_API_KEY is not set');
  process.exit(1);
}

const rows: { name: string; city: string; expected: string; found: string | null; match: boolean; ms: number }[] = [];
for (const s of sites) {
  const t0 = Date.now();
  let found: string | null = null;
  try {
    found = (await findOfficialSite(s.name, s.city))?.url ?? null;
  } catch (e) {
    console.warn(`${s.name}: ${(e as Error).message}`);
  }
  const row = { name: s.name, city: s.city, expected: domain(s.website!), found: found && domain(found), match: !!found && domain(found) === domain(s.website!), ms: Date.now() - t0 };
  rows.push(row);
  console.log(`${row.match ? '✓' : '✗'} ${s.name} (${s.city}) → ${row.found ?? '—'}${row.match ? '' : `  [expected ${row.expected}]`}`);
}

const matched = rows.filter((r) => r.match).length;
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const summary = { sites: rows.length, matched, matchRate: Math.round((1000 * matched) / rows.length) / 10, medianMs: ms[Math.floor(ms.length / 2)] };
mkdirSync('bench/results', { recursive: true });
writeFileSync(out, JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log(`\nTavily found the official website for ${matched}/${rows.length} restaurants (${summary.matchRate}%) from name + city alone; median ${summary.medianMs} ms.`);
