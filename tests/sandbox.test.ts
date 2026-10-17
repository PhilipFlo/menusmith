import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scoreAgainstOracle } from '../src/agent/evaluate.ts';
import { runExtractor } from '../src/sandbox/runner.ts';
import { loadSite, pageText } from './fixtures.ts';
import { REFERENCE_EXTRACTORS } from './reference-extractors.ts';

describe('sandbox: correct extractors pass on fixture sites', () => {
  for (const slug of ['trattoria-sole', 'fjord-burger', 'kebab-kongen', 'pho-hanoi-house', 'sushi-koi']) {
    it(`${slug}: hand-written extractor passes against expected.json`, async () => {
      const { html, expected } = loadSite(slug);
      const run = await runExtractor(REFERENCE_EXTRACTORS[slug]!.index, html, expected.url);
      expect(run.error).toBeUndefined();
      expect(run.ok).toBe(true);
      expect(run.items).toHaveLength(expected.items.length);
      const score = scoreAgainstOracle(expected.items, run.items, pageText(html));
      expect(score.pass).toBe(true);
      expect(score.f1).toBe(1);
      expect(score.wrongPrice).toEqual([]);
    });
  }

  it('fjord-burger: the same extractor on redesign.html does NOT pass (drift detectable)', async () => {
    const { redesign, expected } = loadSite('fjord-burger');
    const run = await runExtractor(REFERENCE_EXTRACTORS['fjord-burger']!.index, redesign, expected.url);
    const score = scoreAgainstOracle(expected.redesignItems, run.items, pageText(redesign));
    expect(score.pass).toBe(false);
  });

  it('fjord-burger: a repaired extractor passes on redesign.html', async () => {
    const { redesign, expected } = loadSite('fjord-burger');
    const run = await runExtractor(REFERENCE_EXTRACTORS['fjord-burger']!.redesign, redesign, expected.url);
    expect(run.ok).toBe(true);
    expect(scoreAgainstOracle(expected.redesignItems, run.items, pageText(redesign)).pass).toBe(true);
  });

  it('passes ctx.url through and exposes parsePrice/cleanText as globals', async () => {
    const code = `function extract($, ctx) { return [{ name: cleanText('  ' + ctx.url + ' '), price: parsePrice('kr 1 290,-') }]; }`;
    const run = await runExtractor(code, '<p>x</p>', 'https://example.example/meny');
    expect(run.ok).toBe(true);
    expect(run.items[0]).toMatchObject({ name: 'https://example.example/meny', price: 1290 });
  });

  it('sanitises output: string prices parsed, nameless items dropped', async () => {
    const code = `function extract() { return [{ name: 'A', price: '189,-' }, { name: '', price: 1 }, null, { name: 'B', price: 'Dagens pris' }]; }`;
    const run = await runExtractor(code, '', '');
    expect(run.ok).toBe(true);
    expect(run.items.map((i) => [i.name, i.price])).toEqual([['A', 189], ['B', null]]);
  });
});

describe('sandbox: failures and isolation', () => {
  it('an infinite loop returns ok:false with a timeout error', async () => {
    const run = await runExtractor('function extract() { while (true) {} }', '<p>x</p>', '');
    expect(run.ok).toBe(false);
    expect(run.items).toEqual([]);
    expect(run.error).toMatch(/timed out/i);
  });

  it('this.constructor.constructor escape returns ok:false', async () => {
    const code = `function extract() { const p = this.constructor.constructor('return process')(); return [{ name: String(Object.keys(p.env)), price: 1 }]; }`;
    const run = await runExtractor(code, '', '');
    expect(run.ok).toBe(false);
    expect(run.items).toEqual([]);
  });

  it('top-level this.constructor.constructor escape returns ok:false', async () => {
    const code = `const P = this.constructor.constructor('return process')();\nfunction extract() { return [{ name: P.version, price: 1 }]; }`;
    const run = await runExtractor(code, '', '');
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/code generation|EvalError/i);
  });

  it('escape via the cheerio object ($.constructor.constructor) returns ok:false', async () => {
    const code = `function extract($) { const p = $.constructor.constructor('return process')(); return [{ name: p.version, price: 1 }]; }`;
    const run = await runExtractor(code, '', '');
    expect(run.ok).toBe(false);
  });

  it('no require/process/fetch in the extractor scope', async () => {
    const code = `function extract() { return [{ name: [typeof require, typeof process, typeof module, typeof fetch].join(','), price: 1 }]; }`;
    const run = await runExtractor(code, '', '');
    expect(run.ok).toBe(true);
    expect(run.items[0]!.name).toBe('undefined,undefined,undefined,undefined');
  });

  describe('writing a file is impossible', () => {
    const target = join(tmpdir(), `menusmith-pwn-${process.pid}-${Date.now()}.txt`);
    afterAll(() => rmSync(target, { force: true }));

    it('via require / process / constructor chains', async () => {
      const code = `function extract($) {
  const attempts = [];
  const T = ${JSON.stringify(target)};
  const tries = [
    () => require('fs').writeFileSync(T, 'x'),
    () => process.mainModule.require('fs').writeFileSync(T, 'x'),
    () => $.constructor.constructor('return process')().mainModule.require('fs').writeFileSync(T, 'x'),
    () => $.root().constructor.constructor('return this')().process.mainModule.require('fs').writeFileSync(T, 'x'),
    () => (async function(){}).constructor('return import("fs")')().then((fs) => fs.writeFileSync(T, 'x')),
  ];
  for (const t of tries) { try { t(); attempts.push('WROTE?'); } catch (e) { attempts.push(String(e && e.name)); } }
  return [{ name: attempts.join(','), price: 1 }];
}`;
      const run = await runExtractor(code, '<p>x</p>', '');
      expect(run.ok).toBe(true);
      expect(run.items[0]!.name).not.toContain('WROTE?');
      expect(existsSync(target)).toBe(false);
    });
  });
});
