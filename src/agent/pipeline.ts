import { config } from '../config.ts';
import { domainOf, fetchPage, type Page } from '../html/fetch.ts';
import { detectPlatform } from '../html/platform.ts';
import { skeleton } from '../html/simplify.ts';
import { jsonMenuView, jsonSkeletonText } from '../html/jsonview.ts';
import { Ledger, type ChatMessage } from '../llm/client.ts';
import { candidatesFor, idForUrl, loadExtractor, saveExtractor } from '../library/store.ts';
import { runExtractor } from '../sandbox/runner.ts';
import { findOfficialSite, tavilyEnabled } from '../tools/tavily.ts';
import type { Emit, ExtractorMeta, MenuItem, RunResult, Score } from '../types.ts';
import { findMenuPage, priceDensity } from './discover.ts';
import { acquire, reacquire, type Acquired } from './acquire.ts';
import { detectHardcoding, feedbackMessage, initialMessages, initialMessagesJson, writeCode } from './forge.ts';
import { itemsHash, normName, scoreAgainstOracle } from './evaluate.ts';
import { readMenu } from './oracle.ts';

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
  /** Don't follow links / call Tavily; treat `url` as the menu page. */
  noDiscover?: boolean;
  /** Allow the headless-browser path for JavaScript-built menus (default true). */
  allowRender?: boolean;
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
  /** "forged" | "reused" | "healed" */
  mode?: 'forged' | 'reused' | 'healed';
}

const noop: Emit = () => {};

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
  const ledger = new Ledger();
  const fail = (reason: string, extra: Partial<ForgeOutcome> = {}): ForgeOutcome => {
    emit({ type: 'result', ok: false, reason });
    return { ok: false, reason, oracleCount: 0, rounds: 0, ledger, ms: Date.now() - t0, ...extra };
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

  // 2. Fetch + find the menu page.
  emit({ type: 'step', step: 'fetch', status: 'start', detail: url });
  let page: Page;
  try {
    page = await fetchPage(url);
  } catch (e) {
    emit({ type: 'step', step: 'fetch', status: 'fail', detail: (e as Error).message });
    return fail((e as Error).message);
  }
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
      text = jsonMenuView(JSON.parse(acq.payload));
    } catch {
      /* keep page text */
    }
  }
  emit({ type: 'log', message: `Source: ${acq.note} · platform ${platform}` });

  // 3. Oracle reading (Nemotron Super).
  emit({ type: 'step', step: 'oracle', status: 'start', detail: 'Nemotron 3 Super is reading the menu' });
  let oracleItems: MenuItem[];
  try {
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
        costUsd: Math.round(ledger.costUsd * 1e6) / 1e6,
        baselineHash: itemsHash(run.items),
        baselineCount: run.items.length,
        reusedFrom: reusedFrom ?? null,
      },
      code,
      how === 'reused' ? `adopted from ${reusedFrom}` : how === 'healed' ? `self-heal: ${input.repairOf?.reason}` : 'forged',
    );
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

  // 5. Forge → test → repair loop (Nemotron Ultra).
  const messages: ChatMessage[] =
    mode === 'json'
      ? initialMessagesJson({
          url: menuUrl,
          platform,
          apiUrl: acq.request!.url,
          method: acq.request!.method,
          jsonSkeleton: jsonSkeletonText(JSON.parse(acq.payload)),
          oracle: oracleItems,
        })
      : initialMessages({ url: menuUrl, platform, skeleton: skeleton(acq.payload), oracle: oracleItems });
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
  for (let round = 1; round <= maxRounds; round++) {
    emit({ type: 'step', step: round === 1 ? 'forge' : 'repair', status: 'start', detail: round === 1 ? 'Nemotron 3 Ultra is writing the extractor' : `Repair round ${round - 1}` });
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
    emit({ type: 'code', version: round, round, code });

    const hard = detectHardcoding(code, oracleItems);
    const run = hard.length ? { ok: false, items: [], error: 'hard-coded content', ms: 0 } : await runExtractor(code, acq.payload, menuUrl, mode);
    const score = run.ok ? scoreAgainstOracle(oracleItems, run.items, text) : null;
    emit({
      type: 'test',
      round,
      score: score ?? scoreAgainstOracle(oracleItems, [], text),
      run: { ok: run.ok, error: run.error, ms: run.ms, count: run.items.length },
    });
    if (score && (!best || score.f1 > best.score.f1)) best = { score, code, run };

    if (score?.pass) {
      emit({ type: 'step', step: 'test', status: 'done', detail: `PASS f1=${score.f1} (${score.extractorCount}/${score.oracleCount})` });
      const r = await finalize(code, score, run, round, lastModel, input.repairOf ? 'healed' : 'forged');
      if (r) return r;
      messages.push({ role: 'user', content: 'Running your function twice on the same HTML gave different results. Make it fully deterministic (no Math.random, Date, or object-order dependence). Return the complete function.' });
      continue;
    }
    emit({ type: 'step', step: 'test', status: 'fail', detail: hard.length ? 'hard-coded content' : run.ok ? `f1=${score!.f1} — not good enough yet` : run.error });
    messages.push({ role: 'user', content: feedbackMessage(round, run, score, hard) });
  }

  return fail(`no passing extractor after ${maxRounds} rounds (best f1 ${best?.score.f1 ?? 0})`, {
    oracleCount: oracleItems.length,
    rounds: maxRounds,
    bestScore: best?.score,
    code: best?.code,
    items: best?.run.items,
  });
}

/** Re-run a stored extractor on the live page — zero tokens. */
export async function rerun(id: string, opts: { fresh?: boolean } = {}) {
  const stored = loadExtractor(id);
  if (!stored) throw new Error(`no extractor ${id}`);
  const src = await reacquire({ kind: stored.meta.source?.kind ?? 'html', url: stored.meta.url, request: stored.meta.source?.request });
  const run = await runExtractor(stored.code, src.payload, stored.meta.url, stored.meta.source?.kind === 'json' ? 'json' : 'html');
  return { stored, src, run, fresh: opts.fresh };
}
