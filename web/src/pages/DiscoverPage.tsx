import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AgentEvent, ExtractorMeta, ForgeSummary, MenuItem } from '../api.ts';
import { Badge, ErrorNote, Panel, StateIcon, type StepState } from '../components/ui.tsx';
import { duration, plural, price, usd } from '../format.ts';
import { href } from '../router.ts';
import { parseData, postSse } from '../sse.ts';

interface AreaRestaurant {
  name: string;
  city: string | null;
  source: string;
  libraryId?: string;
  libraryUrl?: string;
}
interface Row extends AreaRestaurant {
  state: StepState;
  detail?: string;
  items?: MenuItem[];
  meta?: ExtractorMeta;
  costUsd?: number;
  ms?: number;
  mode?: string;
  reason?: string;
}
interface Area {
  query: string;
  city: string | null;
  dish: string | null;
  costUsd: number;
}

const EXAMPLES = ['pizza in San Francisco', 'ramen in New York', 'burgers in Chicago'];

/** Owns the area run — lives in App so it survives navigating to the library and back. */
export function useAreaController() {
  const [area, setArea] = useState<Area | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [searching, setSearching] = useState(false);
  const [forging, setForging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const search = useCallback(async (query: string) => {
    abort.current?.abort();
    setError(null);
    setSearching(true);
    setArea(null);
    setRows([]);
    try {
      const res = await fetch('/api/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
      const body = (await res.json().catch(() => ({}))) as Area & { restaurants?: AreaRestaurant[]; error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setArea({ query: body.query, city: body.city, dish: body.dish, costUsd: body.costUsd });
      setRows((body.restaurants ?? []).map((r) => ({ ...r, state: 'pending' })));
      if (!body.restaurants?.length) setError('No restaurants found for that search — try “dish in city”, e.g. “tacos in Austin”.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }, []);

  /** Forge each restaurant in turn with the normal pipeline (library first: known ones are instant and free). */
  const forgeAll = useCallback(async (list: Row[]) => {
    const ac = new AbortController();
    abort.current = ac;
    setForging(true);
    for (let i = 0; i < list.length; i++) {
      if (ac.signal.aborted) break;
      if (list[i]!.state === 'done') continue;
      const t0 = Date.now();
      patch(i, { state: 'running', detail: 'Finding the website…', reason: undefined });
      let summary: ForgeSummary | null = null;
      let items: MenuItem[] | undefined;
      let meta: ExtractorMeta | undefined;
      let reading: MenuItem[] | undefined;
      try {
        await postSse(
          '/api/forge',
          // Every restaurant is forged for real; a known one starts from its saved page (no search),
          // and falls back to its saved menu only if the run fails.
          { ...(list[i]!.libraryUrl ? { url: list[i]!.libraryUrl } : { restaurant: list[i]!.name, city: list[i]!.city ?? undefined }), fresh: true, noReuse: true },
          (m) => {
            if (m.event === 'summary') summary = parseData<ForgeSummary>(m);
            const e = parseData<AgentEvent>(m);
            if (!e) return;
            if (e.type === 'step' && e.status === 'start' && e.detail) patch(i, { detail: e.detail });
            if (e.type === 'oracle') reading = e.items;
            if (e.type === 'result') {
              items = e.items;
              meta = e.meta;
            }
            if (e.type === 'error') patch(i, { reason: e.message });
          },
          ac.signal,
        );
      } catch (e) {
        if (ac.signal.aborted) {
          patch(i, { state: 'pending', detail: undefined });
          break;
        }
        patch(i, { state: 'fail', reason: (e as Error).message, ms: Date.now() - t0 });
        if (/limit|budget|busy/i.test((e as Error).message)) break;
        continue;
      }
      const s = summary as ForgeSummary | null;
      const ok = !!s?.ok && !!items?.length;
      // A near miss still read the menu: use the reading, clearly marked.
      const shown = ok ? items : reading && reading.length >= 5 ? reading : undefined;
      patch(i, {
        state: ok ? 'done' : 'fail',
        items: shown,
        meta,
        costUsd: s?.costUsd ?? 0,
        ms: Date.now() - t0,
        mode: ok ? (s?.mode ?? meta?.source?.kind) : shown ? 'reading' : undefined,
        reason: ok ? undefined : (s?.reason ?? 'stopped'),
        detail: undefined,
      });
    }
    setForging(false);
  }, []);

  const stop = useCallback(() => abort.current?.abort(), []);
  return { area, rows, searching, forging, error, search, forgeAll, stop };
}
export type AreaController = ReturnType<typeof useAreaController>;

export function DiscoverPage({ ctl }: { ctl: AreaController }) {
  const [value, setValue] = useState('');
  const busy = ctl.searching || ctl.forging;
  const submit = (e?: FormEvent, q = value) => {
    e?.preventDefault();
    if (q.trim().length < 3 || busy) return;
    setValue(q);
    void ctl.search(q);
  };
  const done = ctl.rows.filter((r) => r.items?.length);
  const spent = (ctl.area?.costUsd ?? 0) + ctl.rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);

  return (
    <div className="forge-page">
      <section className="hero">
        <p className="eyebrow">Discover · Tavily</p>
        <h1 className="hero-title">
          One search, a <em>price index</em> for a whole area.
        </h1>
        <p className="hero-sub">
          Type a dish and a city. Tavily finds the places worth knowing, Nemotron names them, and Menusmith forges a menu extractor for each — then compares every dish across them. After that, every re-scrape is free: <strong>$0</strong>.
        </p>
        <form className="forge-form card" onSubmit={submit} aria-label="Discover restaurants">
          <div className="forge-fields">
            <div className="field field-grow">
              <label htmlFor="area-q">What and where</label>
              <input id="area-q" className="input input-lg" type="text" placeholder="pizza in San Francisco" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} autoComplete="off" />
            </div>
            <div className="field field-action">
              <button type="submit" className="btn btn-lg btn-primary" disabled={busy || value.trim().length < 3}>
                {ctl.searching ? 'Searching…' : 'Discover'}
              </button>
            </div>
          </div>
          <div className="chips-block">
            <span className="chips-label">Try</span>
            <div className="chips">
              {EXAMPLES.map((q) => (
                <button type="button" key={q} className="chip chip-outline" onClick={() => submit(undefined, q)} disabled={busy}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        </form>
      </section>

      {ctl.error && <ErrorNote>{ctl.error}</ErrorNote>}

      {ctl.area && ctl.rows.length > 0 && (
        <Panel
          title={`${plural(ctl.rows.length, 'restaurant')} for “${ctl.area.query}”`}
          subtitle={`Found by one Tavily search · named by Nemotron Nano (only names that appear in the results) · ${usd(ctl.area.costUsd)}`}
          actions={
            ctl.forging ? (
              <button type="button" className="btn btn-secondary" onClick={ctl.stop}>
                Stop
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void ctl.forgeAll(ctl.rows)} disabled={ctl.rows.every((r) => r.state === 'done')}>
                {ctl.rows.some((r) => r.state !== 'pending') ? 'Forge the rest' : `Forge all ${ctl.rows.length}`}
              </button>
            )
          }
        >
          <ol className="area-list">
            {ctl.rows.map((r) => (
              <li key={r.name} className="area-row">
                <StateIcon state={r.state} />
                <div className="area-main">
                  <div className="area-name">
                    {r.meta ? <a href={href.extractor(r.meta.id)}>{r.name}</a> : r.name}
                    {r.mode === 'known' && <Badge tone="warn">saved menu — this run stopped</Badge>}
                    {r.mode === 'listing' && <Badge tone="warn">public listing</Badge>}
                    {r.mode === 'reading' && <Badge tone="warn">reading only</Badge>}
                  </div>
                  <div className="small muted">
                    {r.state === 'running'
                      ? r.detail
                      : r.state === 'done'
                        ? `${plural(r.items?.length ?? 0, 'dish', 'dishes')} · ${usd(r.costUsd)} · ${duration(r.ms)}${r.meta ? ` · ${hostOf(r.meta.url)}` : ''}`
                        : r.state === 'fail'
                          ? r.items?.length
                            ? `Menu read (${plural(r.items.length, 'dish', 'dishes')}), code not committed · ${usd(r.costUsd)}`
                            : r.reason
                          : <>mentioned on <a href={r.source} target="_blank" rel="noreferrer">{hostOf(r.source)}</a></>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {(ctl.forging || done.length > 0) && (
            <p className="small muted area-foot">
              {ctl.forging ? 'Forging one restaurant at a time — each takes from seconds (library) to a few minutes (JavaScript sites).' : ''} Spent so far: <strong>{usd(spent)}</strong>.
            </p>
          )}
        </Panel>
      )}

      {done.length > 0 && <PriceIndex rows={done} dish={ctl.area?.dish ?? null} />}
    </div>
  );
}

/** Every dish from every forged menu, side by side — the price index. */
function PriceIndex({ rows, dish }: { rows: Row[]; dish: string | null }) {
  const [q, setQ] = useState(dish ?? '');
  const [sort, setSort] = useState<'price' | 'restaurant'>('price');
  const all = useMemo(() => rows.flatMap((r) => (r.items ?? []).map((it) => ({ ...it, restaurant: r.name, reading: r.mode === 'reading' }))), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/s$/, '');
    const list = s ? all.filter((i) => `${i.section ?? ''} ${i.name} ${i.description ?? ''}`.toLowerCase().includes(s)) : all;
    return [...list].sort((a, b) => (sort === 'price' ? (a.price ?? Infinity) - (b.price ?? Infinity) : a.restaurant.localeCompare(b.restaurant)));
  }, [all, q, sort]);
  const stats = rows.map((r) => {
    const ps = (r.items ?? []).map((i) => i.price).filter((p): p is number => typeof p === 'number' && p > 0).sort((a, b) => a - b);
    const match = q.trim() ? (r.items ?? []).filter((i) => `${i.section ?? ''} ${i.name}`.toLowerCase().includes(q.trim().toLowerCase().replace(/s$/, ''))) : [];
    return { name: r.name, n: r.items?.length ?? 0, median: ps.length ? ps[Math.floor(ps.length / 2)] : null, match: match.length, cheapest: match.filter((m) => m.price != null).sort((a, b) => a.price! - b.price!)[0] };
  });

  return (
    <Panel title="Price index" subtitle={`${plural(all.length, 'dish', 'dishes')} from ${plural(rows.length, 'restaurant')} — every number comes from a menu, re-scraped for $0 from now on`}>
      <div className="area-stats">
        {stats.map((s) => (
          <div key={s.name} className="area-stat">
            <div className="area-stat-name">{s.name}</div>
            <div className="small muted num">
              {plural(s.n, 'dish', 'dishes')} · median {price(s.median)}
            </div>
            {q.trim() && (
              <div className="small num">
                {s.match ? (
                  <>
                    {plural(s.match, 'match', 'matches')}
                    {s.cheapest ? (
                      <>
                        {' '}
                        · from <strong>{price(s.cheapest.price)}</strong>
                      </>
                    ) : (
                      ' · no prices'
                    )}
                  </>
                ) : (
                  <span className="muted">no dish named “{q.trim()}”</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="items">
        <div className="items-bar">
          <label htmlFor="pi-q" className="sr-only">
            Filter dishes
          </label>
          <input id="pi-q" className="input input-sm" type="search" placeholder="Filter, e.g. taco" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input input-sm area-sort" value={sort} onChange={(e) => setSort(e.target.value as 'price' | 'restaurant')} aria-label="Sort">
            <option value="price">Cheapest first</option>
            <option value="restaurant">By restaurant</option>
          </select>
          <span className="muted num small">
            {shown.length} of {all.length}
          </span>
        </div>
        <div className="table-wrap" style={{ maxHeight: 520 }}>
          <table className="table">
            <caption className="sr-only">Dishes across restaurants</caption>
            <thead>
              <tr>
                <th scope="col">Restaurant</th>
                <th scope="col">Dish</th>
                <th scope="col" className="right">
                  Price
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((it, i) => (
                <tr key={i}>
                  <td className="muted">
                    {it.restaurant}
                    {it.reading && ' *'}
                  </td>
                  <td>
                    <div className="dish">{it.name}</div>
                    {it.section && <div className="dish-desc">{it.section}</div>}
                  </td>
                  <td className="right num nowrap">{price(it.price, it.currency)}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted center">
                    No dishes match “{q}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {all.some((i) => i.reading) && <p className="small muted">* read by Nemotron; the extractor for this restaurant did not pass its tests yet.</p>}
      </div>
    </Panel>
  );
}

function hostOf(u?: string | null): string {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}
