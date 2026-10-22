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

// Also matches language/variant suffixes: nameNor, name_en, titleNo, priceInclVat, …
const NAME_KEY = /^(name|title|navn|label)([A-Z_].*)?$|^(display|product|item|dish)_?name$/i;
const PRICE_KEY = /^(price|pris|amount|cost)([A-Z_].*)?$|^(unit|base|gross|display|sale)_?price$/i;

/**
 * For JSON sources: where in the document the dishes actually are. Lists the array
 * paths whose elements look like menu items (a name-ish and a price-ish key), with
 * counts — written relative to the extractor's `data` argument, so a wrapper key
 * like GraphQL's {"data": {...}} shows up as data.data.… and can't be missed.
 */
export function jsonShapeReport(payload: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch {
    return null;
  }
  const found = new Map<string, { count: number; keys: Set<string> }>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 14 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const p = `${path}[]`;
      for (const el of v) {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          const keys = Object.keys(el as object);
          if (keys.some((k) => NAME_KEY.test(k)) && keys.some((k) => PRICE_KEY.test(k))) {
            const f = found.get(p) || { count: 0, keys: new Set<string>() };
            f.count++;
            keys.slice(0, 14).forEach((k) => f.keys.add(k));
            found.set(p, f);
          }
        }
        walk(el, p, depth + 1);
      }
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`, depth + 1);
  };
  walk(doc, 'data', 0);
  const top =
    doc && typeof doc === 'object' && !Array.isArray(doc)
      ? `The extractor's \`data\` argument is the whole document; its top-level keys are: ${Object.keys(doc as object).slice(0, 20).join(', ')}.`
      : `The extractor's \`data\` argument is the whole document (top level: ${Array.isArray(doc) ? 'array' : typeof doc}).`;
  const paths = [...found.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  if (!paths.length) return `${top}\nNo arrays of {name, price}-like objects were found — prices may be nested (e.g. price.amount) or names under another key.`;
  return `${top}\nArrays that contain menu-item-like objects (path relative to \`data\` → how many, their keys):\n${paths
    .map(([p, f]) => `  ${p} → ${f.count} objects · keys: ${[...f.keys].join(', ')}`)
    .join('\n')}`;
}
