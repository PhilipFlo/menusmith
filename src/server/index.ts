import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config, MODELS, ROOT } from '../config.ts';
import { redesignedFixtures, setFixtureRedesigned } from '../html/fetch.ts';
import { listExtractors, loadExtractor, loadSnapshot, loadVersion } from '../library/store.ts';
import { forge } from '../agent/pipeline.ts';
import { CheckError, checkExtractor, fleetHistory, runFleet } from '../fleet/fleet.ts';
import type { AgentEvent } from '../types.ts';
import { Ledger } from '../llm/client.ts';
import { flush, hydrate, refresh, storeEnabled, writePersisted } from '../library/persist.ts';

const app = new Hono();

// ---- light abuse protection for the public demo -------------------------------
const MAX_CONCURRENT_FORGES = Number(process.env.MENUSMITH_MAX_CONCURRENT || 2);
const FORGES_PER_HOUR = Number(process.env.MENUSMITH_FORGES_PER_HOUR || 12);
// Daily model-spend cap so a public demo can't drain the Token Factory credit.
const DAILY_BUDGET_USD = Number(process.env.MENUSMITH_DAILY_BUDGET_USD || 3);
/** Ceiling for a single forge — a normal one costs cents. */
const PER_FORGE_USD = Number(process.env.MENUSMITH_MAX_JOB_USD || 0.5);
// Persisted under the library folder (and so in the durable store) — a free host that
// sleeps and restarts must not get a fresh daily budget on every wake-up.
const spendFile = () => resolve(config.libraryDir, 'state', 'daily-spend.json');
const spend = { day: new Date().toISOString().slice(0, 10), usd: 0 };
function loadSpend() {
  try {
    const v = JSON.parse(readFileSync(spendFile(), 'utf8')) as { day: string; usd: number };
    if (v.day === spend.day && Number.isFinite(v.usd)) spend.usd = v.usd;
  } catch {
    /* none yet */
  }
}
function addSpend(usd: number) {
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) Object.assign(spend, { day: today, usd: 0 });
  spend.usd += usd;
  if (usd > 0) writePersisted(spendFile(), JSON.stringify(spend));
}
function budgetLeft(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) Object.assign(spend, { day: today, usd: 0 });
  return DAILY_BUDGET_USD - spend.usd;
}

let running = 0;
const hits = new Map<string, number[]>();
function allow(ip: string): string | null {
  if (budgetLeft() <= 0) return `Today's model budget for this public demo ($${DAILY_BUDGET_USD}) is used up — browse the Library and Fleet, or run Menusmith locally with your own key.`;
  if (running >= MAX_CONCURRENT_FORGES) return 'The agent is busy with other runs — try again in a minute.';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= FORGES_PER_HOUR) return 'Hourly limit reached for this demo.';
  recent.push(now);
  hits.set(ip, recent);
  return null;
}
/**
 * The client address. Behind a reverse proxy the RIGHTMOST X-Forwarded-For entry is
 * the one the proxy appended (earlier entries are client-controlled and spoofable).
 */
const TRUST_PROXY = process.env.MENUSMITH_TRUST_PROXY !== '0';
function clientIp(c: { req: { header: (n: string) => string | undefined }; env: unknown }): string {
  const xff = c.req.header('x-forwarded-for');
  if (TRUST_PROXY && xff) return xff.split(',').pop()!.trim();
  const sock = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress;
  return sock || 'local';
}
// Forget idle clients so the limiter's memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of hits) if (!ts.some((t) => now - t < 3_600_000)) hits.delete(ip);
}, 600_000).unref();

// ---- API ------------------------------------------------------------------------
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    llmMode: config.llmMode,
    commit: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7) || undefined,
    nebius: !!config.nebiusApiKey,
    tavily: !!config.tavilyApiKey,
    browser: process.env.MENUSMITH_RENDER !== 'off',
    slowBrowser: process.env.MENUSMITH_RENDER_LOWMEM === '1' || undefined,
    store: storeEnabled(),
    budget: { dailyUsd: DAILY_BUDGET_USD, leftUsd: Math.max(0, Math.round(budgetLeft() * 100) / 100) },
    models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v[0]])),
  }),
);

