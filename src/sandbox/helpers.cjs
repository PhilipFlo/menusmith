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

module.exports = { parsePrice, cleanText, normName };
