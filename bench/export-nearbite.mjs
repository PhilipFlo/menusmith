#!/usr/bin/env node
/**
 * Export a benchmark set from the nearBite database (private) into
 * bench/private/ (gitignored). Only the maintainers can run this — it needs the
 * nearBite Supabase service key. The PUBLIC benchmark results contain no menu
 * content, only per-site metrics.
 *
 *   NEARBITE_ENV=~/path/to/nearBite/.env node bench/export-nearbite.mjs [--n 120]
 *
 * Sampling: stratified by city × website platform, deterministic order (md5 of id),
 * restaurants whose latest nearBite menu came from their own website with 8–250 items.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.NEARBITE_ENV;
if (!envPath) throw new Error('set NEARBITE_ENV to the nearBite .env path');
const env = Object.fromEntries(
  readFileSync(envPath.replace(/^~/, process.env.HOME), 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY;
if (!URL_ || !KEY) throw new Error('nearBite .env lacks NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY');

const n = Number(process.argv[process.argv.indexOf('--n') + 1]) || 120;
const QUOTA = {
  Oslo: { unknown: 0.21, wordpress: 0.17, squarespace: 0.125, wix: 0.1, webflow: 0.065 },
  'Palo Alto': { unknown: 0.125, wordpress: 0.085, squarespace: 0.065, wix: 0.04, webflow: 0.015 },
};

async function rest(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

const snaps = await rest('menu_snapshots?select=restaurant_id,item_count,captured_at,source_platform&order=captured_at.desc&limit=10000');
const latest = new Map();
for (const s of snaps) if (!latest.has(s.restaurant_id)) latest.set(s.restaurant_id, s);

const rs = await rest('restaurants?select=id,name,city,website_platform,menu_url,website_url&website_url=not.is.null&menu_url=not.is.null&limit=5000');
const pool = rs
  .filter((r) => {
    const s = latest.get(r.id);
    return s && s.source_platform === 'own_site' && s.item_count >= 8 && s.item_count <= 250 && QUOTA[r.city];
  })
  .map((r) => ({ ...r, platform: r.website_platform || 'unknown', order: createHash('md5').update(r.id).digest('hex') }))
  .sort((a, b) => a.order.localeCompare(b.order));

const picked = [];
for (const [city, plats] of Object.entries(QUOTA)) {
  for (const [platform, share] of Object.entries(plats)) {
    const want = Math.max(1, Math.round(n * share));
    picked.push(...pool.filter((r) => r.city === city && r.platform === platform).slice(0, want));
  }
}

const out = [];
for (const r of picked) {
  const items = await rest(
    `menu_items?select=section_name,name,price,currency&restaurant_id=eq.${encodeURIComponent(r.id)}&is_addon=is.false&limit=2000`,
  );
  out.push({
    id: r.id,
    name: r.name,
    city: r.city,
    platform: r.platform,
    url: r.menu_url.split('#')[0],
    website: r.website_url,
    reference: items.map((i) => ({ section: i.section_name, name: i.name, price: i.price, currency: i.currency })),
  });
}
mkdirSync(resolve(ROOT, 'bench/private'), { recursive: true });
writeFileSync(resolve(ROOT, 'bench/private/sites.json'), JSON.stringify(out, null, 1));
const by = out.reduce((m, r) => ((m[`${r.city}/${r.platform}`] = (m[`${r.city}/${r.platform}`] || 0) + 1), m), {});
console.log(`exported ${out.length} sites →  bench/private/sites.json`, by);