app.post('/api/forge', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string; restaurant?: string; city?: string; noReuse?: boolean };
  if (!body.url && !body.restaurant) return c.json({ error: 'url or restaurant required' }, 400);
  if (body.url && !/^(https?:\/\/|fixture:\/\/)/i.test(body.url)) return c.json({ error: 'URL must start with http(s)://' }, 400);
  const denied = allow(clientIp(c));
  if (denied) return c.json({ error: denied }, 429);
  running++;
  return streamSSE(c, async (stream) => {
    await refresh(0); // pick up versions another writer (the nightly fleet) committed
    const send = (e: AgentEvent) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    // The ledger is owned here so spend is recorded even if the run throws, and the
    // run stops making model calls if the visitor closes the page.
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    const ledger = new Ledger(Math.min(PER_FORGE_USD, Math.max(0, budgetLeft())), abort.signal);
    try {
      const out = await forge({ url: body.url, restaurant: body.restaurant, city: body.city, noReuse: body.noReuse, ledger }, send);
      await stream.writeSSE({
        event: 'summary',
        data: JSON.stringify({
          ok: out.ok,
          reason: out.reason,
          mode: out.mode,
          rounds: out.rounds,
          ms: out.ms,
          costUsd: out.ledger.costUsd,
          tokens: out.ledger.promptTokens + out.ledger.completionTokens,
          byModel: out.ledger.byModel,
          id: out.meta?.id,
          version: out.meta?.version,
          items: out.items?.length ?? 0,
        }),
      });
    } catch (e) {
      await send({ type: 'error', message: (e as Error).message });
    } finally {
      addSpend(ledger.costUsd);
      running--;
    }
  });
});

app.get('/api/library', async (c) => {
  await refresh();
  return c.json(listExtractors().map((x) => x.meta));
});

const ID_RE = /^[a-z0-9-]{1,80}$/;
app.get('/api/library/:id', async (c) => {
  if (!ID_RE.test(c.req.param('id'))) return c.json({ error: 'bad id' }, 400);
  await refresh();
  const x = loadExtractor(c.req.param('id'));
  if (!x) return c.json({ error: 'not found' }, 404);
  const versions = Array.from({ length: x.meta.version }, (_, i) => ({ version: i + 1, code: loadVersion(x.meta.id, i + 1) }));
  const snapFile = resolve(config.libraryDir, 'snapshots', `${x.meta.id}.json`);
  const items = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : null;
  return c.json({ meta: x.meta, code: x.code, versions, items });
});

// ---- single-extractor checks ------------------------------------------------------
const lastCheck = new Map<string, number>();
const busyIds = new Set<string>();
let rescrapes = 0; // each one may start a sandbox (+ a browser for rendered sites) — keep it small
const known = (id: string) => listExtractors().find((x) => x.meta.id === id);

/** "Re-scrape now": run the stored code against the live page — no model, $0. */
app.post('/api/library/:id/rescrape', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'bad id' }, 400);
  const ip = clientIp(c);
  const recent = (hits.get(`rescrape:${ip}`) || []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 40) return c.json({ error: 'Too many re-scrapes from this address — try again later.' }, 429);
  if (busyIds.has(id) || fleetRunning) return c.json({ error: 'This extractor is being checked right now.' }, 409);
  if (rescrapes >= 2) return c.json({ error: 'Other re-scrapes are running — try again in a few seconds.' }, 429);
  if (!known(id)) return c.json({ error: 'not found' }, 404);
  hits.set(`rescrape:${ip}`, [...recent, Date.now()]);
  busyIds.add(id);
  rescrapes++;
  try {
    await refresh();
    const entry = await checkExtractor(id, { heal: false, audit: 'never' });
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json({ entry, items: loadSnapshot(id) ?? [] });
  } finally {
    rescrapes--;
    busyIds.delete(id);
  }
});

