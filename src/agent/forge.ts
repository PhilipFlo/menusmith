import { chat, type ChatMessage, type Ledger } from '../llm/client.ts';
import type { Skeleton } from '../html/simplify.ts';
import type { Emit, MenuItem, Platform, RunResult, Score } from '../types.ts';
import { normName } from './evaluate.ts';

/**
 * The FORGE: Nemotron 3 Super (escalating to Ultra) writes a deterministic extractor for one website,
 * and repairs it from test feedback. The conversation is kept across rounds so the
 * model sees its own previous attempts.
 */

export const CONTRACT = `Write ONE JavaScript function with exactly this signature:

  function extract($, ctx) { ... return items; }

- $ is a cheerio root already loaded with the page HTML (jQuery-like API: $(sel), .find, .each, .text(), .attr, .closest, .prevAll, .nextUntil, .children, .parent, .is, .map(...).get()).
- ctx.url is the page URL.
- Two helper globals exist: parsePrice(str) -> number|null (handles "189,-", "kr 1 290", "$12.50", "1.290,00"; skips dish numbering like "17." and quantities like "2 stk" / "33 cl"), cleanText(str) -> trimmed single-spaced string. Call parsePrice on the PRICE element's own text when one exists, not on a container that also holds the dish name or number.
- Return an array of {section, name, description, price}: section = heading the dish is under (string or null), name = dish name (string), description = string or null, price = number or null (use parsePrice; when several prices are shown, the first; when a section heading states one price for all its items — "Cocktails $17", "Pizza 189,-" — and the items show none, each item gets that price). The section name is the heading text without that price. Each dish once, even if the page repeats a menu (tabs per location/meal) — keep the first.
- Plain synchronous ES2020. No require/import, no fetch, no async, no eval, no Function constructor, no globals other than $, ctx, parsePrice, cleanText (and the tested helpers priceColumns / visualRows / visualDishes / textDishes when a note mentions them). Never throw: guard against missing elements.`;

export const CONTRACT_JSON = `Write ONE JavaScript function with exactly this signature:

  function extract(data, ctx) { ... return items; }

- data is the parsed JSON response of the restaurant's menu API — the WHOLE document shown below (arrays are shortened in the sample; your code must walk ALL elements). If the document itself has a top-level key named "data" (common in GraphQL), you reach it as data.data.
- MENU ITEM ARRAYS FOUND IN THIS DOCUMENT (paths relative to the data argument):
{{PATHS}}
- ctx.url is the restaurant's page URL.
- Two helper globals exist: parsePrice(str|number) -> number|null, cleanText(str) -> trimmed string.
- Return an array of {section, name, description, price}: section = category/group name (string or null), name = dish name, description = string or null, price = number in the menu currency or null.
- Prices in APIs are often integers in minor units (øre/cents, e.g. 18900 for 189 kr) — compare with the reference reading below and divide by 100 if needed. If an item has variants/sizes, use the first/default price.
- Skip hidden/unavailable/archived items and add-on/modifier option lists unless the reference reading includes them.
- Plain synchronous ES2020. No require/import, no fetch, no async, no eval. Never throw: guard against missing fields.`;

const SYSTEM = `You are Menusmith's code-writing agent. You write small, robust, deterministic web extractors that pull a restaurant's menu out of its HTML with CSS selectors. Your code will be executed in a sandbox and graded automatically against a reference reading of the page, then re-run every week for months without you — so it must keep working as dishes and prices change.

Engineering rules:
- Anchor on the page's semantic structure: stable class names, data-* attributes, itemprop, heading hierarchy, table rows. Prefer selectors that describe "a menu item" generically over ones tied to a single element.
- Avoid auto-generated/hashed class names (e.g. comp-kx2d9a3, css-1q2w3e, sc-AxjAm) unless nothing else exists; if you must, combine them with structure.
- Never hard-code dish names, prices, counts or positions (no nth-child chains to specific items). The code must still work when items are added, removed or re-priced.
- Derive sections from the nearest preceding heading or section container.
- Clean names: drop leading numbering ("12. ") and trailing allergen codes ("(1,7)"); keep diacritics.
- Skip items with an empty name. Deduplicate exact repeats (e.g. mobile + desktop copies of the same menu).
- If the menu data is in a JSON-LD <script type="application/ld+json"> block, you may parse it with JSON.parse($('script[type="application/ld+json"]').text()) — that is allowed and very stable.

Answer with the complete function in a single \`\`\`javascript code block and nothing after it.`;

