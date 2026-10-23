/**
 * Benchmark: run Menusmith end-to-end on real restaurant websites and report
 * success rate, rounds, cost, time, determinism and agreement with an independent
 * reference (nearBite's stored menus).
 *
 *   npx tsx bench/run.ts [--sites bench/private/sites.json] [--limit 40] [--offset 0] [--concurrency 3]
 *
 * Writes bench/results/latest.json (+ a timestamped copy). Results contain per-site
 * METRICS only — no menu content — so they can be committed publicly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { forge } from '../src/agent/pipeline.ts';
import { itemsHash, scoreAgainstOracle } from '../src/agent/evaluate.ts';
import { fetchPage } from '../src/html/fetch.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
import { closeBrowser } from '../src/html/render.ts';
import type { MenuItem } from '../src/types.ts';

interface Site {
  id?: string;
  name: string;
  city?: string;
  platform?: string;
  url: string;
  reference?: MenuItem[];
}

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const sitesFile = resolve(ROOT, arg('--sites', 'bench/private/sites.json')!);
const limit = Number(arg('--limit', '40'));
const offset = Number(arg('--offset', '0'));
const concurrency = Number(arg('--concurrency', '3'));
const tag = arg('--tag', 'latest')!;
const SITE_LIMIT_MS = 8 * 60_000;

/** Map a failure reason to a small taxonomy for the report. */
function category(reason = ''): string {
  if (/HTTP 40[13]|HTTP 429|captcha|cloudflare/i.test(reason)) return 'blocked';
  if (/fetch failed|timed out|ENOTFOUND|ECONN|HTTP 5|HTTP 404/i.test(reason)) return 'unreachable';
  if (/no menu|too few menu items/i.test(reason)) return 'no-html-menu (JS/PDF/image)';
  if (/no passing extractor/i.test(reason)) return 'extractor-not-converged';
  if (/oracle failed|code generation failed/i.test(reason)) return 'llm-error';
  return 'other';
}

async function one(site: Site) {
  const t0 = Date.now();
  const out = await forge({ url: site.url, restaurant: site.name, city: site.city });
  const row: Record<string, unknown> = {
    name: site.name,
    city: site.city,
    platformHint: site.platform,
    url: site.url,
    ok: out.ok,
    mode: out.mode ?? null,
    reason: out.ok ? null : out.reason,
    category: out.ok ? null : category(out.reason),
    rounds: out.rounds,
    ms: Date.now() - t0,
    costUsd: Math.round(out.ledger.listCostUsd * 1e5) / 1e5,
    tokens: out.ledger.promptTokens + out.ledger.completionTokens,
    oracleCount: out.oracleCount,
    extracted: out.items?.length ?? 0,
    f1Oracle: out.bestScore?.f1 ?? null,
    precisionOracle: out.bestScore?.precision ?? null,
    recallOracle: out.bestScore?.recall ?? null,
    pricedRatio: out.bestScore?.pricedRatio ?? null,
    bestExtractorCount: out.bestScore?.extractorCount ?? null,
    ungroundedExtras: out.bestScore?.extra.length ?? null,
    duplicates: out.bestScore?.duplicates ?? null,
    sourceKind: out.meta?.source.kind ?? null,
    platform: out.meta?.platform ?? null,
    id: out.meta?.id ?? null,
  };
  if (out.ok && out.code && out.meta) {
    // Determinism on a FRESH fetch: 3 more runs must give an identical item set.
    try {
      const page = await fetchPage(out.meta.url);
      const hashes = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const r = await runExtractor(out.code, page.html, out.meta.url);
        hashes.add(r.ok ? itemsHash(r.items) : 'error');
      }
      row.deterministic = hashes.size === 1 && !hashes.has('error');
      const rerunT0 = Date.now();
      await runExtractor(out.code, page.html, out.meta.url);
      row.rerunMs = Date.now() - rerunT0;
    } catch {
      row.deterministic = null;
    }
    if (site.reference?.length) {
      // nearBite's reference may span several pages of the site; recall against it is a lower bound.
      const s = scoreAgainstOracle(site.reference, out.items!, '');
      row.f1Reference = s.f1;
      row.precisionReference = s.precision;
      row.recallReference = s.recall;
      row.referenceCount = site.reference.length;
    }
  }
  if (!out.ok && out.code) {
    mkdirSync(resolve(ROOT, '.cache/bench-failures'), { recursive: true });
    writeFileSync(
      resolve(ROOT, '.cache/bench-failures', `${String(site.name).replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.json`),
      JSON.stringify({ url: site.url, reason: out.reason, score: out.bestScore, code: out.code, oracle: out.oracle }, null, 2),
    );
  }
  const mark = out.ok ? `OK  ${out.mode} r${out.rounds} f1=${out.bestScore?.f1}` : `FAIL ${row.category}: ${out.reason}`;
  console.log(`${String(site.name).slice(0, 34).padEnd(34)} ${mark}  $${(row.costUsd as number).toFixed(4)} ${((row.ms as number) / 1000).toFixed(0)}s`);
  return row;
}

