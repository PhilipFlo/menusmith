import { config, MODELS, modelName } from '../config.ts';
import { domainOf, fetchPage, type Page } from '../html/fetch.ts';
import { detectPlatform } from '../html/platform.ts';
import { renderPdfPages } from '../html/render.ts';
import { detectPriceColumns, skeleton } from '../html/simplify.ts';
import { jsonMenuLines, jsonSkeletonText } from '../html/jsonview.ts';
import { Ledger, type ChatMessage } from '../llm/client.ts';
import { candidatesFor, idForDomain, idForUrl, listExtractors, loadExtractor, loadSnapshot, saveExtractor, saveSnapshot, type StoredExtractor } from '../library/store.ts';
import { runExtractor } from '../sandbox/runner.ts';
import { findOfficialSite, tavilyEnabled, tavilySearchFull } from '../tools/tavily.ts';
import { BLOCKED_STATUS, detectBotWall } from '../html/botwall.ts';
import type { Emit, ExtractorMeta, MenuItem, RunResult, Score } from '../types.ts';
import { findMenuPage, priceDensity } from './discover.ts';
import { acquire, reacquire, type Acquired } from './acquire.ts';
import { detectHardcoding, ESCALATE_AFTER, feedbackMessage, initialMessages, initialMessagesJson, writeCode } from './forge.ts';
import { itemsHash, nameSimilarity, normName, scoreAgainstOracle } from './evaluate.ts';
import { readMenu } from './oracle.ts';
import { arbitrate } from './judge.ts';
import { readImage, readMenuImages } from './vision.ts';
import { fetchPdf, looksLikePdfUrl, pdfText } from './document.ts';
import { jsonShapeReport, selectorReport } from './debugger.ts';

export interface ForgeInput {
  /** Any page of the restaurant's site (menu page preferred). */
  url?: string;
  /** Restaurant name — used to find the site with Tavily when no URL is given. */
  restaurant?: string;
  city?: string;
  /** Skip library reuse and always write fresh code. */
  noReuse?: boolean;
  /** Forge even if this restaurant is already in the library (the demo chips: show the agents at work). */
  fresh?: boolean;
  /** Existing extractor to repair (self-heal): its code seeds the conversation. */
  repairOf?: { code: string; reason: string };
  /** Dishes that must be in the output for a repair to pass (they are on the page and were lost). */
  mustInclude?: string[];
  /** Don't follow links / call Tavily; treat `url` as the menu page. */
  noDiscover?: boolean;
  /** Allow the headless-browser path for JavaScript-built menus (default true). */
  allowRender?: boolean;
  /** A fresh oracle reading the caller already has (the fleet's drift check) — saves a call. */
  oracle?: MenuItem[];
  /** Caller-owned ledger (budget cap + cancellation); spend survives exceptions. */
  ledger?: Ledger;
}

export interface ForgeOutcome {
  ok: boolean;
  reason?: string;
  meta?: ExtractorMeta;
  code?: string;
  items?: MenuItem[];
  oracleCount: number;
  rounds: number;
  bestScore?: Score;
  ledger: Ledger;
  ms: number;
  /** "forged" | "reused" | "healed" | "vision" (image menu) | "document" (PDF menu) — the last two are fingerprinted */
  mode?: 'forged' | 'reused' | 'healed' | 'vision' | 'document' | 'listing' | 'known';
  /** The reference reading the extractor was graded against (after arbitration). */
  oracle?: MenuItem[];
}

const noop: Emit = () => {};

/** Stored in place of code for PDF menus (never executed). */
export const DOCUMENT_EXTRACTOR = `// This restaurant publishes its menu as a PDF. Its text layer is extracted locally
// (pdf.js) and read by Nemotron 3 Super; Menusmith stores the file's sha256
// fingerprint and the fleet re-reads it only when the PDF changes.
function extract() { return []; }`;

/** Stored in place of code for menus read from a public listing (never executed). */
export const LISTING_EXTRACTOR = `// This restaurant's own website blocks automated visitors (bot protection), and
// Menusmith does not get around that. The menu was read by Nemotron 3 Super from a public
// listing found through Tavily search (the restaurant's site was excluded and never
// contacted). It is not re-checked automatically — forge again to refresh it.
function extract() { return []; }`;

/** Stored in place of code for image menus (never executed). */
export const IMAGE_EXTRACTOR = `// This restaurant publishes its menu as image(s), so there is no page structure to
// write code against. Menusmith fingerprints each image (sha256 of the bytes) and the
// fleet re-reads a picture with Nemotron 3.5 Super VL only when its fingerprint changes.
function extract() { return []; }`;

/** Keep only oracle items whose name actually occurs on the page (drops hallucinations). */
export function groundOracle(items: MenuItem[], text: string): { kept: MenuItem[]; dropped: MenuItem[] } {
  const page = normName(text);
  const kept: MenuItem[] = [];
  const dropped: MenuItem[] = [];
  // On a priced menu, an unpriced "item" that is really a heading echo — its name is one of
  // the reading's own sections, or it ends in ":" ("Preparation:") — is not a dish.
  const priced = items.length ? items.filter((i) => i.price != null).length / items.length : 0;
  const sections = new Set(items.map((i) => normName(i.section ?? '')).filter(Boolean));
  for (const it of items) {
    const n = normName(it.name);
    // On a strongly priced menu (≥75%), unpriced lines are option lists ("Protein", "Tuscan
    // Cream"), bases, notes ("Entrees served with …") — not dishes to demand from the code.
    // A real unpriced dish the code does return still isn't penalised (it is on the page).
    const noteLike = /^\p{Ll}/u.test(it.name) || /\b(served with|choice of|includes?|add\b|with your)\b/i.test(it.name) || it.name.split(/\s+/).length > 6;
    if (it.price == null && ((priced >= 0.75) || (priced >= 0.6 && (/:\s*$/.test(it.name) || sections.has(n) || noteLike)))) {
      dropped.push(it);
      continue;
    }
    // Accept if the full name occurs, or (for long names) its first three words do.
    const head = n.split(' ').slice(0, 3).join(' ');
    if (n && (page.includes(n) || (head.length >= 6 && page.includes(head)))) kept.push(it);
    else dropped.push(it);
  }
  return { kept, dropped };
}

