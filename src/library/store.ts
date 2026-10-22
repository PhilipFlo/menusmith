import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import type { ExtractorMeta, Platform } from '../types.ts';

/**
 * The extractor library: one folder per website, one file per version.
 *
 *   library/extractors/<id>/v1.js, v2.js …   the generated code (committed to git)
 *   library/extractors/<id>/meta.json        metadata for the CURRENT version + history
 */

const dir = () => resolve(config.libraryDir, 'extractors');

export function idForDomain(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Library id for a menu page. Usually the domain — but on shared hosted systems
 * (many restaurants on one domain, e.g. semeny.no/sted/<venue>) the path is what
 * identifies the restaurant, so it becomes part of the id.
 */
export function idForUrl(url: string, domain: string, platform: string): string {
  const shared = !['wordpress', 'squarespace', 'wix', 'webflow', 'shopify', 'unknown'].includes(platform);
  if (!shared) return idForDomain(domain);
  let path = '';
  try {
    path = new URL(url).pathname.split('/').filter(Boolean).slice(0, 3).join('-');
  } catch {
    /* ignore */
  }
  return idForDomain(path ? `${domain}-${path}` : domain).slice(0, 80);
}

export interface StoredExtractor {
  meta: ExtractorMeta;
  code: string;
}

export function loadExtractor(id: string): StoredExtractor | null {
  const metaFile = resolve(dir(), id, 'meta.json');
  if (!existsSync(metaFile)) return null;
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as ExtractorMeta;
  const codeFile = resolve(dir(), id, `v${meta.version}.js`);
  if (!existsSync(codeFile)) return null;
  return { meta, code: stripHeader(readFileSync(codeFile, 'utf8')) };
}

export function loadVersion(id: string, version: number): string | null {
  const f = resolve(dir(), id, `v${version}.js`);
  return existsSync(f) ? stripHeader(readFileSync(f, 'utf8')) : null;
}

export function listExtractors(): StoredExtractor[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => loadExtractor(d.name))
    .filter((x): x is StoredExtractor => !!x)
    .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
}

const HEADER_END = '// --- end menusmith header ---\n';

function header(meta: ExtractorMeta): string {
  return [
    `// Menusmith extractor for ${meta.domain} — v${meta.version}`,
    `// Source page: ${meta.url}`,
    `// Written by ${meta.model}${meta.reusedFrom ? ` (adopted from ${meta.reusedFrom})` : ''} in ${meta.rounds} round(s); ` +
      `f1=${meta.score.f1} on ${meta.score.oracleCount} reference items.`,
    `// Generated code — runs only inside the Menusmith sandbox. Do not edit by hand.`,
    HEADER_END,
  ].join('\n');
}

function stripHeader(src: string): string {
  const i = src.indexOf(HEADER_END);
  return i === -1 ? src : src.slice(i + HEADER_END.length);
}

/** Save a new version; returns the stored meta (version assigned here). */
export function saveExtractor(meta: Omit<ExtractorMeta, 'version' | 'history'>, code: string, reason: string): ExtractorMeta {
  const folder = resolve(dir(), meta.id);
  mkdirSync(folder, { recursive: true });
  const prev = loadExtractor(meta.id);
  let version = (prev?.meta.version ?? 0) + 1;
  // Claim the version file atomically ('wx' fails if it exists): two concurrent
  // writers (a fleet heal and a forge) can never overwrite each other's version.
  for (;;) {
    const full: ExtractorMeta = {
      ...meta,
      version,
      history: [...(prev?.meta.history ?? []), { version, reason, at: meta.createdAt }],
    };
    try {
      writeFileSync(resolve(folder, `v${version}.js`), header(full) + code.trim() + '\n', { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        version++;
        continue;
      }
      throw e;
    }
    const tmp = resolve(folder, `.meta.${process.pid}.${version}.tmp`);
    writeFileSync(tmp, JSON.stringify(full, null, 2) + '\n');
    renameSync(tmp, resolve(folder, 'meta.json'));
    return full;
  }
}

/** Update only the drift baseline (after a legitimate menu change). */
export function updateBaseline(id: string, baselineHash: string, baselineCount: number): void {
  const metaFile = resolve(dir(), id, 'meta.json');
  if (!existsSync(metaFile)) return;
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as ExtractorMeta;
  meta.baselineHash = baselineHash;
  meta.baselineCount = baselineCount;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
}

/** Extractors on the same website platform — candidates for zero-token reuse. */
export function candidatesFor(platform: Platform, excludeId?: string, limit = 8): StoredExtractor[] {
  if (platform === 'unknown') return [];
  return listExtractors()
    .filter((x) => x.meta.platform === platform && x.meta.id !== excludeId && !x.meta.reusedFrom)
    .slice(0, limit);
}

/** Latest item list per extractor — the base for computing price changes. */
export function loadSnapshot(id: string): import('../types.ts').MenuItem[] | null {
  const f = resolve(config.libraryDir, 'snapshots', `${id}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

export function saveSnapshot(id: string, items: import('../types.ts').MenuItem[]): void {
  const d = resolve(config.libraryDir, 'snapshots');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.json`), JSON.stringify(items, null, 1) + '\n');
}

/** Image menus: record the fingerprints of the pictures just read, and the new baseline. */
export function updateImageSource(id: string, images: { url: string; sha256: string }[], baselineHash: string, baselineCount: number): void {
  const metaFile = resolve(dir(), id, 'meta.json');
  if (!existsSync(metaFile)) return;
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as ExtractorMeta;
  meta.source = { kind: 'image', request: { ...(meta.source?.request ?? { url: meta.url, method: 'GET' }), images } };
  meta.baselineHash = baselineHash;
  meta.baselineCount = baselineCount;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
}

/** PDF menus: record the fingerprint of the file just read, and the new baseline. */
export function updateDocumentSource(id: string, document: { url: string; sha256: string }, baselineHash: string, baselineCount: number): void {
  const metaFile = resolve(dir(), id, 'meta.json');
  if (!existsSync(metaFile)) return;
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as ExtractorMeta;
  meta.source = { kind: 'document', request: { ...(meta.source?.request ?? { url: meta.url, method: 'GET' }), document } };
  meta.baselineHash = baselineHash;
  meta.baselineCount = baselineCount;
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
}