/**
 * "Check against Nemotron": re-scrape, then compare with a fresh model reading of the
 * page (~$0.003). Dishes still on the page but missing from the output trigger a
 * self-heal when the daily budget allows; otherwise they're reported for review.
 */
app.post('/api/library/:id/audit', async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return c.json({ error: 'bad id' }, 400);
  const denied = allow(clientIp(c));
  if (denied) return c.json({ error: denied }, 429);
  if (Date.now() - (lastCheck.get(id) || 0) < 120_000) return c.json({ error: 'This extractor was checked less than 2 minutes ago.' }, 429);
  if (busyIds.has(id) || fleetRunning) return c.json({ error: 'This extractor is being checked right now.' }, 409);
  const x = known(id);
  if (!x) return c.json({ error: 'not found' }, 404);
  if (budgetLeft() <= 0.01) return c.json({ error: "Today's model budget for the public demo is used up — try again tomorrow." }, 429);
  lastCheck.set(id, Date.now());
  busyIds.add(id);
  running++;
  try {
    await refresh();
    const maxUsd = Math.min(PER_FORGE_USD, Math.max(0, budgetLeft()));
    // Visitors may check any menu, but only rewrite the demo fixtures — real restaurants'
    // extractors are only rewritten by the admin or the nightly fleet.
    const mayHeal = maxUsd > 0.05 && (isAdmin(c) || x.meta.url.startsWith('fixture://'));
    const entry = await checkExtractor(id, { heal: mayHeal, audit: 'force', maxUsd });
    if (!entry) return c.json({ error: 'not found' }, 404);
    addSpend(entry.costUsd);
    return c.json({ entry, items: loadSnapshot(id) ?? [] });
  } catch (e) {
    if (e instanceof CheckError) addSpend(e.costUsd);
    throw e;
  } finally {
    running--;
    busyIds.delete(id);
  }
});

let fleetRunning = false;
let lastPublicFleet = 0;
const ADMIN_TOKEN = process.env.MENUSMITH_ADMIN_TOKEN || '';
const isAdmin = (c: { req: { header: (n: string) => string | undefined } }) =>
  !!ADMIN_TOKEN && c.req.header('authorization') === `Bearer ${ADMIN_TOKEN}`;

app.post('/api/fleet/run', async (c) => {
  if (fleetRunning) return c.json({ error: 'a fleet run is already in progress' }, 409);
  const body = (await c.req.json().catch(() => ({}))) as { heal?: boolean; only?: string[] };
  const ip = clientIp(c);
  const local = ip === 'local' || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const admin = isAdmin(c) || (!ADMIN_TOKEN && local);
  // Public visitors may run the fleet over the demo (fixture) extractors only, at most
  // once every 3 minutes; healing is paid from the daily budget like any forge.
  let only = Array.isArray(body.only) ? body.only.filter((x) => typeof x === 'string' && ID_RE.test(x)) : undefined;
  if (!admin) {
    if (Date.now() - lastPublicFleet < 180_000) return c.json({ error: 'The demo fleet ran less than 3 minutes ago — try again shortly.' }, 429);
    const demo = listExtractors().filter((x) => x.meta.url.startsWith('fixture://')).map((x) => x.meta.id);
    only = only?.length ? only.filter((x) => demo.includes(x)) : demo;
    if (!only.length) return c.json({ error: 'nothing to run: the public fleet only covers the demo restaurants' }, 400);
    lastPublicFleet = Date.now();
  }
  fleetRunning = true;
  return streamSSE(c, async (stream) => {
    await refresh(0);
    const send = (e: AgentEvent) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    try {
      const report = await runFleet({ heal: body.heal !== false && budgetLeft() > 0, only, maxUsd: Math.max(0, budgetLeft()) }, send);
      addSpend(report.totals.costUsd);
      await stream.writeSSE({ event: 'report', data: JSON.stringify(report) });
    } catch (e) {
      await send({ type: 'error', message: (e as Error).message });
    } finally {
      fleetRunning = false;
    }
  });
});

