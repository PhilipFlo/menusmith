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

const NAME_K = /^(name|title|navn|label|displayname|display_name|productname|product_name|itemname|item_name|categoryname|category_name)$/i;
const PRICE_K = /^(price|pris|amount|cost|unitprice|unit_price|baseprice|base_price|grossprice|displayprice|display_price|pricewithvat|price_incl_vat|priceamount|price_amount)$/i;
const DESC_K = /^(description|desc|beskrivelse|info|details)$/i;
const FLAG_K = /^(available|isavailable|is_available|active|isactive|is_active|hidden|ishidden|is_hidden|visible|isvisible|enabled|isenabled|archived|deleted|soldout|sold_out|outofstock|out_of_stock)$/i;

function scalarPrice(v: unknown): string | null {
  if (typeof v === 'number' || (typeof v === 'string' && /\d/.test(v))) return String(v);
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/amount|value|price|gross|net/i.test(k) && (typeof x === 'number' || typeof x === 'string')) return String(x);
    }
  }
  return null;
}

/**
 * One line per menu-like object, with its category path — readable in chunks by
 * the oracle without losing context:
 *   [Varmretter > Nudler] Pho Bo | price=18900 | Risnudler i oksebuljong | available=true
 * Prices are left exactly as in the API (possibly minor units); the oracle decides.
 */
export function jsonMenuLines(value: unknown, maxLines = 4000): string {
  const lines: string[] = [];
  const walk = (v: unknown, path: string[], d: number) => {
    if (lines.length >= maxLines || d > 16 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, path, d + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    let name: string | null = null;
    let price: string | null = null;
    let desc: string | null = null;
    const flags: string[] = [];
    for (const [k, x] of Object.entries(o)) {
      if (!name && NAME_K.test(k) && typeof x === 'string' && x.trim()) name = x.trim();
      else if (!price && PRICE_K.test(k)) price = scalarPrice(x);
      else if (!desc && DESC_K.test(k) && typeof x === 'string' && x.trim())
        desc = x.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() || null;
      else if (FLAG_K.test(k) && (typeof x === 'boolean' || typeof x === 'number')) flags.push(`${k}=${x}`);
    }
    if (name && price) {
      lines.push(`[${path.join(' > ')}] ${trimString(name, 120)} | price=${price}${desc ? ' | ' + trimString(desc, 140) : ''}${flags.length ? ' | ' + flags.join(' ') : ''}`);
    }
    // A named object without a price is a container (category, menu, group) — it extends the path.
    const childPath = name && !price ? [...path, trimString(name, 60)] : path;
    for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, childPath, d + 1);
  };
  walk(value, [], 0);
  return lines.join('\n');
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
