import type { Platform } from '../types.ts';

/**
 * Hosted ordering / menu systems: every restaurant on one of these shares the same
 * page structure, so one extractor can serve all of them (zero tokens after the first).
 */
const HOSTED: [RegExp, string][] = [
  [/(^|\.)winorder\.no$/, 'winorder'],
  [/(^|\.)ninito\.com$/, 'ninito'],
  [/(^|\.)semeny\.no$/, 'semeny'],
  [/(^|\.)favrit\.com$/, 'favrit'],
  [/(^|\.)order\.online$/, 'order-online'],
  [/(^|\.)toasttab\.com$/, 'toast'],
  [/(^|\.)square\.site$|(^|\.)squareup\.com$/, 'square'],
  [/(^|\.)clover\.com$/, 'clover'],
  [/(^|\.)chownow\.com$/, 'chownow'],
  [/(^|\.)menufy\.com$/, 'menufy'],
  [/(^|\.)weborder\.no$|(^|\.)weborder\.se$/, 'weborder'],
  [/(^|\.)munu\.shop$/, 'munu'],
  [/(^|\.)resto\.no$/, 'resto'],
];

/** Detect the website builder / hosted menu system from the URL and markup fingerprints. */
export function detectPlatform(html: string, url = ''): Platform {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* fixture:// or bad URL */
  }
  for (const [re, name] of HOSTED) if (host && re.test(host)) return name;

  const h = html.slice(0, 400_000);
  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(h)?.[1]?.toLowerCase() || '';
  if (gen.includes('wordpress') || /wp-content\/|wp-includes\//i.test(h)) return 'wordpress';
  if (gen.includes('squarespace') || /static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i.test(h)) return 'squarespace';
  if (gen.includes('wix') || /static\.wixstatic\.com|wix-warmup-data|_wixCssImports/i.test(h)) return 'wix';
  if (gen.includes('webflow') || /data-wf-page|webflow\.js|w-dyn-list/i.test(h)) return 'webflow';
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(h)) return 'shopify';
  return 'unknown';
}
