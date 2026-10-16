// Probe the non-LLM half of the pipeline on real sites: fetch, platform, menu region, skeleton size.
import { readFileSync } from 'node:fs';
import { fetchPage } from '../src/html/fetch.ts';
import { detectPlatform } from '../src/html/platform.ts';
import { pageText, skeleton } from '../src/html/simplify.ts';
import { priceDensity } from '../src/agent/discover.ts';
const sites = JSON.parse(readFileSync('bench/private/sites.json', 'utf8')).slice(0, Number(process.argv[2] || 12));
for (const s of sites) {
  try {
    const p = await fetchPage(s.url);
    const sk = skeleton(p.html);
    console.log(`${s.name.slice(0,28).padEnd(28)} ${String(p.status).padEnd(4)} ${detectPlatform(p.html, p.finalUrl).padEnd(11)} html=${Math.round(p.html.length/1024)}K text=${Math.round(pageText(p.html).length/1024)}K prices=${priceDensity(p.html)} skel=${Math.round(sk.html.length/1024)}K root=${sk.rootPath.slice(-50)} ref=${s.reference.length}`);
  } catch (e) { console.log(`${s.name.slice(0,28).padEnd(28)} ERR ${(e as Error).message.slice(0,90)}`); }
}
