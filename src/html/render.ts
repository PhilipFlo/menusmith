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

let browserPromise: Promise<Browser> | null = null;
async function browser(): Promise<Browser> {
  if (!browserPromise) {
    const p = import('playwright').then(async ({ chromium }) => {
      const b = await chromium.launch({ headless: true });
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

const MAX_JSON = 4 * 1024 * 1024;
const MAX_HTML = 6 * 1024 * 1024;

export async function renderPage(url: string, opts: { timeoutMs?: number } = {}): Promise<Rendered> {
  const t0 = Date.now();
  await assertPublicUrl(url);
  const b = await browser();
  const ctx = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    locale: 'nb-NO',
    viewport: { width: 1280, height: 900 },
  });
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 30_000 });
    if (isBlockedUrlSync(page.url())) throw new Error(`refusing to render a private address (${page.url()})`);
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
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
    await Promise.allSettled(pending);
    let html = await page.content();
    if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
    json.sort((a, b) => b.menuObjects - a.menuObjects);
    if (blocked) emitBlocked(blocked);
    return { url, finalUrl: page.url(), html, json: json.filter((j) => !isBlockedUrlSync(j.url)), ms: Date.now() - t0 };
  } finally {
    await ctx.close().catch(() => {});
  }
}
