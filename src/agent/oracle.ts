import { z } from 'zod';
import { chat, type Ledger } from '../llm/client.ts';
import type { Emit, MenuItem } from '../types.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePrice, cleanText } = require('../sandbox/helpers.cjs') as {
  parsePrice: (s: unknown) => number | null;
  cleanText: (s: unknown) => string;
};

/**
 * The ORACLE: Nemotron 3 Super reads the page text and writes down the menu.
 * It is the reference the generated extractor is tested against — run once per
 * site (and again only when an extractor looks broken), never on every re-scrape.
 */

const ItemSchema = z.object({
  section: z.string().nullish(),
  name: z.string(),
  description: z.string().nullish(),
  price: z.union([z.number(), z.string()]).nullish(),
});
const OracleSchema = z.object({
  is_menu: z.boolean().optional(),
  currency: z.string().nullish(),
  items: z.array(ItemSchema),
});

const SYSTEM = `You read restaurant web pages and write down their menu exactly as published.

Return ONLY a JSON object:
{"is_menu": boolean, "currency": "NOK"|"USD"|"EUR"|"SEK"|"DKK"|"GBP"|null,
 "items": [{"section": string|null, "name": string, "description": string|null, "price": number|null}]}

Rules:
- Include every dish and drink that is listed on the page, in page order. Include items without a price with price null.
- "name" is the dish name as written (keep original language, keep diacritics; drop leading numbering like "12." and trailing allergen codes like "(1,7)").
- "price" is a plain number in the menu's currency: "189,-" -> 189, "kr 1 290" -> 1290, "$12.50" -> 12.5. If several prices are listed (sizes, glass/bottle), use the FIRST one.
- "section" is the heading the item is listed under (e.g. "Pizza", "Drinks"), or null.
- "description" is the short text describing the dish, or null. Do not invent descriptions.
- Never invent items. Ignore navigation, opening hours, addresses, newsletter text, cookie banners, events.
- If the page has no menu, return {"is_menu": false, "currency": null, "items": []}.`;

/** Split long page text on line boundaries so each chunk fits comfortably. */
export function chunkText(text: string, maxChars = 24_000): string[] {
  if (text.length <= maxChars) return [text];
  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > maxChars && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface OracleResult {
  isMenu: boolean;
  currency: string | null;
  items: MenuItem[];
}

function normalise(raw: z.infer<typeof ItemSchema>[], currency: string | null): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of raw) {
    const name = cleanText(it.name)
      .replace(/^\d{1,3}[.)]\s+/, '')
      .replace(/\s*\((?:\d+\s*,?\s*)+\)\s*$/, '')
      .trim();
    if (!name) continue;
    const price = typeof it.price === 'number' ? it.price : parsePrice(it.price ?? null);
    out.push({
      section: it.section ? cleanText(it.section) : null,
      name,
      description: it.description ? cleanText(it.description) : null,
      price: price ?? null,
      currency,
    });
  }
  return out;
}

export async function readMenu(
  pageText: string,
  ctx: { url: string; restaurant?: string | null },
  ledger: Ledger,
  emit?: Emit,
): Promise<OracleResult> {
  const chunks = chunkText(pageText);
  const results = await Promise.all(
    chunks.map((chunk, i) =>
      chat(
        {
          role: 'oracle',
          label: chunks.length > 1 ? `oracle ${i + 1}/${chunks.length}` : 'oracle',
          json: true,
          thinking: false,
          maxTokens: 16_000,
          messages: [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content:
                `Page URL: ${ctx.url}\n` +
                (ctx.restaurant ? `Restaurant: ${ctx.restaurant}\n` : '') +
                (chunks.length > 1 ? `This is part ${i + 1} of ${chunks.length} of the page.\n` : '') +
                `\nPAGE TEXT:\n${chunk}`,
            },
          ],
        },
        ledger,
        emit,
      ),
    ),
  );

  let currency: string | null = null;
  let isMenu = false;
  const items: MenuItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const parsed = OracleSchema.safeParse(r.json);
    if (!parsed.success) continue;
    currency ||= parsed.data.currency ?? null;
    if (parsed.data.is_menu !== false && parsed.data.items.length) isMenu = true;
    for (const it of normalise(parsed.data.items, parsed.data.currency ?? null)) {
      // Chunk overlap / repeated headers can duplicate items.
      const key = `${it.section}|${it.name}|${it.price}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }
  return { isMenu: isMenu && items.length > 0, currency, items };
}
