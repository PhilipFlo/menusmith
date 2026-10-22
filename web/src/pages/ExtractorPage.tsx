import { useEffect, useId, useState } from 'react';
import { api } from '../api.ts';
import { CodeViewer } from '../components/CodeViewer.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { ItemsTable } from '../components/ItemsTable.tsx';
import { ScoreBars } from '../components/ScoreBars.tsx';
import { Badge, Empty, ErrorNote, ModelChip, Panel, PlatformBadge, Spinner } from '../components/ui.tsx';
import { useLoad } from '../controllers.ts';
import { date, int, pct, relative, usd } from '../format.ts';
import { href } from '../router.ts';

export function ExtractorPage({ id }: { id: string }) {
  const { data, error, loading } = useLoad(() => api.extractor(id), [id]);
  const [view, setView] = useState<'code' | 'diff'>('code');
  const [version, setVersion] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const vId = useId();
  const fId = useId();

  useEffect(() => {
    setVersion(null);
    setFrom(null);
    setView('code');
  }, [id]);

  if (loading && !data) return <Spinner label="Loading extractor…" />;
  if (error || !data)
    return (
      <Empty title={error === 'not found' ? 'No such extractor' : "Couldn't load this extractor"}>
        {error && error !== 'not found' && <p>{error}</p>}
        <a className="btn btn-secondary" href={href.library}>
          ← Back to the library
        </a>
      </Empty>
    );

  const { meta, versions, items } = data;
  const cur = version ?? meta.version;
  const curCode = versions.find((v) => v.version === cur)?.code ?? (cur === meta.version ? data.code : null);
  const fromV = from ?? Math.max(1, cur - 1);
  const fromCode = versions.find((v) => v.version === fromV)?.code ?? null;
  const history = [...(meta.history ?? [])].sort((a, b) => b.version - a.version);
  const isUrl = /^https?:\/\//i.test(meta.url);

  return (
    <div>
      <a className="back" href={href.library}>
        ← Library
      </a>
      <header className="page-head detail-head">
        <div>
          <h1>{meta.restaurant || meta.domain}</h1>
          <p className="detail-url">
            {isUrl ? (
              <a href={meta.url} target="_blank" rel="noreferrer noopener">
                {meta.url}
              </a>
            ) : (
              <code>{meta.url}</code>
            )}
          </p>
          <div className="lib-badges">
            <PlatformBadge platform={meta.platform} />
            <Badge tone="neutral">
              <span className="num">v{meta.version}</span>
            </Badge>
            {meta.reusedFrom && (
              <Badge tone="info">
                reused from <a href={href.extractor(meta.reusedFrom)}>{meta.reusedFrom}</a>
              </Badge>
            )}
            <span className="small muted">
              <code>{meta.id}</code>
            </span>
          </div>
        </div>
        <div className="detail-cost">
          <span className="detail-cost-n num">{usd(meta.costUsd)}</span>
          <span className="small muted">one-time cost · $0 per re-run</span>
        </div>
      </header>

      <div className="detail-grid">
        <Panel
          title={meta.source?.kind === 'image' ? 'Read from menu images' : 'Quality at commit'}
          subtitle={
            meta.source?.kind === 'image'
              ? `Nemotron 3.5 Super VL read ${int(meta.score.oracleCount)} dishes from ${meta.source.request?.images?.length ?? 0} picture(s). The fleet compares image fingerprints and only re-reads a picture that changed.`
              : `Scored against Nemotron's own reading of ${int(meta.score.oracleCount)} dishes`
          }
        >
          {meta.source?.kind !== 'image' && <ScoreBars score={{ ...meta.score, pass: true }} />}
          <dl className="facts facts-grid">
            <div>
              <dt>Dishes extracted</dt>
              <dd className="num">{int(meta.baselineCount)}</dd>
            </div>
            <div>
              <dt>With a price</dt>
              <dd className="num">{pct(meta.score.pricedRatio)}</dd>
            </div>
            <div>
              <dt>{meta.source?.kind === 'image' ? 'Menu images' : 'Rounds to pass'}</dt>
              <dd className="num">{meta.source?.kind === 'image' ? meta.source.request?.images?.length ?? 0 : meta.rounds}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd className="num">{int(meta.tokens.prompt + meta.tokens.completion)}</dd>
            </div>
            <div>
              <dt>Written by</dt>
              <dd>{meta.model ? <ModelChip model={meta.model} /> : '—'}</dd>
            </div>
            <div>
              <dt>Committed</dt>
              <dd title={date(meta.createdAt)}>{relative(meta.createdAt)}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="History">
          {history.length ? (
            <ol className="history">
              {history.map((h) => (
                <li key={h.version} className={h.reason.startsWith('self-heal') ? 'is-heal' : ''}>
                  <button type="button" className="history-v num" onClick={() => { setVersion(h.version); setView('code'); }} aria-label={`Show code for version ${h.version}`}>
                    v{h.version}
                  </button>
                  <div>
                    <div className="history-reason">{h.reason}</div>
                    <div className="small muted">{date(h.at)}</div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">v{meta.version} · forged {relative(meta.createdAt)}</p>
          )}
        </Panel>
      </div>

      <Panel
        title="Code"
        subtitle={
          meta.source?.kind === 'image'
            ? 'No code for this one: the menu is a picture. What is stored is the image fingerprints; this note explains the method.'
            : 'Plain, deterministic JavaScript — runs in a sandbox with no secrets, no file access beyond its libraries, and no model.'
        }
        actions={
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={`seg-btn ${view === 'code' ? 'is-active' : ''}`} aria-pressed={view === 'code'} onClick={() => setView('code')}>
              Code
            </button>
            <button type="button" className={`seg-btn ${view === 'diff' ? 'is-active' : ''}`} aria-pressed={view === 'diff'} onClick={() => setView('diff')} disabled={versions.length < 2}>
              Diff
            </button>
          </div>
        }
      >
        <div className="toolbar toolbar-tight">
          {view === 'diff' && (
            <div className="field field-inline">
              <label htmlFor={fId}>From</label>
              <select id={fId} className="input input-sm" value={fromV} onChange={(e) => setFrom(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field field-inline">
            <label htmlFor={vId}>{view === 'diff' ? 'To' : 'Version'}</label>
            <select id={vId} className="input input-sm" value={cur} onChange={(e) => setVersion(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                  {v.version === meta.version ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
          {versions.length < 2 && <span className="small muted">Only one version so far — a diff appears after the first self-heal.</span>}
        </div>
        {view === 'code' || versions.length < 2 ? (
          curCode != null ? (
            <CodeViewer code={curCode} label={`${meta.id} · v${cur}`} />
          ) : (
            <p className="muted">The code for v{cur} isn't stored.</p>
          )
        ) : fromCode != null && curCode != null ? (
          <DiffView oldCode={fromCode} newCode={curCode} oldLabel={`v${fromV}`} newLabel={`v${cur}`} />
        ) : (
          <p className="muted">One of these versions isn't stored.</p>
        )}
      </Panel>

      <Panel title="Latest dishes" subtitle="The most recent snapshot from this extractor — the baseline the fleet compares against.">
        {items && items.length ? <ItemsTable items={items} caption="Latest extracted dishes" /> : <p className="small muted">No snapshot yet — it's written on the first fleet run.</p>}
      </Panel>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
