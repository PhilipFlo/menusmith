import { z } from 'zod';
import { chat, type Ledger } from '../llm/client.ts';
import { listExtractors } from '../library/store.ts';
import { tavilySearchFull } from '../tools/tavily.ts';
import type { Emit } from '../types.ts';

/**
 * AREA DISCOVERY — "tacos in Austin" → the restaurants to put in a price index.
 *
 * One Tavily search (guides, lists, local press, with page text), then Nemotron Nano
 * names the restaurants in it. A name is kept only if it appears in the search results
 * — the model picks from what Tavily found, it never adds places of its own.
 * Each restaurant is then forged by the normal pipeline (library first, $0 if known).
 */

export interface AreaRestaurant {
  name: string;
  city: string | null;
  /** Page that mentioned it. */
  source: string;
  /** Already in the library (answered instantly). */
  libraryId?: string;
}
export interface AreaResult {
  query: string;
  city: string | null;
  /** Word to filter the combined menus by ("taco"), if the query names a dish. */
  dish: string | null;
  restaurants: AreaRestaurant[];
}

const MAX = 6;
const Out = z.object({
  city: z.string().nullish(),
  dish: z.string().nullish(),
  restaurants: z.array(z.object({ name: z.string(), source: z.number().int().nullish() })),
});

const compact = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');

export async function discoverArea(query: string, ledger: Ledger, emit?: Emit): Promise<AreaResult> {
  const q = query.trim().slice(0, 120);
  const results = await tavilySearchFull(`best ${q} restaurants`, [], 8);
  const docs = results.map((r, i) => `[${i}] ${r.url}\n${r.title}\n${r.content}\n${(r.raw_content || '').slice(0, 3500)}`);
  const r = await chat(
    {
      role: 'triage',
      label: 'area',
      json: true,
      thinking: false,
      maxTokens: 800,
      messages: [
        {
          role: 'system',
          content: `You read web search results about restaurants and list the individual restaurants they name.
Return ONLY JSON: {"city": string|null, "dish": string|null, "restaurants": [{"name": string, "source": number}]}
- city: the city the user asked about. dish: the dish or cuisine word to look for on menus, singular and lowercase ("tacos in Austin" -> "taco", "sushi Oslo" -> "sushi"), null if none.
- Up to ${MAX + 2} restaurants located in that city that match the request, most recommended first, each once; source = the [number] of the result that names it.
- Only real restaurant names exactly as written in the results — no dishes, neighbourhoods, writers, websites or chains' parent companies.`,
        },
        { role: 'user', content: `Request: ${q}\n\nSearch results:\n\n${docs.join('\n\n---\n\n')}`.slice(0, 40_000) },
      ],
    },
    ledger,
    emit,
  );
  const parsed = Out.safeParse(r.json);
  if (!parsed.success) return { query: q, city: null, dish: null, restaurants: [] };
  const haystack = compact(docs.join(' '));
  const known = listExtractors().map((x) => ({ id: x.meta.id, name: compact(x.meta.restaurant ?? '') }));
  const seen = new Set<string>();
  const restaurants: AreaRestaurant[] = [];
  for (const it of parsed.data.restaurants) {
    const name = it.name.replace(/\s+/g, ' ').trim();
    const key = compact(name);
    // Grounded: the name must be in what Tavily returned.
    if (key.length < 3 || seen.has(key) || !haystack.includes(key)) continue;
    seen.add(key);
    const lib = known.find((k) => k.name && (k.name === key || k.name.startsWith(key) || key.startsWith(k.name)));
    restaurants.push({ name, city: parsed.data.city ?? null, source: results[it.source ?? -1]?.url ?? results[0]?.url ?? '', ...(lib ? { libraryId: lib.id } : {}) });
    if (restaurants.length >= MAX) break;
  }
  const dish = parsed.data.dish?.toLowerCase().trim() || null;
  return { query: q, city: parsed.data.city ?? null, dish: dish && dish.length <= 30 ? dish : null, restaurants };
}