app.get('/api/fleet/history', async (c) => {
  await refresh();
  return c.json(fleetHistory(50));
});

app.get('/api/fixtures', (c) => {
  const dir = resolve(ROOT, 'fixtures/sites');
  const redesigned = redesignedFixtures();
  const sites = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          let exp: { restaurant?: string; platform?: string; items?: unknown[] } = {};
          try {
            exp = JSON.parse(readFileSync(resolve(dir, d.name, 'expected.json'), 'utf8'));
          } catch {
            /* optional */
          }
          return { slug: d.name, url: `fixture://${d.name}/`, restaurant: exp.restaurant, platform: exp.platform, items: exp.items?.length ?? null, redesigned: redesigned.includes(d.name) };
        })
    : [];
  return c.json(sites);
});

app.post('/api/fixtures/:slug/redesign', async (c) => {
  const slug = c.req.param('slug');
  if (!/^[a-z0-9-]{1,60}$/.test(slug) || !existsSync(resolve(ROOT, 'fixtures/sites', slug, 'redesign.html')))
    return c.json({ error: 'unknown demo site' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  return c.json({ redesigned: setFixtureRedesigned(slug, body.on !== false) });
});

app.get('/api/bench', (c) => {
  const f = resolve(ROOT, 'bench/results/latest.json');
  return existsSync(f) ? c.json(JSON.parse(readFileSync(f, 'utf8'))) : c.json(null);
});

/** Summaries of the focused benchmarks (self-heal, LLM noise, Tavily, precision). */
app.get('/api/bench/measured', (c) => {
  const summary = (name: string) => {
    const f = resolve(ROOT, 'bench/results', `${name}.json`);
    try {
      return existsSync(f) ? ((JSON.parse(readFileSync(f, 'utf8')) as { summary?: unknown }).summary ?? null) : null;
    } catch {
      return null;
    }
  };
  return c.json({ heal: summary('heal'), variance: summary('variance'), varianceT0: summary('variance-t0'), tavily: summary('tavily'), tavilyHoldout: summary('tavily-holdout'), precision: summary('precision'), coverage: summary('coverage'), falseAlarms: summary('false-alarms') });
});

// ---- static web app ---------------------------------------------------------------
// Checked per request, so a build made after the server started is picked up.
const dist = resolve(ROOT, 'web/dist');
app.use('/*', serveStatic({ root: relative(process.cwd(), dist) || '.' }));
app.get('*', (c) =>
  existsSync(resolve(dist, 'index.html'))
    ? c.html(readFileSync(resolve(dist, 'index.html'), 'utf8'))
    : c.text('Web app not built yet — run `npm run build`, or use `npm run dev` for the dev server.', 404),
);

// On a fresh shared volume (Nebius deployment), seed the library from the image.
const shippedLibrary = resolve(ROOT, 'library');
if (config.libraryDir !== shippedLibrary && existsSync(shippedLibrary) && !existsSync(resolve(config.libraryDir, 'extractors'))) {
  cpSync(shippedLibrary, config.libraryDir, { recursive: true });
  console.log(`Seeded library at ${config.libraryDir} from the image`);
}

// Durable store (ephemeral hosts): restore the library before serving.
try {
  const h = await hydrate();
  if (storeEnabled()) console.log(`Store: restored ${h.restored} file(s)${h.seeded ? `, seeded ${h.seeded} from the image` : ''}`);
} catch (e) {
  console.warn(`Store unavailable, continuing with local files: ${(e as Error).message}`);
}

loadSpend();

// Render/containers send SIGTERM before stopping: finish uploads to the durable store.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void flush().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Menusmith API on http://localhost:${info.port}  (LLM mode: ${config.llmMode}, Nebius key: ${config.nebiusApiKey ? 'yes' : 'NO'}, Tavily key: ${config.tavilyApiKey ? 'yes' : 'NO'})`);
});