/**
 * Read a PDF menu: the text layer first (cheap); if that yields no usable menu — designed
 * placemats with letter-spaced, multi-column type, or scanned PDFs without text — render the
 * pages in the browser and let Nemotron 3.5 Super VL read them as images.
 */
export async function readPdfMenu(
  bytes: Uint8Array,
  docUrl: string,
  restaurant: string | null | undefined,
  ledger: Ledger,
  emit: Emit,
): Promise<{ items: MenuItem[]; via: 'text' | 'vision'; pages: number }> {
  let text = '';
  let pages = 0;
  try {
    const t = await pdfText(bytes);
    text = t.text;
    pages = t.pages;
    emit({ type: 'log', message: `PDF: ${t.pages} page(s), ${text.length.toLocaleString()} characters of text` });
  } catch (e) {
    emit({ type: 'log', message: `PDF text layer unreadable: ${(e as Error).message}` });
  }
  let items: MenuItem[] = [];
  if (text.replace(/\s+/g, '').length >= 150) {
    const o = await readMenu(text, { url: docUrl, restaurant }, ledger, emit);
    items = groundOracle(o.items, text).kept;
  }
  if (items.length >= 3 || process.env.MENUSMITH_RENDER === 'off') return { items, via: 'text', pages };
  emit({ type: 'log', message: 'The PDF’s text layer does not read as a menu — rendering its pages for Nemotron 3.5 Super VL' });
  const imgs = await renderPdfPages(bytes, { maxPages: 4 });
  const seen: MenuItem[] = [];
  for (const [k, png] of imgs.entries()) {
    const r = await readImage({ bytes: png, mime: 'image/png', url: `${docUrl}#page=${k + 1}` }, ledger, emit);
    if (r.isMenu) seen.push(...r.items);
    emit({ type: 'log', message: `Nemotron 3.5 Super VL read ${r.items.length} dishes from page ${k + 1}` });
  }
  return { items: seen, via: 'vision', pages: imgs.length };
}

