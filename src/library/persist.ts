import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { config } from '../config.ts';

/**
 * Optional durable mirror for the library folder.
 *
 * Menusmith keeps its library (extractors, snapshots, fleet reports) as plain files
 * so it runs anywhere. On hosts with an ephemeral disk (Render free tier, many
 * serverless platforms) those files vanish on restart — so when MENUSMITH_STORE_*
 * is configured, every write is mirrored to a small Postgres table (Supabase REST,
 * row-level security + a secret header token), and the folder is restored from it
 * at startup. Without the variables this module is a no-op.
 */

const URL_ = process.env.MENUSMITH_STORE_URL || '';
const KEY = process.env.MENUSMITH_STORE_KEY || '';
const TOKEN = process.env.MENUSMITH_STORE_TOKEN || '';
/**
 * Writing to the shared store is opt-in (MENUSMITH_STORE_SYNC=1, set only in the deployed
 * images and the nightly job) and only in live mode: a local script, test or replayed demo
 * that happens to have the variables in .env must never change the public library.
 */
export const storeEnabled = () => !!(URL_ && KEY && TOKEN) && process.env.MENUSMITH_STORE_SYNC === '1' && config.llmMode === 'live';

const table = () => `${URL_.replace(/\/$/, '')}/rest/v1/menusmith_files`;
const headers = (extra: Record<string, string> = {}) => ({
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  'x-menusmith-token': TOKEN,
  'content-type': 'application/json',
  ...extra,
});

// Uploads are serialised (one chain): files go up in the order they were written, so a
// version's code always lands before the meta.json that points to it.
let chain: Promise<void> = Promise.resolve();
let queued = 0;
/** False after a failed restore — then mirroring stale local files could overwrite good rows. */
let storeTrusted = true;
/** When each path was last written locally — a re-sync must not revert a write made while it ran. */
const localWrites = new Map<string, number>();

function relPath(abs: string): string | null {
  const rel = relative(config.libraryDir, abs);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

async function upsert(rows: { path: string; content: string }[]): Promise<void> {
  if (!rows.length) return;
  const res = await fetch(table(), {
    method: 'POST',
    headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`store upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Write a library file and (when a store is configured) mirror it durably. */
export function writePersisted(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  mirror(abs, content);
}

/** Mirror a file that was written locally (e.g. via an atomic rename). */
export function mirror(abs: string, content?: string): void {
  if (!storeEnabled()) return;
  if (!storeTrusted) {
    console.warn('[persist] store was not restored at startup — not mirroring (local files may be stale)');
    return;
  }
  const path = relPath(abs);
  if (!path) return;
  localWrites.set(path, Date.now());
  const body = content ?? readFileSync(abs, 'utf8');
  queued++;
  chain = chain
    .then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await upsert([{ path, content: body }]);
          return;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    })
    .catch((e) => console.warn(`[persist] could not mirror ${path}: ${(e as Error).message}`))
    .finally(() => {
      queued--;
    });
}

/** Wait for queued uploads (call before a CLI/job process exits, and on SIGTERM). */
export async function flush(): Promise<void> {
  while (queued > 0) await chain;
}

let lastRefresh = 0;
/**
 * Re-sync the local folder from the store if the last sync is older than `maxAgeMs`
 * (another writer — the nightly fleet job — may have updated it). Waits for our own
 * pending uploads first so we never pull back a stale copy of our own write.
 */
export async function refresh(maxAgeMs = 60_000): Promise<void> {
  if (!storeEnabled() || Date.now() - lastRefresh < maxAgeMs) return;
  await flush();
  try {
    await pull();
    storeTrusted = true;
    lastRefresh = Date.now();
  } catch (e) {
    console.warn(`[persist] refresh failed, serving local files: ${(e as Error).message}`);
  }
}

function listLocal(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(listLocal(p));
    else out.push(p);
  }
  return out;
}

/**
 * Startup: restore the library folder from the store. If the store is empty (first
 * boot), seed it from the local folder (the library shipped in the image).
 */
async function pull(): Promise<number> {
  const started = Date.now();
  let restored = 0;
  const pageSize = 200;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${table()}?select=path,content&order=path`, {
      headers: headers({ range: `${from}-${from + pageSize - 1}`, 'range-unit': 'items' }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`store read ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as { path: string; content: string }[];
    for (const r of rows) {
      const abs = resolve(config.libraryDir, r.path);
      if (!abs.startsWith(config.libraryDir + sep)) continue;
      if ((localWrites.get(r.path) ?? 0) >= started) continue; // written here during this pull — ours is newer
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, r.content);
      restored++;
    }
    if (rows.length < pageSize) break;
  }
  return restored;
}

export async function hydrate(): Promise<{ restored: number; seeded: number }> {
  if (!storeEnabled()) return { restored: 0, seeded: 0 };
  let restored: number;
  try {
    restored = await pull();
  } catch (e) {
    storeTrusted = false;
    throw e;
  }
  lastRefresh = Date.now();
  let seeded = 0;
  if (restored === 0) {
    const files = listLocal(config.libraryDir);
    for (let i = 0; i < files.length; i += 50) {
      const batch = files
        .slice(i, i + 50)
        .map((f) => ({ path: relPath(f)!, content: readFileSync(f, 'utf8') }))
        .filter((r) => r.path && /^[A-Za-z0-9._/-]+$/.test(r.path));
      await upsert(batch);
      seeded += batch.length;
    }
  }
  return { restored, seeded };
}
