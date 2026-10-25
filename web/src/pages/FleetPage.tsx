import { Fragment, useEffect, useRef, useState } from 'react';
import { api, type Fixture, type FleetEntry, type FleetReport, type FleetStatus, type PriceChange } from '../api.ts';
import { Badge, Empty, ErrorNote, Kpi, Panel, Spinner, StateIcon } from '../components/ui.tsx';
import { useLoad, type FleetController } from '../controllers.ts';
import { date, duration, int, plural, price, relative, usd } from '../format.ts';
import { href } from '../router.ts';

export function FleetPage({ fleet }: { fleet: FleetController }) {
  const history = useLoad(api.fleetHistory);
  const [heal, setHeal] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // Refresh history when a run completes.
  const prevRunning = useRef(fleet.running);
  const reloadHistory = history.reload;
  useEffect(() => {
    if (prevRunning.current && !fleet.running) reloadHistory();
    prevRunning.current = fleet.running;
  }, [fleet.running, reloadHistory]);

  const past = history.data ?? [];
  const shown: FleetReport | null = selected ? (past.find((r) => r.startedAt === selected) ?? null) : (fleet.report ?? past[0] ?? null);
  const isLive = !selected && !!fleet.report && shown === fleet.report;

  return (
    <div>
      <header className="page-head">
        <p className="eyebrow">Fleet</p>
        <h1>The nightly re-run — for free</h1>
        <p className="lead">
          Every night the fleet re-runs every extractor in the library as a Nebius Serverless Job. A healthy run is plain JavaScript: <strong>zero tokens</strong>. Only when a website redesign breaks an extractor does Nemotron step in — to tell a real menu change from broken code, and to heal it.
        </p>
      </header>

      <div className="fleet-top">
        <Panel title="Run the fleet now" className="fleet-run">
          <div className="fleet-controls">
            {fleet.running ? (
              <button type="button" className="btn btn-lg btn-secondary" onClick={fleet.stop}>
                Stop watching
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-lg btn-primary"
                onClick={() => {
                  setSelected(null);
                  void fleet.run({ heal });
                }}
              >
                Run fleet now
              </button>
            )}
            <label className="switch">
              <input type="checkbox" role="switch" checked={heal} onChange={(e) => setHeal(e.target.checked)} disabled={fleet.running} />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
              <span>
                Self-heal broken extractors
                <span className="small muted block">Nemotron rewrites code that a redesign broke</span>
              </span>
            </label>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {fleet.running ? 'Fleet run in progress' : fleet.report ? `Fleet run finished: ${fleet.report.totals.extractors} extractors` : ''}
          </p>
          {fleet.error && <ErrorNote>{fleet.error}</ErrorNote>}
          {(fleet.running || fleet.log.length > 0) && <LiveLog lines={fleet.log} running={fleet.running} startedAt={fleet.startedAt} />}
        </Panel>

        <RedesignDemo disabled={fleet.running} />
      </div>

      {shown ? (
        <ReportView report={shown} live={isLive} />
      ) : history.loading ? (
        <Spinner label="Loading fleet history…" />
      ) : (
        !fleet.running && (
          <Empty title="No fleet runs yet">
            <p>Run the fleet to re-scrape every extractor in the library. If the library is empty, forge one first.</p>
          </Empty>
        )
      )}

      {past.length > 0 && (
        <Panel title="Past runs" subtitle="Each run re-scrapes the whole library; most nights cost nothing.">
          <ul className="runs">
            {past.map((r, i) => {
              const active = shown?.startedAt === r.startedAt;
              return (
                <li key={r.startedAt}>
                  <button type="button" className={`run-row ${active ? 'is-active' : ''}`} aria-pressed={active} onClick={() => setSelected(i === 0 && !fleet.report ? null : r.startedAt)}>
                    <span className="run-when">
                      <span>{relative(r.startedAt)}</span>
                      <span className="small muted">{date(r.startedAt)}</span>
                    </span>
                    <span className="run-mini">
                      <MiniCount n={r.totals.stable} status="stable" />
                      <MiniCount n={r.totals.changed} status="changed" />
                      <MiniCount n={r.totals.healed} status="healed" />
                      <MiniCount n={r.totals.broken + r.totals.error} status="broken" />
                    </span>
                    <span className="run-cost num">
                      <strong className={r.totals.costUsd === 0 ? 'pass-text' : ''}>{usd(r.totals.costUsd, 2)}</strong>
                      <span className="small muted">
                        {plural(r.totals.extractors, 'extractor')} · {duration(r.totals.ms)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      {history.error && <ErrorNote>Couldn't load fleet history: {history.error}</ErrorNote>}
    </div>
  );
}

function MiniCount({ n, status }: { n: number; status: FleetStatus }) {
  return (
    <span className={`mini mini-${status} ${n === 0 ? 'is-zero' : ''}`} title={`${n} ${status}`}>
      <span className="mini-dot" aria-hidden="true" />
      <span className="num">{n}</span>
      <span className="sr-only">{status}</span>
    </span>
  );
}

function LiveLog({ lines, running, startedAt }: { lines: FleetController['log']; running: boolean; startedAt: number }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className="live-log">
      <div className="live-log-head">
        {running ? <StateIcon state="running" size={14} /> : <StateIcon state="done" size={14} />}
        <span className="small">{running ? 'Running…' : 'Last run'}</span>
      </div>
      <ol className="log log-terminal" ref={ref} aria-label="Fleet log">
        {lines.map((l) => (
          <li key={l.id} className={`tone-${l.tone}`}>
            <span className="log-time num">+{duration(l.at - startedAt)}</span>
            <span className="log-text">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReportView({ report, live }: { report: FleetReport; live: boolean }) {
  const t = report.totals;
  const freeRuns = report.entries.filter((e) => e.costUsd === 0).length;
  const [open, setOpen] = useState<Set<string>>(() => new Set(report.entries.filter((e) => e.changes.length > 0 && e.changes.length <= 6).map((e) => e.id)));
  useEffect(() => {
    setOpen(new Set(report.entries.filter((e) => e.changes.length > 0 && e.changes.length <= 6).map((e) => e.id)));
  }, [report]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="report" aria-label="Fleet report">
      <div className="report-head">
        <h2 className="h2">
          {live ? 'This run' : 'Run'} · <span className="muted">{date(report.startedAt)}</span>
        </h2>
        <span className="small muted num">took {duration(t.ms)}</span>
      </div>

      <div className={`cost-callout ${t.costUsd === 0 ? 'is-free' : ''}`}>
        {t.costUsd === 0 ? (
          <>
            <span className="cost-big num">$0.00</span>
            <span>
              for <strong>{plural(t.extractors, 're-run')}</strong> — no model was called. The extractors did all the work.
            </span>
          </>
        ) : (
          <>
            <span className="cost-big num">{usd(t.costUsd)}</span>
            <span>
              spent only where needed — {t.healed > 0 ? `healing ${plural(t.healed, 'extractor')}` : 'checking suspicious changes'}. {freeRuns > 0 && `The other ${plural(freeRuns, 're-run')} cost nothing.`}
            </span>
          </>
        )}
      </div>

      <div className="kpis kpis-7">
        <Kpi label="Extractors" value={int(t.extractors)} />
        <Kpi label="Stable" value={int(t.stable)} tone="pass" />
        <Kpi label="Menu changed" value={int(t.changed)} tone="info" />
        <Kpi label="Healed" value={int(t.healed)} tone="accent" />
        <Kpi label="Broken" value={int(t.broken + t.error)} tone={t.broken + t.error ? 'fail' : undefined} hint={t.error ? `${t.error} errored` : undefined} />
        <Kpi label="Tokens" value={int(t.tokens)} />
        <Kpi label="Cost" value={usd(t.costUsd, t.costUsd === 0 ? 2 : 4)} tone={t.costUsd === 0 ? 'pass' : 'accent'} />
      </div>

      {report.entries.length === 0 ? (
        <Empty title="Nothing to re-run">
          <p>The library is empty — forge an extractor first.</p>
          <a className="btn btn-primary" href={href.forge}>
            Open the Live Forge
          </a>
        </Empty>
      ) : (
        <div className="table-wrap card">
          <table className="table fleet-table">
            <thead>
              <tr>
                <th scope="col">Extractor</th>
                <th scope="col">Status</th>
                <th scope="col" className="right">
                  Dishes
                </th>
                <th scope="col" className="right hide-sm">
                  Version
                </th>
                <th scope="col" className="right hide-sm">
                  Time
                </th>
                <th scope="col" className="right">
                  Cost
                </th>
                <th scope="col" className="hide-md">
                  Detail
                </th>
                <th scope="col">
                  <span className="sr-only">Changes</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {report.entries.map((e) => (
                <EntryRow key={e.id} e={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EntryRow({ e, open, onToggle }: { e: FleetEntry; open: boolean; onToggle: () => void }) {
  const delta = e.items - e.baselineItems;
  return (
    <Fragment>
      <tr className={`entry entry-${e.status}`}>
        <td>
          <a href={href.extractor(e.id)} className="entry-name">
            {e.restaurant || e.domain}
          </a>
          <div className="small muted">{e.domain}</div>
          <div className="small muted show-md">{e.detail}</div>
        </td>
        <td>
          <span className={`pill pill-${e.status}`}>
            <span className="pill-dot" aria-hidden="true" />
            {e.status}
          </span>
        </td>
        <td className="right num nowrap">
          {int(e.items)}
          {delta !== 0 && e.baselineItems > 0 && <span className="delta muted"> {delta > 0 ? `+${delta}` : delta}</span>}
        </td>
        <td className="right num hide-sm">v{e.version}</td>
        <td className="right num nowrap hide-sm">{duration(e.ms)}</td>
        <td className={`right num ${e.costUsd === 0 ? 'muted' : ''}`}>{usd(e.costUsd)}</td>
        <td className="hide-md detail-cell">{e.detail}</td>
        <td className="right">
          {e.changes.length > 0 && (
            <button type="button" className="btn btn-ghost btn-xs nowrap" aria-expanded={open} onClick={onToggle}>
              {plural(e.changes.length, 'change')} {open ? '▴' : '▾'}
            </button>
          )}
        </td>
      </tr>
      {open && e.changes.length > 0 && (
        <tr className="changes-row">
          <td colSpan={8}>
            <ChangesList changes={e.changes} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function ChangesList({ changes }: { changes: PriceChange[] }) {
  return (
    <ul className="changes">
      {changes.map((c, i) => {
        if (c.kind === 'price') {
          const o = c.oldPrice ?? null;
          const n = c.newPrice ?? null;
          const up = o != null && n != null && n > o;
          const p = o && n != null ? ((n - o) / o) * 100 : null;
          return (
            <li key={i}>
              <span className="change-name">
                {c.name}
                {c.section && <span className="muted"> · {c.section}</span>}
              </span>
              <span className="num change-price">
                <span className="muted">{price(o)}</span> → <strong>{price(n)}</strong>
                <span className={`delta ${up ? 'up' : 'down'}`}>
                  {up ? '▲' : '▼'} {p != null ? `${Math.abs(p).toFixed(1)}%` : ''}
                </span>
              </span>
            </li>
          );
        }
        return (
          <li key={i}>
            <span className="change-name">
              <Badge tone={c.kind === 'added' ? 'pass' : 'fail'}>{c.kind === 'added' ? 'new' : 'removed'}</Badge> {c.name}
              {c.section && <span className="muted"> · {c.section}</span>}
            </span>
            <span className="num change-price">{price(c.kind === 'added' ? c.newPrice : c.oldPrice)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RedesignDemo({ disabled }: { disabled: boolean }) {
  const { data, error, loading, setData } = useLoad(api.fixtures);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const flip = async (f: Fixture) => {
    setBusy(f.slug);
    setErr(null);
    try {
      const r = await api.redesign(f.slug, !f.redesigned);
      setData((xs) => (xs ? xs.map((x) => ({ ...x, redesigned: r.redesigned.includes(x.slug) })) : xs));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Demo: simulate a website redesign" className="redesign">
      <ol className="steps-inline small">
        <li>Flip a restaurant to its redesigned site.</li>
        <li>Run the fleet.</li>
        <li>Watch the agent notice its extractor broke — and heal its own code.</li>
      </ol>
      {loading && !data && <Spinner label="Loading demo sites…" />}
      {(error || err) && <ErrorNote>{error || err}</ErrorNote>}
      {data && data.length === 0 && <p className="small muted">No demo sites are installed on this server.</p>}
      {data && data.length > 0 && (
        <ul className="fixture-list">
          {data.map((f) => (
            <li key={f.slug}>
              <div className="fixture-name">
                <span>{f.restaurant || f.slug}</span>
                <span className="small muted">
                  {!f.platform || f.platform === 'unknown' ? 'custom site' : f.platform}
                  {f.items != null && ` · ${f.items} dishes`}
                </span>
              </div>
              <label className="switch switch-sm">
                <input type="checkbox" role="switch" checked={f.redesigned} disabled={disabled || busy === f.slug} onChange={() => void flip(f)} aria-label={`${f.restaurant || f.slug}: redesigned website`} />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                <span className={`small ${f.redesigned ? 'accent-text' : 'muted'}`}>{f.redesigned ? 'Redesigned' : 'Original'}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
