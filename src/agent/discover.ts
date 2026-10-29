import { ORDERING_HOSTS } from '../html/platform.ts';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import { chat, type Ledger } from '../llm/client.ts';
import { fetchPage, type Page } from '../html/fetch.ts';
import { findMenuRoot } from '../html/simplify.ts';
import { tavilyEnabled, tavilyMap } from '../tools/tavily.ts';
import type { Emit } from '../types.ts';

/**
 * Find the page that actually carries the menu. Restaurants link it as
 * "Meny", "Menu", "Mat", "Lunsj", "Food" … or bury it two clicks deep.
 */

const MENU_WORDS = /\b(meny|menyer|menu|menus|mat|food|lunsj|lunch|middag|dinner|drikke|drinks|spisekart|a-la-carte|carte|takeaway|take-away|brunch|frokost|breakfast|bar|vin|wine|pizza|sushi)\b/i;
const SKIP = /\.(jpg|jpeg|png|gif|webp|svg|mp4|zip)(\?|$)|mailto:|tel:|#$|\/(cart|checkout|login|account|privacy|personvern|cookies?|jobb|careers|gift|gavekort)/i;

export function priceDensity(html: string): number {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  return findMenuRoot($)?.priceNodes ?? 0;
}

/** Same-site links whose text or URL suggests a menu. */
/**
 * Links to ANOTHER site that carry the menu — a hosted ordering system, or any link whose text
 * says menu/order (e.g. "Meny & bestill takeaway"). Used only when the restaurant's own pages
 * have no menu.
 */
export function externalMenuLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const $ = cheerio.load(html);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: { url: string; text: string; score: number }[] = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().replace(/\s+/g, ' ').trim().slice(0, 60);
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) return;
    // Gift cards, jobs, reservations etc. on an ordering platform are not the menu.
    if (/(gift|e-?card|career|job|reserv|book(ing)?-?a-?table|login|account|sign.?in|newsletter|merch|subscribe|donat)/i.test(`${u.pathname} ${text}`)) return;
    const known = ORDERING_HOSTS.test(u.hostname);
    const says = MENU_WORDS.test(text) || /bestill|order|takeaway|take away/i.test(text);
    if (!known && !says) return;
    if (/(facebook|instagram|google|tripadvisor|wolt|foodora|ubereats|doordash|grubhub|yelp)\./i.test(u.hostname)) return;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, text, score: (known ? 2 : 0) + (says ? 1 : 0) });
  });
  return out.sort((a, b) => b.score - a.score).map(({ url, text }) => ({ url, text }));
}

export function menuLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const $ = cheerio.load(html);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: { url: string; text: string }[] = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().replace(/\s+/g, ' ').trim().slice(0, 60);
    if (SKIP.test(href)) return;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      return;
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key) || key === base.toString()) return;
    if (!MENU_WORDS.test(text) && !MENU_WORDS.test(u.pathname.replace(/[-_/]/g, ' '))) return;
    seen.add(key);
    out.push({ url: key, text });
  });
  return out;
}

const Pick = z.object({ urls: z.array(z.string()) });

/** Nemotron Nano ranks candidate URLs when there are too many to fetch. */
async function triage(cands: { url: string; text: string }[], restaurant: string | null | undefined, ledger: Ledger, emit?: Emit) {
  const r = await chat(
    {
      role: 'triage',
      label: 'triage',
      json: true,
      thinking: false,
      maxTokens: 600,
      messages: [
        {
          role: 'system',
          content:
            'You pick which links on a restaurant website lead to its food/drink menu with prices. Return JSON {"urls": [up to 4 URLs, most likely first]}. Prefer full menus (dinner/à la carte/lunch) over single dishes, events or booking pages.',
        },
        {
          role: 'user',
          content: `${restaurant ? `Restaurant: ${restaurant}\n` : ''}Links:\n${cands.map((c) => `${c.url}  —  "${c.text}"`).join('\n')}`,
        },
      ],
    },
    ledger,
    emit,
  );
  const parsed = Pick.safeParse(r.json);
  const valid = new Set(cands.map((c) => c.url));
  return parsed.success ? parsed.data.urls.filter((u) => valid.has(u)) : [];
}

export interface Discovered {
  page: Page;
  how: string;
  candidatesTried: number;
}

