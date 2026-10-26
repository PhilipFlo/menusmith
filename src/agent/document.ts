import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { safeFetch } from '../html/netguard.ts';

/**
 * PDF MENUS — very common for restaurants (and a frequent failure for scrapers that
 * only speak HTML). Like image menus, a PDF has no structure to write selectors
 * against, so Menusmith fingerprints the file and only re-reads it when it changes.
 * The text layer is extracted locally with pdf.js; the oracle (Nemotron 3 Super)
 * reads that text. Scanned PDFs without a text layer are reported as such.
 */

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 12;

export function looksLikePdfUrl(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url);
}

export async function fetchPdf(url: string): Promise<{ bytes: Uint8Array; sha256: string; finalUrl: string }> {
  // safeFetch: every redirect hop passes the SSRF guard; size capped while streaming.
  const res = await safeFetch(url, { maxBytes: MAX_BYTES, timeoutMs: 30_000, init: { headers: { 'user-agent': 'Mozilla/5.0 Menusmith/0.1' } } });
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const buf = res.bytes;
  if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) throw new Error('not a PDF file');
  return { bytes: buf, sha256: createHash('sha256').update(buf).digest('hex'), finalUrl: res.url };
}

const WORKER = fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url));

/**
 * Text of the first pages, one visual line per line. Parsing runs in a worker thread
 * with its own heap cap and a hard timeout — PDFs are untrusted input.
 */
export function pdfText(bytes: Uint8Array, timeoutMs = Number(process.env.MENUSMITH_PDF_TIMEOUT_MS || 45_000)): Promise<{ text: string; pages: number }> {
  return new Promise((resolvePromise, reject) => {
    const w = new Worker(WORKER, { workerData: { bytes: bytes.slice() }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error(`PDF parsing timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    w.once('message', (m: { ok: boolean; text?: string; pages?: number; error?: string }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.ok) resolvePromise({ text: m.text || '', pages: m.pages || 0 });
      else reject(new Error(`PDF parsing failed: ${m.error}`));
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`PDF parsing failed: ${e.message}`));
    });
    w.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`PDF parser stopped (exit ${code}) — file too large or malformed`));
    });
  });
}

/** PDF links on a page whose URL or link text suggests a menu. */
export function menuPdfLinks(html: string, baseUrl: string, cheerio: typeof import('cheerio')): string[] {
  const $ = cheerio.load(html);
  const scored = new Map<string, number>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!looksLikePdfUrl(href)) return;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* malformed escape — use as is */
    }
    const hint = `${decoded} ${$(el).text()}`;
    if (!/(meny|menu|mat|food|drikke|drink|lunsj|lunch|middag|dinner|carte|spisekart|takeaway|brunch|breakfast)/i.test(hint)) return;
    // The main food menu first: a drinks list, wine list or catering sheet only if that's all.
    let score = 0;
    if (/(food|mat\b|dinner|middag|lunch|lunsj|brunch|breakfast|frokost|all.?day|main|placemat|a.?la.?carte|spisekart)/i.test(hint)) score += 3;
    if (/(menu|meny)/i.test(hint)) score += 1;
    if (/(drink|drikke|wine|vin\b|cocktail|bar\b|beer|øl\b|catering|allergen|kids|barn|dessert|happy.?hour|brochure)/i.test(hint)) score -= 2;
    try {
      const u = new URL(href, baseUrl).toString();
      scored.set(u, Math.max(scored.get(u) ?? -Infinity, score));
    } catch {
      /* ignore */
    }
  });
  return [...scored].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 3);
}
