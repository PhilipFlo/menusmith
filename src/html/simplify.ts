import * as cheerio from 'cheerio';
import { createRequire } from 'node:module';
import type { AnyNode, Element } from 'domhandler';

/**
 * Two views of a page:
 *   pageText()  — readable text with line breaks, for the oracle to READ the menu;
 *   skeleton()  — compact, structure-preserving HTML of the menu region, for the
 *                 forge model to WRITE selectors against.
 */

const DROP = 'script:not([type="application/ld+json"]), style, noscript, svg, iframe, canvas, video, audio, picture source, link, meta, template';
// The same pairing code the sandbox exposes to extractors as priceColumns($).
const sandboxHelpers = createRequire(import.meta.url)('../sandbox/helpers.cjs') as Record<string, unknown>;

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'table', 'tbody', 'thead',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'footer', 'main', 'nav', 'aside', 'br', 'hr', 'figure', 'figcaption', 'form',
]);
const KEEP_ATTRS = new Set(['class', 'id', 'itemprop', 'itemtype', 'role', 'data-hook', 'data-testid', 'data-price', 'data-name', 'aria-label']);

/** A price-looking token: "189,-", "kr 189", "NOK 1 290", "$12.50", "149.-", "€9,90", "12.50 USD". */
export const PRICE_RE =
  /(?:(?:kr\.?|nok|sek|dkk|usd|eur|\$|€|£)\s?\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2})?)|(?:\b\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{1,2})?\s?(?:,-|\.-|kr\b|nok\b|usd\b|eur\b|€|\$))|(?:\b\d{1,4}[.,]\d{2}\b)/i;

/**
 * Price-column layouts put every name in one block and every price in another, so plain
 * text reads "name, name, name … $7, $10, $8" and a reader has to guess the pairing. Rewrite
 * such pairs in reading order — "NAME — $7" then its description — the way the PDF reader
 * rebuilds rows from positions. The reader still reads and judges the whole page.
 */
function linearizePriceColumns($: cheerio.CheerioAPI): number {
  if ($('br').length < 4) return 0;
  const pairs = (sandboxHelpers.pairPriceColumns as (q: cheerio.CheerioAPI) => { nameEl: Element; priceEl: Element; entries: string[][]; prices: string[] }[])($);
  if (pairs.length < 2) return 0;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const p of pairs) {
    $(p.nameEl).html(p.entries.map((e, k) => `<div>${esc(e[0]!)} — ${esc(p.prices[k]!)}</div>${e.length > 1 ? `<div>${esc(e.slice(1).join(' '))}</div>` : ''}`).join(''));
    $(p.priceEl).remove();
  }
  return pairs.length;
}

/**
 * A dish line ending in a bare price, common on US menus: "Grouper Bites 25",
 * "Oysters Rockefeller 24.50". Letters first, 1–3 digit price last; addresses and phone
 * numbers rarely fit (they carry more digits or start with a number).
 */
const BARE_PRICE_LINE = /^[\p{L}][\p{L}\p{M}'’&.,\-\s"“”()/]{2,60}\s\$?(\d{1,3})(?:\.\d{2})?$/u;

/** Readable text, one block per line, for the oracle. */
export function pageText(html: string): string {
  const $ = cheerio.load(html);
  $(DROP).remove();
  $('script[type="application/ld+json"]').remove();
  linearizePriceColumns($);
  // Free-positioned pages: read in visual rows (like the PDF reader), not in markup order.
  if ($('[data-ms-xy]').length >= 30) {
    const rows = (sandboxHelpers.visualRows as (q: cheerio.CheerioAPI) => { line: string }[])($);
    if (rows.length) return rows.map((r) => r.line).join('\n');
  }
  const out: string[] = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };
  // Iterative walk (an explicit stack): untrusted pages can nest thousands of levels deep.
  const body = $('body')[0] || $.root()[0];
  type Step = { node: AnyNode } | { close: true };
  const stack: Step[] = body ? [...(body as Element).children].reverse().map((node) => ({ node })) : [];
  while (stack.length) {
    const step = stack.pop()!;
    if ('close' in step) {
      flush();
      continue;
    }
    const node = step.node;
    if (node.type === 'text') {
      line += ' ' + (node as unknown as { data: string }).data;
      continue;
    }
    if (node.type !== 'tag') continue;
    const el = node as Element;
    const block = BLOCK.has(el.tagName);
    if (block) {
      flush();
      stack.push({ close: true });
    }
    if (el.tagName === 'td' || el.tagName === 'th') line += ' | ';
    for (let i = el.children.length - 1; i >= 0; i--) stack.push({ node: el.children[i]! });
  }
  flush();
  // Collapse runs of duplicate lines (sticky headers, repeated nav).
  return out.filter((l, i) => l !== out[i - 1]).join('\n');
}

