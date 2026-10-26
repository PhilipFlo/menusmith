/**
 * Rescue pass + final summary.
 *
 * The main benchmark starts from the "menu URL" stored in nearBite. Some of those are
 * wrong (a hotel's offers page, a different branch) or the menu is an image. A real
 * user would just give the restaurant's homepage, so this pass retries every site
 * that failed for a page/source reason — starting from the homepage, with discovery,
 * rendering and the vision path enabled — and writes a merged summary that keeps the
 * two numbers separate.
 *
 *   npx tsx bench/rescue.ts [--results bench/results/latest.json] [--concurrency 3] [--retry-unrecorded]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { forge } from '../src/agent/pipeline.ts';
import { closeBrowser } from '../src/html/render.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const resultsFile = resolve(ROOT, arg('--results', 'bench/results/latest.json'));
const sitesFile = resolve(ROOT, arg('--sites', 'bench/private/sites.json'));
const concurrency = Number(arg('--concurrency', '3'));

const RESCUABLE = new Set(['no-html-menu (JS/PDF/image)', 'unreachable', 'blocked', 'other']);

type Row = Record<string, unknown>;

async function main() {
  const res = JSON.parse(readFileSync(resultsFile, 'utf8')) as { runAt: string; summary: Record<string, unknown>; rows: Row[] };
  const sites = JSON.parse(readFileSync(sitesFile, 'utf8')) as { name: string; url: string; website?: string; city?: string }[];
  // --retry-unrecorded: only redo rescue attempts that ran in replay mode by mistake
  // ("no recorded response …") — they never reached the model.
  const unrecorded = process.argv.includes('--retry-unrecorded');
  const todo = res.rows.filter(
    (r) =>
      !r.ok &&
      RESCUABLE.has(r.category as string) &&
      (!unrecorded || /no recorded response/.test(String((r.rescue as { reason?: string } | undefined)?.reason ?? ''))),
  );
  console.log(`Rescue pass: ${todo.length} site(s) that failed for a page/source reason, retried from the homepage\n`);
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const r = queue.shift()!;
        const site = sites.find((s) => s.name === r.name);
        const start = site?.website || (r.url as string);
        const t0 = Date.now();
        try {
          const out = await forge({ url: start, restaurant: r.name as string, city: site?.city });
          r.rescue = {
            from: start,
            ok: out.ok,
            mode: out.mode ?? null,
            reason: out.ok ? null : out.reason,
            rounds: out.rounds,
            items: out.items?.length ?? 0,
            sourceKind: out.meta?.source.kind ?? null,
            costUsd: Math.round(out.ledger.listCostUsd * 1e5) / 1e5,
            ms: Date.now() - t0,
          };
          console.log(`${String(r.name).slice(0, 34).padEnd(34)} ${out.ok ? `RESCUED (${out.mode}, ${out.meta?.source.kind})` : `still failing: ${out.reason}`}`);
        } catch (e) {
          r.rescue = { from: start, ok: false, reason: (e as Error).message };
        }
      }
    }),
  );

  const n = res.rows.length;
  const okDirect = res.rows.filter((r) => r.ok).length;
  const rescued = res.rows.filter((r) => !r.ok && (r.rescue as { ok?: boolean } | undefined)?.ok).length;
  const byMode: Record<string, number> = {};
  for (const r of res.rows) {
    const m = r.ok ? (r.mode as string) : (r.rescue as { ok?: boolean; mode?: string } | undefined)?.ok ? `${(r.rescue as { mode: string }).mode} (rescue)` : null;
    if (m) byMode[m] = (byMode[m] || 0) + 1;
  }
  const stillFailing: Record<string, number> = {};
  for (const r of res.rows) {
    if (r.ok || (r.rescue as { ok?: boolean } | undefined)?.ok) continue;
    const c = (r.rescue as { reason?: string } | undefined)?.reason ? 'after rescue: ' + String((r.rescue as { reason: string }).reason).split(':')[0] : (r.category as string);
    stillFailing[c] = (stillFailing[c] || 0) + 1;
  }
  res.summary.rescue = {
    attempted: res.rows.filter((r) => r.rescue).length,
    rescued,
    successFromStoredMenuUrl: `${okDirect}/${n} (${Math.round((okDirect / n) * 1000) / 10}%)`,
    successFromHomepageIncludingRescue: `${okDirect + rescued}/${n} (${Math.round(((okDirect + rescued) / n) * 1000) / 10}%)`,
    byMode,
    stillFailing,
  };
  writeFileSync(resultsFile, JSON.stringify(res, null, 2));
  console.log('\n', JSON.stringify(res.summary.rescue, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeBrowser());