export async function forge(input: ForgeInput, emit: Emit = noop): Promise<ForgeOutcome> {
  const t0 = Date.now();
  const ledger = input.ledger ?? new Ledger();
  const fail = (reason: string, extra: Partial<ForgeOutcome> = {}): ForgeOutcome => {
    emit({ type: 'result', ok: false, reason });
    return { ok: false, reason, oracleCount: 0, rounds: 0, ledger, ms: Date.now() - t0, ...extra };
  };

  // PDF menus: extract the text layer, let the oracle read it, fingerprint the file.
  const documentPath = async (docUrl: string, pageUrl: string): Promise<ForgeOutcome> => {
    emit({ type: 'step', step: 'document', status: 'start', detail: `Reading the PDF menu ${docUrl.split('/').pop()}` });
    let pdf: Awaited<ReturnType<typeof fetchPdf>>;
    try {
      pdf = await fetchPdf(docUrl);
    } catch (e) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: (e as Error).message });
      return fail(`could not read the PDF: ${(e as Error).message}`);
    }
    let items: MenuItem[];
    let via: 'text' | 'vision' = 'text';
    try {
      const r = await readPdfMenu(pdf.bytes, docUrl, input.restaurant, ledger, emit);
      items = r.items;
      via = r.via;
    } catch (e) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: (e as Error).message });
      return fail(`could not read the PDF menu: ${(e as Error).message}`);
    }
    if (items.length < 3) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: 'no menu found in the PDF' });
      return fail('no menu with dishes found in the PDF');
    }
    emit({ type: 'oracle', items });
    emit({ type: 'step', step: 'document', status: 'done', detail: `${items.length} dishes from the PDF${via === 'vision' ? ' (read as images by Nemotron 3.5 Super VL)' : ''}` });
    const domain = domainOf(pageUrl);
    const platform = detectPlatform('', pageUrl);
    // A direct PDF link often lives on a shared CDN (squarespace-cdn, wsimg, Drive…):
    // key it by its path too, so different restaurants never share an id.
    const id = pageUrl === docUrl || looksLikePdfUrl(pageUrl) ? idForUrl(pageUrl, domain, 'pdf') : idForUrl(pageUrl, domain, platform);
    const priced = items.filter((i) => i.price != null).length / items.length;
    const meta = saveExtractor(
      {
        id,
        url: pageUrl,
        domain,
        restaurant: input.restaurant ?? null,
        platform,
        source: { kind: 'document', request: { url: pageUrl, method: 'GET', document: { url: pdf.finalUrl, sha256: pdf.sha256 } } },
        createdAt: new Date().toISOString(),
        model: via === 'vision' ? MODELS.vision[0]! : MODELS.oracle[0]!,
        rounds: 0,
        score: { precision: 1, recall: 1, f1: 1, pricedRatio: Math.round(priced * 1000) / 1000, oracleCount: items.length, extractorCount: items.length },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselineHash: itemsHash(items),
        baselineCount: items.length,
        baselinePriced: Math.round(priced * 1000) / 1000,
        reusedFrom: null,
      },
      DOCUMENT_EXTRACTOR,
      'document: read the PDF menu',
    );
    saveSnapshot(id, items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version} (PDF fingerprint)` });
    emit({ type: 'result', ok: true, meta, items });
    return { ok: true, meta, code: DOCUMENT_EXTRACTOR, items, oracleCount: items.length, rounds: 0, ledger, ms: Date.now() - t0, mode: 'document' };
  };

  // Bot-protected restaurant site: never get around it. Look for the menu on a public listing
  // through search instead (the blocked domain is excluded, so it is never contacted).
  const listingPath = async (siteUrl: string, why: string): Promise<ForgeOutcome> => {
    emit({ type: 'step', step: 'fetch', status: 'fail', detail: why });
    if (!tavilyEnabled()) return fail(`${why} — Menusmith respects bot protection`);
    const domain = domainOf(siteUrl);
    const brand = input.restaurant || domain.replace(/^www\./, '').split('.')[0]!.replace(/[-_]+/g, ' ');
    emit({ type: 'step', step: 'listing', status: 'start', detail: `Looking for ${brand}'s menu on a public listing (the site itself is not contacted)` });
    let candidates: { url: string; text: string; prices: number }[] = [];
    try {
      const results = await tavilySearchFull(`${brand}${input.city ? ' ' + input.city : ''} menu prices`, [domain.replace(/^www\./, '')]);
      candidates = results
        .map((r) => {
          const text = (r.raw_content || '').slice(0, 60_000);
          const prices = (text.match(/(?:\$|€|£|kr\.?\s?)\d{1,4}(?:[.,]\d{1,2})?|\d{1,4}(?:[.,]\d{2})?\s?(?:kr|,-|€)/gi) || []).length;
          return { url: r.url, text, prices };
        })
        // Must be THIS restaurant's page: a listing that never names it is another restaurant.
        .filter((c) => c.prices >= 8 && mentionsBrand(`${c.url} ${c.text.slice(0, 20_000)}`, brand))
        .sort((a, b) => b.prices - a.prices);
    } catch (e) {
      emit({ type: 'log', message: `Search failed: ${(e as Error).message}` });
    }
    const respects = /bot protection|blocks automated/.test(why) ? 'Menusmith respects bot protection, and ' : '';
    if (!candidates.length && !input.restaurant) emit({ type: 'log', message: `No listing with prices names "${brand}"` });
    if (!candidates.length) {
      emit({ type: 'step', step: 'listing', status: 'fail', detail: 'no public listing with prices found' });
      return fail(`${why} — ${respects}no public listing of the menu was found`);
    }
    // Try the two most price-rich listings: one may be a review page that only quotes prices.
    let items: MenuItem[] = [];
    let best = candidates[0]!;
    // Readings vary: with a single usable listing, read it a second time before giving up.
    for (const c of candidates.length > 1 ? candidates.slice(0, 2) : [candidates[0]!, candidates[0]!]) {
      try {
        const o = await readMenu(c.text, { url: c.url, restaurant: brand }, ledger, emit);
        const got = groundOracle(o.items, c.text).kept;
        if (got.length >= 5) {
          items = got;
          best = c;
          break;
        }
      } catch (e) {
        emit({ type: 'log', message: `Could not read ${c.url}: ${(e as Error).message}` });
      }
    }
    if (items.length < 5) {
      emit({ type: 'step', step: 'listing', status: 'fail', detail: 'no readable menu on the public listings found' });
      return fail(`${why} — ${respects}the public listings found had no readable menu`);
    }
    const host = new URL(best.url).hostname.replace(/^www\./, '');
    emit({ type: 'oracle', items });
    emit({ type: 'step', step: 'listing', status: 'done', detail: `${items.length} dishes from a public listing on ${host} — not the restaurant's own website` });
    const id = idForUrl(siteUrl, domain, 'listing');
    const priced = items.filter((i) => i.price != null).length / items.length;
    const meta = saveExtractor(
      {
        id,
        url: siteUrl,
        domain,
        restaurant: input.restaurant ?? brand,
        platform: 'unknown',
        source: { kind: 'listing', request: { url: best.url, method: 'GET' } },
        createdAt: new Date().toISOString(),
        model: MODELS.oracle[0]!,
        rounds: 0,
        score: { precision: 1, recall: 1, f1: 1, pricedRatio: Math.round(priced * 1000) / 1000, oracleCount: items.length, extractorCount: items.length },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselineHash: itemsHash(items),
        baselineCount: items.length,
        baselinePriced: Math.round(priced * 1000) / 1000,
        reusedFrom: null,
      },
      LISTING_EXTRACTOR,
      `listing: ${host} (${why})`,
    );
    saveSnapshot(id, items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version} (from a public listing on ${host})` });
    emit({ type: 'result', ok: true, meta, items });
    return { ok: true, meta, code: LISTING_EXTRACTOR, items, oracleCount: items.length, rounds: 0, ledger, ms: Date.now() - t0, mode: 'listing' };
  };

  // 1. Locate the website.
  let url = input.url?.trim();
  if (!url) {
    if (!input.restaurant) return fail('give a URL or a restaurant name');
    if (!tavilyEnabled()) return fail('no URL given and TAVILY_API_KEY is not set');
    emit({ type: 'step', step: 'discover', status: 'start', detail: `Searching the web for ${input.restaurant}` });
    const site = await findOfficialSite(input.restaurant, input.city).catch((e) => {
      emit({ type: 'log', message: `Tavily search failed: ${(e as Error).message}` });
      return null;
    });
    if (!site) {
      emit({ type: 'step', step: 'discover', status: 'fail' });
      return fail(`could not find an official website for ${input.restaurant}`);
    }
    url = site.url;
    emit({ type: 'step', step: 'discover', status: 'done', detail: `Tavily: ${site.title} → ${url}` });
  }

  // 1b. Already in the library? Answer from it — the whole point of keeping the code.
  // Re-running saved code costs 0 tokens and takes seconds; a repeated test never
  // spends the daily AI allowance again. "Forge fresh" (noReuse) skips this.
  if (!input.noReuse && !input.fresh && !input.repairOf) {
    const hit = knownExtractor(url);
    if (hit) {
      const answered = await answerFromLibrary(hit, emit);
      if (answered) return { ...answered, ledger, ms: Date.now() - t0 };
    }
  }

  // A link straight to a PDF menu.
  if (looksLikePdfUrl(url)) return documentPath(url, url);

  // 2. Fetch + find the menu page.
  emit({ type: 'step', step: 'fetch', status: 'start', detail: url });
  let page: Page;
  try {
    page = await fetchPage(url);
  } catch (e) {
    if (BLOCKED_STATUS.test((e as Error).message)) return listingPath(url, `${(e as Error).message} — the site blocks automated visitors`);
    if (ledger.signal?.aborted) return fail((e as Error).message);
    return listingPath(url, `the restaurant’s own website could not be loaded (${(e as Error).message})`);
  }
  const wall = detectBotWall(page.html);
  if (wall) return listingPath(page.finalUrl, `the site is behind bot protection (${wall})`);
  if (BLOCKED_STATUS.test(`HTTP ${page.status}`)) return listingPath(page.finalUrl, `HTTP ${page.status} from ${url} — the site blocks automated visitors`);
  // Served as a PDF despite the URL.
  if (page.html.startsWith('%PDF')) return documentPath(page.finalUrl, page.finalUrl);
  if (page.status >= 400) return listingPath(page.finalUrl, `the restaurant’s own website could not be loaded (HTTP ${page.status} from ${url})`);
  emit({ type: 'step', step: 'fetch', status: 'done', detail: `${Math.round(page.html.length / 1024)} KB` });

  if (!input.noDiscover) {
    emit({ type: 'step', step: 'locate', status: 'start', detail: 'Looking for the menu page' });
    const found = await findMenuPage(page, { restaurant: input.restaurant, ledger, emit });
    page = found.page;
    emit({ type: 'step', step: 'locate', status: 'done', detail: found.how });
  }

  // 2b. Get the menu in its most stable form: server HTML, a JSON menu API, or the rendered DOM.
  let acq: Acquired;
  try {
    acq = await acquire(page, emit, { allowRender: input.allowRender !== false });
  } catch (e) {
    emit({ type: 'step', step: 'render', status: 'fail', detail: (e as Error).message });
    if (ledger.signal?.aborted || !/^https?:/.test(page.finalUrl)) return fail(`could not load the page in a browser: ${(e as Error).message}`);
    return listingPath(page.finalUrl, `the restaurant’s own website could not be loaded in a browser (${(e as Error).message})`);
  }
  const mode: 'html' | 'json' = acq.kind === 'json' ? 'json' : 'html';
  const menuUrl = acq.url;
  const domain = domainOf(acq.request?.url && acq.kind === 'json' ? menuUrl : menuUrl);
  const platform = detectPlatform(acq.html, acq.kind === 'json' ? acq.request!.url : menuUrl);
  const id = idForUrl(menuUrl, domain, platform);
  // What the oracle reads: the visible page — or, for API menus whose page shows no
  // prices, the menu fields of the JSON itself.
  let text = acq.text;
  if (acq.kind === 'json' && priceDensity(acq.html) < 5) {
    try {
      text = jsonMenuLines(JSON.parse(acq.payload));
    } catch {
      /* keep page text */
    }
  }
  emit({ type: 'log', message: `Source: ${acq.note} · platform ${platform}` });

  if (acq.kind === 'document') return documentPath(acq.payload, acq.url);

  // Image menus: no structure to write code against. Read the pictures with Nemotron
  // 3.5 Super VL and store their fingerprints — re-runs only re-read a changed image.
  imageMenu: if (acq.kind === 'image') {
    emit({ type: 'step', step: 'vision', status: 'start', detail: `${modelName(MODELS.vision[0]!)} is reading the menu images` });
    let v: Awaited<ReturnType<typeof readMenuImages>>;
    try {
      v = await readMenuImages(JSON.parse(acq.payload) as string[], ledger, emit);
    } catch (e) {
      emit({ type: 'step', step: 'vision', status: 'fail', detail: (e as Error).message });
      return fail(`could not read the menu images: ${(e as Error).message}`);
    }
    if (v.items.length < 3) {
      // Pictures named "menu" are often banners or food photos. Not the end: read the page
      // itself (its text, a widget, links) like any rendered page.
      if (!acq.html || acq.text.length < 200) {
        emit({ type: 'step', step: 'vision', status: 'fail', detail: 'no readable menu in the images' });
        if (!input.repairOf && /^https?:/.test(menuUrl)) return listingPath(menuUrl, 'the menu pictures on the restaurant’s own website could not be read');
        return fail('the menu images could not be read');
      }
      emit({ type: 'step', step: 'vision', status: 'fail', detail: 'the pictures are not a menu — reading the page itself' });
      acq = { ...acq, kind: 'rendered', payload: acq.html, note: `${acq.note} → not a menu; the rendered page instead` };
      break imageMenu;
    }
    emit({ type: 'oracle', items: v.items });
    emit({ type: 'step', step: 'vision', status: 'done', detail: `${v.items.length} dishes from ${v.images.length} image(s)` });
    const priced = v.items.filter((i) => i.price != null).length / v.items.length;
    const meta = saveExtractor(
      {
        id,
        url: menuUrl,
        domain,
        restaurant: input.restaurant ?? null,
        platform,
        source: { kind: 'image', request: { url: menuUrl, method: 'GET', images: v.images } },
        createdAt: new Date().toISOString(),
        model: MODELS.vision[0]!,
        rounds: 0,
        // No code is tested on this path — the reading itself is the result.
        score: { precision: 1, recall: 1, f1: 1, pricedRatio: Math.round(priced * 1000) / 1000, oracleCount: v.items.length, extractorCount: v.items.length },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselineHash: itemsHash(v.items),
        baselineCount: v.items.length,
        baselinePriced: Math.round(priced * 1000) / 1000,
        reusedFrom: null,
      },
      IMAGE_EXTRACTOR,
      `vision: read ${v.images.length} menu image(s)`,
    );
    saveSnapshot(id, v.items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version} (image fingerprints)` });
    emit({ type: 'result', ok: true, meta, items: v.items });
    return { ok: true, meta, code: IMAGE_EXTRACTOR, items: v.items, oracleCount: v.items.length, rounds: 0, ledger, ms: Date.now() - t0, mode: 'vision' };
  }

  // 3. Oracle reading (Nemotron Super).
  let oracleItems: MenuItem[];
  if (input.oracle?.length) {
    oracleItems = input.oracle;
    emit({ type: 'oracle', items: oracleItems });
    emit({ type: 'step', step: 'oracle', status: 'done', detail: `${oracleItems.length} items (fresh reading from the drift check)` });
  } else try {
    emit({ type: 'step', step: 'oracle', status: 'start', detail: `${modelName(MODELS.oracle[0]!)} is reading the menu` });
    const o = await readMenu(text, { url: menuUrl, restaurant: input.restaurant }, ledger, emit);
    if (!o.isMenu) {
      emit({ type: 'step', step: 'oracle', status: 'fail', detail: 'no menu found on this page' });
      // Chains that only price items inside an ordering app, sites without a menu page: the
      // same public-listing fallback, clearly labelled.
      if (!input.repairOf && /^https?:/.test(menuUrl)) return listingPath(menuUrl, 'the restaurant’s own website shows no menu with prices');
      return fail('no menu with dishes found on the page (it may be a PDF, an image, or rendered by JavaScript)');
    }
    const g = groundOracle(o.items, text);
    oracleItems = g.kept;
    if (g.dropped.length) emit({ type: 'log', message: `Dropped ${g.dropped.length} oracle item(s) not found in the page text` });
    emit({ type: 'oracle', items: oracleItems });
    emit({ type: 'step', step: 'oracle', status: 'done', detail: `${oracleItems.length} items, currency ${o.currency ?? '?'}` });
  } catch (e) {
    emit({ type: 'step', step: 'oracle', status: 'fail', detail: (e as Error).message });
    return fail(`oracle failed: ${(e as Error).message}`);
  }
  if (oracleItems.length < 3) {
    if (!input.repairOf && /^https?:/.test(menuUrl)) return listingPath(menuUrl, 'the restaurant’s own website shows too few dishes to read');
    return fail('too few menu items to build a reliable extractor', { oracleCount: oracleItems.length });
  }

  const baseMeta = {
    id,
    url: menuUrl,
    domain,
    restaurant: input.restaurant ?? null,
    platform,
    source: { kind: acq.kind, request: acq.request ?? null },
  };

  const finalize = async (code: string, score: Score, run: RunResult, rounds: number, model: string, how: 'forged' | 'reused' | 'healed', reusedFrom?: string) => {
    // Determinism: a second run must produce the identical item set.
    const again = await runExtractor(code, acq.payload, menuUrl, mode);
    if (!again.ok || itemsHash(again.items) !== itemsHash(run.items)) {
      emit({ type: 'log', message: 'Second run differed — extractor is not deterministic; rejecting' });
      return null;
    }
    const meta = saveExtractor(
      {
        ...baseMeta,
        createdAt: new Date().toISOString(),
        model,
        rounds,
        score: {
          precision: score.precision,
          recall: score.recall,
          f1: score.f1,
          pricedRatio: score.pricedRatio,
          oracleCount: score.oracleCount,
          extractorCount: score.extractorCount,
        },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselinePriced: run.items.length ? Math.round((run.items.filter((i) => i.price != null).length / run.items.length) * 1000) / 1000 : 0,
        baselineHash: itemsHash(run.items),
        baselineCount: run.items.length,
        reusedFrom: reusedFrom ?? null,
      },
      code,
      how === 'reused' ? `adopted from ${reusedFrom}` : how === 'healed' ? `self-heal: ${input.repairOf?.reason}` : 'forged',
    );
    saveSnapshot(id, run.items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version}` });
    emit({ type: 'result', ok: true, meta, items: run.items });
    return { ok: true, meta, code, items: run.items, oracleCount: oracleItems.length, rounds, bestScore: score, ledger, ms: Date.now() - t0, mode: how } satisfies ForgeOutcome;
  };

  // 4. Library reuse — an extractor written for another site on the same platform may just work (0 tokens).
  if (!input.noReuse && !input.repairOf) {
    const cands = candidatesFor(platform, id);
    if (cands.length) {
      emit({ type: 'step', step: 'reuse', status: 'start', detail: `Trying ${cands.length} ${platform} extractor(s) from the library` });
      for (const c of cands) {
        if ((c.meta.source?.kind === 'json') !== (mode === 'json')) continue;
        const run = await runExtractor(c.code, acq.payload, menuUrl, mode);
        if (!run.ok) continue;
        const score = scoreAgainstOracle(oracleItems, run.items, text);
        emit({ type: 'log', message: `  ${c.meta.id}: f1=${score.f1}` });
        if (score.pass) {
          emit({ type: 'step', step: 'reuse', status: 'done', detail: `Adopted ${c.meta.id} (f1 ${score.f1}) — no code generation needed` });
          const r = await finalize(c.code, score, run, 0, c.meta.model, 'reused', c.meta.id);
          if (r) return r;
        }
      }
      emit({ type: 'step', step: 'reuse', status: 'skip', detail: 'No library extractor fits — writing a new one' });
    }
  }

  // 5. Forge → test → repair loop (Nemotron Super, escalating to Ultra).
  const messages: ChatMessage[] =
    mode === 'json'
      ? initialMessagesJson({
          url: menuUrl,
          platform,
          apiUrl: acq.request!.url,
          method: acq.request!.method,
          jsonSkeleton: jsonSkeletonText(JSON.parse(acq.payload)),
          oracle: oracleItems,
          pathReport: jsonShapeReport(acq.payload),
        })
      : initialMessages({ url: menuUrl, platform, skeleton: skeleton(acq.payload, undefined, oracleItems.map((i) => i.name)), oracle: oracleItems, priceColumns: detectPriceColumns(acq.payload), positioned: (acq.payload.match(/data-ms-xy=/g) || []).length >= 30 });
  if (input.repairOf) {
    messages.push({ role: 'assistant', content: '```javascript\n' + input.repairOf.code + '\n```' });
    messages.push({
      role: 'user',
      content: `This extractor worked when it was written, but the website has changed and it now fails: ${input.repairOf.reason}. The ${mode === 'json' ? 'JSON' : 'HTML'} above is the CURRENT ${mode === 'json' ? 'API response' : 'page'}. Rewrite the complete function so it works on it.`,
    });
  }

  let best: { score: Score; code: string; run: RunResult } | null = null;
  const maxRounds = 1 + config.maxRepairs;
  let lastModel = '';
  const deferredHints: ChatMessage[] = [];
  let stagnant = 0;
  let arbitrations = 0;
  let roundsUsed = 0;

  // Layouts with a tested parser (price columns, free-positioned pages): try the parser as-is
  // first — zero tokens, and the same deterministic code the model would build on. It is
  // committed only if it passes against the reading like any written extractor.
  if (mode === 'html' && !input.repairOf) {
    const helperCode = (acq.payload.match(/data-ms-xy=/g) || []).length >= 30
      ? 'function extract($, ctx) {\n  // Free-positioned page: dishes rebuilt from the visual rows (tested helper).\n  return visualDishes($);\n}'
      : detectPriceColumns(acq.payload)
        ? 'function extract($, ctx) {\n  // Names and prices in side-by-side columns: paired by position (tested helper).\n  return priceColumns($);\n}'
        : null;
    if (!helperCode) {
      // Ordinary page: the tested line parser is not committed up front (the agent writes the
      // extractor), but a decent result is shown to the model as a starting point.
      const lineCode = 'function extract($, ctx) {\n  return textDishes($);\n}';
      const run = await runExtractor(lineCode, acq.payload, menuUrl, mode);
      const score = run.ok && run.items.length ? scoreAgainstOracle(oracleItems, run.items, text) : null;
      if (score && score.f1 >= 0.6) {
        emit({ type: 'log', message: `Line parser: ${run.items.length} items, f1 ${score.f1}${score.pass ? ' (already passes — offered if round 1 fails)' : ' — offered to the model as a starting point'}` });
        best = { score, code: lineCode, run }; // nothing scored before this point
        // Round 1 stays the model's own reading of the page (on simple pages it writes exact
        // code); if the parser already passes, it is offered only after round 1 fails.
        (score.pass ? deferredHints : messages).push({
          role: 'user',
          content: score.pass
            ? `Note: a tested helper global textDishes($) already reads this page correctly — alone it returns ${run.items.length} items and passes the test (f1 ${score.f1}). Unless you see something it gets wrong, build on it: call textDishes($) and return its result (optionally cleaned up).`
            : `Note: a tested helper global textDishes($) reads this page's text lines (dish lines ending in a price, descriptions below, headings above) and alone returns ${run.items.length} items (f1 ${score.f1}; ${score.failures.slice(0, 2).join('; ')}). You may build on it — e.g. call it and then add what it misses or drop non-dishes — or write your own parser if the page structure is clearer.`,
        });
      }
    }
    if (helperCode) {
      const run = await runExtractor(helperCode, acq.payload, menuUrl, mode);
      const score = run.ok ? scoreAgainstOracle(oracleItems, run.items, text) : null;
      emit({ type: 'log', message: `Layout parser alone: ${run.items.length} items${score ? `, f1 ${score.f1}` : ''}${score?.pass ? ' — passes' : ' — the model takes over'}` });
      if (score?.pass) {
        emit({ type: 'step', step: 'test', status: 'done', detail: `PASS f1=${score.f1} (${score.extractorCount}/${score.oracleCount}) — layout parser, no code generation needed` });
        const r = await finalize(helperCode, score, run, 0, 'layout-parser', 'forged');
        if (r) return r;
      } else if (score && score.f1 >= 0.5) {
        // Also a candidate for the near-miss second reading at the end.
        best = { score, code: helperCode, run }; // nothing scored before this point
        messages.push({
          role: 'user',
          content: `Note: a tested helper is available as a global — ${helperCode.includes('textDishes') ? 'textDishes($) (dish lines ending in a price, descriptions below, headings above)' : helperCode.includes('visualDishes') ? 'visualDishes($)' : 'priceColumns($)'} — and alone it returned ${run.items.length} items (f1 ${score.f1}). ${score.failures.slice(0, 2).join('; ')}. You may start from its output and fix what it gets wrong (add what it misses, drop non-dishes) rather than parsing from scratch.`,
        });
      }
    }
  }

  // A visitor is waiting: past the forge deadline, stop repairing and go to the safety nets
  // (line parser, second reading) with what we have.
  const deadline = t0 + Number(process.env.MENUSMITH_FORGE_DEADLINE_MS || 10 * 60_000);
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1 && Date.now() > deadline) {
      emit({ type: 'log', message: `Time limit reached after ${round - 1} round(s) — finishing with the best result so far` });
      break;
    }
    roundsUsed = round;
    emit({ type: 'step', step: round === 1 ? 'forge' : 'repair', status: 'start', detail: round === 1
          ? `${modelName(MODELS.forge[0]!)} is writing the extractor`
          : round > ESCALATE_AFTER
            ? `Repair round ${round - 1}: escalated to ${modelName(MODELS.escalate[0]!)}`
            : `Repair round ${round - 1}: ${modelName(MODELS.forge[0]!)} is fixing its code` });
    let code: string | null;
    try {
      const w = await writeCode(messages, round, ledger, emit);
      code = w.code;
      lastModel = Object.keys(ledger.byModel).pop() || '';
      messages.push({ role: 'assistant', content: w.reply || '(empty reply)' });
      if (w.reasoning) emit({ type: 'log', message: `Reasoning: ${w.reasoning.slice(0, 600)}${w.reasoning.length > 600 ? '…' : ''}` });
    } catch (e) {
      emit({ type: 'step', step: 'forge', status: 'fail', detail: (e as Error).message });
      return fail(`code generation failed: ${(e as Error).message}`, { oracleCount: oracleItems.length, rounds: round });
    }
    if (!code) {
      messages.push({ role: 'user', content: `Your reply did not contain a \`\`\`javascript block defining function extract(${mode === 'json' ? 'data' : '$'}, ctx). Return the complete function.` });
      emit({ type: 'step', step: 'test', status: 'fail', detail: 'no code in reply' });
      continue;
    }
    emit({ type: 'step', step: round === 1 ? 'forge' : 'repair', status: 'done', detail: `${code.split('\n').length} lines of code` });
    emit({ type: 'code', version: round, round, code });
    emit({ type: 'step', step: 'test', status: 'start', detail: `Running round ${round} in the sandbox` });

    const hard = detectHardcoding(code, oracleItems);
    const run = hard.length ? { ok: false, items: [], error: 'hard-coded content', ms: 0 } : await runExtractor(code, acq.payload, menuUrl, mode);
    let score = run.ok ? scoreAgainstOracle(oracleItems, run.items, text) : null;
    // Disagreement between the reading and the code on specific items → Nemotron Nano arbitrates.
    if (score && score.f1 >= 0.75 && (score.grounded.length || score.extra.length || score.missing.length) && arbitrations < 3) {
      const disputedExtractor = [...score.grounded, ...score.extra];
      const disputedOracle = score.pass ? [] : score.missing;
      try {
        arbitrations++;
        const a = await arbitrate(disputedExtractor, disputedOracle, text, ledger, emit);
        // Dishes a repair must recover are known to be real — never let a tie-break drop them.
        for (const n of input.mustInclude ?? []) a.rejected.delete(normName(n));
        if (a.disputed) {
          const before = oracleItems.length;
          oracleItems = [...oracleItems.filter((i) => !a.rejected.has(normName(i.name))), ...a.accepted];
          score = scoreAgainstOracle(oracleItems, run.items, text, { rejected: a.rejected });
          emit({
            type: 'log',
            message: `Nemotron Nano arbitrated ${a.disputed} disputed item(s): ${a.rejected.size} not dishes, ${a.accepted.length} dish(es) the reading missed · reference ${before} → ${oracleItems.length} items`,
          });
          if (a.accepted.length || before !== oracleItems.length) emit({ type: 'oracle', items: oracleItems });
        }
      } catch (e) {
        emit({ type: 'log', message: `Arbitration unavailable: ${(e as Error).message}` });
      }
    }
    // A repair that doesn't bring back the dishes it was started for has not passed.
    if (score && input.mustInclude?.length) {
      const got = run.items.map((i) => normName(i.name));
      const still = input.mustInclude.filter((n) => !got.some((g) => g === normName(n) || nameSimilarity(g, normName(n)) >= 0.6)); // same bar as the scorer
      if (still.length) {
        score = { ...score, pass: false, failures: [`still missing these dishes that are on the page: ${still.slice(0, 8).join(', ')}`, ...score.failures] };
      }
    }
    emit({
      type: 'test',
      round,
      score: score ?? scoreAgainstOracle(oracleItems, [], text),
      run: { ok: run.ok, error: run.error, ms: run.ms, count: run.items.length, trace: run.trace },
    });
    if (score && (!best || score.f1 > best.score.f1)) best = { score, code, run };

    if (score?.pass) {
      emit({ type: 'step', step: 'test', status: 'done', detail: `PASS f1=${score.f1} (${score.extractorCount}/${score.oracleCount})` });
      const r = await finalize(code, score, run, round, lastModel, input.repairOf ? 'healed' : 'forged');
      if (r) return r;
      messages.push({ role: 'user', content: 'Running your function twice on the same HTML gave different results. Make it fully deterministic (no Math.random, Date, or object-order dependence). Return the complete function.' });
      continue;
    }
    emit({ type: 'step', step: 'test', status: 'fail', detail: hard.length ? 'hard-coded content' : run.ok ? `f1=${score!.f1} — ${score!.failures[0] ?? 'not good enough yet'}` : run.error });
    // Stop early when repairs stagnate: two rounds in a row without improving the best F1.
    stagnant = score && best && score.f1 < best.score.f1 + 0.01 && round > 1 ? stagnant + 1 : 0;
    // …but keep going when we're close: near-misses usually converge with one more round.
    if (stagnant >= 2 && (best?.score.f1 ?? 0) < 0.8) {
      emit({ type: 'log', message: 'Repairs have stopped improving — giving up early to save tokens' });
      break;
    }
    // Too few items → give the agent a debugger view: which of its selectors / paths actually match.
    const tooFew = !run.ok || (score && score.extractorCount < score.oracleCount * 0.5);
    const diagnostics =
      tooFew && !hard.length
        ? mode === 'json'
          ? jsonShapeReport(acq.payload)
          : run.trace?.length
            ? `Execution trace of your code on the real page (selector → elements):\n${run.trace.map((t) => '  ' + t).join('\n')}`
            : selectorReport(code, acq.payload)
        : null;
    if (diagnostics) emit({ type: 'log', message: `Debugger: ${diagnostics.split('\n').slice(1, 6).join(' ').trim()}` });
    messages.push({ role: 'user', content: feedbackMessage(round, run, score, hard, diagnostics) + (round === 1 && deferredHints.length ? `\n\n${deferredHints.map((h) => h.content).join('\n')}` : '') });
  }

  // Safety net for ordinary line-based menus when the written code didn't pass: the tested
  // line parser (dish lines ending in a price, descriptions below, headings above). Deterministic
  // code like any extractor, committed only if it passes; otherwise it may still be the best
  // candidate for the second reading below.
  if (mode === 'html' && !input.repairOf && !input.mustInclude?.length) {
    const lineCode = 'function extract($, ctx) {\n  // A line-based menu: dish lines ending in a price, descriptions below, headings above (tested helper).\n  return textDishes($);\n}';
    const run = await runExtractor(lineCode, acq.payload, menuUrl, mode);
    const score = run.ok && run.items.length ? scoreAgainstOracle(oracleItems, run.items, text) : null;
    if (score) {
      emit({ type: 'log', message: `Line parser as a safety net: ${run.items.length} items, f1 ${score.f1}${score.pass ? ' — passes' : ''}` });
      // Show it as its own round, so the committed code is visible next to the model's attempts.
      const safetyRound = roundsUsed + 1;
      emit({ type: 'code', version: safetyRound, round: safetyRound, code: lineCode });
      emit({ type: 'test', round: safetyRound, score, run: { ok: run.ok, error: run.error, ms: run.ms, count: run.items.length, trace: run.trace } });
    }
    if (score?.pass) {
      emit({ type: 'step', step: 'test', status: 'done', detail: `PASS f1=${score.f1} (${score.extractorCount}/${score.oracleCount}) — tested line parser` });
      const r = await finalize(lineCode, score, run, roundsUsed, 'line-parser', 'forged');
      if (r) return r;
    } else if (score && (!best || score.f1 > best.score.f1)) best = { score, code: lineCode, run };
  }

  // A near miss is often the reading's fault, not the code's (one reading is noisy — see
  // bench/variance.ts). Before giving up, pay for one more independent reading and grade the
  // best code against it; it passes only if it clears the same bar there.
  if (best && best.score.f1 >= 0.75 && !input.mustInclude?.length) {
    try {
      emit({ type: 'log', message: `Near miss (f1 ${best.score.f1}) — asking Nemotron for a second, independent reading of the menu` });
      const o2 = await readMenu(text, { url: menuUrl, restaurant: input.restaurant }, ledger, emit);
      const second = groundOracle(o2.items, text).kept;
      const s2 = second.length >= 3 ? scoreAgainstOracle(second, best.run.items, text) : null;
      if (s2?.pass) {
        oracleItems = second;
        emit({ type: 'oracle', items: second });
        emit({ type: 'step', step: 'test', status: 'done', detail: `PASS against a second reading f1=${s2.f1} (${s2.extractorCount}/${s2.oracleCount})` });
        const r = await finalize(best.code, s2, best.run, roundsUsed, lastModel, input.repairOf ? 'healed' : 'forged');
        if (r) return r;
      } else if (s2) {
        // Two independent readings both agree the code is close and precise: what is left is
        // menu ambiguity (option lists, "build your own" choices), not wrong data. Accept — the
        // output is ≥90% correct against both — but never with other failures (unpriced output,
        // dishes that are not on the page).
        const s1 = best.score;
        const onlyCoverage = (sc: Score) => sc.failures.every((f) => /^F1 |^recall /.test(f));
        if (Math.min(s1.f1, s2.f1) >= 0.85 && Math.min(s1.precision, s2.precision) >= 0.9 && onlyCoverage(s1) && onlyCoverage(s2)) {
          oracleItems = second;
          emit({ type: 'oracle', items: second });
          emit({ type: 'step', step: 'test', status: 'done', detail: `PASS on two independent readings — f1 ${s1.f1} / ${s2.f1}, precision ${s1.precision} / ${s2.precision}` });
          const r = await finalize(best.code, s2, best.run, roundsUsed, lastModel, input.repairOf ? 'healed' : 'forged');
          if (r) return r;
        }
        emit({ type: 'log', message: `Second reading agrees with the first (f1 ${s2.f1}) — not accepted` });
      }
    } catch (e) {
      emit({ type: 'log', message: `Second reading unavailable: ${(e as Error).message}` });
    }
  }

  const reason = `no passing extractor after ${roundsUsed} rounds (best f1 ${best?.score.f1 ?? 0})`;
  if (best) emit({ type: 'log', message: `Best attempt returned ${best.run.items.length} items (f1 ${best.score.f1})` });
  emit({ type: 'result', ok: false, reason, items: best?.run.items });
  return {
    ok: false,
    reason,
    ledger,
    ms: Date.now() - t0,
    oracleCount: oracleItems.length,
    oracle: oracleItems,
    rounds: roundsUsed,
    bestScore: best?.score,
    code: best?.code,
    items: best?.run.items,
  };
}

