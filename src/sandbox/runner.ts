import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '../types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, 'harness.cjs');
const NODE_MODULES = resolve(HERE, '../../node_modules');

const WALL_TIMEOUT_MS = 12_000;
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

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > MAX_STDOUT) {
        child.kill('SIGKILL');
        finish({ ok: false, items: [], error: 'output too large', ms: Date.now() - t0 });
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4000) err += d.toString('utf8');
    });
    child.on('error', (e) => finish({ ok: false, items: [], error: `spawn failed: ${e.message}`, ms: Date.now() - t0 }));
    child.on('close', (codeExit) => {
      const line = out.trim().split('\n').pop() || '';
      try {
        const parsed = JSON.parse(line) as RunResult;
        finish({ ok: !!parsed.ok, items: parsed.items || [], error: parsed.error, ms: Date.now() - t0 });
      } catch {
        const why = err.trim().split('\n').slice(-3).join(' ') || `exit code ${codeExit}`;
        finish({ ok: false, items: [], error: `sandbox crashed: ${why}`, ms: Date.now() - t0 });
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(mode === 'json' ? { code, json: payload, url, mode } : { code, html: payload, url, mode }));
  });
}
