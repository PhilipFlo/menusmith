import type { Browser } from 'playwright';
import { assertPublicUrl, isBlockedUrlSync } from './netguard.ts';

/**
 * Headless-browser rendering for JavaScript-built menus.
 *
 * About half of real restaurant sites (hosted ordering systems, SPA builders)
 * ship an empty HTML shell and load the menu as JSON from an API. Rendering gives
 * us two things:
 *   1. the rendered DOM (for HTML extractors), and
 *   2. the JSON responses the page fetched — often the menu itself, in clean
 *      structured form. An extractor over that JSON is far more stable than one
 *      over HTML, and re-runs can fetch the JSON directly, without a browser.
 */

export interface CapturedJson {
  url: string;
  method: string;
  postData: string | null;
  requestHeaders: Record<string, string>;
  status: number;
  body: string;
  /** How many objects look like {name…, price…} — the menu-likeness score. */
  menuObjects: number;
}

export interface Rendered {
  url: string;
  finalUrl: string;
  html: string;
  json: CapturedJson[];
  ms: number;
}

/**
 * Low-memory mode for small hosts (MENUSMITH_RENDER_LOWMEM=1, e.g. Render free: 512 MB):
 * one render at a time, Chromium flags that keep it small, and the browser is closed after
 * every render so nothing stays resident between visitors.
 */
const LOWMEM = process.env.MENUSMITH_RENDER_LOWMEM === '1';
const LOWMEM_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=160',
];
let renderQueue: Promise<unknown> = Promise.resolve();

let browserPromise: Promise<Browser> | null = null;
async function browser(): Promise<Browser> {
  if (!browserPromise) {
    const p = import('playwright').then(async ({ chromium }) => {
      const b = await chromium.launch({ headless: true, args: LOWMEM ? LOWMEM_ARGS : [] });
      // A crashed or closed browser must not poison every later render.
      b.on('disconnected', () => {
        if (browserPromise === p) browserPromise = null;
      });
      return b;
    });
    browserPromise = p;
    p.catch(() => {
      if (browserPromise === p) browserPromise = null;
    });
  }
  return browserPromise;
}

function emitBlocked(u: string) {
  console.warn(`[render] blocked a request to a private address: ${u.slice(0, 120)}`);
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    await b?.close().catch(() => {});
  }
}

const NAME_KEY = /^(name|title|navn|label|productname|product_name|itemname|item_name|dish|displayname|display_name)$/i;
const PRICE_KEY = /^(price|pris|amount|cost|unitprice|unit_price|baseprice|base_price|price_amount|priceamount|grossprice|displayprice|display_price|pricewithvat|price_incl_vat)$/i;

