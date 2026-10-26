import { fetchPage, type Page } from '../html/fetch.ts';
import { renderPage, type CapturedJson } from '../html/render.ts';
import { safeFetch } from '../html/netguard.ts';
import { pageText } from '../html/simplify.ts';
import type { Emit, SourceKind, SourceRequest } from '../types.ts';
import { menuLinks, priceDensity } from './discover.ts';
import { findMenuImages } from './vision.ts';
import { menuPdfLinks } from './document.ts';
import * as cheerio from 'cheerio';

/**
 * ACQUIRE: get the menu in the most stable form the site offers.
 *
 *   html     — the server-rendered page has the menu (cheapest: plain HTTP GET)
 *   json     — the page loads the menu as JSON from an API; we capture that request
 *              and replay it directly on re-runs (stable, structured, no browser)
 *   rendered — the menu only exists after JavaScript runs; re-runs need a browser
 */

export interface Acquired {
  kind: SourceKind;
  /** The page the customer sees. */
  url: string;
  /** What the extractor consumes: HTML for html/rendered, a JSON string for json. */
  payload: string;
  /** Visible page HTML (static or rendered) — for platform detection and the skeleton. */
  html: string;
  /** Visible page text — what the oracle reads and what grounds the scores. */
  text: string;
  request?: SourceRequest;
  note: string;
}

const STATIC_OK = 10;

function pickJson(json: CapturedJson[], domPrices: number): CapturedJson | null {
  const best = json[0];
  if (!best || best.menuObjects < 8) return null;
  // Prefer the API when it carries at least as much of the menu as the rendered page shows.
  return best.menuObjects >= Math.min(domPrices, 20) * 0.8 ? best : null;
}

