import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, type Fixture, type Health } from '../api.ts';
import { CodeViewer } from '../components/CodeViewer.tsx';
import { ItemsTable } from '../components/ItemsTable.tsx';
import { LlmLedger } from '../components/LlmLedger.tsx';
import { Pipeline } from '../components/Pipeline.tsx';
import { ScoreBars, ScoreDetails } from '../components/ScoreBars.tsx';
import { Badge, ErrorNote, Panel, PlatformBadge, StateIcon } from '../components/ui.tsx';
import type { ForgeController } from '../controllers.ts';
import { bestTest, isReasoning, STEP_INFO, upcomingSteps, type ForgeState } from '../forgeRun.ts';
import { duration, int, plural, score as fmtScore, usd } from '../format.ts';
import { href } from '../router.ts';

/** Real restaurant sites for the quick-pick row. */
const EXAMPLE_SITES: { label: string; url: string }[] = [
  { label: 'Damaskus Huset · Oslo', url: 'https://semeny.no/sted/634damaskushusetrestaurant' },
  { label: 'Pizzabakeren · Oslo', url: 'https://www.pizzabakeren.no/glutenfri' },
  { label: 'Pele Pele · PDF menu', url: 'https://pelepele.no/wp-content/uploads/2025/09/PelePele-Menu.pdf' },
  { label: 'Listen to Delhi · image menu', url: 'https://listentodelhi.no/' },
];

const NAME_EXAMPLE = { label: 'Just a name: “Alex Sushi, Oslo” · Tavily', name: 'Alex Sushi', city: 'Oslo' };

