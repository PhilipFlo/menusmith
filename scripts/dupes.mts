// Show which items an extractor returns twice in one section (debug aid for a bench failure dump).
import { readFileSync } from 'node:fs';
import { renderPage, closeBrowser } from '../src/html/render.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
const f = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const r = await renderPage(f.url);
const j = r.json[0]!;
const out = await runExtractor(f.code, j.body, f.url, 'json');
const by = new Map<string, any[]>();
for (const it of out.items) { const k = `${it.section}|${it.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`; by.set(k, [...(by.get(k) || []), it]); }
for (const it of [...out.items].sort((a, b) => a.name.localeCompare(b.name))) console.log(JSON.stringify([it.section, it.name, it.price]));
for (const [k, v] of by) if (v.length > 1) console.log(k, '→', v.map((x) => JSON.stringify([x.name, x.price])).join('  '));
console.log('items', out.items.length);
await closeBrowser();
