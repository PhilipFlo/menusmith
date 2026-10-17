import { chat, type ChatMessage, type Ledger } from '../llm/client.ts';
import type { Skeleton } from '../html/simplify.ts';
import type { Emit, MenuItem, Platform, RunResult, Score } from '../types.ts';
import { normName } from './evaluate.ts';

/**
 * The FORGE: Nemotron 3 Ultra writes a deterministic extractor for one website,
 * and repairs it from test feedback. The conversation is kept across rounds so the
 * model sees its own previous attempts.
 */

export const CONTRACT = `Write ONE JavaScript function with exactly this signature:

  function extract($, ctx) { ... return items; }

- $ is a cheerio root already loaded with the page HTML (jQuery-like API: $(sel), .find, .each, .text(), .attr, .closest, .prevAll, .nextUntil, .children, .parent, .is, .map(...).get()).
- ctx.url is the page URL.
- Two helper globals exist: parsePrice(str) -> number|null (handles "189,-", "kr 1 290", "$12.50", "1.290,00"), cleanText(str) -> trimmed single-spaced string.
- Return an array of {section, name, description, price}: section = heading the dish is under (string or null), name = dish name (string), description = string or null, price = number or null (use parsePrice; when several prices are shown, the first).
- Plain synchronous ES2020. No require/import, no fetch, no async, no eval, no Function constructor, no globals other than $, ctx, parsePrice, cleanText. Never throw: guard against missing elements.`;

export const CONTRACT_JSON = `Write ONE JavaScript function with exactly this signature:

  function extract(data, ctx) { ... return items; }

- data is the parsed JSON response of the restaurant's menu API (shape shown below; arrays are shortened in the sample — your code must walk ALL elements).
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
}): ChatMessage[] {
  const user = `${CONTRACT_JSON}

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
}): ChatMessage[] {
  const { skeleton: sk } = input;
  const user = `${CONTRACT}

PAGE: ${input.url}
WEBSITE PLATFORM: ${input.platform}
The menu region was located at: ${sk.rootPath}
(${sk.priceNodes} price-looking text nodes on the page.)

COMPACT HTML OF THE MENU REGION (scripts/styles removed, long runs of identical siblings collapsed into a comment — your code must handle ALL of them, not just the ones shown):
\`\`\`html
${sk.html}
\`\`\`
${sk.jsonLd.length ? `\nJSON-LD BLOCKS FOUND ON THE PAGE:\n${sk.jsonLd.map((j) => '```json\n' + j + '\n```').join('\n')}\n` : ''}
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
    `Round ${round} test result: ${s.extractorCount} items returned, ${s.oracleCount} expected. precision=${s.precision} recall=${s.recall} f1=${s.f1} priced=${Math.round(s.pricedRatio * 100)}%.`,
    `First items you returned:\n${sample.join('\n') || '(none)'}`,
  ];
  if (s.missing.length)
    parts.push(`MISSING (in the reference, not in your output) — ${s.missing.length}${s.missing.length >= 25 ? '+' : ''}:\n` +
      s.missing.slice(0, 15).map((i) => `- [${i.section ?? ''}] ${i.name} — ${i.price ?? 'no price'}`).join('\n'));
  if (s.wrongPrice.length)
    parts.push(`WRONG PRICE:\n` + s.wrongPrice.slice(0, 10).map((w) => `- ${w.name}: expected ${w.expected}, got ${w.got}`).join('\n'));
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

export async function writeCode(
  messages: ChatMessage[],
  round: number,
  ledger: Ledger,
  emit?: Emit,
): Promise<{ code: string | null; reply: string; reasoning?: string }> {
  const r = await chat(
    { role: 'forge', label: round === 1 ? 'forge' : `repair ${round - 1}`, thinking: true, maxTokens: 24_000, messages },
    ledger,
    emit,
  );
  return { code: extractCode(r.text), reply: r.text, reasoning: r.reasoning };
}
