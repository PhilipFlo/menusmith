/**
 * Judge simulation: what happens when someone types a US restaurant they know?
 * Restaurants are given by NAME + CITY only (no URL), like a visitor would, across
 * cities, cuisines, chains and small places. Every run is live (Tavily + Nemotron).
 *
 *   MENUSMITH_LIBRARY=.cache/judge-lib MENUSMITH_RENDER_LOWMEM=1 npx tsx bench/judge-sim.ts [--max-usd 3] [--only "Name"]
 *
 * "Got a menu" = the visitor saw dishes: an extractor, a PDF/image/listing reading, or
 * (near miss) Nemotron's reading. Writes bench/results/judge-sim.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, config } from '../src/config.ts';
import { forge } from '../src/agent/pipeline.ts';
import { Ledger } from '../src/llm/client.ts';

if (config.libraryDir === resolve(ROOT, 'library')) {
  console.error('Set MENUSMITH_LIBRARY to a scratch folder (see the header).');
  process.exit(1);
}
const arg = (k: string) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const MAX_USD = Number(arg('--max-usd') ?? 3);
const PER_RUN_USD = 0.3;
const CONCURRENCY = 2;

export const RESTAURANTS: [string, string][] = [
  ['Swan Oyster Depot', 'San Francisco'],
  ['House of Prime Rib', 'San Francisco'],
  ['Burma Superstar', 'San Francisco'],
  ['La Taqueria', 'San Francisco'],
  ['Nopalito', 'San Francisco'],
  ['Evvia Estiatorio', 'Palo Alto'],
  ['Tamarine', 'Palo Alto'],
  ["Joe's Shanghai", 'New York'],
  ['Carbone', 'New York'],
  ['Los Tacos No. 1', 'New York'],
  ["Xi'an Famous Foods", 'New York'],
  ['Peter Luger Steak House', 'Brooklyn'],
  ['Pike Place Chowder', 'Seattle'],
  ['Din Tai Fung', 'Seattle'],
  ["Portillo's", 'Chicago'],
  ['Girl & the Goat', 'Chicago'],
  ["Hattie B's Hot Chicken", 'Nashville'],
  ["Joe's Stone Crab", 'Miami'],
  ['Bestia', 'Los Angeles'],
  ["Howlin' Ray's", 'Los Angeles'],
  ['Uchi', 'Austin'],
  ['Chipotle', 'San Francisco'],
];

const only = arg('--only');
const queue = RESTAURANTS.filter(([n]) => !only || only.split(',').includes(n));
const rows: Record<string, unknown>[] = [];
let spent = 0;

async function one([restaurant, city]: [string, string]) {
  if (spent >= MAX_USD - PER_RUN_USD) {
    rows.push({ restaurant, city, skipped: 'budget' });
    return;
  }
  const ledger = new Ledger(PER_RUN_USD);
  const t = Date.now();
  let url: string | undefined;
  let reading = 0;
  try {
    const out = await forge({ restaurant, city, fresh: true, ledger }, (e) => {
      if (e.type === 'step' && e.step === 'discover' && e.status === 'done') url = e.detail?.split('→ ').pop();
      if (e.type === 'oracle') reading = e.items.length;
    });
    const dishes = out.items?.length ?? 0;
    const gotMenu = out.ok ? dishes > 0 : reading >= 5;
    rows.push({ restaurant, city, url, ok: out.ok, mode: out.mode, kind: out.meta?.source?.kind, dishes, reading, gotMenu, reason: out.reason, costUsd: Math.round(ledger.costUsd * 1e4) / 1e4, s: Math.round((Date.now() - t) / 1000) });
    console.log(`${out.ok ? '✓' : gotMenu ? '~' : '✗'} ${restaurant} (${city}) — ${out.ok ? `${out.meta?.source?.kind} ${dishes} dishes` : out.reason} · $${ledger.costUsd.toFixed(4)} · ${Math.round((Date.now() - t) / 1000)}s · ${url ?? ''}`);
  } catch (e) {
    rows.push({ restaurant, city, url, ok: false, gotMenu: false, reason: `crash: ${(e as Error).message}`, costUsd: ledger.costUsd });
    console.log(`✗ ${restaurant} — crash: ${(e as Error).message}`);
  }
  spent += ledger.costUsd;
}

const workers = Array.from({ length: CONCURRENCY }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) await one(next);
});
await Promise.all(workers);

const done = rows.filter((r) => !r.skipped);
const summary = {
  restaurants: done.length,
  committed: done.filter((r) => r.ok).length,
  gotMenu: done.filter((r) => r.gotMenu).length,
  byKind: done.filter((r) => r.ok).reduce<Record<string, number>>((a, r) => ((a[r.kind as string] = (a[r.kind as string] ?? 0) + 1), a), {}),
  totalCostUsd: Math.round(spent * 1e4) / 1e4,
  medianSeconds: done.map((r) => r.s as number).filter(Boolean).sort((a, b) => a - b)[Math.floor(done.length / 2)] ?? null,
};
mkdirSync(resolve(ROOT, 'bench/results'), { recursive: true });
if (!only) writeFileSync(resolve(ROOT, 'bench/results/judge-sim.json'), JSON.stringify({ runAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\n' + JSON.stringify(summary));
