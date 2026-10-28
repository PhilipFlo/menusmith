/**
 * Bot protection ("checking your browser" walls). Menusmith never tries to get past these —
 * it recognises them so it stops at once (no rendering, no wasted model calls) and can fall
 * back to a public listing of the menu found through search.
 */
const WALLS: [RegExp, string][] = [
  [/Vercel Security Checkpoint/i, 'Vercel Security Checkpoint'],
  [/<title>\s*Just a moment\.\.\.\s*<\/title>|cf-chl-|challenges\.cloudflare\.com|Attention Required! \| Cloudflare/i, 'Cloudflare'],
  [/captcha-delivery\.com|datadome/i, 'DataDome'],
  [/px-captcha|perimeterx|Press & Hold/i, 'PerimeterX / HUMAN'],
  [/Incapsula incident|_Incapsula_Resource|Pardon Our Interruption/i, 'Imperva'],
  [/Access Denied[\s\S]{0,400}Reference #\d|akamai-bot|_abck/i, 'Akamai'],
  [/sucuri_cloudproxy|Sucuri WebSite Firewall/i, 'Sucuri'],
  [/kpsdk|Kasada/i, 'Kasada'],
];

/** The protection a page shows instead of content, or null. Only short pages count as walls. */
export function detectBotWall(html: string): string | null {
  if (html.length > 250_000) return null; // a real page that merely mentions a vendor
  for (const [re, name] of WALLS) if (re.test(html)) return name;
  return null;
}

/** HTTP statuses that mean "automated visitors are not allowed here". */
export const BLOCKED_STATUS = /\bHTTP (401|403|405|406|429|451)\b/;
