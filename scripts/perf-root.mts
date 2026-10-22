// Time findMenuRoot on the largest cached pages (regression guard for O(n²) behaviour).
import { readdirSync, readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { findMenuRoot } from '../src/html/simplify.ts';
const dir = '.cache/pages';
const pages = readdirSync(dir).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))).sort((a, b) => b.html.length - a.html.length).slice(0, 5);
for (const p of pages) {
  const $ = cheerio.load(p.html);
  $('script, style, noscript, svg').remove();
  const t0 = Date.now();
  const r = findMenuRoot($);
  console.log(`${Math.round(p.html.length / 1024)}K  ${Date.now() - t0}ms  prices=${r?.priceNodes ?? 0}  ${p.url.slice(0, 60)}`);
}
