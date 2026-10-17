import { describe, expect, it } from 'vitest';
import { itemsHash, nameSimilarity, normName, PASS, samePrice, scoreAgainstOracle } from '../src/agent/evaluate.ts';
import type { MenuItem } from '../src/types.ts';

const MENU: MenuItem[] = [
  { section: 'Antipasti', name: 'Bruschetta al pomodoro', description: 'Tomat og basilikum', price: 119 },
  { section: 'Antipasti', name: 'Burrata pugliese', description: null, price: 179 },
  { section: 'Antipasti', name: 'Carpaccio di manzo', description: null, price: 189 },
  { section: 'Primi', name: 'Spaghetti alla carbonara', description: null, price: 219 },
  { section: 'Primi', name: 'Tagliatelle al ragù', description: null, price: 225 },
  { section: 'Primi', name: 'Pappardelle ai funghi porcini', description: null, price: 239 },
  { section: 'Primi', name: 'Risotto al limone', description: null, price: 265 },
  { section: 'Secondi', name: 'Saltimbocca alla romana', description: null, price: 335 },
  { section: 'Secondi', name: 'Branzino al forno', description: null, price: 349 },
  { section: 'Dolci', name: 'Tiramisù della casa', description: null, price: 129 },
];

const PAGE = MENU.map((m) => `${m.name} ${m.price},-`).join('\n') + '\nDagens pasta Focaccia della nonna';

describe('nameSimilarity / samePrice', () => {
  it('identical names are 1, substring names are 0.9, unrelated are low', () => {
    expect(nameSimilarity('margherita', 'margherita')).toBe(1);
    expect(nameSimilarity('kebab i pita', '12 kebab i pita')).toBe(0.9);
    expect(nameSimilarity('pho ga', 'banh mi chay')).toBeLessThan(0.6);
  });
  it('prices within tolerance are the same', () => {
    expect(samePrice(189, 189)).toBe(true);
    expect(samePrice(12.5, 12.75)).toBe(true); // 0.5 absolute tolerance
    expect(samePrice(189, 199)).toBe(false);
    expect(samePrice(null, null)).toBe(true);
    expect(samePrice(null, 189)).toBe(false);
  });
});

describe('scoreAgainstOracle', () => {
  it('identical lists -> f1 1 and pass', () => {
    const s = scoreAgainstOracle(MENU, MENU, PAGE);
    expect(s.f1).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.pass).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.extra).toEqual([]);
    expect(s.wrongPrice).toEqual([]);
  });

  it('is insensitive to order, accents and allergen brackets', () => {
    const shuffled = [...MENU].reverse().map((m) => ({ ...m, name: m.name.normalize('NFD').replace(/[̀-ͯ]/g, '') + ' (1,7)' }));
    expect(scoreAgainstOracle(MENU, shuffled, PAGE).pass).toBe(true);
  });

  it('missing 20% of items -> fails on recall', () => {
    const partial = MENU.slice(0, 8);
    const s = scoreAgainstOracle(MENU, partial, PAGE);
    expect(s.recall).toBeCloseTo(0.8, 5);
    expect(s.recall).toBeLessThan(PASS.minRecall);
    expect(s.precision).toBe(1);
    expect(s.pass).toBe(false);
    expect(s.missing.map((m) => m.name)).toEqual(['Branzino al forno', 'Tiramisù della casa']);
  });

  it('wrong prices are reported in wrongPrice and not counted as correct', () => {
    const wrong = MENU.map((m, i) => (i < 2 ? { ...m, price: (m.price ?? 0) + 30 } : m));
    const s = scoreAgainstOracle(MENU, wrong, PAGE);
    expect(s.wrongPrice).toHaveLength(2);
    expect(s.wrongPrice[0]).toEqual({ name: 'Bruschetta al pomodoro', expected: 119, got: 149 });
    expect(s.wrongPrice[1]).toEqual({ name: 'Burrata pugliese', expected: 179, got: 209 });
    expect(s.matched).toBe(MENU.length - 2);
    expect(s.recall).toBeCloseTo(0.8, 5);
    expect(s.pass).toBe(false);
  });

  it('extra items that occur in the page text are not penalised', () => {
    const extra = [...MENU, { section: 'Primi', name: 'Dagens pasta', price: 189 }, { section: null, name: 'Focaccia della nonna', price: 59 }];
    const s = scoreAgainstOracle(MENU, extra, PAGE);
    expect(s.precision).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.extra).toEqual([]); // grounded extras are not listed as "extra"
    expect(s.pass).toBe(true);
  });

  it('ungrounded (hallucinated) items are penalised', () => {
    const halluc: MenuItem[] = [
      ...MENU,
      { name: 'Lasagne al forno', price: 239 },
      { name: 'Pizza quattro stagioni', price: 199 },
      { name: 'Gelato misto', price: 99 },
    ];
    const s = scoreAgainstOracle(MENU, halluc, PAGE);
    expect(s.precision).toBeCloseTo(10 / 13, 3);
    expect(s.extra.map((e) => e.name)).toEqual(['Lasagne al forno', 'Pizza quattro stagioni', 'Gelato misto']);
    expect(s.pass).toBe(false); // 3 ungrounded > max(2, 5% of 13)
  });

  it('empty extractor output fails', () => {
    const s = scoreAgainstOracle(MENU, [], PAGE);
    expect(s.pass).toBe(false);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.extractorCount).toBe(0);
    expect(s.missing).toHaveLength(MENU.length);
  });

  it('empty output fails even against an empty oracle', () => {
    expect(scoreAgainstOracle([], [], '').pass).toBe(false);
  });

  it('a priced menu extracted without prices fails', () => {
    const s = scoreAgainstOracle(MENU, MENU.map((m) => ({ ...m, price: null })), PAGE);
    expect(s.pricedRatio).toBe(0);
    expect(s.pass).toBe(false);
  });

  it('an unpriced oracle menu does not require prices', () => {
    const unpriced = MENU.map((m) => ({ ...m, price: null }));
    expect(scoreAgainstOracle(unpriced, unpriced, PAGE).pass).toBe(true);
  });
});

