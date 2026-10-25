import { useState } from 'react';
import { api, type CheckResult, type ExtractorMeta } from '../api.ts';
import { int, price, relative, usd } from '../format.ts';
import { ChangesList } from '../pages/FleetPage.tsx';
import { Panel } from './ui.tsx';

const VERDICT: Record<string, string> = {
  stable: 'Same menu as last time — the saved code still works.',
  changed: 'The restaurant changed its menu — the changes below were recorded.',
  healed: 'The saved code was missing part of the menu, so Nemotron rewrote it — the dishes below are now extracted.',
  review: 'Something looks off — kept the last good data and flagged it for review.',
  broken: 'The saved code no longer works on this website.',
  error: 'The check could not run (site unreachable or a temporary problem).',
};

/**
 * Re-check one restaurant: re-run its saved code ($0), or compare it with a fresh
 * Nemotron reading of the page to catch dishes the code silently misses.
 */
export function RecheckPanel({ meta, onDone }: { meta: ExtractorMeta; onDone: () => void }) {
  const [busy, setBusy] = useState<null | 'rescrape' | 'audit'>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isFile = meta.source?.kind === 'image' || meta.source?.kind === 'document';

  async function run(kind: 'rescrape' | 'audit') {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const r = kind === 'rescrape' ? await api.rescrape(meta.id) : await api.audit(meta.id);
      setResult(r);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const e = result?.entry;
  const a = e?.audit;
  return (
    <Panel
      title="Re-check this menu"
      subtitle={
        isFile
          ? 'This menu is a picture or a PDF: a re-check compares the file fingerprint and only asks the model again if the file changed.'
          : 'Re-scraping runs the saved code against the live website — no model, $0. The Nemotron check also reads the page fresh and compares, to catch dishes the code silently misses.'
      }
    >
      <div className="recheck-actions">
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void run('rescrape')}>
          {busy === 'rescrape' ? 'Re-scraping…' : 'Re-scrape now · $0'}
        </button>
        {!isFile && (
          <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void run('audit')}>
            {busy === 'audit' ? 'Nemotron is reading the page…' : 'Check against Nemotron · ~$0.003'}
          </button>
        )}
        {meta.lastAudit && (
          <span className="small muted">
            Last Nemotron check {relative(meta.lastAudit.at)}: {meta.lastAudit.pass ? 'all dishes caught' : `${meta.lastAudit.missing} dish(es) missed`} (recall {meta.lastAudit.recall})
          </span>
        )}
      </div>
      <div aria-live="polite">
        {error && <p className="fail-text small">{error}</p>}
        {e && (
          <div className="recheck-result">
            <p>
              <span className={`pill pill-${e.status}`}>
                <span className="pill-dot" aria-hidden="true" />
                {e.status}
              </span>{' '}
              {VERDICT[e.status] ?? ''}
              {e.status === 'review' && !a && !isFile && ' Run the Nemotron check to find out whether the restaurant removed them or the code is missing them.'}
            </p>
            <p className="small muted">
              {e.detail} · {int(e.items)} dishes · {(e.ms / 1000).toFixed(1)} s · {e.costUsd > 0 ? `${usd(e.costUsd)} in model calls` : 'no model calls'}
            </p>
            {a && (
              <div className="recheck-audit">
                <h4 className="list-title">
                  Compared with a fresh Nemotron reading: {a.pass ? 'the code catches the whole menu' : e.status === 'healed' ? 'the old code missed dishes' : 'the code misses dishes'}
                </h4>
                <p className="small">
                  {int(Math.round(a.recall * a.oracleCount))} of {int(a.oracleCount)} dishes on the page were extracted (recall {a.recall}, precision {a.precision}).
                </p>
                {!!a.stillOnPage?.length && (
                  <p className="small fail-text">
                    Not a menu change: {a.stillOnPage.join(', ')} dropped out of the output but {a.stillOnPage.length === 1 ? 'is' : 'are'} still on the page — the code
                    is at fault, so it was {e.status === 'healed' ? 'rewritten' : 'flagged for repair'}.
                  </p>
                )}
                {a.missing.length > 0 && (
                  <ul className="mini-list">
                    {a.missing.slice(0, 12).map((m, i) => (
                      <li key={i}>
                        <span>
                          Missed: {m.name}
                          {m.section ? <span className="muted"> · {m.section}</span> : null}
                        </span>
                        <span className="num muted">{price(m.price)}</span>
                      </li>
                    ))}
                    {a.missing.length > 12 && <li className="muted">+{a.missing.length - 12} more</li>}
                  </ul>
                )}
                {a.wrongPrice.length > 0 && (
                  <ul className="mini-list">
                    {a.wrongPrice.slice(0, 8).map((w, i) => (
                      <li key={i}>
                        <span>Price differs: {w.name}</span>
                        <span className="num">
                          <span className="fail-text">{price(w.got)}</span>
                          <span className="muted"> → {price(w.expected)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {e.changes.length > 0 && <ChangesList changes={e.changes} />}
          </div>
        )}
      </div>
    </Panel>
  );
}
