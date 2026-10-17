/**
 * Integrity checks for the synthetic fixture sites: every expected.json is
 * exactly what a deterministic extractor reads off the page, the redesign
 * differs by exactly the recorded changes, and everything stays fictional.
 * Runs the trusted reference extractors in-process (fast); tests/sandbox.test.ts
 * runs some of them through the real sandbox.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { itemsHash, scoreAgainstOracle } from '../src/agent/evaluate.ts';
import type { MenuItem } from '../src/types.ts';
import { helpers, loadSite, pageText, runInProcess, SITES_DIR, siteIndex } from './fixtures.ts';
import { REFERENCE_EXTRACTORS } from './reference-extractors.ts';

const PLATFORMS = ['wordpress', 'squarespace', 'wix', 'webflow', 'shopify', 'unknown'];
const SLUGS = siteIndex().map((s) => s.slug);
/** Extractors whose `index` version is robust to the redesign by design (JSON-LD). */
const DRIFT_ROBUST = new Set(['sushi-koi']);

const norm = (items: MenuItem[]) =>
  items.map((it) => ({
    section: helpers.normName(it.section ?? ''),
    name: it.name,
    description: it.description ?? null,
    price: it.price,
  }));

it('index.json lists all 10 sites', () => {
  expect(SLUGS).toHaveLength(10);
  expect(new Set(SLUGS).size).toBe(10);
});

describe.each(SLUGS)('fixture %s', (slug) => {
  const { dir, html, redesign, expected } = loadSite(slug);
  const entry = siteIndex().find((s) => s.slug === slug)!;
  const ref = REFERENCE_EXTRACTORS[slug]!;

  it('has the required files, sizes and metadata', () => {
    for (const f of ['index.html', 'redesign.html', 'expected.json']) expect(existsSync(resolve(dir, f))).toBe(true);
    for (const f of ['index.html', 'redesign.html']) {
      const kb = statSync(resolve(dir, f)).size / 1024;
      expect(kb).toBeGreaterThanOrEqual(15);
      expect(kb).toBeLessThanOrEqual(80);
    }
    expect(PLATFORMS).toContain(expected.platform);
    expect(expected.platform).toBe(entry.platform);
    expect(expected.items).toHaveLength(entry.items);
    expect(expected.redesignItems).toHaveLength(entry.redesignItems);
    expect(new URL(expected.url).hostname).toMatch(/\.example$/); // clearly fictional
    for (const it of [...expected.items, ...expected.redesignItems]) {
      expect(typeof it.name).toBe('string');
      expect(it.price === null || typeof it.price === 'number').toBe(true);
      expect('section' in it && 'description' in it).toBe(true);
    }
  });

  it('every expected item is grounded in the page text', () => {
    const page = helpers.normName(pageText(html));
    for (const it of expected.items) expect(page, it.name).toContain(helpers.normName(it.name));
    const page2 = helpers.normName(pageText(redesign));
    for (const it of expected.redesignItems) expect(page2, it.name).toContain(helpers.normName(it.name));
  });

  it('reference extractor reproduces expected.items from index.html', () => {
    const got = runInProcess(ref.index, html, expected.url);
    expect(norm(got)).toEqual(norm(expected.items));
    expect(scoreAgainstOracle(expected.items, got, pageText(html)).pass).toBe(true);
  });

  it('reference extractor reproduces expected.redesignItems from redesign.html', () => {
    const got = runInProcess(ref.redesign, redesign, expected.url);
    expect(norm(got)).toEqual(norm(expected.redesignItems));
  });

  it('redesign differs by exactly the recorded changes', () => {
    const before = new Map(expected.items.map((i) => [i.name, i.price]));
    const after = new Map(expected.redesignItems.map((i) => [i.name, i.price]));
    const priceChanges = expected.redesignChanges.filter((c) => c.type === 'price');
    const added = expected.redesignChanges.filter((c) => c.type === 'added');
    expect(priceChanges.length).toBeGreaterThanOrEqual(1);
    expect(priceChanges.length).toBeLessThanOrEqual(2);
    expect(added).toHaveLength(1);
    const changedNames = new Set<string>();
    for (const c of priceChanges) {
      expect(before.get(c.name)).toBe(c.from);
      expect(after.get(c.name)).toBe(c.to);
      changedNames.add(c.name);
    }
    for (const [name, p] of before) if (!changedNames.has(name)) expect(after.get(name), name).toBe(p);
    const newNames = [...after.keys()].filter((n) => !before.has(n));
    expect(newNames).toEqual([added[0]!.name]);
    expect(itemsHash(expected.redesignItems)).not.toBe(itemsHash(expected.items));
  });

  it.skipIf(DRIFT_ROBUST.has(slug))('the original extractor does not pass on the redesign (drift is detectable)', () => {
    const got = runInProcess(ref.index, redesign, expected.url);
    expect(scoreAgainstOracle(expected.redesignItems, got, pageText(redesign)).pass).toBe(false);
  });
});

it('fixture dir contains only the listed sites', async () => {
  const { readdirSync } = await import('node:fs');
  const dirs = readdirSync(SITES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  expect(dirs).toEqual([...SLUGS].sort());
});
