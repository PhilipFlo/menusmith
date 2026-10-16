import type { Browser } from 'playwright';

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
    browserPromise = import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
    browserPromise.catch(() => (browserPromise = null));
  }
  return browserPromise;
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

export async function renderPage(url: string, opts: { timeoutMs?: number } = {}): Promise<Rendered> {
  const t0 = Date.now();
  const b = await browser();
  const ctx = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    locale: 'nb-NO',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
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
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 30_000 });
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
    const html = await page.content();
    json.sort((a, b) => b.menuObjects - a.menuObjects);
    return { url, finalUrl: page.url(), html, json, ms: Date.now() - t0 };
  } finally {
    await ctx.close().catch(() => {});
  }
}
