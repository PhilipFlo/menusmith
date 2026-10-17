import { describe, expect, it } from 'vitest';
import { diffItems, looksBroken, looksSuspicious } from '../src/fleet/fleet.ts';

const item = (name: string, price: number | null, section = 'Pizza') => ({ section, name, price });

describe('fleet drift logic', () => {
  it('diffs repeated names (sizes listed separately) without collapsing them', () => {
    const prev = [item('Margherita', 129), item('Margherita', 179)];
    const next = [item('Margherita', 129), item('Margherita', 189)];
    expect(diffItems(prev, next)).toEqual([{ name: 'Margherita', section: 'Pizza', kind: 'price', oldPrice: 179, newPrice: 189 }]);
  });
  it('reports added and removed dishes', () => {
    const d = diffItems([item('A', 1), item('B', 2)], [item('A', 1), item('C', 3)]);
    expect(d.map((x) => x.kind).sort()).toEqual(['added', 'removed']);
  });
  it('does not flag a menu that never had prices as broken', () => {
    const unpriced = Array.from({ length: 20 }, (_, i) => item(`Dish ${i}`, null));
    expect(looksBroken(unpriced, 20, 0)).toBeNull();
    expect(looksBroken(unpriced, 20, 1)).toMatch(/price/);
  });
  it('flags empty output and big drops as broken', () => {
    expect(looksBroken([], 10)).toMatch(/no items/);
    expect(looksBroken(Array.from({ length: 5 }, (_, i) => item(`D${i}`, 10)), 20)).toMatch(/down from 20/);
  });
  it('flags a gradual 20% drop as suspicious (not silently accepted)', () => {
    const prev = Array.from({ length: 20 }, (_, i) => item(`Dish ${i}`, 100 + i));
    expect(looksSuspicious(prev.slice(0, 16), prev, 20)).toMatch(/fell from 20 to 16/);
    expect(looksSuspicious(prev.slice(0, 19), prev, 20)).toBeNull();
  });
  it('flags output whose dish names mostly changed', () => {
    const prev = Array.from({ length: 10 }, (_, i) => item(`Dish ${i}`, 100));
    const next = Array.from({ length: 10 }, (_, i) => item(`Other ${i}`, 100));
    expect(looksSuspicious(next, prev, 10)).toMatch(/names match/);
  });
});
