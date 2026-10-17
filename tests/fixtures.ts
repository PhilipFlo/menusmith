/** Shared helpers for loading the synthetic fixture sites in tests. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import type { MenuItem } from '../src/types.ts';

const require = createRequire(import.meta.url);
export const helpers = require('../src/sandbox/helpers.cjs') as {
  parsePrice: (s: unknown) => number | null;
  cleanText: (s: unknown) => string;
  normName: (s: unknown) => string;
};

export const SITES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/sites');

export interface Expected {
  restaurant: string;
  platform: string;
  currency: string;
  url: string;
  items: MenuItem[];
  redesignItems: MenuItem[];
  redesignChanges: (
    | { type: 'price'; name: string; from: number; to: number }
    | { type: 'added'; section: string; name: string; price: number | null }
    | { type: 'reordered'; order: string[] }
  )[];
}

export interface SiteIndexEntry {
  slug: string;
  platform: string;
  items: number;
  redesignItems: number;
}

export function siteIndex(): SiteIndexEntry[] {
  return JSON.parse(readFileSync(resolve(SITES_DIR, 'index.json'), 'utf8')).sites;
}

export function loadSite(slug: string) {
  const dir = resolve(SITES_DIR, slug);
  const html = readFileSync(resolve(dir, 'index.html'), 'utf8');
  const redesign = readFileSync(resolve(dir, 'redesign.html'), 'utf8');
  const expected = JSON.parse(readFileSync(resolve(dir, 'expected.json'), 'utf8')) as Expected;
  return { dir, html, redesign, expected };
}

/** Visible-ish page text, as the scorer's grounding check sees it. */
export function pageText(html: string): string {
  return cheerio.load(html)('body').text();
}

/**
 * Run an extractor code string in-process (fast, NOT sandboxed — only for our
 * own trusted reference extractors). Mirrors the harness's sanitising.
 */
export function runInProcess(code: string, html: string, url: string): MenuItem[] {
  const $ = cheerio.load(html);
  const fn = new Function('$', 'ctx', 'parsePrice', 'cleanText', `"use strict";\n${code}\n;return extract($, ctx);`);
  const raw = fn($, Object.freeze({ url }), helpers.parsePrice, helpers.cleanText) as MenuItem[];
  return raw.map((it) => ({
    section: it.section ? helpers.cleanText(it.section) : null,
    name: helpers.cleanText(it.name),
    description: it.description ? helpers.cleanText(it.description) : null,
    price: typeof it.price === 'number' ? it.price : null,
  }));
}
