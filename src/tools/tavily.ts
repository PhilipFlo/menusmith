import { config } from '../config.ts';

/**
 * Tavily — the agent's eyes on the open web. Used to (1) find a restaurant's
 * official website from its name, and (2) map a site to find its menu pages.
 * https://docs.tavily.com
 */

const BASE = 'https://api.tavily.com';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export const tavilyEnabled = () => !!config.tavilyApiKey;

async function post<T>(path: string, body: unknown, timeoutMs = 40_000): Promise<T> {
  if (!config.tavilyApiKey) throw new Error('TAVILY_API_KEY is not set');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyApiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Tavily ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function tavilySearch(query: string, maxResults = 8): Promise<TavilyResult[]> {
  const r = await post<{ results: TavilyResult[] }>('/search', {
    query,
    search_depth: 'basic',
    max_results: maxResults,
    include_answer: false,
  });
  return r.results || [];
}

/** Discover URLs on a site, steered towards menu pages. */
export async function tavilyMap(url: string, limit = 40): Promise<string[]> {
  const r = await post<{ results: string[] }>(
    '/map',
    {
      url,
      instructions: 'Find pages that show the restaurant menu with dishes and prices (food, drinks, lunch, dinner, takeaway).',
      max_depth: 2,
      limit,
      allow_external: false,
    },
    60_000,
  );
  return r.results || [];
}

/** Sites that list restaurants but are not the restaurant's own website. */
export const AGGREGATORS =
  /(tripadvisor|yelp|facebook|instagram|google\.|goo\.gl|wolt\.|foodora|doordash|ubereats|grubhub|opentable|thefork|dinnerbooking|bookatable|timeout\.|reddit|tiktok|wikipedia|menupix|allmenus|restaurantguru|zomato|happycow|linkedin|x\.com|twitter)/i;

/** Find the restaurant's own website from its name (+ city). */
export async function findOfficialSite(restaurant: string, city?: string): Promise<{ url: string; title: string } | null> {
  const results = await tavilySearch(`${restaurant}${city ? ' ' + city : ''} restaurant official website menu`, 10);
  const own = results.filter((r) => !AGGREGATORS.test(r.url));
  const best = own[0];
  return best ? { url: best.url, title: best.title } : null;
}
