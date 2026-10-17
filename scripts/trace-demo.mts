// Show the sandbox execution trace for the failing Ultra attempt on taqueria-luna.
import { readFileSync } from 'node:fs';
import { runExtractor } from '../src/sandbox/runner.ts';
const html = readFileSync('fixtures/sites/taqueria-luna/index.html', 'utf8');
const code = `function extract($) { const items=[]; const $main=$('#MainContent'); if(!$main.length) return items;
  $main.children('.shopify-section').each((_, s) => { const $s=$(s); const $h=$s.find('h2.title').first(); if(!$h.length) return;
    $s.find('ul.product-grid').first().find('> li.grid__item').each((_, li) => { const $card=$(li).find('article.card').first();
      const infos=$card.find('.card-information'); if (infos.length<2) return; items.push({name:'x', price:1}); }); });
  return items; }`;
const r = await runExtractor(code, html, 'fixture://taqueria-luna/');
console.log(r.items.length, r.trace);
