import { createHash } from 'node:crypto';
import { assertPublicUrl } from '../html/netguard.ts';

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
  await assertPublicUrl(url);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Mozilla/5.0 Menusmith/0.1' } });
  if (res.url && res.url !== url) await assertPublicUrl(res.url);
  if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('PDF too large');
  if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) throw new Error('not a PDF file');
  return { bytes: buf, sha256: createHash('sha256').update(buf).digest('hex'), finalUrl: res.url || url };
}

/**
 * Text of the first pages, one visual line per line (items grouped by their y
 * position, ordered left to right), so "Margherita ........ 189" stays on one line.
 */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    // pdf.js takes ownership of (detaches) the buffer — give it a copy.
    data: bytes.slice(),
    // Untrusted input: no eval (CVE-2024-4367), no font loading, no external fetches.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  }).promise;
  const out: string[] = [];
  const pages = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (!it.str?.trim() || !it.transform) continue;
      const y = Math.round(it.transform[5]! / 3) * 3; // bucket nearby baselines
      const row = rows.get(y) || [];
      row.push({ x: it.transform[4]!, s: it.str });
      rows.set(y, row);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(
        rows
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((r) => r.s)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    out.push('');
    page.cleanup();
  }
  await doc.destroy();
  return { text: out.join('\n').trim(), pages };
}

/** PDF links on a page whose URL or link text suggests a menu. */
export function menuPdfLinks(html: string, baseUrl: string, cheerio: typeof import('cheerio')): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
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
    if (!/(meny|menu|mat|food|drikke|drink|lunsj|lunch|middag|dinner|carte|spisekart|takeaway)/i.test(hint)) return;
    try {
      out.add(new URL(href, baseUrl).toString());
    } catch {
      /* ignore */
    }
  });
  return [...out].slice(0, 3);
}
