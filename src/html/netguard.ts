import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard. Menusmith fetches and renders URLs that visitors type into a public
 * demo; without this, someone could point it at localhost, the cloud metadata
 * service (169.254.169.254) or other internal addresses and have the oracle read
 * the response back to them.
 */

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const [a, b] = [p[0]!, p[1]!];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast / reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  if (x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd')) return true;
  const mapped = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateV4(mapped[1]!) : false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return false;
}

/** Hostnames that are private without needing DNS. */
function obviouslyPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return isIP(h) ? isPrivateAddress(h) : false;
}

/** Synchronous check for sub-requests inside the browser (no DNS). */
export function isBlockedUrlSync(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return obviouslyPrivateHost(u.hostname);
  } catch {
    return true;
  }
}

/** Throws unless the URL is http(s) and resolves only to public addresses. */
export async function assertPublicUrl(url: string): Promise<void> {
  if (process.env.MENUSMITH_ALLOW_PRIVATE_URLS === '1') return; // local development only
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http(s) URLs are allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (obviouslyPrivateHost(host)) throw new Error(`refusing to fetch a private address (${host})`);
  if (!isIP(host)) {
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`refusing to fetch ${host}: it resolves to a private address`);
  }
}
