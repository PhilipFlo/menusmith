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
function parsePrice(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  let s = String(input).replace(/ | /g, ' ').trim();
  if (!s) return null;
  // First run of digits with optional thousand separators / decimals.
  const m = s.match(/\d{1,3}(?:[ .,'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
  if (!m) return null;
  let num = m[0];
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
