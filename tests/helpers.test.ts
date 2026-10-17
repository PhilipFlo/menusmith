import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parsePrice, cleanText, normName } = require('../src/sandbox/helpers.cjs') as {
  parsePrice: (s: unknown) => number | null;
  cleanText: (s: unknown) => string;
  normName: (s: unknown) => string;
};

describe('parsePrice', () => {
  const cases: [unknown, number | null][] = [
    ['189,-', 189],
    ['kr 189', 189],
    ['NOK 1 290', 1290],
    ['1.290,00 kr', 1290],
    ['$12.50', 12.5],
    ['12', 12],
    ['189 / 249', 189],
    ['Dagens pris', null],
    ['', null],
    [null, null],
    ['1,290', 1290],
    ['€ 9,90', 9.9],
    ['149.-', 149],
    // formats used by the fixture sites
    ['kr 1 290,-', 1290],
    ['1 290 kr', 1290], // non-breaking space as thousands separator
    ['kr 189', 189],
    ['Glass $14 / Bottle $52', 14],
    ['14 | 52', 14],
    ['US$18.50', 18.5],
    ['$4.25 USD', 4.25],
    ['Liten 129,- / Stor 179,-', 129],
    ['179 NOK', 179],
    ['  \n kr 59 \t', 59],
    ['dagspris', null],
    [undefined, null],
    [42, 42],
    [-5, null],
    [Number.NaN, null],
  ];
  it.each(cases)('parsePrice(%j) -> %j', (input, want) => {
    expect(parsePrice(input)).toBe(want);
  });
});

describe('cleanText', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanText('  Spaghetti \n\t alla   carbonara  ')).toBe('Spaghetti alla carbonara');
  });
  it('handles null/undefined', () => {
    expect(cleanText(null)).toBe('');
    expect(cleanText(undefined)).toBe('');
  });
});

describe('normName', () => {
  it('lowercases and strips accents', () => {
    expect(normName('Tiramisù della casa')).toBe('tiramisu della casa');
    expect(normName('Bánh Mì Gà')).toBe('banh mi ga');
    expect(normName('Crème Brûlée')).toBe('creme brulee');
  });
  it('strips punctuation', () => {
    expect(normName('Halloumi & Rødbete!')).toBe('halloumi rødbete');
    expect(normName("'Nduja e Miele")).toBe('nduja e miele');
    expect(normName('Pan-Roasted Half Chicken')).toBe('pan roasted half chicken');
  });
  it('strips bracketed allergen numbers', () => {
    expect(normName('Margherita (1,7)')).toBe('margherita');
    expect(normName('Napoletana (1,4,7)')).toBe(normName('Napoletana'));
  });
  it('keeps Norwegian letters æ and ø', () => {
    expect(normName('Smørbrød med reker')).toBe('smørbrød med reker');
    expect(normName('Grønnsaksbiff med ærter')).toBe('grønnsaksbiff med ærter');
  });
  it('collapses whitespace', () => {
    expect(normName('  Café   Loft!! ')).toBe('cafe loft');
  });
  // BUG (src/sandbox/helpers.cjs normName): Vietnamese "đ"/"Đ" (U+0111/U+0110) has no
  // NFKD decomposition, so it is not turned into "d" — it is deleted by the
  // [^a-z0-9æøå ] filter. "Phở Đặc Biệt" -> "pho ac biet" instead of "pho dac biet".
  // Matching is still symmetric (both sides lose the letter), but names lose
  // information and short tokens ("Đá" -> "a") vanish entirely from token sets.
  it('maps Vietnamese đ/Đ to d', () => {
    expect(normName('Phở Đặc Biệt')).toBe('pho dac biet');
  });
});
