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

/** Expand an IPv6 literal to 8 16-bit groups (handles "::" and a trailing dotted IPv4). */
function v6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const dotted = x.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number);
    x = x.slice(0, -dotted[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const [head, tail] = x.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // unparseable → refuse
  const embedded = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.every((v) => v === 0)) return true; // ::
  if (g.slice(0, 7).every((v) => v === 0) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if (g[0]! >= 0xff00) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d, any notation), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96)
  if (g.slice(0, 5).every((v) => v === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(embedded()) || g[5] === 0;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((v) => v === 0)) return isPrivateV4(embedded());
  return false;
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

/**
 * fetch() for untrusted URLs: follows redirects one hop at a time (every hop must pass
 * the SSRF guard), enforces a timeout, rejects bodies over `maxBytes` (Content-Length
 * pre-check AND a streaming cap, so a huge response can't exhaust memory).
 */
export async function safeFetch(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number; init?: RequestInit } = { maxBytes: 6 * 1024 * 1024 },
): Promise<{ status: number; ok: boolean; url: string; headers: Headers; bytes: Uint8Array }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    let current = url;
    await assertPublicUrl(current);
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(current, { ...(opts.init || {}), redirect: 'manual', signal: ctrl.signal });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (loc) {
        await res.body?.cancel().catch(() => {});
        current = new URL(loc, current).toString();
        await assertPublicUrl(current);
        continue;
      }
      const len = Number(res.headers.get('content-length') || 0);
      if (len > opts.maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`response too large (${len} bytes)`);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > opts.maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`response too large (>${opts.maxBytes} bytes)`);
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.byteLength;
      }
      return { status: res.status, ok: res.ok, url: current, headers: res.headers, bytes };
    }
    throw new Error('too many redirects');
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`timed out after ${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
