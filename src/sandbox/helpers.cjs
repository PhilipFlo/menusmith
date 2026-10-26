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
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 10);
    const value = toNumber(m[0]);
    if (value === null) continue;
    const isNumbering = m.index === 0 && /^\s*[.)]\s+\S/.test(after) && /^\d{1,3}$/.test(m[0]);
    const isUnit = UNIT_AFTER.test(after);
    const hasCurrency = CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after);
    cands.push({ value, hasCurrency, skip: isNumbering || (isUnit && !hasCurrency) });
  }
  if (!cands.length) return null;
  const withCurrency = cands.find((c) => c.hasCurrency && !c.skip);
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

/** The lines of an element, split on <br> (tags stripped). Empty lines dropped unless keepEmpty. */
function brLines($, el, keepEmpty) {
  const html = $(el).html() || '';
  const lines = html.split(/<br\s*\/?>/i).map((l) => cleanText($('<x>' + l + '</x>').text()));
  return keepEmpty ? lines : lines.filter(Boolean);
}

/** Paragraphs of a <br>-separated block: runs of non-empty lines between blank lines. */
function brParagraphs($, el) {
  const out = [];
  let cur = [];
  for (const l of brLines($, el, true)) {
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

/**
 * "Price column" layouts (Tilda zero-blocks and similar builders): a block holding a column
 * of prices (one per <br> line) sits next to a block holding the dish names in the same
 * order — one dish per line, or per paragraph (name line, description lines, blank line).
 * Returns each matched pair of blocks with its entries and prices.
 */
function pairPriceColumns($) {
  const pairs = [];
  const isLeaf = (el) => !$(el).find(BLOCKS).toArray().some((c) => brLines($, c).length > 1);
  const textBlocks = $(BLOCKS)
    .toArray()
    .filter((el) => isLeaf(el) && cleanText($(el).text()));
  const order = new Map(textBlocks.map((el, i) => [el, i]));
  const priceBlocks = textBlocks.filter((el) => {
    const ls = brLines($, el);
    return ls.length >= 2 && ls.every((l) => PRICE_LINE.test(l));
  });
  const used = new Set();
  for (const pb of priceBlocks) {
    const prices = brLines($, pb);
    // Smallest ancestor that also holds a matching name block.
    let best = null;
    let scope = $(pb).parent();
    for (let depth = 0; depth < 6 && scope.length && !best; depth++, scope = scope.parent()) {
      const cands = scope
        .find(BLOCKS)
        .toArray()
        .filter((el) => el !== pb && order.has(el) && !used.has(el))
        .map((el) => {
          const lines = brLines($, el).filter((l) => !FOOTNOTE.test(l));
          const paras = brParagraphs($, el).filter((p) => !FOOTNOTE.test(p[0]));
          const entries = lines.length === prices.length ? lines.map((l) => [l]) : paras.length === prices.length ? paras : null;
          return { el, lines, entries };
        })
        .filter((c) => c.entries && !c.lines.every((l) => PRICE_LINE.test(l)));
      if (cands.length) {
        // Nearest in document order to the price block.
        cands.sort((a, b) => Math.abs(order.get(a.el) - order.get(pb)) - Math.abs(order.get(b.el) - order.get(pb)));
        best = cands[0];
      }
    }
    if (!best) continue;
    used.add(best.el);
    // Section: nearest preceding single-line block that isn't a price.
    let section = null;
    for (let i = order.get(best.el) - 1; i >= 0 && i >= order.get(best.el) - 6; i--) {
      const ls = brLines($, textBlocks[i]);
      if (ls.length === 1 && !PRICE_LINE.test(ls[0]) && ls[0].length <= 40) {
        section = ls[0];
        break;
      }
    }
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

module.exports = { parsePrice, cleanText, normName, priceColumns, pairPriceColumns };