describe('itemsHash', () => {
  it('is order-insensitive', () => {
    expect(itemsHash([...MENU].reverse())).toBe(itemsHash(MENU));
  });
  it('ignores whitespace/case/accents in names (normalised)', () => {
    const noisy = MENU.map((m) => ({ ...m, name: `  ${m.name.toUpperCase()} ` }));
    expect(itemsHash(noisy)).toBe(itemsHash(MENU));
  });
  it('ignores descriptions', () => {
    expect(itemsHash(MENU.map((m) => ({ ...m, description: 'changed' })))).toBe(itemsHash(MENU));
  });
  it('changes when a price changes', () => {
    const bumped = MENU.map((m, i) => (i === 3 ? { ...m, price: 229 } : m));
    expect(itemsHash(bumped)).not.toBe(itemsHash(MENU));
  });
  it('changes when an item is added or removed', () => {
    expect(itemsHash(MENU.slice(1))).not.toBe(itemsHash(MENU));
    expect(itemsHash([...MENU, { name: 'Panna cotta', price: 115 }])).not.toBe(itemsHash(MENU));
  });
  it('is a 16-char hex string', () => {
    expect(itemsHash(MENU)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('normName is re-exported from evaluate.ts', () => {
    expect(normName('Margherita (1,7)')).toBe('margherita');
  });
});

describe('duplicates vs legitimately repeated dishes', () => {
  it('treats a repeat in a DIFFERENT section as a candidate, not a duplicate', async () => {
    const { scoreAgainstOracle } = await import('../src/agent/evaluate.ts');
    const oracle = [
      { section: 'Grill', name: 'Aioli', price: 25 },
      { section: 'Mains', name: 'Choripán', price: 189 },
    ];
    const got = [
      { section: 'Grill', name: 'Aioli', price: 25 },
      { section: 'Tilbehør', name: 'Aioli', price: 25 },
      { section: 'Mains', name: 'Choripán', price: 189 },
    ];
    const s = scoreAgainstOracle(oracle, got, 'Grill Aioli 25 Mains Choripán 189 Tilbehør Aioli 25');
    expect(s.duplicates).toBe(0);
    expect(s.grounded.length).toBe(1);
  });
  it('counts a same-section same-price repeat as a duplicate', async () => {
    const { scoreAgainstOracle } = await import('../src/agent/evaluate.ts');
    const oracle = [{ section: 'Pizza', name: 'Margherita', price: 159 }];
    const got = [
      { section: 'Pizza', name: 'Margherita', price: 159 },
      { section: 'Pizza', name: 'Margherita', price: 159 },
    ];
    expect(scoreAgainstOracle(oracle, got, 'Pizza Margherita 159').duplicates).toBe(1);
  });
});
