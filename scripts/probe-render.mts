// Render JS-built menu pages and show what the browser path recovers (DOM prices + captured menu JSON).
import { readFileSync } from 'node:fs';
import { renderPage, closeBrowser } from '../src/html/render.ts';
import { priceDensity } from '../src/agent/discover.ts';
import { pageText } from '../src/html/simplify.ts';
const names = process.argv.slice(2);
const sites = JSON.parse(readFileSync('bench/private/sites.json', 'utf8')).filter((s: any) => names.some((n) => s.name.includes(n)));
for (const s of sites) {
  try {
    const r = await renderPage(s.url);
    console.log(`\n${s.name} (${Math.round(r.ms/1000)}s) dom prices=${priceDensity(r.html)} text=${Math.round(pageText(r.html).length/1024)}K json=${r.json.length} ref=${s.reference.length}`);
    for (const j of r.json.slice(0, 3)) console.log(`   ${j.method} ${j.url.slice(0, 110)}  objs=${j.menuObjects} size=${Math.round(j.body.length/1024)}K post=${j.postData ? 'yes' : 'no'}`);
  } catch (e) { console.log(s.name, 'ERR', (e as Error).message.slice(0, 120)); }
}
await closeBrowser();
