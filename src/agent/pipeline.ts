import { config, MODELS, modelName } from '../config.ts';
import { domainOf, fetchPage, type Page } from '../html/fetch.ts';
import { detectPlatform } from '../html/platform.ts';
import { detectPriceColumns, skeleton } from '../html/simplify.ts';
import { jsonMenuLines, jsonSkeletonText } from '../html/jsonview.ts';
import { Ledger, type ChatMessage } from '../llm/client.ts';
import { candidatesFor, idForUrl, loadExtractor, saveExtractor, saveSnapshot } from '../library/store.ts';
import { runExtractor } from '../sandbox/runner.ts';
import { findOfficialSite, tavilyEnabled } from '../tools/tavily.ts';
import type { Emit, ExtractorMeta, MenuItem, RunResult, Score } from '../types.ts';
import { findMenuPage, priceDensity } from './discover.ts';
import { acquire, reacquire, type Acquired } from './acquire.ts';
import { detectHardcoding, ESCALATE_AFTER, feedbackMessage, initialMessages, initialMessagesJson, writeCode } from './forge.ts';
import { itemsHash, nameSimilarity, normName, scoreAgainstOracle } from './evaluate.ts';
import { readMenu } from './oracle.ts';
import { arbitrate } from './judge.ts';
import { readMenuImages } from './vision.ts';
import { fetchPdf, looksLikePdfUrl, pdfText } from './document.ts';
import { jsonShapeReport, selectorReport } from './debugger.ts';

export interface ForgeInput {
  /** Any page of the restaurant's site (menu page preferred). */
  url?: string;
  /** Restaurant name — used to find the site with Tavily when no URL is given. */
  restaurant?: string;
  city?: string;
  /** Skip library reuse and always write fresh code. */
  noReuse?: boolean;
  /** Existing extractor to repair (self-heal): its code seeds the conversation. */
  repairOf?: { code: string; reason: string };
  /** Dishes that must be in the output for a repair to pass (they are on the page and were lost). */
  mustInclude?: string[];
  /** Don't follow links / call Tavily; treat `url` as the menu page. */
  noDiscover?: boolean;
  /** Allow the headless-browser path for JavaScript-built menus (default true). */
  allowRender?: boolean;
  /** A fresh oracle reading the caller already has (the fleet's drift check) — saves a call. */
  oracle?: MenuItem[];
  /** Caller-owned ledger (budget cap + cancellation); spend survives exceptions. */
  ledger?: Ledger;
}

export interface ForgeOutcome {
  ok: boolean;
  reason?: string;
  meta?: ExtractorMeta;
  code?: string;
  items?: MenuItem[];
  oracleCount: number;
  rounds: number;
  bestScore?: Score;
  ledger: Ledger;
  ms: number;
  /** "forged" | "reused" | "healed" | "vision" (image menu) | "document" (PDF menu) — the last two are fingerprinted */
  mode?: 'forged' | 'reused' | 'healed' | 'vision' | 'document';
  /** The reference reading the extractor was graded against (after arbitration). */
  oracle?: MenuItem[];
}

const noop: Emit = () => {};

/** Stored in place of code for PDF menus (never executed). */
export const DOCUMENT_EXTRACTOR = `// This restaurant publishes its menu as a PDF. Its text layer is extracted locally
// (pdf.js) and read by Nemotron 3 Super; Menusmith stores the file's sha256
// fingerprint and the fleet re-reads it only when the PDF changes.
function extract() { return []; }`;

/** Stored in place of code for image menus (never executed). */
export const IMAGE_EXTRACTOR = `// This restaurant publishes its menu as image(s), so there is no page structure to
// write code against. Menusmith fingerprints each image (sha256 of the bytes) and the
// fleet re-reads a picture with Nemotron 3.5 Super VL only when its fingerprint changes.
function extract() { return []; }`;

