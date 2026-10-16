import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, ROOT } from '../config.ts';

export interface Page {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  fetchedAt: string;
  fromCache: boolean;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Menusmith/0.1 (+https://github.com/PhilipFlo/menusmith)';
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

/**
 * `fixture://<slug>/<file>` reads one of our own synthetic test sites from
 * fixtures/sites — used by tests, the offline demo and the self-heal demo.
 */
const fixtureStateFile = () => resolve(config.cacheDir, 'fixture-state.json');

/** Which fixture sites are currently "redesigned" (serve redesign.html at their URL). */
export function redesignedFixtures(): string[] {
  try {
    return (JSON.parse(readFileSync(fixtureStateFile(), 'utf8')) as { redesigned: string[] }).redesigned || [];
  } catch {
    return [];
  }
}

/** Flip a fixture site to/from its redesigned version — the self-heal demo. */
export function setFixtureRedesigned(slug: string, on: boolean): string[] {
  const set = new Set(redesignedFixtures());
  if (on) set.add(slug);
  else set.delete(slug);
  mkdirSync(config.cacheDir, { recursive: true });
  writeFileSync(fixtureStateFile(), JSON.stringify({ redesigned: [...set] }));
  return [...set];
}

/** Resolve the file a fixture site serves for a path, honouring the redesign switch. */
export function fixtureFile(slug: string, file?: string): string {
  const name = !file || file === 'index.html' ? (redesignedFixtures().includes(slug) ? 'redesign.html' : 'index.html') : file;
  const full = resolve(ROOT, 'fixtures/sites', slug, name);
  if (!full.startsWith(resolve(ROOT, 'fixtures/sites') + '/')) throw new Error('bad fixture path');
  return full;
}

function readFixture(url: string): Page | null {
  const m = url.match(/^fixture:\/\/([a-z0-9-]+)\/?([\w.-]*)$/i);
  if (!m) return null;
  const file = fixtureFile(m[1]!, m[2] || undefined);
  if (!existsSync(file)) throw new Error(`fixture not found: ${url}`);
  return { url, finalUrl: url, status: 200, html: readFileSync(file, 'utf8'), fetchedAt: new Date().toISOString(), fromCache: false };
}

function decode(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buf);
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Fetch a page's raw HTML. Successful fetches are cached on disk (.cache/, never
 * committed) so repeated runs of the same extractor are reproducible and polite.
 * `maxAgeMs: 0` forces a fresh fetch (the fleet does this).
 */
export async function fetchPage(url: string, opts: { maxAgeMs?: number } = {}): Promise<Page> {
  const fixture = readFixture(url);
  if (fixture) return fixture;
  if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported URL: ${url}`);

  const maxAge = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const key = createHash('sha256').update(url).digest('hex').slice(0, 20);
  const dir = resolve(config.cacheDir, 'pages');
  const file = resolve(dir, `${key}.json`);
  if (maxAge > 0 && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as Page;
    if (Date.now() - Date.parse(cached.fetchedAt) < maxAge) return { ...cached, fromCache: true };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en,nb;q=0.9,no;q=0.8',
      },
    });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error(`page too large (${len} bytes)`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error(`page too large (${buf.byteLength} bytes)`);
    const page: Page = {
      url,
      finalUrl: res.url || url,
      status: res.status,
      html: decode(buf, res.headers.get('content-type')),
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };
    if (res.ok) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(page));
    }
    return page;
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (e as Error).message;
    throw new Error(`fetch failed for ${url}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

export function domainOf(url: string): string {
  const fx = url.match(/^fixture:\/\/([a-z0-9-]+)/i);
  if (fx) return `${fx[1]}.fixture`;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