/** Letters and digits only, accents dropped: "Zuni Café" → "zunicafe". */
const compact = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Does this listing page name the restaurant? The brand may be a domain ("joejuice",
 * "louandherberts") or a typed name; listings write "Joe & The Juice", "Lou & Herbert's".
 */
export function mentionsBrand(text: string, brand: string): boolean {
  const want = compact(brand);
  if (want.length < 3) return false;
  const t = text.toLowerCase();
  const variants = [compact(t.replace(/&/g, 'and')), compact(t.replace(/&|\b(the|and|n)\b/g, ' '))];
  if (variants.some((v) => v.includes(want))) return true;
  // A typed name: every significant word must appear ("Alex Sushi" in "Alex Sushi Aker Brygge").
  const words = brand.split(/\s+/).map(compact).filter((w) => w.length >= 3 && !['the', 'and', 'restaurant', 'cafe', 'bar'].includes(w));
  return words.length > 0 && words.every((w) => variants[0]!.includes(w));
}

const hostKey = (u: string) => {
  try {
    const x = new URL(u);
    return { host: x.hostname.replace(/^www\./, '').toLowerCase(), path: ((x.pathname.replace(/\/+$/, '') || '/') + x.search).toLowerCase() };
  } catch {
    return null;
  }
};

/**
 * The library entry for this URL: same page, or — for a site that is one restaurant per
 * domain — any page of the same domain (a visitor types the homepage, we saved /menu).
 * Location pages on shared hosts (ordering platforms, chains' /store/206) need the same path.
 */
