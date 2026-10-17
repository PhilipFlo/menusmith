import { useId, useMemo, useState } from 'react';
import { api, type ExtractorMeta } from '../api.ts';
import { Badge, Empty, ErrorNote, Kpi, PlatformBadge, Spinner } from '../components/ui.tsx';
import { useLoad } from '../controllers.ts';
import { int, relative, score, usd } from '../format.ts';
import { href } from '../router.ts';

type Sort = 'recent' | 'f1' | 'items' | 'name';

export function LibraryPage() {
  const { data, error, loading } = useLoad(api.library);
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState('all');
  const [sort, setSort] = useState<Sort>('recent');
  const qId = useId();
  const pId = useId();
  const sId = useId();

  const list = data ?? [];
  const platforms = useMemo(() => [...new Set(list.map((x) => x.platform))].sort(), [list]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const xs = list.filter((x) => (platform === 'all' || x.platform === platform) && (!s || `${x.id} ${x.domain} ${x.restaurant ?? ''}`.toLowerCase().includes(s)));
    const by: Record<Sort, (a: ExtractorMeta, b: ExtractorMeta) => number> = {
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
      f1: (a, b) => b.score.f1 - a.score.f1,
      items: (a, b) => b.baselineCount - a.baselineCount,
      name: (a, b) => (a.restaurant || a.domain).localeCompare(b.restaurant || b.domain),
    };
    return [...xs].sort(by[sort]);
  }, [list, q, platform, sort]);

  const totals = useMemo(() => {
    const cost = list.reduce((a, x) => a + (x.costUsd || 0), 0);
    const f1 = list.length ? list.reduce((a, x) => a + x.score.f1, 0) / list.length : 0;
    const dishes = list.reduce((a, x) => a + (x.baselineCount || 0), 0);
    const reused = list.filter((x) => x.reusedFrom).length;
    return { cost, f1, dishes, reused };
  }, [list]);

  return (
    <div>
      <header className="page-head">
        <p className="eyebrow">Library</p>
        <h1>Extractors written once, run forever</h1>
        <p className="lead">Every extractor here was written by Nemotron, tested against its own reading of the menu, and committed. Re-running one is plain JavaScript in a sandbox — no model, no tokens.</p>
      </header>

      {loading && !data && <Spinner label="Loading the library…" />}
      {error && <ErrorNote>Couldn't load the library: {error}</ErrorNote>}

      {data && data.length === 0 && (
        <Empty title="The library is empty">
          <p>Forge your first extractor and it will appear here — with its code, version history and the dishes it extracts.</p>
          <a className="btn btn-primary" href={href.forge}>
            Open the Live Forge
          </a>
        </Empty>
      )}

      {data && data.length > 0 && (
        <>
          <div className="kpis">
            <Kpi label="Extractors" value={int(list.length)} />
            <Kpi label="Dishes tracked" value={int(totals.dishes)} />
            <Kpi label="Average F1" value={score(totals.f1)} tone="pass" />
            <Kpi label="Reused (0 tokens)" value={int(totals.reused)} tone="info" />
            <Kpi label="Total one-time cost" value={usd(totals.cost, 4)} hint="$0 per re-run" tone="accent" />
          </div>

          <div className="toolbar">
            <div className="field field-grow">
              <label htmlFor={qId} className="sr-only">
                Search extractors
              </label>
              <input id={qId} className="input" type="search" placeholder="Search by restaurant or domain…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={pId} className="sr-only">
                Platform
              </label>
              <select id={pId} className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="all">All platforms</option>
                {platforms.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={sId} className="sr-only">
                Sort
              </label>
              <select id={sId} className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="recent">Newest first</option>
                <option value="f1">Best F1</option>
                <option value="items">Most dishes</option>
                <option value="name">Name</option>
              </select>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="muted">No extractors match.</p>
          ) : (
            <ul className="lib-grid">
              {shown.map((x) => (
                <li key={x.id}>
                  <a className="lib-card" href={href.extractor(x.id)}>
                    <div className="lib-card-head">
                      <div className="lib-name">
                        <span className="lib-title">{x.restaurant || x.domain}</span>
                        <span className="lib-domain">{x.restaurant ? x.domain : x.id}</span>
                      </div>
                      <span className="version num">v{x.version}</span>
                    </div>
                    <div className="lib-badges">
                      <PlatformBadge platform={x.platform} />
                      {x.reusedFrom && (
                        <Badge tone="info" title={`Adopted from ${x.reusedFrom}`}>
                          reused from {x.reusedFrom}
                        </Badge>
                      )}
                      {x.history?.some((h) => h.reason.startsWith('self-heal')) && <Badge tone="accent">self-healed</Badge>}
                    </div>
                    <dl className="lib-stats">
                      <div>
                        <dt>F1</dt>
                        <dd className="num">{score(x.score.f1)}</dd>
                      </div>
                      <div>
                        <dt>Dishes</dt>
                        <dd className="num">{int(x.baselineCount)}</dd>
                      </div>
                      <div>
                        <dt>Once</dt>
                        <dd className="num">{usd(x.costUsd)}</dd>
                      </div>
                    </dl>
                    <div className="lib-foot">
                      <span>{relative(x.createdAt)}</span>
                      <span>{x.rounds === 0 ? 'no code generated' : `${x.rounds} ${x.rounds === 1 ? 'round' : 'rounds'}`}</span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