function toRequest(raw: string, city: string) {
  const v = raw.trim();
  if (/^(https?|fixture):\/\//i.test(v)) return { url: v };
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return { url: `https://${v}` };
  return { restaurant: v, city: city.trim() || undefined };
}

export function ForgePage({ forge, health }: { forge: ForgeController; health: Health | null }) {
  const { state, start, cancel } = forge;
  const [value, setValue] = useState('');
  const [city, setCity] = useState('');
  const [noReuse, setNoReuse] = useState(false);
  const [fixtures, setFixtures] = useState<Fixture[] | null>(null);
  const inputId = useId();
  const cityId = useId();
  const running = state.phase === 'running';
  const isUrl = /^(https?|fixture):\/\//i.test(value.trim()) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value.trim());

  useEffect(() => {
    api
      .fixtures()
      .then(setFixtures)
      .catch(() => setFixtures([]));
  }, []);

  const go = (raw: string) => {
    if (!raw.trim() || running) return;
    void start({ ...toRequest(raw, city), noReuse: noReuse || undefined });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(value);
  };
  const pick = (url: string) => {
    setValue(url);
    go(url);
  };
  /** Start from just a name: Tavily finds the official website, then the agents take over. */
  const pickName = (name: string, inCity: string) => {
    if (running) return;
    setValue(name);
    setCity(inCity);
    void start({ restaurant: name, city: inCity, noReuse: noReuse || undefined });
  };

  return (
    <div className="forge-page">
      <section className="hero">
        <p className="eyebrow">Live Forge</p>
        <h1 className="hero-title">
          Agents that write the scraper <em>once</em> — so the price index runs forever.
        </h1>
        <p className="hero-sub">
          Point Menusmith at a restaurant. Nemotron reads the menu, writes a small deterministic extractor for that one site, tests it against its own reading, repairs it until it passes, and commits it. Every re-scrape after that costs <strong>zero tokens</strong>.
        </p>

        <form className="forge-form card" onSubmit={onSubmit} aria-label="Forge an extractor">
          <div className="forge-fields">
            <div className="field field-grow">
              <label htmlFor={inputId}>Restaurant website or name</label>
              <input
                id={inputId}
                className="input input-lg"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste a menu URL, or type a restaurant name"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={running}
              />
            </div>
            <div className={`field field-city ${isUrl ? 'is-dim' : ''}`}>
              <label htmlFor={cityId}>
                City <span className="muted">(optional)</span>
              </label>
              <input id={cityId} className="input input-lg" type="text" placeholder="Oslo" value={city} onChange={(e) => setCity(e.target.value)} disabled={running || isUrl} />
            </div>
            <div className="field field-action">
              {running ? (
                <button type="button" className="btn btn-lg btn-secondary" onClick={cancel}>
                  Cancel
                </button>
              ) : (
                <button type="submit" className="btn btn-lg btn-primary" disabled={!value.trim()}>
                  <ForgeIcon /> Forge
                </button>
              )}
            </div>
          </div>
          <div className="forge-options">
            <label className="check">
              <input type="checkbox" checked={noReuse} onChange={(e) => setNoReuse(e.target.checked)} disabled={running} />
              <span>Always write fresh code (skip library reuse)</span>
            </label>
          </div>
          <div className="chips-block">
            <span className="chips-label">Demo restaurants</span>
            <div className="chips">
              {fixtures === null && <span className="chip chip-skeleton" aria-hidden="true" />}
              {fixtures?.length === 0 && <span className="small muted">No demo sites found on the server.</span>}
              {fixtures?.map((f) => (
                <button type="button" key={f.slug} className="chip" onClick={() => pick(f.url)} disabled={running} title={f.url}>
                  <span>{f.restaurant || f.slug}</span>
                  {f.platform && f.platform !== 'unknown' && <span className="chip-meta">{f.platform}</span>}
                  {f.redesigned && <span className="chip-flag">redesigned</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="chips-block">
            <span className="chips-label">Real websites</span>
            <div className="chips">
              {EXAMPLE_SITES.map((s) => (
                <button type="button" key={s.url} className="chip chip-outline" onClick={() => pick(s.url)} disabled={running} title={s.url}>
                  {s.label}
                </button>
              ))}
              <button type="button" className="chip chip-outline" onClick={() => pickName(NAME_EXAMPLE.name, NAME_EXAMPLE.city)} disabled={running} title="No URL — Tavily search finds the official website">
                {NAME_EXAMPLE.label}
              </button>
            </div>
          </div>
        </form>
        {health && health.llmMode === 'replay' && <p className="small muted hero-note">Replay mode: model calls are served from recorded cassettes.</p>}
        {health && health.browser && health.slowBrowser && (
          <p className="small muted hero-note">
            Menus that only appear after JavaScript runs are rendered in a real headless browser. On this free server (0.1 CPU) that step alone can take
            2–4 minutes — the steps below keep updating while it works. The first request after a quiet spell also takes a minute to wake the server.
          </p>
        )}
        {health && health.browser === false && (
          <p className="small muted hero-note">
            This free-tier demo runs without a headless browser: menus in the page HTML, menu PDFs and menu images all work; menus that only appear after
            JavaScript runs need the full build (see the repo). The first request after a quiet spell can take a minute while the server wakes up.
          </p>
        )}
      </section>

      <LiveStatus state={state} />

      {state.phase !== 'idle' ? <RunView state={state} /> : <IdleExplainer />}
    </div>
  );
}

function ForgeIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M3 9h11.5c1 0 1.8.8 1.8 1.8S15.5 12.5 14.5 12.5H13l-1.3 2H13v1.8H6.5v-1.8h1.3L6.5 12.5H6c-1.7 0-3-1.3-3-3z" fill="currentColor" />
      <path d="M12 2.5l.8 2 2-.8-.8 2 2 .8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LiveStatus({ state }: { state: ForgeState }) {
  let text = '';
  if (state.phase === 'running') {
    const cur = [...state.steps].reverse().find((s) => s.state === 'running');
    text = cur ? `Working: ${STEP_INFO[cur.step]?.label ?? cur.step}${cur.detail ? ` — ${cur.detail}` : ''}` : 'Starting the agent…';
  } else if (state.phase === 'success') {
    text = `Done: extractor ${state.result?.meta?.id ?? ''} v${state.result?.meta?.version ?? ''} committed.`;
  } else if (state.phase === 'failed') {
    text = `Stopped: ${state.summary?.reason || state.result?.reason || state.error || 'the agent did not finish'}`;
  }
  return (
    <p className="sr-only" aria-live="polite" role="status">
      {text}
    </p>
  );
}

function IdleExplainer() {
  const items = [
    { n: '1', t: 'Read', d: 'Nemotron 3 Super reads the menu page once into structured dishes — the oracle.' },
    { n: '2', t: 'Write', d: 'Nemotron 3 Super writes a ~50-line JavaScript extractor for this one site (Ultra takes over if it gets stuck).' },
    { n: '3', t: 'Test & repair', d: 'The code runs in a locked-down sandbox and is scored on precision, recall and F1 until it passes.' },
    { n: '4', t: 'Run forever', d: 'The extractor is committed to the library. The nightly fleet re-runs it for $0 and heals it if the site changes.' },
  ];
  return (
    <section className="explainer" aria-label="How a forge works">
      {items.map((i) => (
        <div key={i.n} className="explainer-item">
          <span className="explainer-n num">{i.n}</span>
          <div>
            <h3>{i.t}</h3>
            <p>{i.d}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

function RunView({ state }: { state: ForgeState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state.phase !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [state.phase]);

  const upcoming = upcomingSteps(state);
  const reasoning = state.logs.filter((l) => isReasoning(l.message));
  const activity = state.logs.filter((l) => !isReasoning(l.message));
  const elapsed = (state.endedAt ?? now) - state.startedAt;
  const cost = state.llm.reduce((a, c) => a + c.costUsd, 0);
  const tokens = state.llm.reduce((a, c) => a + c.promptTokens + c.completionTokens, 0);
  const target = state.input?.url || [state.input?.restaurant, state.input?.city].filter(Boolean).join(', ');

  return (
    <div className="run">
      <div className="run-meta">
        <span className="run-target" title={target}>
          {target}
        </span>
        <span className="run-stats num">
          <span>{duration(elapsed)}</span>
          <span>{int(tokens)} tokens</span>
          <span>{usd(cost)}</span>
        </span>
      </div>
      <div className="run-grid">
        <aside className="run-side">
          <Panel title="Pipeline" className="pipeline-panel">
            <Pipeline steps={state.steps} upcoming={upcoming} now={now} />
          </Panel>
        </aside>
        <div className="run-main">
          {state.phase === 'success' && <SuccessCard state={state} />}
          {state.phase === 'failed' && <FailureCard state={state} />}
          {(state.code.length > 0 || state.tests.length > 0) && <Rounds state={state} />}
          <Panel title="LLM calls" subtitle="Every model call, routed to the cheapest Nemotron that can do the job.">
            <LlmLedger calls={state.llm} />
          </Panel>
          {state.oracle && (
            <details className="panel collapsible" open={state.phase === 'running' && state.code.length === 0}>
              <summary>
                <span className="panel-title">Oracle reading</span>
                <span className="muted small">Nemotron 3 Super read {plural(state.oracle.length, 'dish', 'dishes')} — the answer key the code is tested against</span>
              </summary>
              <ItemsTable items={state.oracle} maxHeight={340} caption="Dishes read by the oracle" />
            </details>
          )}
          {reasoning.length > 0 && (
            <details className="panel collapsible">
              <summary>
                <span className="panel-title">Agent thinking</span>
                <span className="muted small">{plural(reasoning.length, 'note')} from the code-writing model's reasoning</span>
              </summary>
              <ol className="thinking">
                {reasoning.map((r, i) => (
                  <li key={i}>{r.message.replace(/^Reasoning:\s*/, '')}</li>
                ))}
              </ol>
            </details>
          )}
          {activity.length > 0 && (
            <details className="panel collapsible">
              <summary>
                <span className="panel-title">Activity log</span>
                <span className="muted small">{plural(activity.length, 'line')}</span>
              </summary>
              <ol className="log">
                {activity.map((l, i) => (
                  <li key={i}>
                    <span className="log-time num">+{duration(l.at - state.startedAt)}</span>
                    <span>{l.message}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessCard({ state }: { state: ForgeState }) {
  const meta = state.result?.meta;
  const items = state.result?.items ?? [];
  const s = state.summary;
  const rounds = s?.rounds ?? meta?.rounds ?? 0;
  const cost = s?.costUsd ?? meta?.costUsd ?? 0;
  const reused = s?.mode === 'reused' || !!meta?.reusedFrom;
  return (
    <section className="result-card is-success" aria-label="Result">
      <div className="result-head">
        <StateIcon state="done" size={28} />
        <div>
          <h2 className="result-title">
            Extractor v{meta?.version ?? 1} committed
            {reused && (
              <Badge tone="info" title="Adopted from another site on the same platform">
                reused
              </Badge>
            )}
          </h2>
          <p className="result-line num">
            <strong>{plural(items.length || meta?.baselineCount || 0, 'dish', 'dishes')}</strong>
            <span className="sep">·</span>
            {plural(rounds, 'round')}
            <span className="sep">·</span>
            <strong>{usd(cost)}</strong> once
            <span className="sep">·</span>
            <strong className="pass-text">$0.0000</strong> per re-run forever
          </p>
          {reused && meta?.reusedFrom && (
            <p className="small muted">
              Adopted <a href={href.extractor(meta.reusedFrom)}>{meta.reusedFrom}</a> from the library — no code was generated.
            </p>
          )}
        </div>
        {meta && (
          <a className="btn btn-secondary result-open" href={href.extractor(meta.id)}>
            Open in library →
          </a>
        )}
      </div>
      {meta && (
        <div className="result-metrics">
          <ScoreBars score={{ ...meta.score, pass: true }} />
          <dl className="facts">
            <div>
              <dt>Platform</dt>
              <dd>
                <PlatformBadge platform={meta.platform} />
              </dd>
            </div>
            <div>
              <dt>Oracle / extracted</dt>
              <dd className="num">
                {meta.score.oracleCount} / {meta.score.extractorCount}
              </dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd className="num">{int(s?.tokens ?? meta.tokens.prompt + meta.tokens.completion)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd className="num">{duration(s?.ms ?? (state.endedAt ?? 0) - state.startedAt)}</dd>
            </div>
          </dl>
        </div>
      )}
      {items.length > 0 && <ItemsTable items={items} caption="Dishes extracted by the committed extractor" />}
    </section>
  );
}

/** Plain-language "why, and what to try next" for the common ways a forge stops. */
function nextStep(reason: string): string | null {
  if (/HTTP 40[1356]|HTTP 429|blocked|bot protection/i.test(reason))
    return 'This website blocks automated visitors. Menusmith respects that and does not try to get around it — try another restaurant.';
  if (/no menu with dishes found|too few menu items|menu images could not be read/i.test(reason))
    return 'No menu with prices was found on this website. Many chains only show prices inside a location-specific ordering app (pick a store, then order) — try a single restaurant’s own site, the URL of the page that lists dishes and prices, or just type the name and city.';
  if (/could not load|timed out|unreachable|ENOTFOUND|HTTP 404|HTTP 5\d\d/i.test(reason))
    return 'The website could not be loaded right now. Check the address, or try again in a minute.';
  if (/no passing extractor/i.test(reason))
    return 'The agent wrote code that extracts most of the menu (below), but it did not agree closely enough with Nemotron’s own reading to be trusted, so nothing was committed.';
  if (/time budget|request timed out|code generation failed|oracle failed|rate.?limit|HTTP 50\d|overloaded/i.test(reason))
    return 'The AI service (NVIDIA Nemotron on Nebius Token Factory) was slow to answer just now — please try again in a minute.';
  if (/budget|busy|too many/i.test(reason)) return 'The public demo is rate-limited to keep it free — try again in a little while.';
  return null;
}

function FailureCard({ state }: { state: ForgeState }) {
  const reason = state.summary?.reason || state.result?.reason || state.error || 'The agent stopped before finishing.';
  const best = bestTest(state.tests);
  const keyHint = /api key|401|unauthor|NEBIUS/i.test(reason + (state.error ?? ''));
  const hint = keyHint ? null : nextStep(reason);
  const draft = state.result?.items ?? [];
  return (
    <section className="result-card is-fail" aria-label="Result">
      <div className="result-head">
        <StateIcon state="fail" size={28} />
        <div>
          <h2 className="result-title">No extractor committed</h2>
          <p className="result-reason">{reason}</p>
          {hint && <p className="small">{hint}</p>}
          {state.error && state.error !== reason && <ErrorNote>{state.error}</ErrorNote>}
          {keyHint && (
            <p className="small muted">
              The forge needs Nemotron on Nebius Token Factory — add <code>NEBIUS_API_KEY</code> to <code>.env</code> and restart the server.
            </p>
          )}
        </div>
      </div>
      {best && (
        <div className="best-attempt">
          <h3 className="h3">
            Best attempt — round {best.round}, F1 {fmtScore(best.score.f1)}
          </h3>
          <ScoreBars score={best.score} />
          <p className="small muted">Open round {best.round} below to see its code and what it missed.</p>
        </div>
      )}
      {draft.length > 0 && <ItemsTable items={draft} caption="Best attempt — not committed (shown for transparency)" />}
    </section>
  );
}

function Rounds({ state }: { state: ForgeState }) {
  const rounds = useMemo(() => {
    const set = new Set<number>([...state.code.map((c) => c.round), ...state.tests.map((t) => t.round)]);
    return [...set].sort((a, b) => a - b);
  }, [state.code, state.tests]);
  const [picked, setPicked] = useState<number | null>(null);
  const latest = rounds[rounds.length - 1] ?? 1;
  const selected = picked !== null && rounds.includes(picked) ? picked : latest;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  // Follow the newest round while running, unless the user picked one.
  useEffect(() => {
    if (state.phase === 'running') setPicked(null);
  }, [rounds.length, state.phase]);

  const code = state.code.find((c) => c.round === selected);
  const test = state.tests.find((t) => t.round === selected);

  const onKey = (e: KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight') next = Math.min(rounds.length - 1, idx + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rounds.length - 1;
    else return;
    e.preventDefault();
    setPicked(rounds[next] ?? null);
    tabRefs.current[next]?.focus();
  };

  return (
    <Panel title="Rounds" subtitle="Each round: Nemotron writes code (Super, or Ultra after an escalation), the sandbox runs it, the score decides.">
      <div className="tabs" role="tablist" aria-label="Rounds">
        {rounds.map((r, i) => {
          const t = state.tests.find((x) => x.round === r);
          const pass = t?.score.pass;
          return (
            <button
              key={r}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${r}`}
              aria-controls={`${baseId}-panel`}
              aria-selected={r === selected}
              tabIndex={r === selected ? 0 : -1}
              className={`tab ${r === selected ? 'is-active' : ''}`}
              onClick={() => setPicked(r)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <StateIcon state={t ? (pass ? 'done' : 'fail') : 'running'} size={14} />
              Round {r}
              {t && <span className="tab-meta num">F1 {fmtScore(t.score.f1)}</span>}
            </button>
          );
        })}
      </div>
      <div className="round-body" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${selected}`}>
        <div className="round-test">
          {test ? (
            <>
              <div className="round-verdict">
                {test.score.pass ? <Badge tone="pass">Pass</Badge> : <Badge tone="fail">Fail</Badge>}
                <span className="small muted num">
                  {test.run.ok ? `ran in ${duration(test.run.ms)} · ${plural(test.run.count, 'item')} · ${test.score.matched}/${test.score.oracleCount} matched` : `run failed: ${test.run.error ?? 'unknown error'}`}
                </span>
              </div>
              <ScoreBars score={test.score} />
              <ScoreDetails score={test.score} />
              {test.run.trace && test.run.trace.length > 0 && !test.score.pass && (
                <details className="trace">
                  <summary>Debugger — what each selector matched on the real page</summary>
                  <pre className="trace-lines">{test.run.trace.join('\n')}</pre>
                </details>
              )}
            </>
          ) : (
            <p className="small muted">
              <StateIcon state="running" size={14} /> Testing in the sandbox…
            </p>
          )}
        </div>
        {code ? <CodeViewer code={code.code} label={`extractor · round ${code.round}`} maxHeight={460} /> : <p className="small muted">No code in this round's reply.</p>}
      </div>
    </Panel>
  );
}
