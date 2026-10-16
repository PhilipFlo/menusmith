import { runExtractor } from '../src/sandbox/runner.ts';
const html = `<div class="menu"><h2>Pizza</h2><div class="item"><span class="n">Margherita</span><span class="p">kr 189,-</span></div><div class="item"><span class="n">Diavola</span><span class="p">NOK 1 229,50</span></div></div>`;
const good = `function extract($, ctx){ const out=[]; $('.item').each((i,el)=>{ out.push({section:$(el).prevAll('h2').first().text()||'Pizza', name:$(el).find('.n').text(), price: parsePrice($(el).find('.p').text())}); }); return out; }`;
console.log('good', JSON.stringify(await runExtractor(good, html, 'https://x.no')));
console.log('loop', JSON.stringify(await runExtractor('function extract(){ while(true){} }', html, '')));
console.log('escape-env', JSON.stringify(await runExtractor(`function extract(){ const p=this.constructor.constructor('return process')(); return [{name: JSON.stringify(Object.keys(p.env)), price:1}]; }`, html, '')));
console.log('escape-host', JSON.stringify(await runExtractor(`function extract($){ const p=$.constructor.constructor('return process')(); const fs=p.mainModule? p.mainModule.require('fs'):null; let r='nofs'; try{ r = fs.readFileSync('/etc/hosts','utf8').slice(0,20);}catch(e){r=e.code||e.message} let w; try{fs.writeFileSync('/tmp/pwn','x'); w='WROTE'}catch(e){w=e.code} return [{name: r+' | '+w + ' | env=' + Object.keys(p.env).length, price:1}]; }`, html, '')));
console.log('bad-return', JSON.stringify(await runExtractor('function extract(){ return 5 }', html, '')));
console.log('syntax', JSON.stringify(await runExtractor('function extract( {', html, '')));
