import * as cheerio from 'cheerio';

/**
 * A debugger for the code-writing agent. When an extractor returns nothing (or far
 * too little), "0 items" is useless feedback. Instead we pull every CSS selector
 * literal out of the generated code and report how many elements each one matches
 * on the real page — the same thing a developer would check first in DevTools.
 */

const CALL = /(?:\$|\.find|\.children|\.closest|\.filter|\.is|\.not|\.has|\.prevAll|\.nextAll|\.nextUntil|\.prevUntil|\.parents|\.siblings)\(\s*(['"`])((?:\\.|(?!\1).)+?)\1/g;

export function selectorsIn(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(CALL)) {
    const sel = m[2]!.trim();
    if (!sel || sel.includes('${') || sel.length > 160) continue;
    out.add(sel);
  }
  return [...out].slice(0, 30);
}

export function selectorReport(code: string, html: string): string | null {
  const sels = selectorsIn(code);
  if (!sels.length) return null;
  const $ = cheerio.load(html);
  const lines: string[] = [];
  for (const sel of sels) {
    let n: number | string;
    try {
      // Bare child combinators ("> li") are relative — test them as descendants of anything.
      n = $(sel.startsWith('>') ? `* ${sel}` : sel).length;
    } catch {
      n = 'INVALID selector';
    }
    lines.push(`  ${JSON.stringify(sel)} → ${n}${n === 0 ? '   ← matches nothing on this page' : ''}`);
  }
  return `Selector check on the real page (whole document, ignoring nesting in your code):\n${lines.join('\n')}`;
}

/** For JSON sources: the top-level shape, so "0 items" can be traced to a wrong path. */
export function jsonShapeReport(payload: string): string | null {
  try {
    const data = JSON.parse(payload) as unknown;
    const describe = (v: unknown): string =>
      Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `object{${Object.keys(v).slice(0, 12).join(', ')}}` : typeof v;
    if (Array.isArray(data)) return `Top level is ${describe(data)}; first element: ${describe(data[0])}`;
    if (data && typeof data === 'object')
      return `Top-level keys: ${Object.entries(data as Record<string, unknown>)
        .slice(0, 20)
        .map(([k, v]) => `${k}: ${describe(v)}`)
        .join('; ')}`;
    return `Top level is ${typeof data}`;
  } catch {
    return null;
  }
}
