// Show the rendered text of one bench site (debug aid).
import { readFileSync } from 'node:fs';
import { renderPage, closeBrowser } from '../src/html/render.ts';
import { pageText } from '../src/html/simplify.ts';
const s = JSON.parse(readFileSync('bench/private/sites.json', 'utf8')).find((x: any) => x.name.includes(process.argv[2]));
const r = await renderPage(s.url);
const t = pageText(r.html);
console.log(s.url, '\n', t.slice(0, Number(process.argv[3] || 1500)));
console.log('JSON responses:', r.json.map((j) => j.url.slice(0, 100)));
await closeBrowser();
