/**
 * Compact views of a JSON menu payload:
 *   jsonSkeleton() — structure with arrays shortened, for the forge model to write code against;
 *   jsonMenuView() — the menu-relevant fields only, for the oracle to read when the page text
 *                    itself doesn't show prices.
 */

function trimString(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function jsonSkeleton(value: unknown, opts: { arrayItems?: number; maxString?: number; maxDepth?: number } = {}): unknown {
  const arrayItems = opts.arrayItems ?? 3;
  const maxString = opts.maxString ?? 80;
  const maxDepth = opts.maxDepth ?? 14;
  const walk = (v: unknown, d: number): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? trimString(v, maxString) : v;
    if (d >= maxDepth) return Array.isArray(v) ? `[… ${v.length} items]` : '{…}';
    if (Array.isArray(v)) {
      const head = v.slice(0, arrayItems).map((x) => walk(x, d + 1));
      if (v.length > arrayItems) head.push(`… ${v.length - arrayItems} more items with the same shape`);
      return head;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, d + 1);
    return out;
  };
  return walk(value, 0);
}

/** Shrink the skeleton until it fits the budget. */
export function jsonSkeletonText(value: unknown, budget = 24_000): string {
  for (const [arrayItems, maxString, maxDepth] of [[3, 80, 14], [2, 60, 12], [2, 40, 10], [1, 30, 9], [1, 20, 7]] as const) {
    const t = JSON.stringify(jsonSkeleton(value, { arrayItems, maxString, maxDepth }), null, 1);
    if (t.length <= budget) return t;
  }
  return JSON.stringify(jsonSkeleton(value, { arrayItems: 1, maxString: 16, maxDepth: 6 })).slice(0, budget) + ' …(truncated)';
}

const KEEP = /^(name|title|navn|label|description|desc|beskrivelse|info|price|pris|amount|cost|currency|category|categories|section|sections|group|groups|items|products|dishes|menu|menus|children|entries|variants|options|sizes|unitprice|baseprice|displayname|productname|itemname|categoryname|subcategories|courses)$/i;

/** Keep only menu-relevant keys (recursively), then serialise compactly. */
export function jsonMenuView(value: unknown, budget = 60_000): string {
  const walk = (v: unknown, d: number): unknown => {
    if (v === null || typeof v !== 'object' || d > 14) return typeof v === 'string' ? trimString(v, 200) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1)).filter((x) => x !== undefined);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== null && typeof x === 'object') {
        const w = walk(x, d + 1);
        if (w && (Array.isArray(w) ? w.length : Object.keys(w as object).length)) out[k] = w;
      } else if (KEEP.test(k)) out[k] = typeof x === 'string' ? trimString(x, 200) : x;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const t = JSON.stringify(walk(value, 0));
  return t.length > budget ? t.slice(0, budget) + ' …(truncated)' : t;
}