function summarise(rows: Record<string, unknown>[]) {
  const ok = rows.filter((r) => r.ok);
  const forgedOk = ok.filter((r) => r.mode === 'forged' || r.mode === 'healed');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const byCat: Record<string, number> = {};
  for (const r of rows.filter((r) => !r.ok)) byCat[r.category as string] = (byCat[r.category as string] || 0) + 1;
  const byPlatform: Record<string, { n: number; ok: number }> = {};
  for (const r of rows) {
    const p = (r.platform as string) || (r.platformHint as string) || 'unknown';
    byPlatform[p] ||= { n: 0, ok: 0 };
    byPlatform[p].n++;
    if (r.ok) byPlatform[p].ok++;
  }
  const reachable = rows.filter((r) => r.ok || !['blocked', 'unreachable', 'no-html-menu (JS/PDF/image)'].includes(r.category as string));
  return {
    sites: rows.length,
    succeeded: ok.length,
    successRate: rows.length ? Math.round((ok.length / rows.length) * 1000) / 10 : 0,
    successRateOnHtmlMenus: reachable.length ? Math.round((ok.length / reachable.length) * 1000) / 10 : 0,
    forged: ok.filter((r) => r.mode === 'forged').length,
    reused: ok.filter((r) => r.mode === 'reused').length,
    // Code metrics only cover extractors the agent WROTE (not reused, PDF or image menus).
    medianRounds: median(forgedOk.map((r) => r.rounds as number)),
    firstTryPassRate: forgedOk.length ? Math.round((forgedOk.filter((r) => r.rounds === 1).length / forgedOk.length) * 1000) / 10 : 0,
    pdfMenus: ok.filter((r) => r.mode === 'document').length,
    imageMenus: ok.filter((r) => r.mode === 'vision').length,
    // Over runs where determinism could be measured (a re-fetch can fail independently).
    deterministicRate: (() => {
      const m = ok.filter((r) => r.deterministic != null);
      return m.length ? Math.round((m.filter((r) => r.deterministic === true).length / m.length) * 1000) / 10 : 0;
    })(),
    deterministicMeasured: `${ok.filter((r) => r.deterministic === true).length}/${ok.filter((r) => r.deterministic != null).length}`,
    avgF1Oracle: Math.round(avg(forgedOk.map((r) => r.f1Oracle as number)) * 1000) / 1000,
    avgPrecisionVsNearBite: Math.round(avg(ok.filter((r) => r.precisionReference != null).map((r) => r.precisionReference as number)) * 1000) / 1000,
    avgRecallVsNearBite: Math.round(avg(ok.filter((r) => r.recallReference != null).map((r) => r.recallReference as number)) * 1000) / 1000,
    avgCostPerSuccessUsd: Math.round(avg(ok.map((r) => r.costUsd as number)) * 1e4) / 1e4,
    totalCostUsd: Math.round(rows.reduce((s, r) => s + (r.costUsd as number), 0) * 1e4) / 1e4,
    medianForgeSeconds: Math.round(median(ok.map((r) => r.ms as number)) / 1000),
    medianRerunMs: median(ok.filter((r) => r.rerunMs != null).map((r) => r.rerunMs as number)),
    failures: byCat,
    byPlatform,
  };
}

async function main() {
  if (!existsSync(sitesFile)) throw new Error(`no sites file at ${sitesFile} (see bench/export-nearbite.mjs or bench/public-sites.json)`);
  const all = JSON.parse(readFileSync(sitesFile, 'utf8')) as Site[];
  const sites = all.slice(offset, offset + limit);
  console.log(`Benchmarking ${sites.length} sites (concurrency ${concurrency})…\n`);
  const rows: Record<string, unknown>[] = [];
  const queue = [...sites];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const s = queue.shift()!;
        try {
          // Watchdog: one pathological site must never stall the whole benchmark.
          let timer: NodeJS.Timeout | undefined;
          const limit = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`site timed out after ${SITE_LIMIT_MS / 60000} min`)), SITE_LIMIT_MS)));
          try {
            rows.push(await Promise.race([one(s), limit]));
          } finally {
            clearTimeout(timer);
          }
        } catch (e) {
          rows.push({ name: s.name, url: s.url, ok: false, reason: (e as Error).message, category: 'other', rounds: 0, costUsd: 0, ms: 0 });
        }
      }
    }),
  );
  // --merge-into <tag>: replace the rows of re-run sites in an existing result file
  // (e.g. sites that failed during a network outage) and recompute the summary.
  const mergeInto = arg('--merge-into');
  if (mergeInto) {
    const f = resolve(ROOT, 'bench/results', `${mergeInto}.json`);
    const prev = JSON.parse(readFileSync(f, 'utf8')) as { runAt: string; rows: Record<string, unknown>[]; summary?: Record<string, unknown> };
    const fresh = new Map(rows.map((r) => [r.name, r]));
    const merged = prev.rows.map((r) => fresh.get(r.name) ?? r);
    const out = {
      runAt: prev.runAt,
      rerunAt: new Date().toISOString(),
      summary: { ...summarise(merged), ...(prev.summary?.rescue ? { rescue: prev.summary.rescue } : {}) },
      rows: merged,
    };
    writeFileSync(f, JSON.stringify(out, null, 2));
    console.log(`\nMerged ${fresh.size} re-run site(s) into ${mergeInto}.json\n`, JSON.stringify(out.summary, null, 2));
    return;
  }
  const result = { runAt: new Date().toISOString(), summary: summarise(rows), rows };
  const dir = resolve(ROOT, 'bench/results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${tag}.json`), JSON.stringify(result, null, 2));
  writeFileSync(resolve(dir, `run-${result.runAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(result, null, 2));
  console.log('\n', JSON.stringify(result.summary, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // The headless browser keeps the event loop alive — close it so the run exits.
  .finally(() => closeBrowser());
