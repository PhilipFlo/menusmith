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
    const content = await page.getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const y = Math.round(it.transform[5] / 3) * 3; // bucket nearby baselines
      const row = rows.get(y) || [];
      row.push({ x: it.transform[4], s: it.str });
      rows.set(y, row);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(
        rows
          .get(y)
          .sort((a, b) => a.x - b.x)
          .map((r) => r.s)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    out.push('');
    page.cleanup();
    if (out.join('\n').length > 400_000) break;
  }
  await doc.destroy();
  return { text: out.join('\n').trim(), pages };
}

run().then(
  (r) => parentPort.postMessage({ ok: true, ...r }),
  (e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e) }),
);
