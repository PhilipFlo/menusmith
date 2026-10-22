import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { assertPublicUrl } from '../html/netguard.ts';
import { chat, type ChatMessage, type Ledger } from '../llm/client.ts';
import type { Emit, MenuItem } from '../types.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePrice, cleanText } = require('../sandbox/helpers.cjs') as {
  parsePrice: (s: unknown) => number | null;
  cleanText: (s: unknown) => string;
};

/**
 * VISION PATH — menus published as pictures.
 *
 * A photographed or designed menu has no structure to write selectors against, so
 * the code-writing loop can't apply. Menusmith still keeps re-runs free: it
 * fingerprints the image bytes (sha256) and only calls Nemotron 3.5 Super VL when a
 * picture actually changes. Content-addressing instead of code.
 */

export interface MenuImage {
  url: string;
  sha256: string;
}

// Only explicit menu words: dish words ("sushi", "dessert") also name food PHOTOS.
const MENU_WORD = /(meny|menu|menus|menyen|spisekart|drikkekart|vinkart|prisliste|price[-_ ]?list|carte)/i;
const NOT_MENU = /(logo|icon|favicon|avatar|sprite|banner-?ad|payment|vipps|visa|mastercard|instagram|facebook|tripadvisor|foodora|wolt|ubereats|doordash|\.svg)/i;
const MAX_IMAGES = 6;
const MAX_BYTES = 8 * 1024 * 1024;

/** Image URLs on the page whose file name, alt or title says they are (part of) the menu. */
export function findMenuImages(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const add = (src: string | undefined, hint: string) => {
    if (!src || src.startsWith('data:')) return;
    let u: string;
    try {
      u = new URL(src, baseUrl).toString();
    } catch {
      return;
    }
    if (NOT_MENU.test(u) || NOT_MENU.test(hint)) return;
    const file = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
    if (MENU_WORD.test(file) || MENU_WORD.test(hint)) out.add(u);
  };
  const srcOf = (e: ReturnType<typeof $>) => {
    const srcset = (e.attr('srcset') || e.attr('data-srcset') || '').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    // Prefer the largest srcset candidate (last), else src / lazy-load attributes.
    return srcset[srcset.length - 1] || e.attr('data-src') || e.attr('src');
  };
  const strong: ReturnType<typeof $>[] = [];
  $('img').each((_, el) => {
    const e = $(el);
    const before = out.size;
    add(srcOf(e), `${e.attr('alt') || ''} ${e.attr('title') || ''}`);
    if (out.size > before) strong.push(e);
  });
  // Multi-page menus are often a gallery where only some pictures are named "meny":
  // include the other pictures in the same container as a clearly-named one.
  for (const e of strong) {
    const box = e.parent().parent();
    box.find('img').each((_, el) => {
      const src = srcOf($(el));
      if (!src || src.startsWith('data:') || NOT_MENU.test(src)) return;
      try {
        out.add(new URL(src, baseUrl).toString());
      } catch {
        /* ignore */
      }
    });
  }
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/\.(png|jpe?g|webp)(\?|$)/i.test(href)) add(href, $(el).text());
  });
  return [...out].slice(0, MAX_IMAGES);
}

export async function fetchImage(url: string): Promise<{ bytes: Buffer; mime: string; sha256: string }> {
  await assertPublicUrl(url);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'Mozilla/5.0 Menusmith/0.1' } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  if (res.url && res.url !== url) await assertPublicUrl(res.url);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('image too large');
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0]!;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) throw new Error(`not a supported image (${mime})`);
  return { bytes, mime, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const Items = z.object({
  is_menu: z.boolean().optional(),
  currency: z.string().nullish(),
  items: z.array(z.object({ section: z.string().nullish(), name: z.string(), description: z.string().nullish(), price: z.union([z.number(), z.string()]).nullish() })),
});

const SYSTEM = `You read restaurant menus from images and write them down exactly as printed.
Return ONLY JSON: {"is_menu": boolean, "currency": "NOK"|"USD"|"EUR"|null, "items": [{"section": string|null, "name": string, "description": string|null, "price": number|null}]}
- Every dish and drink in reading order; drop leading numbering ("12.") and allergen codes; keep diacritics.
- price is a plain number ("189,-" -> 189); first price if several sizes are shown.
- If the image is not a menu (a photo of food, a logo, the restaurant), return {"is_menu": false, "items": []}.`;

/** Read one menu image with Nemotron 3.5 Super VL. */
export async function readImage(img: { bytes: Buffer; mime: string; url: string }, ledger: Ledger, emit?: Emit): Promise<{ isMenu: boolean; items: MenuItem[] }> {
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Menu image from ${img.url}` },
        { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.bytes.toString('base64')}` } },
      ],
    },
  ] as unknown as ChatMessage[];
  const r = await chat({ role: 'vision', label: 'vision', json: true, thinking: false, maxTokens: 8000, messages }, ledger, emit);
  const parsed = Items.safeParse(r.json);
  if (!parsed.success) return { isMenu: false, items: [] };
  const items: MenuItem[] = parsed.data.items
    .map((it) => ({
      section: it.section ? cleanText(it.section) : null,
      name: cleanText(it.name).replace(/^\d{1,3}[.)]\s*/, '').replace(/\s*\((?:[\dA-Z]+\s*,?\s*)+\)\s*$/, '').trim(),
      description: it.description ? cleanText(it.description) : null,
      price: typeof it.price === 'number' ? it.price : parsePrice(it.price ?? null),
      currency: parsed.data.currency ?? null,
    }))
    .filter((it) => it.name);
  return { isMenu: parsed.data.is_menu !== false && items.length > 0, items };
}

/** Fetch + read all menu images; returns the merged menu and each image's fingerprint. */
export async function readMenuImages(urls: string[], ledger: Ledger, emit?: Emit): Promise<{ items: MenuItem[]; images: MenuImage[] }> {
  const images: MenuImage[] = [];
  const items: MenuItem[] = [];
  for (const url of urls) {
    try {
      const img = await fetchImage(url);
      const r = await readImage({ ...img, url }, ledger, emit);
      if (!r.isMenu) {
        emit?.({ type: 'log', message: `Not a menu image: ${url}` });
        continue;
      }
      images.push({ url, sha256: img.sha256 });
      items.push(...r.items);
      emit?.({ type: 'log', message: `Nemotron 3.5 Super VL read ${r.items.length} dishes from ${url.split('/').pop()}` });
    } catch (e) {
      emit?.({ type: 'log', message: `Image ${url} skipped: ${(e as Error).message}` });
    }
  }
  return { items, images };
}