/** Count objects that look like menu items (have a name-ish and a price-ish field). */
export function countMenuObjects(value: unknown, depth = 0): number {
  if (depth > 12 || value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((s: number, v) => s + countMenuObjects(v, depth + 1), 0);
  const obj = value as Record<string, unknown>;
  let hasName = false;
  let hasPrice = false;
  for (const [k, v] of Object.entries(obj)) {
    if (NAME_KEY.test(k) && typeof v === 'string' && v.trim()) hasName = true;
    if (PRICE_KEY.test(k) && (typeof v === 'number' || (typeof v === 'string' && /\d/.test(v)) || (v && typeof v === 'object'))) hasPrice = true;
  }
  let n = hasName && hasPrice ? 1 : 0;
  for (const v of Object.values(obj)) n += countMenuObjects(v, depth + 1);
  return n;
}

function localeFor(url: string): string {
  try {
    const tld = new URL(url).hostname.split('.').pop()!.toLowerCase();
    return ({ no: 'nb-NO', se: 'sv-SE', dk: 'da-DK', fi: 'fi-FI', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', uk: 'en-GB' } as Record<string, string>)[tld] ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

/** Third-party scripts that never carry a menu but cost CPU (analytics, ads, chat widgets). */
const TRACKERS =
  /(googletagmanager|google-analytics|googleadservices|doubleclick|facebook\.net|connect\.facebook|hotjar|clarity\.ms|segment\.(io|com)|mixpanel|intercom|crisp\.chat|tiktok|snap\.licdn|bat\.bing|cookiebot|onetrust|trustarc|sentry\.io|newrelic|nr-data)/i;

const MAX_JSON = 4 * 1024 * 1024;
const MAX_HTML = 6 * 1024 * 1024;
// A 0.1-CPU host needs ~20 s just to load a React bundle — give small hosts more time.
const RENDER_LIMIT_MS = LOWMEM ? 240_000 : 90_000;

export async function renderPage(url: string, opts: { timeoutMs?: number } = {}): Promise<Rendered> {
  if (!LOWMEM) return renderOnce(url, opts);
  const turn = renderQueue.then(() => renderOnce(url, opts)).finally(() => closeBrowser());
  renderQueue = turn.catch(() => {});
  return turn;
}

async function renderOnce(url: string, opts: { timeoutMs?: number }): Promise<Rendered> {
  const t0 = Date.now();
  await assertPublicUrl(url);
  const b = await browser();
  const ctx = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    // Present as a local visitor: Nordic sites in their language, everything else as en-US.
    locale: localeFor(url),
    viewport: LOWMEM ? { width: 1024, height: 768 } : { width: 1280, height: 900 },
  });
  // Hard ceiling for the whole render: closing the context makes every pending page
  // operation reject, so nothing here can hang a caller indefinitely.
  const watchdog = setTimeout(() => void ctx.close().catch(() => {}), Math.max(RENDER_LIMIT_MS, (opts.timeoutMs ?? 0) + 30_000));
  try {
    const page = await ctx.newPage();
    let blocked: string | null = null;
    // Redirects are followed by the browser itself; catch any hop that lands somewhere private.
    page.on('request', (req) => {
      if (!blocked && isBlockedUrlSync(req.url())) blocked = req.url();
    });
    await page.route('**/*', (route) => {
      const req = route.request();
      const t = req.resourceType();
      // Never let the page reach private/internal addresses (SSRF), nor download heavy media.
      if (isBlockedUrlSync(req.url())) return route.abort('blockedbyclient');
      if (TRACKERS.test(req.url())) return route.abort();
      return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
    });
    const json: CapturedJson[] = [];
    const pending: Promise<void>[] = [];
    page.on('response', (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      pending.push(
        (async () => {
          try {
            const ct = res.headers()['content-type'] || '';
            if (!/json/i.test(ct) && !/\.json(\?|$)/i.test(res.url())) return;
            const body = await res.text();
            if (body.length > MAX_JSON || body.length < 20) return;
            const parsed = JSON.parse(body);
            const menuObjects = countMenuObjects(parsed);
            if (menuObjects < 3) return;
            const h = req.headers();
            const keep: Record<string, string> = {};
            for (const k of ['accept', 'content-type', 'x-requested-with', 'accept-language']) if (h[k]) keep[k] = h[k]!;
            json.push({ url: res.url(), method: req.method(), postData: req.postData(), requestHeaders: keep, status: res.status(), body, menuObjects });
          } catch {
            /* not JSON / body unavailable */
          }
        })(),
      );
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? (LOWMEM ? 90_000 : 30_000) });
    if (isBlockedUrlSync(page.url())) throw new Error(`refusing to render a private address (${page.url()})`);
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    // On a slow CPU the app may still be executing after the network went quiet: wait until
    // price-like text has appeared and stopped growing (bounded), instead of guessing a delay.
    await page
      .waitForFunction(
        () => {
          const w = window as unknown as { __ms?: { n: number; same: number } };
          // textContent, not innerText: innerText forces a layout pass, which is costly on a slow CPU.
          const n = (document.body?.textContent?.match(/\d{1,4}(?:[.,]\d{1,2})?\s?(?:,-|kr|nok|\$|€|£)|(?:kr|nok|\$|€|£)\s?\d{1,4}/gi) || []).length;
          const prev = w.__ms ?? { n: -1, same: 0 };
          w.__ms = { n, same: n === prev.n ? prev.same + 1 : 0 };
          return n >= 3 && w.__ms.same >= 2; // prices present and stable for ~2 polls
        },
        undefined,
        { timeout: LOWMEM ? 60_000 : 15_000, polling: LOWMEM ? 2500 : 1000 },
      )
      .catch(() => {});
    // Trigger lazy-loaded sections.
    await page
      .evaluate(async () => {
        for (let i = 0; i < 8; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise((r) => setTimeout(r, 250));
        }
      })
      .catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    // Response bodies of long-lived requests (SSE, long-polling) never complete —
    // never wait more than a few seconds for captured bodies.
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 5000))]);
    // Free-positioned pages (Canva-style sites: every text box placed by a CSS transform) carry
    // no structure linking a dish to its price — only the layout does. Record each text box's
    // position so the reader and the code can rebuild rows (bounded; skipped on normal pages).
    await page
      .evaluate(() => {
        const all = Array.from(document.body?.querySelectorAll('*') ?? []).slice(0, 30_000) as HTMLElement[];
        let positioned = 0;
        for (const el of all) {
          const st = el.style;
          if (st && (st.transform.includes('translate') || st.position === 'absolute')) positioned++;
        }
        if (positioned < 30) return;
        let n = 0;
        for (const el of all) {
          if (n >= 5000) break;
          const own = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent || '').trim());
          if (!own) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          el.setAttribute('data-ms-xy', `${Math.round(r.left + window.scrollX)},${Math.round(r.top + window.scrollY)}`);
          n++;
        }
      })
      .catch(() => {});
    let html = await page.content();
    if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
    json.sort((a, b) => b.menuObjects - a.menuObjects);
    if (blocked) emitBlocked(blocked);
    return { url, finalUrl: page.url(), html, json: json.filter((j) => !isBlockedUrlSync(j.url)), ms: Date.now() - t0 };
  } finally {
    clearTimeout(watchdog);
    await ctx.close().catch(() => {});
  }
}

