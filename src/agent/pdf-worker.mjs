// Worker thread: extract the text layer of an untrusted PDF with pdf.js.
// Runs off the main thread with its own heap cap (set by the parent) and is
// terminated by the parent on timeout, so a malicious or huge PDF can't stall
// or exhaust the server.
import { parentPort, workerData } from 'node:worker_threads';

const MAX_PAGES = 12;

async function run() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: workerData.bytes,
    // Untrusted input: no eval (CVE-2024-4367), no font loading, no external fetches.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  }).promise;
  const out = [];
  const pages = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const width = page.getViewport({ scale: 1 }).width || 612;
    const content = await page.getTextContent();
    const items = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[0]) || 10;
      items.push({ x: it.transform[4], y: it.transform[5], w: it.width || size * 0.5 * it.str.length, size, s: it.str });
    }
    for (const col of columns(items, width)) {
      out.push(...rowsOf(col));
      out.push('');
    }
    page.cleanup();
    if (out.join('\n').length > 400_000) break;
  }
  await doc.destroy();
  return { text: out.join('\n').trim(), pages };
}

/**
 * Designed menus are laid out in columns. Find vertical gutters — x ranges no text crosses —
 * and read each column top to bottom, instead of reading rows across the whole page.
 */
function columns(items, width) {
  if (items.length < 20) return [items];
  const W = Math.ceil(width);
  const covered = new Uint8Array(W + 1);
  for (const it of items) {
    // Wide single runs (titles across the page) would hide the gutters — ignore them here.
    if (it.w > width * 0.45) continue;
    for (let x = Math.max(0, Math.floor(it.x)); x <= Math.min(W, Math.ceil(it.x + it.w)); x++) covered[x] = 1;
  }
  const minGap = Math.max(12, width * 0.02);
  const cuts = [];
  let start = -1;
  for (let x = Math.floor(width * 0.08); x <= Math.ceil(width * 0.92); x++) {
    if (!covered[x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= minGap) cuts.push((start + x) / 2);
      start = -1;
    }
  }
  if (!cuts.length) return [items];
  const bounds = [-Infinity, ...cuts, Infinity];
  const cols = bounds.slice(0, -1).map(() => []);
  for (const it of items) {
    const cx = it.w > width * 0.45 ? it.x : it.x + it.w / 2;
    const k = bounds.findIndex((b, i) => cx >= b && cx < bounds[i + 1]);
    cols[Math.max(0, k)].push(it);
  }
  return cols.filter((c) => c.length);
}

/** Rows of one column, top to bottom; within a row, pieces joined by their real gaps. */
function rowsOf(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, it.size * 0.35));
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => {
      const xs = r.items.sort((a, b) => a.x - b.x);
      let line = '';
      let end = null;
      for (const it of xs) {
        // Letter-spaced type ("P O T A T O", "2 4") comes as separate pieces with small gaps.
        const gap = end === null ? 0 : it.x - end;
        if (end !== null) line += gap > it.size * 0.12 ? (gap > it.size * 2.5 ? '   ' : ' ') : '';
        line += it.s;
        end = it.x + it.w;
      }
      // Letter-spaced headings and prices ("A P P E T I Z E R S", "P O T AT O") → words.
      return line
        .replace(/(?:^|(?<=\s))((?:[\p{L}\d&]{1,2} ){2,}[\p{L}\d&]{1,2})(?=\s|$|[,.|])/gu, (m) => m.replace(/ /g, ''))
        .replace(/\s+/g, ' ')
        .trim();
    })
    .filter(Boolean);
}

run().then(
  (r) => parentPort.postMessage({ ok: true, ...r }),
  (e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e) }),
);
