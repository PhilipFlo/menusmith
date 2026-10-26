import { describe, expect, it } from 'vitest';
import { diffItems, looksBroken, looksSuspicious, lostNames, stillListed } from '../src/fleet/fleet.ts';

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

describe('fleet filter (review finding)', () => {
  it('an empty `only` list runs nothing — never the whole library', async () => {
    const { runFleet } = await import('../src/fleet/fleet.ts');
    const r = await runFleet({ only: [], heal: false });
    expect(r.entries).toHaveLength(0);
    expect(r.totals.extractors).toBe(0);
  });
});

describe('coverage check: removed vs. silently missed', () => {
  const d = (name: string, price: number | null = 100) => ({ name, price });
  it('a dish that left the output but is still on the page is the code\'s fault', () => {
    expect(stillListed([d('Ayran', 30), d('Brus 0,5 l', 35)], [d('Brus 0,5 l', 35), d('Ayran', 30)])).toEqual(['Ayran', 'Brus 0,5 l']);
  });
  it('an exact name counts even if the price changed', () => {
    expect(stillListed([d('Ayran', 35)], [d('Ayran', 30)])).toEqual(['Ayran']);
  });
  it('a close name only counts at the same price', () => {
    expect(stillListed([d('Pizza Margherita', 129)], [d('Margherita', 129)])).toEqual(['Pizza Margherita']);
    expect(stillListed([d('Ekstra kebabkjøtt', 25)], [d('Kebab', 129)])).toEqual([]);
    expect(stillListed([d('Cheeseburger', 159)], [d('Burger', 139)])).toEqual([]);
  });
  it('dishes the restaurant really removed are not flagged', () => {
    expect(stillListed([d('Ayran')], [d('Lammeskank')])).toEqual([]);
    expect(stillListed([], [d('Lammeskank')])).toEqual([]);
  });
  it('a dish that only moved to another section is not "vanished"', () => {
    expect(stillListed([d('Ayran', 30)], [d('Ayran', 30)], [{ name: 'Ayran', price: 30 }])).toEqual([]);
  });
});

describe('section moves', () => {
  it('a dish that moved to another section is not lost', () => {
    expect([...lostNames([item('Fries', 7, 'Desserts')], [item('Fries', 7, 'Sides')])]).toEqual([]);
  });
  it('losing one copy of a dish listed in two sections is a loss', () => {
    const prev = [item('Pizza', 129, 'Lunch'), item('Pizza', 159, 'Dinner'), item('Salad', 99, 'Lunch')];
    expect([...lostNames(prev, [item('Pizza', 159, 'Dinner'), item('Salad', 99, 'Lunch')])]).toEqual(['pizza']);
  });
});

describe('shared store safety', () => {
  // Spawned processes, so the module reads exactly the environment we give it.
  const check = async (env: Record<string, string>) => {
    const { execFileSync } = await import('node:child_process');
    const base = { PATH: process.env.PATH!, HOME: process.env.HOME!, MENUSMITH_STORE_URL: 'https://example.invalid', MENUSMITH_STORE_KEY: 'k', MENUSMITH_STORE_TOKEN: 't' };
    return execFileSync('npx', ['tsx', '-e', "import('./src/library/persist.ts').then((m) => process.stdout.write(String(m.storeEnabled())))"], { env: { ...base, ...env }, encoding: 'utf8' });
  };
  it('a local run with the store variables in .env does not write to the shared store', async () => {
    expect(await check({ MENUSMITH_LLM: 'live' })).toBe('false');
  });
  it('a replayed or recorded run never writes, even when sync is switched on', async () => {
    expect(await check({ MENUSMITH_LLM: 'replay', MENUSMITH_STORE_SYNC: '1' })).toBe('false');
    expect(await check({ MENUSMITH_LLM: 'record', MENUSMITH_STORE_SYNC: '1' })).toBe('false');
  });
  it('the deployed server and the nightly job (live + sync) do write', async () => {
    expect(await check({ MENUSMITH_LLM: 'live', MENUSMITH_STORE_SYNC: '1' })).toBe('true');
  });
});
