import { z } from 'zod';
import { chat, type Ledger } from '../llm/client.ts';
import type { Emit, MenuItem } from '../types.ts';
import { normName } from './evaluate.ts';
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
- Allergen labels and badges (e.g. "Hvete", "Egg", "Melk", "Gluten", "Nøtter", "Soya", "Sesam", "Vegan", "Spicy") are NOT dishes.
- If the page has no menu, return {"is_menu": false, "currency": null, "items": []}.
- If the input is a list of lines exported from a menu API ("[Category > Sub] Name | price=… | description | flags"), use the category path as section, skip items flagged unavailable/hidden/archived/deleted, skip modifier/option groups (sizes, extras, sauces, add-ons) unless they are standalone dishes, and convert prices given in minor units (e.g. 18900 for a 189 kr dish) to the normal amount.`;

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

const SECOND_READ = `

This is a second, independent check of the page. Go through it line by line and make sure NO orderable item is skipped — including sides, add-ons sold as separate items, drinks, desserts and items listed in small print.`;

const MAX_ORACLE_CHARS = 120_000;
const MAX_CHUNKS = 5;

export interface OracleResult {
  isMenu: boolean;
  currency: string | null;
  items: MenuItem[];
}

/** The 14 EU allergens (+ common label words) in Norwegian and English — never dish names on their own. */
const ALLERGEN_LABEL =
  /^(gluten|hvete|wheat|rug|rye|bygg|barley|havre|oats?|egg|eggs|melk|milk|laktose|lactose|fisk|fish|skalldyr|crustaceans?|shellfish|bløtdyr|molluscs?|nøtter|nuts?|valnøtter|walnuts?|mandler|almonds?|hasselnøtter|hazelnuts?|cashew|pistasj|pistachios?|pekannøtter|pecans?|peanøtter|peanuts?|soya|soy|selleri|celery|sennep|mustard|sesam|sesame|lupin|sulfitt|sulphites?|sulfites?|svoveldioksid|vegan|vegetar|vegetarian|spicy|sterk|glutenfri|gluten[- ]free|laktosefri|lactose[- ]free)$/i;

function normalise(raw: z.infer<typeof ItemSchema>[], currency: string | null): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of raw) {
    const name = cleanText(it.name)
      .replace(/^\d{1,3}[.)]\s+/, '')
      .replace(/\s*\((?:\d+\s*,?\s*)+\)\s*$/, '')
      .trim();
    if (!name) continue;
    const price = typeof it.price === 'number' ? it.price : parsePrice(it.price ?? null);
    // An allergen badge read as if it were a dish (no price, name is just the allergen).
    if (price == null && ALLERGEN_LABEL.test(name)) continue;
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

async function readOnce(
  pageText: string,
  ctx: { url: string; restaurant?: string | null },
  ledger: Ledger,
  emit: Emit | undefined,
  second: boolean,
): Promise<OracleResult> {
  // Hard cap on how much text one reading may cost: 5 chunks (~120k chars) is a very
  // large menu; anything beyond is page noise or an attempt to burn credits.
  const chunks = chunkText(pageText.slice(0, MAX_ORACLE_CHARS)).slice(0, MAX_CHUNKS);
  const results = await Promise.all(
    chunks.map((chunk, i) =>
      chat(
        {
          role: 'oracle',
          label: (second ? 'oracle (2nd read)' : 'oracle') + (chunks.length > 1 ? ` ${i + 1}/${chunks.length}` : ''),
          json: true,
          thinking: false,
          maxTokens: 16_000,
          messages: [
            { role: 'system', content: second ? SYSTEM + SECOND_READ : SYSTEM },
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

/**
 * Read the menu. For normal-sized menus the page is read TWICE in parallel (the second
 * pass told to hunt for skipped items) and the readings are merged: a single LLM
 * reading sometimes skims past add-ons or a whole section, and the extractor is graded
 * against this reference. The second reading only ADDS dishes the first one missed.
 */
export async function readMenu(
  pageText: string,
  ctx: { url: string; restaurant?: string | null },
  ledger: Ledger,
  emit?: Emit,
): Promise<OracleResult> {
  const chunkCount = chunkText(pageText.slice(0, MAX_ORACLE_CHARS)).slice(0, MAX_CHUNKS).length;
  if (chunkCount > 2) return readOnce(pageText, ctx, ledger, emit, false);
  const [a, b] = await Promise.all([
    readOnce(pageText, ctx, ledger, emit, false),
    readOnce(pageText, ctx, ledger, emit, true).catch(() => null),
  ]);
  if (!b || !b.items.length) return a;
  const key = (i: MenuItem) => `${normName(i.name)}|${i.price ?? ''}`;
  const seen = new Set(a.items.map(key));
  const added = b.items.filter((i) => !seen.has(key(i)));
  if (added.length) emit?.({ type: 'log', message: `Second reading found ${added.length} dish(es) the first one missed` });
  return {
    isMenu: a.isMenu || b.isMenu,
    currency: a.currency ?? b.currency,
    items: [...a.items, ...added],
  };
}