/**
 * Render the first pages of a PDF to PNG images in the headless browser (pdf.js), so a vision
 * model can read designed or scanned menus whose text layer is unusable. The PDF bytes are
 * handed to an isolated blank page; nothing is fetched from the network.
 */
export async function renderPdfPages(bytes: Uint8Array, opts: { maxPages?: number; scale?: number } = {}): Promise<Buffer[]> {
  const run = async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const lib = readFileSync(req.resolve('pdfjs-dist/build/pdf.min.mjs'), 'utf8');
    const worker = readFileSync(req.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8');
    const b = await browser();
    const ctx = await b.newContext({ viewport: { width: 800, height: 600 } });
    const watchdog = setTimeout(() => void ctx.close().catch(() => {}), RENDER_LIMIT_MS);
    try {
      const page = await ctx.newPage();
      // Serve pdf.js from a fake local origin; block everything else.
      await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u === 'https://menusmith.local/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
        if (u === 'https://menusmith.local/pdf.mjs') return route.fulfill({ contentType: 'text/javascript', body: lib });
        if (u === 'https://menusmith.local/pdf.worker.mjs') return route.fulfill({ contentType: 'text/javascript', body: worker });
        return route.abort();
      });
      await page.goto('https://menusmith.local/');
      const pngs = (await page.evaluate(
        async ({ b64, maxPages, scale }) => {
          const pdfjs = await import('https://menusmith.local/pdf.mjs' as string);
          pdfjs.GlobalWorkerOptions.workerSrc = 'https://menusmith.local/pdf.worker.mjs';
          const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: false }).promise;
          const out: string[] = [];
          for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
            const pg = await doc.getPage(p);
            const vp = pg.getViewport({ scale });
            // Keep images within what the vision model reads well.
            const k = Math.min(1, 2000 / Math.max(vp.width, vp.height));
            const v = pg.getViewport({ scale: scale * k });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(v.width);
            canvas.height = Math.ceil(v.height);
            await pg.render({ canvasContext: canvas.getContext('2d')!, viewport: v }).promise;
            out.push(canvas.toDataURL('image/png').split(',')[1]!);
          }
          await doc.destroy();
          return out;
        },
        { b64: Buffer.from(bytes).toString('base64'), maxPages: opts.maxPages ?? 4, scale: opts.scale ?? 2 },
      )) as string[];
      return pngs.map((s) => Buffer.from(s, 'base64'));
    } finally {
      clearTimeout(watchdog);
      await ctx.close().catch(() => {});
    }
  };
  if (!LOWMEM) return run();
  const turn = renderQueue.then(run).finally(() => closeBrowser());
  renderQueue = turn.catch(() => {});
  return turn;
}
