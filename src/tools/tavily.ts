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

export async function tavilySearch(query: string, maxResults = 8, country?: string): Promise<TavilyResult[]> {
  const r = await post<{ results: TavilyResult[] }>('/search', {
    query,
    search_depth: 'basic',
    max_results: maxResults,
    include_answer: false,
    ...(country ? { topic: 'general', country } : {}),
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
  /(tripadvisor|yelp|facebook|instagram|google\.|goo\.gl|wolt\.|foodora|doordash|ubereats|grubhub|opentable|thefork|dinnerbooking|bookatable|timeout\.|reddit|tiktok|wikipedia|menupix|allmenus|restaurantguru|zomato|happycow|linkedin|x\.com|twitter|visit[a-z]+\.|michelin|whitepages|gulesider|1881\.no|proff\.no|mapquest|foursquare|sluurpy|menu\.app|menuweb|eat\.no|matprat|aftenposten|vg\.no|dn\.no|infatuation|eater\.com|sfgate|mercurynews)/i;

/** Country hints for the cities we know: boost local results ("Shanti, Oslo" is not shantiboston.com). */
const CITY_COUNTRY: [RegExp, { country: string; tld: string }][] = [
  [/\b(oslo|bergen|trondheim|stavanger|tromsø|drammen|kristiansand|fredrikstad|bærum|lillestrøm|sandvika|asker)\b/i, { country: 'norway', tld: 'no' }],
  [/\b(stockholm|göteborg|gothenburg|malmö|uppsala)\b/i, { country: 'sweden', tld: 'se' }],
  [/\b(copenhagen|københavn|aarhus|odense)\b/i, { country: 'denmark', tld: 'dk' }],
  [/\b(palo alto|san francisco|menlo park|mountain view|san jose|new york|los angeles|seattle|boston|chicago)\b/i, { country: 'united states', tld: 'com' }],
];

/** Find the restaurant's own website from its name (+ city). */
export async function findOfficialSite(restaurant: string, city?: string): Promise<{ url: string; title: string } | null> {
  const where = city ? CITY_COUNTRY.find(([re]) => re.test(city))?.[1] : undefined;
  const results = await tavilySearch(`${restaurant}${city ? ' ' + city : ''} restaurant official website menu`, 10, where?.country);
  const own = results.filter((r) => !AGGREGATORS.test(r.url));
  // Prefer a domain that contains the restaurant's name ("villaparadiso.no" for "Villa Paradiso").
  const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  // The brand is the part before a branch/location suffix ("Peppes Pizza - Grorud Senter",
  // "Grytelokket Avd. Torshov"); its first word matters most.
  const brand = restaurant.split(/\s+[-–|(]\s*|\s+avd\.?\s+/i)[0]!;
  const words = brand.toLowerCase().split(/\s+/).map(squash).filter((w) => w.length >= 3);
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const nameScore = (u: string) => {
    const h = squash(host(u).split('.').slice(0, -1).join(''));
    if (!h) return 0;
    const full = squash(brand);
    if (full.length >= 5 && h.includes(full.slice(0, 12))) return 3;
    return words.reduce((n, w, i) => n + (h.includes(w) ? (i === 0 ? 2 : 1) : 0), 0);
  };
  // Same-named restaurants exist in many cities: reward results that are clearly local.
  const placeScore = (r: TavilyResult) => {
    let p = 0;
    if (city && `${r.title} ${r.content} ${r.url}`.toLowerCase().includes(city.toLowerCase())) p++;
    if (where && host(r.url).endsWith(`.${where.tld}`)) p++;
    return p;
  };
  const rank = (r: TavilyResult) => 2 * nameScore(r.url) + placeScore(r);
  const best = [...own].sort((a, b) => rank(b) - rank(a) || b.score - a.score)[0];
  return best ? { url: best.url, title: best.title } : null;
}