/** JSON-LD blocks that look like menu data (schema.org Menu / offers). */
export function menuJsonLd(html: string, maxChars = 6000): string[] {
  const $ = cheerio.load(html);
  const blocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const t = $(el).text().trim();
    if (/Menu|hasMenuItem|offers|"price"/i.test(t)) blocks.push(t.length > maxChars ? t.slice(0, maxChars) + ' …(truncated)' : t);
  });
  return blocks;
}

function cssPath($: cheerio.CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.type === 'tag' && cur.tagName !== 'html') {
    let s = cur.tagName;
    const id = $(cur).attr('id');
    const cls = ($(cur).attr('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (id) s += `#${id}`;
    else if (cls.length) s += '.' + cls.join('.');
    parts.unshift(s);
    cur = cur.parent && cur.parent.type === 'tag' ? (cur.parent as Element) : null;
  }
  return parts.join(' > ');
}

/** The smallest element that contains (most of) the price-bearing nodes. */
export function findMenuRoot($: cheerio.CheerioAPI): { root: Element; priceNodes: number } | null {
  // The smallest elements whose full text is a short price-bearing snippet. Prices are
  // often split across elements (<span>179</span><span>kr</span>), so own text alone
  // misses them. One bottom-up pass, O(n): each element's text is assembled from its
  // children's and abandoned as soon as it is too long to be a price.
  const priceEls: Element[] = [];
  const MAX = 200;
  const visit = (node: AnyNode): { text: string | null; hasPrice: boolean } => {
    if (node.type === 'text') {
      const d = (node as unknown as { data: string }).data;
      return { text: d.length > MAX ? null : d, hasPrice: false };
    }
    if (node.type !== 'tag' && node.type !== 'root') return { text: '', hasPrice: false };
    let text = '';
    let tooLong = false;
    let descendantPrice = false;
    for (const c of (node as Element).children) {
      const r = visit(c);
      if (r.hasPrice) descendantPrice = true;
      if (r.text === null) tooLong = true;
      else if (!tooLong) {
        text += r.text;
        if (text.length > MAX) tooLong = true;
      }
    }
    if (node.type !== 'tag' || tooLong) return { text: null, hasPrice: descendantPrice };
    const t = text.replace(/\s+/g, ' ').trim();
    // "$12.50" / "189,-" — or a US-style bare price after the dish name ("Grouper Bites 25").
    const isPrice = !!t && ((t.length <= 40 && PRICE_RE.test(t)) || (t.length <= 70 && BARE_PRICE_LINE.test(t)));
    if (isPrice && !descendantPrice) priceEls.push(node as Element);
    return { text, hasPrice: isPrice || descendantPrice };
  };
  const body = $('body')[0] || $.root()[0];
  if (body) visit(body as AnyNode);
  if (priceEls.length < 2) return null;
  const counts = new Map<Element, number>();
  for (const p of priceEls) {
    let cur: Element | null = p;
    while (cur && cur.type === 'tag') {
      counts.set(cur, (counts.get(cur) || 0) + 1);
      cur = cur.parent && cur.parent.type === 'tag' ? (cur.parent as Element) : null;
    }
  }
  const need = Math.ceil(priceEls.length * 0.8);
  let best: Element | null = null;
  let bestDepth = -1;
  for (const [el, n] of counts) {
    if (n < need) continue;
    let depth = 0;
    for (let c = el.parent; c; c = c.parent) depth++;
    if (depth > bestDepth) {
      bestDepth = depth;
      best = el;
    }
  }
  return best ? { root: best, priceNodes: priceEls.length } : null;
}

function signature(el: Element): string {
  const cls = ((el.attribs?.class as string) || '').trim().split(/\s+/).sort().join('.');
  return `${el.tagName}.${cls}`;
}

interface SkeletonOptions {
  /** Keep this many leading siblings of a repeated run, plus the last one. */
  keepRepeated?: number;
  maxText?: number;
}

function render($: cheerio.CheerioAPI, node: AnyNode, o: Required<SkeletonOptions>, indent: string): string {
  if (node.type === 'text') {
    let t = (node as unknown as { data: string }).data.replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length > o.maxText) t = t.slice(0, o.maxText - 1) + '…';
    return indent + t + '\n';
  }
  if (node.type !== 'tag') return '';
  const el = node as Element;
  const attrs = Object.entries(el.attribs || {})
    .filter(([k]) => KEEP_ATTRS.has(k) || k.startsWith('data-'))
    .map(([k, v]) => {
      const val = String(v).length > 80 ? String(v).slice(0, 77) + '…' : String(v);
      return `${k}="${val}"`;
    });
  const open = `<${el.tagName}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  const kids = el.children.filter((c) => c.type === 'tag' || (c.type === 'text' && (c as unknown as { data: string }).data.trim()));
  if (!kids.length) return `${indent}${open}</${el.tagName}>\n`;
  // Inline short text-only elements.
  if (kids.length === 1 && kids[0]!.type === 'text') {
    const t = render($, kids[0]!, o, '').trim();
    return `${indent}${open}${t}</${el.tagName}>\n`;
  }
  let out = `${indent}${open}\n`;
  // Compress long runs of same-signature siblings: keep first N + last, note the count.
  let i = 0;
  while (i < kids.length) {
    const k = kids[i]!;
    if (k.type === 'tag') {
      const sig = signature(k as Element);
      let j = i;
      while (j + 1 < kids.length && kids[j + 1]!.type === 'tag' && signature(kids[j + 1] as Element) === sig) j++;
      const run = j - i + 1;
      if (run > o.keepRepeated + 2) {
        for (let x = i; x < i + o.keepRepeated; x++) out += render($, kids[x]!, o, indent + '  ');
        out += `${indent}  <!-- … ${run - o.keepRepeated - 1} more <${sig}> siblings with the same structure … -->\n`;
        out += render($, kids[j]!, o, indent + '  ');
        i = j + 1;
        continue;
      }
    }
    out += render($, k, o, indent + '  ');
    i++;
  }
  return out + `${indent}</${el.tagName}>\n`;
}

export interface Skeleton {
  /** CSS-ish path from <body> to the menu root. */
  rootPath: string;
  html: string;
  priceNodes: number;
  jsonLd: string[];
  truncated: boolean;
}

/**
 * Compact HTML of the menu region for code generation. Tries progressively harder
 * compression until it fits the character budget.
 */
/**
 * Locate the menu by its dish names when prices don't give it away (bare numbers like "235",
 * prices in separate widgets): the smallest element that holds most of the names a reading
 * found. Linear: each matched name walks up its ancestors once.
 */
export function findRootByNames($: cheerio.CheerioAPI, names: string[]): Element | null {
  const norm = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9æøå]+/g, ' ').trim();
  const wanted = [...new Set(names.map(norm).filter((n) => n.length >= 4))].slice(0, 300);
  if (wanted.length < 5) return null;
  const hits = new Map<string, Element>();
  const body = ($('body')[0] || $.root()[0]) as Element | undefined;
  const stack: AnyNode[] = body ? [...body.children] : [];
  let visited = 0;
  while (stack.length && visited++ < 200_000 && hits.size < wanted.length) {
    const n = stack.pop()!;
    if (n.type === 'text') {
      const t = norm((n as unknown as { data: string }).data);
      if (t.length < 4 || !n.parent) continue;
      for (const w of wanted) if (!hits.has(w) && t.includes(w)) hits.set(w, n.parent as Element);
    } else if (n.type === 'tag') for (const c of (n as Element).children) stack.push(c);
  }
  if (hits.size < Math.max(5, wanted.length * 0.5)) return null;
  const count = new Map<Element, number>();
  const depth = new Map<Element, number>();
  for (const el of hits.values()) {
    let d = 0;
    for (let p: Element | null = el; p && p.type === 'tag'; p = p.parent as Element | null, d++) {
      count.set(p, (count.get(p) ?? 0) + 1);
      if (!depth.has(p)) {
        let k = 0;
        for (let q = p.parent; q; q = q.parent) k++;
        depth.set(p, k);
      }
    }
  }
  const need = Math.ceil(hits.size * 0.8);
  let best: Element | null = null;
  for (const [el, c] of count) if (c >= need && (!best || depth.get(el)! > depth.get(best)!)) best = el;
  return best;
}

export function skeleton(html: string, budget = 28_000, names: string[] = []): Skeleton {
  const $ = cheerio.load(html);
  $(DROP).remove();
  $('*')
    .contents()
    .filter((_, n) => n.type === 'comment')
    .remove();
  const jsonLd = menuJsonLd(html);
  $('script[type="application/ld+json"]').remove();

  let found = findMenuRoot($);
  // Few recognisable prices: fall back to where the reading's dish names are.
  if ((!found || found.priceNodes < 5) && names.length) {
    const byNames = findRootByNames($, names);
    if (byNames) found = { root: byNames, priceNodes: found?.priceNodes ?? 0 };
  }
  const root = (found?.root || $('body')[0] || $.root()[0]) as Element;
  const rootPath = found ? cssPath($, found.root) : 'body';

  // Show the ancestors of the menu region as open tags, so selectors anchored above it are grounded.
  const ancestors: string[] = [];
  for (let p = root.parent; p && p.type === 'tag' && (p as Element).tagName !== 'html'; p = p.parent) {
    const el = p as Element;
    const attrs = ['id', 'class', 'role', 'data-section-type']
      .filter((k) => el.attribs?.[k])
      .map((k) => `${k}="${String(el.attribs[k]).slice(0, 80)}"`);
    ancestors.unshift(`<${el.tagName}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
  }
  const wrap = (inner: string) =>
    ancestors.length ? `<!-- ancestors of the menu region (siblings omitted) -->\n${ancestors.join('\n')}\n<!-- menu region: -->\n${inner}` : inner;
  for (const [keep, maxText] of [[6, 120], [4, 80], [3, 60], [2, 40], [1, 30]] as const) {
    const out = wrap(render($, root, { keepRepeated: keep, maxText }, ''));
    if (out.length <= budget) return { rootPath, html: out, priceNodes: found?.priceNodes ?? 0, jsonLd, truncated: false };
  }
  const out = wrap(render($, root, { keepRepeated: 1, maxText: 30 }, ''));
  return { rootPath, html: out.slice(0, budget) + '\n<!-- … skeleton truncated … -->', priceNodes: found?.priceNodes ?? 0, jsonLd, truncated: true };
}


/**
 * "Price column" layouts (Tilda zero-blocks and similar builders): one text block holds a
 * whole column of prices separated by <br>, positioned next to a block with the dish names
 * in the same order — there is no per-dish element. Returns how many such price columns
 * the page has and the class of a container that holds them, or null.
 */
export function detectPriceColumns(html: string): { columns: number; container: string | null } | null {
  if (!/<br/i.test(html)) return null;
  const $ = cheerio.load(html);
  const pairs = (sandboxHelpers.pairPriceColumns as (q: cheerio.CheerioAPI) => { priceEl: Element }[])($);
  if (pairs.length < 2) return null;
  let container: string | null = null;
  for (let p = $(pairs[0]!.priceEl).parent(), depth = 0; p.length && depth < 8 && !container; p = p.parent(), depth++) {
    const cls = (p.attr('class') || '').split(/\s+/).find((c) => /artboard|section|block|row|container/i.test(c));
    if (cls) container = `.${cls}`;
  }
  return { columns: pairs.length, container };
}
