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

describe('parsePrice skips numbering and quantities (benchmark findings)', () => {
  const { parsePrice } = createRequire(import.meta.url)('../src/sandbox/helpers.cjs') as { parsePrice: (s: unknown) => number | null };
  it.each([
    ['17. Gustosa 190,-', 190],
    ['1 stk 175,-', 175],
    ['2 stk · 69 kr', 69],
    ['0,5 l 35,-', 35],
    ['33 cl fl 55,-', 55],
    ['8 biter 159', 159],
    ['120 g', null],
  ])('%s → %s', (input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });
});

describe('price-column layouts (Tilda zero-blocks)', () => {
  // Names in one block, prices in a neighbouring block, paired only by order.
  const page = `<html><body>
    <div class="t396__artboard"><div class="tn-elem"><div class="tn-atom">Seafood</div></div>
      <div class="tn-elem"><div class="tn-atom">SPANISH OCTOPUS<br>Grilled octopus, baby potatoes,<br>tomato sauce<br><br>BRANZINO<br>Branzino fillet<br><br>*add salad +5$</div></div>
      <div class="tn-elem"><div class="tn-atom"><strong>$ 34</strong><br><br><strong>$ 41</strong></div></div></div>
    <div class="t396__artboard"><div class="tn-elem"><div class="tn-atom">Sides</div></div>
      <div class="tn-elem"><div class="tn-atom">FRENCH FRIES<br><br>STEAMED RICE<br><br>GRILLED ASPARAGUS</div></div>
      <div class="tn-elem"><div class="tn-atom">$ 7<br><br>$ 8<br><br>$ 9</div></div></div>
  </body></html>`;
  const { priceColumns } = require('../src/sandbox/helpers.cjs') as { priceColumns: ($: unknown) => { section: string | null; name: string; description: string | null; price: number | null }[] };

  it('pairs each name (one per paragraph or line) with the price in the same position', async () => {
    const cheerio = await import('cheerio');
    const items = priceColumns(cheerio.load(page));
    expect(items.map((i) => [i.name, i.price])).toEqual([
      ['SPANISH OCTOPUS', 34],
      ['BRANZINO', 41],
      ['FRENCH FRIES', 7],
      ['STEAMED RICE', 8],
      ['GRILLED ASPARAGUS', 9],
    ]);
    expect(items[0]!.description).toBe('Grilled octopus, baby potatoes, tomato sauce');
    expect(items[0]!.section).toBe('Seafood');
  });

  it('page text for the reader puts every dish next to its own price', async () => {
    const { pageText, detectPriceColumns } = await import('../src/html/simplify.ts');
    expect(detectPriceColumns(page)?.columns).toBe(2);
    const t = pageText(page);
    expect(t).toContain('SPANISH OCTOPUS — $ 34');
    expect(t).toContain('STEAMED RICE — $ 8');
    expect(t).not.toMatch(/^\$ 41$/m); // the loose price column is gone
  });
});

describe('price-column pairing stays cheap on hostile pages', () => {
  // Found by review: each of these took 10–70 s with the first implementation.
  const timed = async (html: string) => {
    const { pageText, detectPriceColumns } = await import('../src/html/simplify.ts');
    const t0 = Date.now();
    pageText(html);
    detectPriceColumns(html);
    return Date.now() - t0;
  };
  it('a deep wrapper chain with many blocks and many pairs', async () => {
    let pairs = '';
    for (let i = 0; i < 120; i++) pairs += `<div>$7<br>$8</div><div>A${i}<br>B${i}</div>`;
    const html = `<body><div>${'<div>'.repeat(300)}${'<p>x</p>'.repeat(5000)}${'</div>'.repeat(300)}${pairs}</div></body>`;
    expect(await timed(html)).toBeLessThan(3000);
  });
  it('thousands of line breaks inside deeply nested inline tags', async () => {
    const html = `<body><div>${'<b>'.repeat(2000)}${'x<br>'.repeat(20000)}${'</b>'.repeat(2000)}</div></body>`;
    expect(await timed(html)).toBeLessThan(3000);
  });
  it('page text survives 5,000 levels of nesting', async () => {
    const { pageText } = await import('../src/html/simplify.ts');
    const html = `<body>${'<div>'.repeat(5000)}Pizza 129,-${'</div>'.repeat(5000)}</body>`;
    expect(pageText(html)).toContain('Pizza 129,-');
  });
  it('a page with thousands of <br> price blocks is parsed quickly and left alone', async () => {
    const { pageText } = await import('../src/html/simplify.ts');
    const block = '<div><div>$ 1<br>$ 2<br>$ 3</div><div>A<br>B<br>C</div></div>';
    const page = `<html><body>${block.repeat(3000)}</body></html>`;
    const t0 = Date.now();
    const text = pageText(page);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(text).not.toContain('A — $ 1'); // over the work limit: not rewritten
  });
});

describe('free-positioned pages (Canva-style)', () => {
  // Every text box is placed by position only; the renderer records it as data-ms-xy.
  const box = (x: number, y: number, t: string) => `<div data-ms-xy="${x},${y}"><p>${t}</p></div>`.replace('<p>', '').replace('</p>', '');
  const page =
    '<body>' +
    [
      box(600, 10, 'Pizza'), // heading alone on its row? no — sits with dishes below
      box(10, 100, 'Pancetta Classics'),
      box(200, 100, '1 - Margherita'),
      box(400, 100, '145'),
      box(450, 100, '235'),
      box(600, 100, '2 - Capricciosa'),
      box(800, 100, '155'),
      box(850, 100, '245'),
      box(200, 120, 'Ost og tomatsaus'),
      box(600, 121, 'Skinke og champignon'),
      box(200, 200, '3 - Hawaii'),
      box(400, 200, '165'),
    ].join('') +
    '</body>';
  const { visualRows, visualDishes } = require('../src/sandbox/helpers.cjs') as {
    visualRows: ($: unknown) => { line: string }[];
    visualDishes: ($: unknown) => { section: string | null; name: string; description: string | null; price: number | null }[];
  };
  it('groups boxes into rows by position, left to right', async () => {
    const cheerio = await import('cheerio');
    const rows = visualRows(cheerio.load(page));
    expect(rows[1]!.line).toBe('Pancetta Classics | 1 - Margherita | 145 | 235 | 2 - Capricciosa | 155 | 245');
    expect(rows[2]!.line).toBe('Ost og tomatsaus | Skinke og champignon'); // 1 px apart = same row
  });
  it('rebuilds dishes across side-by-side columns, with descriptions from the same column', async () => {
    const cheerio = await import('cheerio');
    const d = visualDishes(cheerio.load(page));
    expect(d.map((x) => [x.section, x.name, x.price, x.description])).toEqual([
      ['Pancetta Classics', '1 - Margherita', 145, 'Ost og tomatsaus'],
      ['Pancetta Classics', '2 - Capricciosa', 155, 'Skinke og champignon'],
      ['Pancetta Classics', '3 - Hawaii', 165, null],
    ]);
  });
  it('pages without recorded positions are unaffected', async () => {
    const cheerio = await import('cheerio');
    expect(visualRows(cheerio.load('<body><p>Pizza 129,-</p></body>'))).toEqual([]);
  });
});