export function knownExtractor(url: string, library: StoredExtractor[] = listExtractors()): StoredExtractor | null {
  const want = hostKey(url);
  if (!want) return null;
  const all = library.filter((x) => hostKey(x.meta.url)?.host === want.host);
  const samePage = all.find((x) => hostKey(x.meta.url)!.path === want.path);
  if (samePage) return samePage;
  const whole = all.filter((x) => x.meta.id === idForDomain(x.meta.domain));
  return whole.length === 1 ? whole[0]! : null;
}

/** Serve a library hit: re-run its code on the live page, or show the saved menu for readings. */
async function answerFromLibrary(hit: StoredExtractor, emit: Emit): Promise<Omit<ForgeOutcome, 'ledger' | 'ms'> | null> {
  const { meta } = hit;
  const kind = meta.source?.kind ?? 'html';
  emit({ type: 'step', step: 'reuse', status: 'start', detail: `${meta.id} is already in the library — no AI needed` });
  if (kind === 'listing' || kind === 'document' || kind === 'image') {
    const items = loadSnapshot(meta.id) ?? [];
    if (items.length < 3) return null;
    const what = kind === 'listing' ? 'menu read from a public listing' : kind === 'document' ? 'PDF menu' : 'image menu';
    emit({ type: 'step', step: 'reuse', status: 'done', detail: `Saved ${what} from ${meta.createdAt.slice(0, 10)}${kind === 'listing' ? '' : ' — the fleet re-checks it for changes'}` });
    emit({ type: 'result', ok: true, meta, items });
    return { ok: true, meta, code: hit.code, items, oracleCount: items.length, rounds: 0, mode: 'known' };
  }
  try {
    const r = await Promise.race([
      rerun(meta.id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('took too long')), kind === 'rendered' ? 150_000 : 60_000).unref()),
    ]);
    const n = r.run.items.length;
    // A clear drop means the site changed: fall through and let the agent repair it.
    if (r.run.ok && n >= 3 && n >= Math.floor(meta.baselineCount * 0.6)) {
      emit({ type: 'step', step: 'reuse', status: 'done', detail: `Re-ran saved code v${meta.version} on the live page: ${n} dishes, 0 tokens` });
      emit({ type: 'result', ok: true, meta, items: r.run.items });
      return { ok: true, meta, code: hit.code, items: r.run.items, oracleCount: meta.score.oracleCount, rounds: 0, mode: 'known' };
    }
    emit({ type: 'step', step: 'reuse', status: 'skip', detail: `Saved code returned ${n} of ${meta.baselineCount} dishes — the page changed, repairing` });
  } catch (e) {
    emit({ type: 'step', step: 'reuse', status: 'skip', detail: `Saved code could not run (${(e as Error).message}) — forging again` });
  }
  return null;
}

/** Re-run a stored extractor on the live page — zero tokens. */
export async function rerun(id: string, opts: { fresh?: boolean } = {}) {
  const stored = loadExtractor(id);
  if (!stored) throw new Error(`no extractor ${id}`);
  if (stored.meta.source?.kind === 'image' || stored.meta.source?.kind === 'document')
    throw new Error('image and PDF menus are re-checked by the fleet (fingerprints), not re-run as code');
  const src = await reacquire({ kind: stored.meta.source?.kind ?? 'html', url: stored.meta.url, request: stored.meta.source?.request });
  const run = await runExtractor(stored.code, src.payload, stored.meta.url, stored.meta.source?.kind === 'json' ? 'json' : 'html');
  return { stored, src, run, fresh: opts.fresh };
}