export async function acquire(start: Page, emit: Emit, opts: { allowRender?: boolean } = {}): Promise<Acquired> {
  const staticDensity = priceDensity(start.html);
  const staticText = pageText(start.html);
  if (staticDensity >= STATIC_OK) {
    return { kind: 'html', url: start.finalUrl, payload: start.html, html: start.html, text: staticText, note: `server-rendered HTML (${staticDensity} prices)` };
  }
  const renderAllowed = opts.allowRender !== false && process.env.MENUSMITH_RENDER !== 'off';
  if (!renderAllowed || !/^https?:/i.test(start.finalUrl)) {
    // No browser available (e.g. a small free-tier host): PDF and image menus linked
    // from the plain HTML can still be read.
    if (staticDensity < 5 && /^https?:/i.test(start.finalUrl)) {
      const pdfs = menuPdfLinks(start.html, start.finalUrl, cheerio);
      if (pdfs.length)
        return { kind: 'document', url: start.finalUrl, payload: pdfs[0]!, html: start.html, text: staticText, request: { url: pdfs[0]!, method: 'GET' }, note: `PDF menu ${pdfs[0]}` };
      const imgs = findMenuImages(start.html, start.finalUrl);
      if (imgs.length)
        return {
          kind: 'image',
          url: start.finalUrl,
          payload: JSON.stringify(imgs),
          html: start.html,
          text: staticText,
          request: { url: start.finalUrl, method: 'GET', images: imgs.map((u) => ({ url: u, sha256: '' })) },
          note: `menu images: ${imgs.map((u) => u.split('/').pop()).join(', ')}`,
        };
    }
    return {
      kind: 'html',
      url: start.finalUrl,
      payload: start.html,
      html: start.html,
      text: staticText,
      note: renderAllowed ? `static HTML only (${staticDensity} prices)` : `static HTML only (${staticDensity} prices; headless browser disabled on this host)`,
    };
  }

  emit({ type: 'step', step: 'render', status: 'start', detail: 'Menu not in the HTML — rendering with a headless browser and watching its API calls' });
  let r = await renderPage(start.finalUrl);
  let domPrices = priceDensity(r.html);
  // The rendered page may still only link to the menu.
  if (domPrices < STATIC_OK && !r.json.length) {
    // Each render costs minutes on a 0.1-CPU host: follow only the best link there.
    for (const l of menuLinks(r.html, r.finalUrl).slice(0, process.env.MENUSMITH_RENDER_LOWMEM === '1' ? 1 : 3)) {
      const r2 = await renderPage(l.url).catch(() => null);
      if (!r2) continue;
      const d2 = priceDensity(r2.html);
      if (d2 > domPrices || r2.json.length) {
        r = r2;
        domPrices = d2;
        if (d2 >= STATIC_OK || r2.json.length) break;
      }
    }
  }
  const text = pageText(r.html);
  const j = pickJson(r.json, domPrices);
  if (j) {
    emit({ type: 'step', step: 'render', status: 'done', detail: `Found the menu API: ${j.method} ${j.url.slice(0, 90)} (${j.menuObjects} menu objects)` });
    return {
      kind: 'json',
      url: r.finalUrl,
      payload: j.body,
      html: r.html,
      text,
      request: { url: j.url, method: j.method, body: j.postData, headers: j.requestHeaders },
      note: `menu API ${j.method} ${new URL(j.url).hostname}${new URL(j.url).pathname} (${j.menuObjects} objects)`,
    };
  }
  // No text menu and no menu API — maybe the menu is a PDF or published as pictures.
  if (domPrices < 5) {
    const pdfs = [...new Set([...menuPdfLinks(r.html, r.finalUrl, cheerio), ...menuPdfLinks(start.html, start.finalUrl, cheerio)])];
    if (pdfs.length) {
      emit({ type: 'step', step: 'render', status: 'done', detail: `The menu is a PDF: ${pdfs[0]!.split('/').pop()}` });
      return { kind: 'document', url: r.finalUrl, payload: pdfs[0]!, html: r.html, text, request: { url: pdfs[0]!, method: 'GET' }, note: `PDF menu ${pdfs[0]}` };
    }
  }
  if (domPrices < 5) {
    const imgs = findMenuImages(r.html, r.finalUrl);
    if (imgs.length) {
      emit({ type: 'step', step: 'render', status: 'done', detail: `The menu is published as ${imgs.length} image(s)` });
      return {
        kind: 'image',
        url: r.finalUrl,
        payload: JSON.stringify(imgs),
        html: r.html,
        text,
        request: { url: r.finalUrl, method: 'GET', images: imgs.map((u) => ({ url: u, sha256: '' })) },
        note: `menu images: ${imgs.map((u) => u.split('/').pop()).join(', ')}`,
      };
    }
  }
  emit({ type: 'step', step: 'render', status: domPrices ? 'done' : 'fail', detail: `Rendered page: ${domPrices} prices, ${r.json.length} JSON responses` });
  return { kind: 'rendered', url: r.finalUrl, payload: r.html, html: r.html, text, note: `browser-rendered DOM (${domPrices} prices)` };
}

/**
 * Re-acquire the payload for a stored extractor (fleet, re-runs). JSON sources
 * replay the captured request directly; if the API refuses (expired token etc.),
 * fall back to rendering and re-capturing the same endpoint.
 */
export async function reacquire(source: { kind: SourceKind; url: string; request?: SourceRequest | null }): Promise<{ payload: string; html: string; via: string }> {
  if (source.kind === 'html') {
    const p = await fetchPage(source.url, { maxAgeMs: 0 });
    if (p.status >= 400) throw new Error(`HTTP ${p.status}`);
    return { payload: p.html, html: p.html, via: 'http' };
  }
  if (source.kind === 'json' && source.request) {
    const q = source.request;
    try {
      const res = await safeFetch(q.url, {
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 25_000,
        init: {
          method: q.method,
          headers: { 'user-agent': 'Mozilla/5.0 Menusmith/0.1', ...(q.headers || {}) },
          body: q.method === 'GET' || q.method === 'HEAD' ? undefined : q.body ?? undefined,
        },
      });
      const body = new TextDecoder().decode(res.bytes);
      if (res.ok) {
        JSON.parse(body);
        return { payload: body, html: '', via: 'api replay' };
      }
    } catch {
      /* fall back to the browser */
    }
    const r = await renderPage(source.url);
    const path = new URL(q.url).pathname;
    const same = r.json.find((j) => new URL(j.url).pathname === path) || r.json[0];
    if (!same) throw new Error('menu API not seen when re-rendering the page');
    return { payload: same.body, html: r.html, via: 'browser re-capture' };
  }
  const r = await renderPage(source.url);
  return { payload: r.html, html: r.html, via: 'browser' };
}