/** Keep only oracle items whose name actually occurs on the page (drops hallucinations). */
export function groundOracle(items: MenuItem[], text: string): { kept: MenuItem[]; dropped: MenuItem[] } {
  const page = normName(text);
  const kept: MenuItem[] = [];
  const dropped: MenuItem[] = [];
  for (const it of items) {
    const n = normName(it.name);
    // Accept if the full name occurs, or (for long names) its first three words do.
    const head = n.split(' ').slice(0, 3).join(' ');
    if (n && (page.includes(n) || (head.length >= 6 && page.includes(head)))) kept.push(it);
    else dropped.push(it);
  }
  return { kept, dropped };
}

export async function forge(input: ForgeInput, emit: Emit = noop): Promise<ForgeOutcome> {
  const t0 = Date.now();
  const ledger = input.ledger ?? new Ledger();
  const fail = (reason: string, extra: Partial<ForgeOutcome> = {}): ForgeOutcome => {
    emit({ type: 'result', ok: false, reason });
    return { ok: false, reason, oracleCount: 0, rounds: 0, ledger, ms: Date.now() - t0, ...extra };
  };

  // PDF menus: extract the text layer, let the oracle read it, fingerprint the file.
  const documentPath = async (docUrl: string, pageUrl: string): Promise<ForgeOutcome> => {
    emit({ type: 'step', step: 'document', status: 'start', detail: `Reading the PDF menu ${docUrl.split('/').pop()}` });
    let pdf: Awaited<ReturnType<typeof fetchPdf>>;
    let text: string;
    try {
      pdf = await fetchPdf(docUrl);
      const t = await pdfText(pdf.bytes);
      text = t.text;
      emit({ type: 'log', message: `PDF: ${t.pages} page(s), ${text.length.toLocaleString()} characters of text` });
    } catch (e) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: (e as Error).message });
      return fail(`could not read the PDF: ${(e as Error).message}`);
    }
    if (text.replace(/\s+/g, '').length < 150) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: 'the PDF has no text layer (scanned)' });
      return fail('scanned PDF without a text layer');
    }
    let items: MenuItem[];
    try {
      const o = await readMenu(text, { url: docUrl, restaurant: input.restaurant }, ledger, emit);
      items = groundOracle(o.items, text).kept;
    } catch (e) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: (e as Error).message });
      return fail(`oracle failed: ${(e as Error).message}`);
    }
    if (items.length < 3) {
      emit({ type: 'step', step: 'document', status: 'fail', detail: 'no menu found in the PDF' });
      return fail('no menu with dishes found in the PDF');
    }
    emit({ type: 'oracle', items });
    emit({ type: 'step', step: 'document', status: 'done', detail: `${items.length} dishes from the PDF` });
    const domain = domainOf(pageUrl);
    const platform = detectPlatform('', pageUrl);
    // A direct PDF link often lives on a shared CDN (squarespace-cdn, wsimg, Drive…):
    // key it by its path too, so different restaurants never share an id.
    const id = pageUrl === docUrl || looksLikePdfUrl(pageUrl) ? idForUrl(pageUrl, domain, 'pdf') : idForUrl(pageUrl, domain, platform);
    const priced = items.filter((i) => i.price != null).length / items.length;
    const meta = saveExtractor(
      {
        id,
        url: pageUrl,
        domain,
        restaurant: input.restaurant ?? null,
        platform,
        source: { kind: 'document', request: { url: pageUrl, method: 'GET', document: { url: pdf.finalUrl, sha256: pdf.sha256 } } },
        createdAt: new Date().toISOString(),
        model: MODELS.oracle[0]!,
        rounds: 0,
        score: { precision: 1, recall: 1, f1: 1, pricedRatio: Math.round(priced * 1000) / 1000, oracleCount: items.length, extractorCount: items.length },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselineHash: itemsHash(items),
        baselineCount: items.length,
        baselinePriced: Math.round(priced * 1000) / 1000,
        reusedFrom: null,
      },
      DOCUMENT_EXTRACTOR,
      'document: read the PDF menu',
    );
    saveSnapshot(id, items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version} (PDF fingerprint)` });
    emit({ type: 'result', ok: true, meta, items });
    return { ok: true, meta, code: DOCUMENT_EXTRACTOR, items, oracleCount: items.length, rounds: 0, ledger, ms: Date.now() - t0, mode: 'document' };
  };

  // 1. Locate the website.
  let url = input.url?.trim();
  if (!url) {
    if (!input.restaurant) return fail('give a URL or a restaurant name');
    if (!tavilyEnabled()) return fail('no URL given and TAVILY_API_KEY is not set');
    emit({ type: 'step', step: 'discover', status: 'start', detail: `Searching the web for ${input.restaurant}` });
    const site = await findOfficialSite(input.restaurant, input.city).catch((e) => {
      emit({ type: 'log', message: `Tavily search failed: ${(e as Error).message}` });
      return null;
    });
    if (!site) {
      emit({ type: 'step', step: 'discover', status: 'fail' });
      return fail(`could not find an official website for ${input.restaurant}`);
    }
    url = site.url;
    emit({ type: 'step', step: 'discover', status: 'done', detail: `Tavily: ${site.title} → ${url}` });
  }

  // A link straight to a PDF menu.
  if (looksLikePdfUrl(url)) return documentPath(url, url);

  // 2. Fetch + find the menu page.
  emit({ type: 'step', step: 'fetch', status: 'start', detail: url });
  let page: Page;
  try {
    page = await fetchPage(url);
  } catch (e) {
    emit({ type: 'step', step: 'fetch', status: 'fail', detail: (e as Error).message });
    return fail((e as Error).message);
  }
  // Served as a PDF despite the URL.
  if (page.html.startsWith('%PDF')) return documentPath(page.finalUrl, page.finalUrl);
  if (page.status >= 400) {
    emit({ type: 'step', step: 'fetch', status: 'fail', detail: `HTTP ${page.status}` });
    return fail(`HTTP ${page.status} from ${url}`);
  }
  emit({ type: 'step', step: 'fetch', status: 'done', detail: `${Math.round(page.html.length / 1024)} KB` });

  if (!input.noDiscover) {
    emit({ type: 'step', step: 'locate', status: 'start', detail: 'Looking for the menu page' });
    const found = await findMenuPage(page, { restaurant: input.restaurant, ledger, emit });
    page = found.page;
    emit({ type: 'step', step: 'locate', status: 'done', detail: found.how });
  }

  // 2b. Get the menu in its most stable form: server HTML, a JSON menu API, or the rendered DOM.
  let acq: Acquired;
  try {
    acq = await acquire(page, emit, { allowRender: input.allowRender !== false });
  } catch (e) {
    emit({ type: 'step', step: 'render', status: 'fail', detail: (e as Error).message });
    return fail(`could not load the page in a browser: ${(e as Error).message}`);
  }
  const mode: 'html' | 'json' = acq.kind === 'json' ? 'json' : 'html';
  const menuUrl = acq.url;
  const domain = domainOf(acq.request?.url && acq.kind === 'json' ? menuUrl : menuUrl);
  const platform = detectPlatform(acq.html, acq.kind === 'json' ? acq.request!.url : menuUrl);
  const id = idForUrl(menuUrl, domain, platform);
  // What the oracle reads: the visible page — or, for API menus whose page shows no
  // prices, the menu fields of the JSON itself.
  let text = acq.text;
  if (acq.kind === 'json' && priceDensity(acq.html) < 5) {
    try {
      text = jsonMenuLines(JSON.parse(acq.payload));
    } catch {
      /* keep page text */
    }
  }
  emit({ type: 'log', message: `Source: ${acq.note} · platform ${platform}` });

  if (acq.kind === 'document') return documentPath(acq.payload, acq.url);

  // Image menus: no structure to write code against. Read the pictures with Nemotron
  // 3.5 Super VL and store their fingerprints — re-runs only re-read a changed image.
  if (acq.kind === 'image') {
    emit({ type: 'step', step: 'vision', status: 'start', detail: `${modelName(MODELS.vision[0]!)} is reading the menu images` });
    let v: Awaited<ReturnType<typeof readMenuImages>>;
    try {
      v = await readMenuImages(JSON.parse(acq.payload) as string[], ledger, emit);
    } catch (e) {
      emit({ type: 'step', step: 'vision', status: 'fail', detail: (e as Error).message });
      return fail(`could not read the menu images: ${(e as Error).message}`);
    }
    if (v.items.length < 3) {
      emit({ type: 'step', step: 'vision', status: 'fail', detail: 'no readable menu in the images' });
      return fail('the menu images could not be read');
    }
    emit({ type: 'oracle', items: v.items });
    emit({ type: 'step', step: 'vision', status: 'done', detail: `${v.items.length} dishes from ${v.images.length} image(s)` });
    const priced = v.items.filter((i) => i.price != null).length / v.items.length;
    const meta = saveExtractor(
      {
        id,
        url: menuUrl,
        domain,
        restaurant: input.restaurant ?? null,
        platform,
        source: { kind: 'image', request: { url: menuUrl, method: 'GET', images: v.images } },
        createdAt: new Date().toISOString(),
        model: MODELS.vision[0]!,
        rounds: 0,
        // No code is tested on this path — the reading itself is the result.
        score: { precision: 1, recall: 1, f1: 1, pricedRatio: Math.round(priced * 1000) / 1000, oracleCount: v.items.length, extractorCount: v.items.length },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselineHash: itemsHash(v.items),
        baselineCount: v.items.length,
        baselinePriced: Math.round(priced * 1000) / 1000,
        reusedFrom: null,
      },
      IMAGE_EXTRACTOR,
      `vision: read ${v.images.length} menu image(s)`,
    );
    saveSnapshot(id, v.items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version} (image fingerprints)` });
    emit({ type: 'result', ok: true, meta, items: v.items });
    return { ok: true, meta, code: IMAGE_EXTRACTOR, items: v.items, oracleCount: v.items.length, rounds: 0, ledger, ms: Date.now() - t0, mode: 'vision' };
  }

  // 3. Oracle reading (Nemotron Super).
  let oracleItems: MenuItem[];
  if (input.oracle?.length) {
    oracleItems = input.oracle;
    emit({ type: 'oracle', items: oracleItems });
    emit({ type: 'step', step: 'oracle', status: 'done', detail: `${oracleItems.length} items (fresh reading from the drift check)` });
  } else try {
    emit({ type: 'step', step: 'oracle', status: 'start', detail: `${modelName(MODELS.oracle[0]!)} is reading the menu` });
    const o = await readMenu(text, { url: menuUrl, restaurant: input.restaurant }, ledger, emit);
    if (!o.isMenu) {
      emit({ type: 'step', step: 'oracle', status: 'fail', detail: 'no menu found on this page' });
      return fail('no menu with dishes found on the page (it may be a PDF, an image, or rendered by JavaScript)');
    }
    const g = groundOracle(o.items, text);
    oracleItems = g.kept;
    if (g.dropped.length) emit({ type: 'log', message: `Dropped ${g.dropped.length} oracle item(s) not found in the page text` });
    emit({ type: 'oracle', items: oracleItems });
    emit({ type: 'step', step: 'oracle', status: 'done', detail: `${oracleItems.length} items, currency ${o.currency ?? '?'}` });
  } catch (e) {
    emit({ type: 'step', step: 'oracle', status: 'fail', detail: (e as Error).message });
    return fail(`oracle failed: ${(e as Error).message}`);
  }
  if (oracleItems.length < 3) return fail('too few menu items to build a reliable extractor', { oracleCount: oracleItems.length });

  const baseMeta = {
    id,
    url: menuUrl,
    domain,
    restaurant: input.restaurant ?? null,
    platform,
    source: { kind: acq.kind, request: acq.request ?? null },
  };

  const finalize = async (code: string, score: Score, run: RunResult, rounds: number, model: string, how: 'forged' | 'reused' | 'healed', reusedFrom?: string) => {
    // Determinism: a second run must produce the identical item set.
    const again = await runExtractor(code, acq.payload, menuUrl, mode);
    if (!again.ok || itemsHash(again.items) !== itemsHash(run.items)) {
      emit({ type: 'log', message: 'Second run differed — extractor is not deterministic; rejecting' });
      return null;
    }
    const meta = saveExtractor(
      {
        ...baseMeta,
        createdAt: new Date().toISOString(),
        model,
        rounds,
        score: {
          precision: score.precision,
          recall: score.recall,
          f1: score.f1,
          pricedRatio: score.pricedRatio,
          oracleCount: score.oracleCount,
          extractorCount: score.extractorCount,
        },
        tokens: { prompt: ledger.promptTokens, completion: ledger.completionTokens },
        costUsd: Math.round(ledger.listCostUsd * 1e6) / 1e6,
        baselinePriced: run.items.length ? Math.round((run.items.filter((i) => i.price != null).length / run.items.length) * 1000) / 1000 : 0,
        baselineHash: itemsHash(run.items),
        baselineCount: run.items.length,
        reusedFrom: reusedFrom ?? null,
      },
      code,
      how === 'reused' ? `adopted from ${reusedFrom}` : how === 'healed' ? `self-heal: ${input.repairOf?.reason}` : 'forged',
    );
    saveSnapshot(id, run.items);
    emit({ type: 'step', step: 'commit', status: 'done', detail: `${id} v${meta.version}` });
    emit({ type: 'result', ok: true, meta, items: run.items });
    return { ok: true, meta, code, items: run.items, oracleCount: oracleItems.length, rounds, bestScore: score, ledger, ms: Date.now() - t0, mode: how } satisfies ForgeOutcome;
  };

  // 4. Library reuse — an extractor written for another site on the same platform may just work (0 tokens).
  if (!input.noReuse && !input.repairOf) {
    const cands = candidatesFor(platform, id);
    if (cands.length) {
      emit({ type: 'step', step: 'reuse', status: 'start', detail: `Trying ${cands.length} ${platform} extractor(s) from the library` });
      for (const c of cands) {
        if ((c.meta.source?.kind === 'json') !== (mode === 'json')) continue;
        const run = await runExtractor(c.code, acq.payload, menuUrl, mode);
        if (!run.ok) continue;
        const score = scoreAgainstOracle(oracleItems, run.items, text);
        emit({ type: 'log', message: `  ${c.meta.id}: f1=${score.f1}` });
        if (score.pass) {
          emit({ type: 'step', step: 'reuse', status: 'done', detail: `Adopted ${c.meta.id} (f1 ${score.f1}) — no code generation needed` });
          const r = await finalize(c.code, score, run, 0, c.meta.model, 'reused', c.meta.id);
          if (r) return r;
        }
      }
      emit({ type: 'step', step: 'reuse', status: 'skip', detail: 'No library extractor fits — writing a new one' });
    }
  }

  // 5. Forge → test → repair loop (Nemotron Super, escalating to Ultra).
  const messages: ChatMessage[] =
    mode === 'json'
      ? initialMessagesJson({
          url: menuUrl,
          platform,
          apiUrl: acq.request!.url,
          method: acq.request!.method,
          jsonSkeleton: jsonSkeletonText(JSON.parse(acq.payload)),
          oracle: oracleItems,
          pathReport: jsonShapeReport(acq.payload),
        })
      : initialMessages({ url: menuUrl, platform, skeleton: skeleton(acq.payload), oracle: oracleItems, priceColumns: detectPriceColumns(acq.payload) });
  if (input.repairOf) {
    messages.push({ role: 'assistant', content: '```javascript\n' + input.repairOf.code + '\n```' });
    messages.push({
      role: 'user',
      content: `This extractor worked when it was written, but the website has changed and it now fails: ${input.repairOf.reason}. The ${mode === 'json' ? 'JSON' : 'HTML'} above is the CURRENT ${mode === 'json' ? 'API response' : 'page'}. Rewrite the complete function so it works on it.`,
    });
  }

  let best: { score: Score; code: string; run: RunResult } | null = null;
  const maxRounds = 1 + config.maxRepairs;
  let lastModel = '';
  let stagnant = 0;
  let arbitrations = 0;
  let roundsUsed = 0;
  for (let round = 1; round <= maxRounds; round++) {
    roundsUsed = round;
    emit({ type: 'step', step: round === 1 ? 'forge' : 'repair', status: 'start', detail: round === 1
          ? `${modelName(MODELS.forge[0]!)} is writing the extractor`
          : round > ESCALATE_AFTER
            ? `Repair round ${round - 1}: escalated to ${modelName(MODELS.escalate[0]!)}`
            : `Repair round ${round - 1}: ${modelName(MODELS.forge[0]!)} is fixing its code` });
    let code: string | null;
    try {
      const w = await writeCode(messages, round, ledger, emit);
      code = w.code;
      lastModel = Object.keys(ledger.byModel).pop() || '';
      messages.push({ role: 'assistant', content: w.reply || '(empty reply)' });
      if (w.reasoning) emit({ type: 'log', message: `Reasoning: ${w.reasoning.slice(0, 600)}${w.reasoning.length > 600 ? '…' : ''}` });
    } catch (e) {
      emit({ type: 'step', step: 'forge', status: 'fail', detail: (e as Error).message });
      return fail(`code generation failed: ${(e as Error).message}`, { oracleCount: oracleItems.length, rounds: round });
    }
    if (!code) {
      messages.push({ role: 'user', content: `Your reply did not contain a \`\`\`javascript block defining function extract(${mode === 'json' ? 'data' : '$'}, ctx). Return the complete function.` });
      emit({ type: 'step', step: 'test', status: 'fail', detail: 'no code in reply' });
      continue;
    }
    emit({ type: 'step', step: round === 1 ? 'forge' : 'repair', status: 'done', detail: `${code.split('\n').length} lines of code` });
    emit({ type: 'code', version: round, round, code });
    emit({ type: 'step', step: 'test', status: 'start', detail: `Running round ${round} in the sandbox` });

    const hard = detectHardcoding(code, oracleItems);
    const run = hard.length ? { ok: false, items: [], error: 'hard-coded content', ms: 0 } : await runExtractor(code, acq.payload, menuUrl, mode);
    let score = run.ok ? scoreAgainstOracle(oracleItems, run.items, text) : null;
    // Disagreement between the reading and the code on specific items → Nemotron Nano arbitrates.
    if (score && score.f1 >= 0.75 && (score.grounded.length || score.extra.length || score.missing.length) && arbitrations < 3) {
      const disputedExtractor = [...score.grounded, ...score.extra];
      const disputedOracle = score.pass ? [] : score.missing;
      try {
        arbitrations++;
        const a = await arbitrate(disputedExtractor, disputedOracle, text, ledger, emit);
        // Dishes a repair must recover are known to be real — never let a tie-break drop them.
        for (const n of input.mustInclude ?? []) a.rejected.delete(normName(n));
        if (a.disputed) {
          const before = oracleItems.length;
          oracleItems = [...oracleItems.filter((i) => !a.rejected.has(normName(i.name))), ...a.accepted];
          score = scoreAgainstOracle(oracleItems, run.items, text, { rejected: a.rejected });
          emit({
            type: 'log',
            message: `Nemotron Nano arbitrated ${a.disputed} disputed item(s): ${a.rejected.size} not dishes, ${a.accepted.length} dish(es) the reading missed · reference ${before} → ${oracleItems.length} items`,
          });
          if (a.accepted.length || before !== oracleItems.length) emit({ type: 'oracle', items: oracleItems });
        }
      } catch (e) {
        emit({ type: 'log', message: `Arbitration unavailable: ${(e as Error).message}` });
      }
    }
    // A repair that doesn't bring back the dishes it was started for has not passed.
    if (score && input.mustInclude?.length) {
      const got = run.items.map((i) => normName(i.name));
      const still = input.mustInclude.filter((n) => !got.some((g) => g === normName(n) || nameSimilarity(g, normName(n)) >= 0.8));
      if (still.length) {
        score = { ...score, pass: false, failures: [`still missing these dishes that are on the page: ${still.slice(0, 8).join(', ')}`, ...score.failures] };
      }
    }
    emit({
      type: 'test',
      round,
      score: score ?? scoreAgainstOracle(oracleItems, [], text),
      run: { ok: run.ok, error: run.error, ms: run.ms, count: run.items.length, trace: run.trace },
    });
    if (score && (!best || score.f1 > best.score.f1)) best = { score, code, run };

    if (score?.pass) {
      emit({ type: 'step', step: 'test', status: 'done', detail: `PASS f1=${score.f1} (${score.extractorCount}/${score.oracleCount})` });
      const r = await finalize(code, score, run, round, lastModel, input.repairOf ? 'healed' : 'forged');
      if (r) return r;
      messages.push({ role: 'user', content: 'Running your function twice on the same HTML gave different results. Make it fully deterministic (no Math.random, Date, or object-order dependence). Return the complete function.' });
      continue;
    }
    emit({ type: 'step', step: 'test', status: 'fail', detail: hard.length ? 'hard-coded content' : run.ok ? `f1=${score!.f1} — ${score!.failures[0] ?? 'not good enough yet'}` : run.error });
    // Stop early when repairs stagnate: two rounds in a row without improving the best F1.
    stagnant = score && best && score.f1 < best.score.f1 + 0.01 && round > 1 ? stagnant + 1 : 0;
    // …but keep going when we're close: near-misses usually converge with one more round.
    if (stagnant >= 2 && (best?.score.f1 ?? 0) < 0.8) {
      emit({ type: 'log', message: 'Repairs have stopped improving — giving up early to save tokens' });
      break;
    }
    // Too few items → give the agent a debugger view: which of its selectors / paths actually match.
    const tooFew = !run.ok || (score && score.extractorCount < score.oracleCount * 0.5);
    const diagnostics =
      tooFew && !hard.length
        ? mode === 'json'
          ? jsonShapeReport(acq.payload)
          : run.trace?.length
            ? `Execution trace of your code on the real page (selector → elements):\n${run.trace.map((t) => '  ' + t).join('\n')}`
            : selectorReport(code, acq.payload)
        : null;
    if (diagnostics) emit({ type: 'log', message: `Debugger: ${diagnostics.split('\n').slice(1, 6).join(' ').trim()}` });
    messages.push({ role: 'user', content: feedbackMessage(round, run, score, hard, diagnostics) });
  }

  const reason = `no passing extractor after ${roundsUsed} rounds (best f1 ${best?.score.f1 ?? 0})`;
  if (best) emit({ type: 'log', message: `Best attempt returned ${best.run.items.length} items (f1 ${best.score.f1})` });
  emit({ type: 'result', ok: false, reason, items: best?.run.items });
  return {
    ok: false,
    reason,
    ledger,
    ms: Date.now() - t0,
    oracleCount: oracleItems.length,
    oracle: oracleItems,
    rounds: roundsUsed,
    bestScore: best?.score,
    code: best?.code,
    items: best?.run.items,
  };
}

/** Re-run a stored extractor on the live page — zero tokens. */
export async function rerun(id: string, opts: { fresh?: boolean } = {}) {
  const stored = loadExtractor(id);
  if (!stored) throw new Error(`no extractor ${id}`);
  if (stored.meta.source?.kind === 'image' || stored.meta.source?.kind === 'document')
    throw new Error('image and PDF menus are re-checked by the fleet (fingerprints), not re-run as code');
  const src = await reacquire({ kind: stored.meta.source?.kind ?? 'html', url: stored.meta.url, request: stored.meta.source?.request });
  const run = await runExtractor(stored.code, src.payload, stored.meta.url, stored.meta.source?.kind === 'json' ? 'json' : 'html');
  return { stored, src, run, fresh: opts.fresh };
}