function sampleOracle(items: MenuItem[], n = 30): string {
  const sections = [...new Set(items.map((i) => i.section || '(none)'))];
  const pick: MenuItem[] = [];
  // Spread the sample across sections so the model sees every pattern.
  const per = Math.max(2, Math.ceil(n / Math.max(1, sections.length)));
  for (const s of sections) pick.push(...items.filter((i) => (i.section || '(none)') === s).slice(0, per));
  const lines = pick.slice(0, n).map((i) => JSON.stringify({ section: i.section ?? null, name: i.name, price: i.price }));
  return `${items.length} items in ${sections.length} sections: ${sections.slice(0, 20).join(' | ')}\nSample:\n${lines.join('\n')}`;
}

export function initialMessagesJson(input: {
  url: string;
  platform: Platform;
  apiUrl: string;
  method: string;
  jsonSkeleton: string;
  oracle: MenuItem[];
  pathReport?: string | null;
}): ChatMessage[] {
  const paths = (input.pathReport || '').split('\n').filter((l) => l.startsWith('  ')).join('\n') || '  (none detected automatically)';
  const user = `${CONTRACT_JSON.replace('{{PATHS}}', paths)}

RESTAURANT PAGE: ${input.url}
PLATFORM: ${input.platform}
MENU API: ${input.method} ${input.apiUrl}

JSON RESPONSE (structure sample — long arrays shortened, strings truncated):
\`\`\`json
${input.jsonSkeleton}
\`\`\`

REFERENCE READING OF THIS MENU (what your output will be graded against):
${sampleOracle(input.oracle)}

Write extract(data, ctx).`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

export function initialMessages(input: {
  url: string;
  platform: Platform;
  skeleton: Skeleton;
  oracle: MenuItem[];
  priceColumns?: { columns: number; container: string | null } | null;
  /** The renderer recorded text-box positions (data-ms-xy): a free-positioned page. */
  positioned?: boolean;
}): ChatMessage[] {
  const { skeleton: sk } = input;
  const pc = input.priceColumns;
  const positionNote = input.positioned
    ? `\nLAYOUT NOTE: this page places every text box by screen position (a Canva-style site) — the markup has no element per dish, and siblings are in no useful order. Each text box carries data-ms-xy="x,y" (its position on the rendered page). A tested helper global visualRows($) returns the page's text grouped into visual rows in reading order: [{y, cells: [{x, text}], line}]. A dish's name and its price(s) are usually in the SAME row (name left, price right), with description lines in the following rows. A second tested helper, visualDishes($), already does the usual parse and returns [{section, name, description, price}] (dishes in several columns side by side are handled) — start from it, then fix what the reading shows it gets wrong (e.g. drop non-dish rows like addresses or phone numbers). If you parse rows yourself: for each row whose cells include a price, the name is the left-most non-price cell; attach the next non-price rows as the description until the next priced row; section headings are rows without prices that are followed by priced rows. Use parsePrice on price cells; when a row has two prices (sizes), take the first.\n`
    : '';
  const layoutNote =
    positionNote ||
    (pc
    ? `\nLAYOUT NOTE: this page has no element per dish. It lays the menu out in side-by-side text blocks: ${pc.columns} blocks each hold a whole column of PRICES (one per line, lines separated by <br>), and a neighbouring block holds the DISH NAMES in the same order. A tested helper global does exactly this: priceColumns($) returns [{section, name, description, price}] for every such pair on the page — start from it (you may fix sections, filter non-dishes, or add items it can't see, e.g. prices written inline). Otherwise pair them yourself: for each container${pc.container ? ` (e.g. \`${pc.container}\`)` : ''}, find the price block and the name block, split both on <br> line breaks, drop empty lines, and zip the k-th name with the k-th price. If the name block also contains description lines, keep only the lines that line up with prices. Do this for EVERY container on the page — the HTML below shows only part of it.\n`
    : '');
  const user = `${CONTRACT}

PAGE: ${input.url}
WEBSITE PLATFORM: ${input.platform}
The menu region was located at: ${sk.rootPath}
(${sk.priceNodes} price-looking text nodes on the page.)

COMPACT HTML OF THE MENU REGION (scripts/styles removed, long runs of identical siblings collapsed into a comment — your code must handle ALL of them, not just the ones shown):
\`\`\`html
${sk.html}
\`\`\`
${layoutNote}${sk.jsonLd.length ? `\nJSON-LD BLOCKS FOUND ON THE PAGE:\n${sk.jsonLd.map((j) => '```json\n' + j + '\n```').join('\n')}\n` : ''}
REFERENCE READING OF THIS MENU (what your output will be graded against):
${sampleOracle(input.oracle)}

Write extract($, ctx).`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

export function feedbackMessage(round: number, run: RunResult, score: Score | null, hardcoded: string[], diagnostics?: string | null): string {
  if (hardcoded.length) {
    return `Round ${round} REJECTED: your code hard-codes menu content (${hardcoded.slice(0, 5).map((s) => JSON.stringify(s)).join(', ')}). Extract from the HTML structure instead. Rewrite the complete function.`;
  }
  if (!run.ok) {
    return `Round ${round} FAILED TO RUN in the sandbox:\n${run.error}${diagnostics ? '\n\n' + diagnostics : ''}\nFix it and return the complete function.`;
  }
  const s = score!;
  const sample = run.items.slice(0, 8).map((i) => JSON.stringify({ section: i.section, name: i.name, price: i.price }));
  const parts = [
    `Round ${round} test result: ${s.extractorCount} items returned, ${s.oracleCount} expected. precision=${s.precision} recall=${s.recall} f1=${s.f1} priced=${Math.round(s.pricedRatio * 100)}%.` +
      (s.failures.length ? `\nNOT ACCEPTED because: ${s.failures.join('; ')}.` : ''),
    `First items you returned:\n${sample.join('\n') || '(none)'}`,
  ];
  if (s.missing.length)
    parts.push(`MISSING (in the reference, not in your output) — ${s.missing.length}${s.missing.length >= 25 ? '+' : ''}:\n` +
      s.missing.slice(0, 15).map((i) => `- [${i.section ?? ''}] ${i.name} — ${i.price ?? 'no price'}`).join('\n'));
  if (s.wrongPrice.length)
    parts.push(`WRONG PRICE:\n` + s.wrongPrice.slice(0, 10).map((w) => `- ${w.name}: expected ${w.expected}, got ${w.got}`).join('\n'));
  if (s.duplicates)
    parts.push(`DUPLICATES: ${s.duplicates} dish(es) appear more than once in the same section (shown below as "(duplicate)"). The page may repeat its menu (mobile + desktop copies) or list a dish once per size/price — return each dish ONCE per section, with its first price.`);
  if (s.extra.length)
    parts.push(`NOT ON THE MENU (your output, not found in the reference or the page text):\n` +
      s.extra.slice(0, 10).map((i) => `- [${i.section ?? ''}] ${i.name} — ${i.price ?? ''}`).join('\n'));
  if (diagnostics) parts.push(diagnostics);
  parts.push('Diagnose the cause from the HTML/JSON structure (wrong container or array? missed a section variant? price in a sibling element or in minor units? duplicate copies? hidden items?) and return the complete corrected function.');
  return parts.join('\n\n');
}

/** Pull the function out of the model's reply. */
export function extractCode(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:javascript|js)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]!.trim());
  const withFn = blocks.filter((b) => /function\s+extract\s*\(/.test(b));
  const code = withFn.pop() || blocks.pop() || (/function\s+extract\s*\(/.test(text) ? text.trim() : null);
  if (!code || !/function\s+extract\s*\(/.test(code)) return null;
  return code;
}

/**
 * Detect "cheating": dish names or price lists copied into the code as literals.
 * Returns the offending literals (empty when clean).
 */
export function detectHardcoding(code: string, oracle: MenuItem[]): string[] {
  const literals = [...code.matchAll(/(['"`])((?:\\.|(?!\1).){4,120})\1/g)].map((m) => normName(m[2]));
  const lits = new Set(literals.filter((l) => l.length >= 4));
  const hits: string[] = [];
  for (const it of oracle) {
    const n = normName(it.name);
    if (n.length >= 4 && lits.has(n)) hits.push(it.name);
  }
  // A handful of literal names can be legitimate (e.g. skipping a "Allergener" heading).
  return hits.length >= 3 ? hits : [];
}

/** Rounds handled by the forge model before escalating to the strongest model. */
export const ESCALATE_AFTER = Number(process.env.MENUSMITH_ESCALATE_AFTER || 2);

export async function writeCode(
  messages: ChatMessage[],
  round: number,
  ledger: Ledger,
  emit?: Emit,
  escalateAfter = ESCALATE_AFTER,
): Promise<{ code: string | null; reply: string; reasoning?: string }> {
  // Escalation: Nemotron 3 Super writes the first attempts; if they keep failing,
  // Nemotron 3 Ultra takes over the same conversation for the harder reasoning.
  const role = round <= escalateAfter ? 'forge' : 'escalate';
  const label = round === 1 ? 'forge' : role === 'escalate' ? `repair ${round - 1} (escalated)` : `repair ${round - 1}`;
  let r;
  try {
    r = await chat({ role, label, thinking: true, maxTokens: 24_000, messages }, ledger, emit);
  } catch (e) {
    // The reasoning used up the whole output budget: ask again without it rather than fail.
    if ((e as { status?: number }).status !== 413) throw e;
    emit?.({ type: 'log', message: 'The model reasoned past its output budget — asking again without step-by-step reasoning' });
    r = await chat({ role, label: `${label} (no reasoning)`, thinking: false, maxTokens: 12_000, messages }, ledger, emit);
  }
  return { code: extractCode(r.text), reply: r.text, reasoning: r.reasoning };
}
