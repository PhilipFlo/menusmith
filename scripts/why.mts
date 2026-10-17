// Forge one site and print the full score of every round — for diagnosing near-misses.
import { forge } from '../src/agent/pipeline.ts';
import { closeBrowser } from '../src/html/render.ts';
const url = process.argv[2]!;
const out = await forge({ url, noReuse: true }, (e) => {
  if (e.type === 'test') {
    const s = e.score;
    console.log(`round ${e.round}: ok=${e.run.ok} n=${s.extractorCount}/${s.oracleCount} p=${s.precision} r=${s.recall} f1=${s.f1} priced=${s.pricedRatio} pass=${s.pass} dup=${s.duplicates} extra=${s.extra.length} grounded=${s.grounded.length} wrong=${s.wrongPrice.length}`);
    console.log('   extra:', s.extra.slice(0, 6).map((i) => `${i.name}|${i.price}`).join(' ; '));
    console.log('   missing:', s.missing.slice(0, 6).map((i) => `${i.name}|${i.price}`).join(' ; '));
    console.log('   wrong:', s.wrongPrice.slice(0, 4).map((w) => `${w.name} ${w.expected}->${w.got}`).join(' ; '));
  }
  if (e.type === 'log' && /arbitrat|Debugger|Judge/.test(e.message)) console.log('  ', e.message.slice(0, 200));
});
console.log(out.ok ? 'OK' : 'FAIL ' + out.reason, '$' + out.ledger.costUsd.toFixed(4));
await closeBrowser();
