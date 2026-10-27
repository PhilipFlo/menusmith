'use strict';
/**
 * Helpers exposed to generated extractors inside the sandbox (and reused by the
 * host for scoring). Plain CommonJS so the sandbox harness can load it without a
 * TypeScript toolchain.
 *
 * Generated code gets these as globals: `parsePrice`, `cleanText`.
 */

/**
 * Parse a menu price string into a number, or null when there is no price.
 *
 * Handles the formats seen on real menus:
 *   "189,-"  "kr 189"  "NOK 1 290"  "1.290,00 kr"  "$12.50"  "12"  "189 / 249"
 * For ranges/multiple prices ("189 / 249") the FIRST price is returned — size
 * variants are a separate concern from extraction.
 */
function toNumber(num) {
  // Decide what the separators mean.
  const lastSep = Math.max(num.lastIndexOf(','), num.lastIndexOf('.'));
  if (lastSep !== -1) {
    const decimals = num.length - lastSep - 1;
    if (decimals === 3) {
      // "1.290" / "1,290" → thousands separator
      num = num.replace(/[ .,'’]/g, '');
    } else {
      const intPart = num.slice(0, lastSep).replace(/[ .,'’]/g, '');
      num = intPart + '.' + num.slice(lastSep + 1);
    }
  } else {
    num = num.replace(/[ '’]/g, '');
  }
  const v = Number(num);
  if (!Number.isFinite(v) || v < 0 || v > 1_000_000) return null;
  return Math.round(v * 100) / 100;
}

const CURRENCY_BEFORE = /(kr\.?|nok|sek|dkk|usd|eur|us\$|\$|€|£)\s*$/i;
const CURRENCY_AFTER = /^\s*(,-|\.-|,–|kr\b|nok\b|sek\b|dkk\b|usd\b|eur\b|€|\$)/i;
// Quantities and sizes that are not prices: "2 stk", "0,5 l", "33 cl", "120 g", "8 biter", "3x".
const UNIT_AFTER = /^\s*(stk|pcs|pc|biter|bitar|pieces|x\b|cl\b|ml\b|dl\b|l\b|ltr|liter|g\b|gr\b|gram|kg\b|cm\b|%|oz\b|personer|pers\b|people|kuler)/i;

/**
 * Parse a menu price string into a number, or null when there is no price.
 *
 * Handles the formats seen on real menus:
 *   "189,-"  "kr 189"  "NOK 1 290"  "1.290,00 kr"  "$12.50"  "12"  "189 / 249"
 * When the text holds several numbers it does NOT blindly take the first one: list
 * numbering ("17. Gustosa 190,-") and quantities ("2 stk · 69 kr", "0,5 l 35,-") are
 * skipped, and a number next to a currency marker wins. Among equally good
 * candidates (e.g. sizes "189 / 249") the FIRST is returned.
 */
function parsePrice(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  const s = String(input).replace(/\u00a0|\u202f/g, ' ').trim();
  if (!s) return null;
  const re = /\d{1,3}(?:[ .,'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;
  const cands = [];
  const ends = [];
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 10);
    const value = toNumber(m[0]);
    if (value === null) continue;
    const isNumbering = m.index === 0 && /^\s*[.)]\s+\S/.test(after) && /^\d{1,3}$/.test(m[0]);
    const isUnit = UNIT_AFTER.test(after);
    const currencyBefore = CURRENCY_BEFORE.test(before);
    const hasCurrency = currencyBefore || CURRENCY_AFTER.test(after);
    // A number followed by a word is part of the dish name ("Category “5” Shrimp 21",
    // "3 Cheese Pizza 18") — when another number follows to be the price.
    const inName = !hasCurrency && /^\s*["”’']?\s*\p{L}/u.test(after);
    cands.push({ value, hasCurrency, currencyBefore, skip: isNumbering || (isUnit && !hasCurrency), inName });
    ends.push(m.index + m[0].length);
  }
  for (let k = 0; k < cands.length - 1; k++) if (cands[k].inName && !cands[k].skip) cands[k].skip = cands.slice(k + 1).some((c) => !c.skip);
  if (!cands.length) return null;
  // "$14" / "kr 189" (marker right before the number) beats a marker after one: in
  // "Combo 2 $14" the "$" belongs to 14, not to 2.
  const withCurrency = cands.find((c) => c.currencyBefore && !c.skip) || cands.find((c) => c.hasCurrency && !c.skip);
  if (withCurrency) return withCurrency.value;
  const plain = cands.find((c) => !c.skip);
  if (plain) return plain.value;
  return cands.length === 1 && !UNIT_AFTER.test(s.slice(String(cands[0].value).length)) ? cands[0].value : null;
}

/** Collapse whitespace and trim. */
function cleanText(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Normalise a dish name for matching: lowercase, strip accents/punctuation/numbers-in-brackets. */
function normName(s) {
  return cleanText(s)
    .toLowerCase()
    // đ (Vietnamese) and ł (Polish) don't decompose under NFKD.
    .replace(/đ/g, 'd')
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9æøå ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRICE_LINE = /^(?:[$€£]|kr\.?|nok)?\s*\d{1,4}(?:[.,]\d{1,2})?(?:\s*\/\s*\d{1,4}(?:[.,]\d{1,2})?)?\s*(?:,-|kr\.?|nok|[$€£])?$/i;
const BLOCKS = 'div, p, td, span, h1, h2, h3, h4, h5, h6';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(t) {
  return t.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

/** The lines of an element, split on <br> (tags stripped). Empty lines dropped unless keepEmpty. */
function brLines($, el, keepEmpty) {
  const html = $(el).html() || '';
  const lines = html.split(/<br\s*\/?>/i).map((l) => cleanText(decodeEntities(l.replace(/<[^>]*>/g, ''))));
  return keepEmpty ? lines : lines.filter(Boolean);
}

/** Paragraphs of a list of lines: runs of non-empty lines between blank lines. */
function toParagraphs(lines) {
  const out = [];
  let cur = [];
  for (const l of lines) {
    if (l) cur.push(l);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A footnote under a column ("*add chicken +10$ …") is not a dish. */
const FOOTNOTE = /^[*†‡※]/;
// Work limits: this also runs on every page the reader sees, including untrusted ones, so
// every loop is bounded and nothing re-scans the document.
const MAX_BRS = 20000;
const MAX_BLOCKS = 1500;
const MAX_PRICE_BLOCKS = 120;
const MAX_DEPTH = 400; // deeper documents are not menus (and deep serialisation overflows)
const BLOCK_TAGS = new Set(['div', 'p', 'td', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const isBlock = (n) => n && n.type === 'tag' && BLOCK_TAGS.has(n.name);

/**
 * "Price column" layouts (Tilda zero-blocks and similar builders): a block holding a column
 * of prices (one per <br> line) sits next to a block holding the dish names in the same
 * order — one dish per line, or per paragraph (name line, description lines, blank line).
 * Returns each matched pair of blocks with its entries and prices.
 *
 * Linear in page size: it starts from the <br> elements, serialises only the blocks that
 * hold them (which never nest), and looks a price block's partners up by line count.
 */
function pairPriceColumns($) {
  const brs = $('br').toArray();
  if (brs.length < 4 || brs.length > MAX_BRS) return [];
  // Blocks that directly hold line breaks (through inline wrappers like <strong>).
  const holderOf = new Map(); // br's parent → its block (cached: many brs share a parent)
  const holders = new Set();
  for (const br of brs) {
    const parent = br.parent;
    if (!parent) continue;
    if (!holderOf.has(parent)) {
      let b = parent;
      for (let d = 0; b && !isBlock(b) && d < 12; d++) b = b.parent;
      holderOf.set(parent, isBlock(b) ? b : null);
    }
    const h = holderOf.get(parent);
    if (h) holders.add(h);
    if (holders.size > MAX_BLOCKS) return [];
  }
  // Ancestor chains (bounded) — also guards against pathologically deep documents.
  const chain = new Map();
  for (const h of holders) {
    const anc = [];
    let depth = 0;
    for (let p = h.parent; p; p = p.parent) {
      if (++depth > MAX_DEPTH) return [];
      if (anc.length < 8) anc.push(p);
    }
    chain.set(h, anc);
  }
  // Keep the innermost holders: one that contains another mixes two columns.
  const outer = new Set();
  for (const h of holders) for (const a of chain.get(h)) if (holders.has(a)) outer.add(a);
  const leaves = [...holders].filter((h) => !outer.has(h));
  const order = new Map(leaves.map((el, i) => [el, i]));
  const info = new Map();
  const byCount = new Map(); // line or paragraph count → leaves
  const index = (n, el) => {
    if (!byCount.has(n)) byCount.set(n, new Set());
    byCount.get(n).add(el);
  };
  for (const el of leaves) {
    const all = brLines($, el, true);
    const raw = all.filter(Boolean);
    const lines = raw.filter((l) => !FOOTNOTE.test(l));
    const paras = toParagraphs(all).filter((p) => !FOOTNOTE.test(p[0]));
    const allPrices = raw.length > 0 && raw.every((l) => PRICE_LINE.test(l));
    info.set(el, { raw, lines, paras, allPrices });
    if (!allPrices) {
      index(lines.length, el);
      index(paras.length, el);
    }
  }
  const priceBlocks = leaves.filter((el) => info.get(el).allPrices && info.get(el).raw.length >= 2);
  if (priceBlocks.length > MAX_PRICE_BLOCKS) return [];
  const pairs = [];
  const used = new Set();
  for (const pb of priceBlocks) {
    const prices = info.get(pb).raw;
    const pbAnc = chain.get(pb).slice(0, 6);
    // Only leaves with the right number of entries can be the name column.
    let best = null;
    let bestLevel = Infinity;
    for (const el of byCount.get(prices.length) || []) {
      if (used.has(el)) continue;
      const { lines, paras } = info.get(el);
      const entries = lines.length === prices.length ? lines.map((l) => [l]) : paras.length === prices.length ? paras : null;
      if (!entries) continue;
      // Smallest shared container (level along the price block's ancestors), then nearest.
      const anc = chain.get(el);
      const level = pbAnc.findIndex((a) => anc.includes(a));
      if (level < 0) continue;
      const dist = Math.abs(order.get(el) - order.get(pb));
      if (level < bestLevel || (level === bestLevel && dist < best.dist)) {
        best = { el, entries, dist };
        bestLevel = level;
      }
    }
    if (!best) continue;
    used.add(best.el);
    // Section: the one short single-line title inside the same container (builders like Tilda
    // place it anywhere in the markup). Bounded walk; nested wrappers repeat the same text.
    const titles = new Set();
    const stack = [pbAnc[bestLevel]];
    for (let visited = 0; stack.length && visited < 400; visited++) {
      const n = stack.pop();
      const kids = (n.children || []).filter((c) => c.type === 'tag');
      if (n !== pbAnc[bestLevel] && isBlock(n) && !info.has(n) && !kids.some(isBlock)) {
        const t = cleanText($(n).text());
        if (t && t.length <= 40 && !PRICE_LINE.test(t) && !FOOTNOTE.test(t)) titles.add(t);
        continue;
      }
      for (const c of kids) if (!info.has(c)) stack.push(c);
    }
    const section = titles.size === 1 ? [...titles][0] : null;
    pairs.push({ nameEl: best.el, priceEl: pb, section, entries: best.entries, prices });
  }
  return pairs;
}

/** Every dish in a price-column layout: [{section, name, description, price}]. */
function priceColumns($) {
  const out = [];
  for (const p of pairPriceColumns($)) {
    p.entries.forEach((entry, k) => {
      const name = entry[0];
      if (/:$/.test(name)) return; // "Monday:" — opening hours, not dishes
      out.push({ section: p.section, name, description: entry.slice(1).join(' ') || null, price: parsePrice(p.prices[k]) });
    });
  }
  return out;
}

/**
 * Free-positioned pages (Canva-style sites): the renderer records each text box's position as
 * data-ms-xy="x,y". Returns the page's text in reading order, grouped into visual rows:
 * [{y, cells: [{x, text}], line}] — a dish's name and its price(s) usually share a row.
 * Empty on pages without positions.
 */
function visualRows($) {
  const cells = [];
  for (const el of $('[data-ms-xy]').toArray().slice(0, 5000)) {
    const xy = String($(el).attr('data-ms-xy') || '').split(',').map(Number);
    if (xy.length !== 2 || !xy.every(Number.isFinite)) continue;
    // Own text only: nested boxes carry their own positions.
    const text = cleanText((el.children || []).filter((c) => c.type === 'text').map((c) => c.data).join(' '));
    if (text) cells.push({ x: xy[0], y: xy[1], text });
  }
  cells.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const c of cells) {
    const row = rows[rows.length - 1];
    if (row && c.y - row.y <= 8) row.cells.push(c);
    else rows.push({ y: c.y, cells: [c] });
  }
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    r.line = r.cells.map((c) => c.text).join(' | ');
  }
  return rows;
}

/**
 * Dishes from a free-positioned page (see visualRows): in a row, a non-price cell starts a dish
 * and the price cells after it are its prices (first = the price); rows without prices below
 * a dish, in the same column (x within 40 px), are its description; a single short row without
 * prices directly above priced rows is a section heading. Handles menus laid out in several
 * columns side by side. [{section, name, description, price}]
 */
function visualDishes($) {
  const isPrice = (t) => PRICE_LINE.test(t);
  const rows = visualRows($);
  const out = [];
  let section = null;
  let open = []; // dishes from the latest priced row, by x
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells;
    const priced = cells.some((c) => isPrice(c.text));
    if (priced) {
      open = [];
      let cur = null;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        if (isPrice(c.text)) {
          if (cur && cur.price === null) cur.price = parsePrice(c.text);
          continue;
        }
        // A non-price cell followed directly by another one is a heading on the dishes' row.
        const next = cells[k + 1];
        if (next && !isPrice(next.text) && c.text.length <= 40) {
          section = c.text;
          for (const d of out) if (d.price === null && d.name === c.text) d.price = undefined;
          continue;
        }
        cur = { section, name: c.text, description: null, price: null, x: c.x };
        out.push(cur);
        open.push(cur);
      }
      continue;
    }
    const nextPriced = rows[i + 1] && rows[i + 1].cells.some((c) => isPrice(c.text));
    if (cells.length === 1 && cells[0].text.length <= 40 && nextPriced) {
      section = cells[0].text;
      open = [];
      continue;
    }
    for (const c of cells) {
      const d = open.find((o) => Math.abs(o.x - c.x) <= 40);
      if (d) d.description = d.description ? `${d.description} ${c.text}` : c.text;
    }
  }
  return out.filter((d) => d.price !== null && d.price !== undefined).map(({ x, ...d }) => d);
}

module.exports = { parsePrice, cleanText, normName, priceColumns, pairPriceColumns, visualRows, visualDishes };