/** Starting from any page of the site, return the best menu page. */
export async function findMenuPage(
  start: Page,
  opts: { restaurant?: string | null; ledger: Ledger; emit?: Emit; useTavily?: boolean },
): Promise<Discovered> {
  const startDensity = priceDensity(start.html);
  if (startDensity >= 10) return { page: start, how: `given page has a menu (${startDensity} prices)`, candidatesTried: 0 };

  let cands = menuLinks(start.html, start.finalUrl);
  let how = 'site links';
  if (opts.useTavily !== false && tavilyEnabled() && /^https?:/.test(start.finalUrl)) {
    try {
      const mapped = await tavilyMap(start.finalUrl);
      opts.emit?.({ type: 'log', message: `Tavily map found ${mapped.length} pages on the site` });
      const extra = mapped
        .filter((u) => !SKIP.test(u) && MENU_WORDS.test(new URL(u).pathname.replace(/[-_/]/g, ' ')))
        .map((u) => ({ url: u, text: '' }));
      const known = new Set(cands.map((c) => c.url));
      cands = [...cands, ...extra.filter((e) => !known.has(e.url))];
      how = 'site links + Tavily map';
    } catch (e) {
      opts.emit?.({ type: 'log', message: `Tavily map unavailable: ${(e as Error).message}` });
    }
  }
  if (!cands.length) return { page: start, how: 'no menu links found; using given page', candidatesTried: 0 };

  let ordered = cands;
  if (cands.length > 5) {
    try {
      const picked = await triage(cands.slice(0, 60), opts.restaurant, opts.ledger, opts.emit);
      ordered = [...picked.map((u) => cands.find((c) => c.url === u)!), ...cands.filter((c) => !picked.includes(c.url))];
      how += ' + Nemotron Nano triage';
    } catch {
      /* fall back to page order */
    }
  }

  let best: { page: Page; density: number } = { page: start, density: startDensity };
  let tried = 0;
  for (const c of ordered.slice(0, 5)) {
    if (/\.pdf(\?|$)/i.test(c.url)) {
      opts.emit?.({ type: 'log', message: `Skipping PDF menu ${c.url} (PDF menus are read by the vision path, not the HTML forge)` });
      continue;
    }
    tried++;
    try {
      const p = await fetchPage(c.url);
      const d = priceDensity(p.html);
      opts.emit?.({ type: 'log', message: `Candidate ${c.url}: ${d} prices` });
      if (d > best.density) best = { page: p, density: d };
      if (d >= 25) break;
    } catch (e) {
      opts.emit?.({ type: 'log', message: `Candidate ${c.url} failed: ${(e as Error).message}` });
    }
  }
  return { page: best.page, how: `${how} → ${best.page.finalUrl} (${best.density} prices)`, candidatesTried: tried };
}

const Guess = z.object({ urls: z.array(z.string()).optional() });

/**
 * Without web search (no key, quota spent, outage): Nemotron Nano names the official site
 * it knows, and the site is only used if it really names the restaurant — a wrong or
 * invented domain is caught here, never shown.
 */
export async function guessOfficialSite(restaurant: string, city: string | undefined, ledger: Ledger, emit?: Emit): Promise<{ url: string; title: string } | null> {
  const squash = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const words = restaurant.split(/\s+/).map(squash).filter((w) => w.length >= 3 && !['the', 'and', 'restaurant', 'cafe', 'bar'].includes(w));
  const tried = new Set<string>();
  // Super first; Ultra only if none of Super's suggestions checks out (they know different sites).
  for (const role of ['oracle', 'escalate'] as const) {
    const r = await chat(
      {
        role,
        label: 'site guess',
        json: true,
        thinking: false,
        maxTokens: 300,
        messages: [
          {
            role: 'system',
            content:
              'You know restaurant websites. Return JSON {"urls": [up to 3 candidate official website URLs of the restaurant, most likely first]}. Only the restaurant\'s own site (for a chain: its site for that country) — never Yelp, TripAdvisor, delivery apps or social media. Return {"urls": []} if you do not know.',
          },
          { role: 'user', content: `${restaurant}${city ? `, ${city}` : ''}` },
        ],
      },
      ledger,
      emit,
    );
    const parsed = Guess.safeParse(r.json);
    for (const raw of (parsed.success ? (parsed.data.urls ?? []) : []).slice(0, 3)) {
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const key = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '').toLowerCase();
      if (tried.has(key)) continue;
      tried.add(key);
      try {
        const page = await fetchPage(url);
        const $ = cheerio.load(page.html);
        const text = squash(`${$('title, h1, h2, header, footer').text()} ${$('meta[property="og:site_name"]').attr('content') ?? ''}`);
        // Verified: the site loads and its title/headings carry the name (most of its words).
        const named = words.length > 0 && text.includes(words[0]!) && words.filter((w) => text.includes(w)).length >= Math.ceil(words.length / 2);
        // Or the domain itself spells the name ("peterluger.com") — enough when the site turns
        // automated visitors away and its headings cannot be read.
        const host = squash(new URL(page.finalUrl).hostname.replace(/^www\./, '').split('.').slice(0, -1).join(''));
        const head = squash(restaurant.split(/\s+/).slice(0, 2).join(''));
        const spelled = head.length >= 6 && host.includes(head);
        if ((page.status < 400 && named) || spelled) return { url: page.finalUrl, title: `${restaurant} (suggested by Nemotron, verified)` };
        emit?.({ type: 'log', message: `Suggested site ${url} does not name ${restaurant} — skipped` });
      } catch (e) {
        emit?.({ type: 'log', message: `Suggested site ${url} could not be loaded: ${(e as Error).message}` });
      }
    }
  }
  return null;
}
