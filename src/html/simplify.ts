import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

/**
 * Two views of a page:
 *   pageText()  — readable text with line breaks, for the oracle to READ the menu;
 *   skeleton()  — compact, structure-preserving HTML of the menu region, for the
 *                 forge model to WRITE selectors against.
 */

const DROP = 'script:not([type="application/ld+json"]), style, noscript, svg, iframe, canvas, video, audio, picture source, link, meta, template';
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'table', 'tbody', 'thead',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'footer', 'main', 'nav', 'aside', 'br', 'hr', 'figure', 'figcaption', 'form',
]);
const KEEP_ATTRS = new Set(['class', 'id', 'itemprop', 'itemtype', 'role', 'data-hook', 'data-testid', 'data-price', 'data-name', 'aria-label']);

/** A price-looking token: "189,-", "kr 189", "NOK 1 290", "$12.50", "149.-", "€9,90", "12.50 USD". */
export const PRICE_RE =
  /(?:(?:kr\.?|nok|sek|dkk|usd|eur|\$|€|£)\s?\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2})?)|(?:\b\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{1,2})?\s?(?:,-|\.-|kr\b|nok\b|usd\b|eur\b|€|\$))|(?:\b\d{1,4}[.,]\d{2}\b)/i;

/** Readable text, one block per line, for the oracle. */
export function pageText(html: string): string {
  const $ = cheerio.load(html);
  $(DROP).remove();
  $('script[type="application/ld+json"]').remove();
  const out: string[] = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
    line = '';
  };
  const walk = (node: AnyNode) => {
    if (node.type === 'text') {
      line += ' ' + (node as unknown as { data: string }).data;
      return;
    }
    if (node.type !== 'tag') return;
    const el = node as Element;
    const block = BLOCK.has(el.tagName);
    if (block) flush();
    if (el.tagName === 'td' || el.tagName === 'th') line += ' | ';
    for (const c of el.children) walk(c);
    if (block) flush();
  };
  const body = $('body')[0] || $.root()[0];
  if (body) for (const c of (body as Element).children) walk(c);
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
  // The smallest element whose full text is a price-bearing snippet. Prices are
  // often split across elements (<span>179</span><span>kr</span>), so own text
  // alone misses them.
  const priceEls: Element[] = [];
  $('body *').each((_, el) => {
    if (el.type !== 'tag') return;
    const e = el as Element;
    const t = $(e).text().replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40 || !PRICE_RE.test(t)) return;
    const childHas = $(e)
      .children()
      .toArray()
      .some((c) => PRICE_RE.test($(c).text().replace(/\s+/g, ' ').trim()));
    if (!childHas) priceEls.push(e);
  });
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
export function skeleton(html: string, budget = 28_000): Skeleton {
  const $ = cheerio.load(html);
  $(DROP).remove();
  $('*')
    .contents()
    .filter((_, n) => n.type === 'comment')
    .remove();
  const jsonLd = menuJsonLd(html);
  $('script[type="application/ld+json"]').remove();

  const found = findMenuRoot($);
  const root = (found?.root || $('body')[0] || $.root()[0]) as Element;
  const rootPath = found ? cssPath($, found.root) : 'body';

  for (const [keep, maxText] of [[6, 120], [4, 80], [3, 60], [2, 40], [1, 30]] as const) {
    const out = render($, root, { keepRepeated: keep, maxText }, '');
    if (out.length <= budget) return { rootPath, html: out, priceNodes: found?.priceNodes ?? 0, jsonLd, truncated: false };
  }
  const out = render($, root, { keepRepeated: 1, maxText: 30 }, '');
  return { rootPath, html: out.slice(0, budget) + '\n<!-- … skeleton truncated … -->', priceNodes: found?.priceNodes ?? 0, jsonLd, truncated: true };
}
