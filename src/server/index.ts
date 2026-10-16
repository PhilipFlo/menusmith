import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config, MODELS, ROOT } from '../config.ts';
import { redesignedFixtures, setFixtureRedesigned } from '../html/fetch.ts';
import { listExtractors, loadExtractor, loadVersion } from '../library/store.ts';
import { forge } from '../agent/pipeline.ts';
import { fleetHistory, runFleet } from '../fleet/fleet.ts';
import type { AgentEvent } from '../types.ts';

const app = new Hono();

// ---- light abuse protection for the public demo -------------------------------
const MAX_CONCURRENT_FORGES = Number(process.env.MENUSMITH_MAX_CONCURRENT || 2);
const FORGES_PER_HOUR = Number(process.env.MENUSMITH_FORGES_PER_HOUR || 12);
let running = 0;
const hits = new Map<string, number[]>();
function allow(ip: string): string | null {
  if (running >= MAX_CONCURRENT_FORGES) return 'The agent is busy with other runs — try again in a minute.';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= FORGES_PER_HOUR) return 'Hourly limit reached for this demo.';
  recent.push(now);
  hits.set(ip, recent);
  return null;
}
const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';

// ---- API ------------------------------------------------------------------------
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    llmMode: config.llmMode,
    nebius: !!config.nebiusApiKey,
    tavily: !!config.tavilyApiKey,
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
    const send = (e: AgentEvent) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    try {
      const out = await forge({ url: body.url, restaurant: body.restaurant, city: body.city, noReuse: body.noReuse }, send);
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
        }),
      });
    } catch (e) {
      await send({ type: 'error', message: (e as Error).message });
    } finally {
      running--;
    }
  });
});

app.get('/api/library', (c) => c.json(listExtractors().map((x) => x.meta)));

app.get('/api/library/:id', (c) => {
  const x = loadExtractor(c.req.param('id'));
  if (!x) return c.json({ error: 'not found' }, 404);
  const versions = Array.from({ length: x.meta.version }, (_, i) => ({ version: i + 1, code: loadVersion(x.meta.id, i + 1) }));
  const snapFile = resolve(config.libraryDir, 'snapshots', `${x.meta.id}.json`);
  const items = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : null;
  return c.json({ meta: x.meta, code: x.code, versions, items });
});

let fleetRunning = false;
app.post('/api/fleet/run', async (c) => {
  if (fleetRunning) return c.json({ error: 'a fleet run is already in progress' }, 409);
  const body = (await c.req.json().catch(() => ({}))) as { heal?: boolean; only?: string[] };
  fleetRunning = true;
  return streamSSE(c, async (stream) => {
    const send = (e: AgentEvent) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {});
    try {
      const report = await runFleet({ heal: body.heal !== false, only: body.only }, send);
      await stream.writeSSE({ event: 'report', data: JSON.stringify(report) });
    } catch (e) {
      await send({ type: 'error', message: (e as Error).message });
    } finally {
      fleetRunning = false;
    }
  });
});

app.get('/api/fleet/history', (c) => c.json(fleetHistory(50)));

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
  const body = (await c.req.json().catch(() => ({}))) as { on?: boolean };
  return c.json({ redesigned: setFixtureRedesigned(c.req.param('slug'), body.on !== false) });
});

app.get('/api/bench', (c) => {
  const f = resolve(ROOT, 'bench/results/latest.json');
  return existsSync(f) ? c.json(JSON.parse(readFileSync(f, 'utf8'))) : c.json(null);
});

// ---- static web app ---------------------------------------------------------------
const dist = resolve(ROOT, 'web/dist');
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: 'web/dist' }));
  app.get('*', (c) => c.html(readFileSync(resolve(dist, 'index.html'), 'utf8')));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Menusmith API on http://localhost:${info.port}  (LLM mode: ${config.llmMode}, Nebius key: ${config.nebiusApiKey ? 'yes' : 'NO'}, Tavily key: ${config.tavilyApiKey ? 'yes' : 'NO'})`);
});
