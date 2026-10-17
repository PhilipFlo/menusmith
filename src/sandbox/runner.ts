import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MenuItem, RunResult } from '../types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, 'harness.cjs');
const NODE_MODULES = resolve(HERE, '../../node_modules');

const WALL_TIMEOUT_MS = 12_000;
const MAX_ITEMS = 3000;

/** Never trust the child's output shape: re-validate and cap on the host side too. */
function validItems(raw: unknown): MenuItem[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.slice(0, n) : null);
  const out: MenuItem[] = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const name = str(o.name, 200);
    if (!name) continue;
    out.push({
      section: str(o.section, 120),
      name,
      description: str(o.description, 500),
      price: typeof o.price === 'number' && Number.isFinite(o.price) ? o.price : null,
      currency: str(o.currency, 8),
    });
  }
  return out;
}
const MAX_STDOUT = 8 * 1024 * 1024;

/**
 * Run model-written extractor code against a page in an isolated Node process.
 *
 * Isolation layers (see harness.cjs for the in-process ones):
 *   1. separate process with env = {} — no secrets reachable,
 *   2. Node permission model: no fs writes, no child_process, no workers;
 *      reads only the harness dir and node_modules,
 *   3. 256 MB heap cap, wall-clock SIGKILL,
 *   4. vm context with CPU timeout and no string code-generation.
 */
export function runExtractor(code: string, payload: string, url: string, mode: 'html' | 'json' = 'html'): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${HERE}`,
        `--allow-fs-read=${NODE_MODULES}`,
        '--max-old-space-size=256',
        '--disallow-code-generation-from-strings',
        HARNESS,
      ],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, items: [], error: `timed out after ${WALL_TIMEOUT_MS} ms`, ms: Date.now() - t0 });
    }, WALL_TIMEOUT_MS);

    // Decode as one UTF-8 stream so multi-byte characters split across pipe chunks survive.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (out.length > MAX_STDOUT) {
        child.kill('SIGKILL');
        finish({ ok: false, items: [], error: 'output too large', ms: Date.now() - t0 });
      }
    });
    child.stderr.on('data', (d: string) => {
      if (err.length < 4000) err += d;
    });
    child.on('error', (e) => finish({ ok: false, items: [], error: `spawn failed: ${e.message}`, ms: Date.now() - t0 }));
    child.on('close', (codeExit) => {
      const line = out.trim().split('\n').pop() || '';
      try {
        const parsed = JSON.parse(line) as RunResult;
        finish({
          ok: !!parsed.ok,
          items: validItems(parsed.items),
          error: typeof parsed.error === 'string' ? parsed.error.slice(0, 2000) : undefined,
          ms: Date.now() - t0,
          trace: Array.isArray(parsed.trace) ? parsed.trace.filter((t) => typeof t === 'string').slice(0, 40).map((t) => t.slice(0, 300)) : undefined,
        });
      } catch {
        const why = err.trim().split('\n').slice(-3).join(' ') || `exit code ${codeExit}`;
        finish({ ok: false, items: [], error: `sandbox crashed: ${why}`, ms: Date.now() - t0 });
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(mode === 'json' ? { code, json: payload, url, mode } : { code, html: payload, url, mode }));
  });
}
