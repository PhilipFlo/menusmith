import { api, type Health, type Measured } from '../api.ts';
import { ModelChip, Panel } from '../components/ui.tsx';
import { useLoad } from '../controllers.ts';
import { href } from '../router.ts';

const ROUTING = [
  { role: 'triage', label: 'Triage & arbitration', fallback: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', job: 'Pick the menu page; rule on items the code and the reading disagree about', why: 'Called many times per site — cheapest and fastest', price: '$0.06 · $0.24' },
  { role: 'oracle', label: 'Oracle', fallback: 'nvidia/nemotron-3-super-120b-a12b', job: 'Read a whole menu page into structured dishes and prices', why: 'Long context and careful reading at a mid-tier price', price: '$0.30 · $0.90' },
  { role: 'forge', label: 'Forge & repair', fallback: 'nvidia/nemotron-3-super-120b-a12b', job: 'Write the extractor, then fix it from test feedback (reasoning on)', why: 'Solves most sites in one or two rounds at a third of the price', price: '$0.30 · $0.90' },
  { role: 'escalate', label: 'Escalation', fallback: 'nvidia/Nemotron-3-Ultra-550b-a55b', job: 'Take over repairs that Super could not fix in two rounds', why: 'Strongest reasoning, spent only on the hard cases', price: '$1.00 · $3.00' },
  { role: 'vision', label: 'Vision', fallback: 'nvidia/Nemotron-3.5-Super-VL', job: 'Read menus published as images (PDF menus are read from their text layer by Super)', why: "For menus that aren't text at all", price: '$0.30 · $0.90' },
] as const;

const SANDBOX = [
  { t: 'Separate process', d: 'Every extractor runs in its own short-lived Node process, killed with SIGKILL at a wall-clock deadline.' },
  { t: 'Empty environment', d: 'The child starts with env = {} — API keys and secrets are simply not there to steal.' },
  { t: 'Node permission model', d: 'Run with --permission: no file writes, no child processes, no workers; reads limited to the harness and its libraries.' },
  { t: 'CPU & memory limits', d: '256 MB heap cap, a CPU timeout inside the vm context, and a cap on output size.' },
  { t: 'No string code-gen', d: '--disallow-code-generation-from-strings: eval and new Function are off, so the code is exactly what was reviewed.' },
  { t: 'Checked, not trusted', d: 'Code that hard-codes dishes from the page is rejected, and a second run must give identical output before commit.' },
];

const SERVICES = [
  { t: 'Nebius Token Factory', d: 'Serves every NVIDIA Nemotron model Menusmith calls, through one OpenAI-compatible API, with per-call token and cost accounting.', tag: 'Inference' },
  { t: 'Nebius AI Cloud Serverless', d: 'Deployment scripts for an Endpoint (this app, full image with the headless browser) and a Job (the nightly fleet). This public demo runs on a free host with the slim image; the fleet runs as a scheduled job.', tag: 'Hosting' },
  { t: 'Tavily', d: 'Finds the official website from a restaurant name, and maps the site to locate the menu page.', tag: 'Search' },
];

export function AboutPage({ health }: { health: Health | null }) {
  const bench = useLoad(api.bench);
  const measured = useLoad(api.measured);
  return (
    <div className="about">
      <header className="page-head">
        <p className="eyebrow">How it works</p>
        <h1>Use the model to write code — not to scrape</h1>
        <p className="lead">
          Asking an LLM to read every menu every night is slow, costly and non-deterministic. Menusmith uses NVIDIA Nemotron <em>once</em> per website to write a tiny, deterministic extractor, proves it against the model's own reading, and keeps it. The price index then runs on plain code — and the agent only comes back when a website changes.
        </p>
      </header>

      <Panel title="The loop">
        <LoopDiagram />
        <LoopList />
        <div className="legend small">
          <span>
            <span className="legend-swatch is-llm" /> calls a Nemotron model
          </span>
          <span>
            <span className="legend-swatch is-det" /> deterministic code — zero tokens
          </span>
        </div>
      </Panel>

      <div className="about-grid">
        <Panel title="Model routing" subtitle="The cheapest Nemotron that can do each job well, each with a fallback chain.">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Model</th>
                  <th scope="col">Job</th>
                  <th scope="col" className="right nowrap">
                    $ / 1M tok in · out
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROUTING.map((r) => (
                  <tr key={r.role}>
                    <th scope="row" className="nowrap">
                      {r.label}
                    </th>
                    <td>
                      <ModelChip model={health?.models[r.role] ?? r.fallback} />
                    </td>
                    <td>
                      {r.job}
                      <div className="small muted">{r.why}</div>
                    </td>
                    <td className="right num nowrap">{r.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Why it's cheap" subtitle="Cost per restaurant over a year of nightly scrapes.">
          <div className="compare">
            <div className="compare-row">
              <span>LLM reads the menu every night</span>
              <span className="compare-bar">
                <span className="compare-fill is-bad" style={{ width: '100%' }} />
              </span>
              <span className="num">365 calls</span>
            </div>
            <div className="compare-row">
              <span>Menusmith</span>
              <span className="compare-bar">
                <span className="compare-fill is-good" style={{ width: '2%' }} />
              </span>
              <span className="num">~3 calls</span>
            </div>
            <p className="small muted">One oracle read + a few forge rounds, once. Every re-run after that is a sandboxed JavaScript function: milliseconds, deterministic, and $0. Sites on the same platform often reuse an existing extractor for zero tokens.</p>
          </div>
        </Panel>
      </div>

      <Panel title="Sandbox security model" subtitle="Model-written code is untrusted code. It runs with nothing to reach.">
        <ul className="cards">
          {SANDBOX.map((s) => (
            <li key={s.t} className="mini-card">
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Built on">
        <ul className="cards cards-4">
          {SERVICES.map((s) => (
            <li key={s.t} className="mini-card">
              <span className="tag">{s.tag}</span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ul>
      </Panel>

      {measured.data != null && <MeasuredView m={measured.data} />}
      {bench.data != null && <BenchView data={bench.data} />}

      <div className="cta-row">
        <a className="btn btn-primary btn-lg" href={href.forge}>
          Try the Live Forge
        </a>
        <a className="btn btn-secondary btn-lg" href={href.fleet}>
          Watch the fleet self-heal
        </a>
      </div>
    </div>
  );
}

function Node({ x, y, w = 150, title, sub, kind }: { x: number; y: number; w?: number; title: string; sub: string; kind: 'llm' | 'det' | 'out' }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect className={`dg-box dg-${kind}`} width={w} height={64} rx={12} />
      <text className="dg-title" x={w / 2} y={27} textAnchor="middle">
        {title}
      </text>
      <text className="dg-sub" x={w / 2} y={46} textAnchor="middle">
        {sub}
      </text>
    </g>
  );
}

function LoopDiagram() {
  return (
    <svg className="diagram" viewBox="0 -14 892 300" role="img" aria-labelledby="dg-title dg-desc">
      <title id="dg-title">The Menusmith loop</title>
      <desc id="dg-desc">
        Discover the site, read the menu with Nemotron 3 Super, write an extractor with Nemotron 3 Super (escalating to Nemotron 3 Ultra when repairs stall), run it in a sandbox, and test it. Failures loop back to repair. A passing extractor is committed to the library; the nightly fleet re-runs it for free and, when a redesign breaks it, sends it back to be healed.
      </desc>
      <defs>
        <marker id="dg-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="dg-head" />
        </marker>
        <marker id="dg-arrow-accent" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="dg-head-accent" />
        </marker>
      </defs>

      {/* Row 1 */}
      <Node x={20} y={30} title="Discover" sub="Tavily · Nemotron 3 Nano" kind="llm" />
      <Node x={195} y={30} title="Read the menu" sub="Nemotron 3 Super" kind="llm" />
      <Node x={370} y={30} title="Write code" sub="Super → Ultra" kind="llm" />
      <Node x={545} y={30} title="Run" sub="isolated sandbox" kind="det" />
      <Node x={720} y={30} title="Test" sub="precision · recall · F1" kind="det" />

      <path className="dg-arrow" d="M170 62H193" markerEnd="url(#dg-arrow)" />
      <path className="dg-arrow" d="M345 62H368" markerEnd="url(#dg-arrow)" />
      <path className="dg-arrow" d="M520 62H543" markerEnd="url(#dg-arrow)" />
      <path className="dg-arrow" d="M695 62H718" markerEnd="url(#dg-arrow)" />

      {/* Repair loop */}
      <path className="dg-arrow dg-accent" d="M765 94C765 150 480 150 480 96" markerEnd="url(#dg-arrow-accent)" />
      <text className="dg-label dg-label-accent" x={622} y={152} textAnchor="middle">
        fail → repair with feedback
      </text>

      {/* Pass → commit */}
      <path className="dg-arrow dg-pass" d="M835 94V208" markerEnd="url(#dg-arrow)" />
      <text className="dg-label" x={828} y={168} textAnchor="end">
        pass
      </text>

      {/* Row 2 */}
      <Node x={720} y={210} title="Commit" sub="versioned in the library" kind="det" />
      <Node x={420} y={210} w={200} title="Nightly fleet" sub="re-run all · $0 · scheduled job" kind="det" />
      <Node x={20} y={210} w={210} title="Price index" sub="dishes & prices over time" kind="out" />

      <path className="dg-arrow" d="M718 242H622" markerEnd="url(#dg-arrow)" />
      <path className="dg-arrow" d="M418 242H232" markerEnd="url(#dg-arrow)" />
      <text className="dg-label" x={325} y={232} textAnchor="middle">
        changes, ▲▼ prices
      </text>

      {/* Drift → heal */}
      <path className="dg-arrow dg-accent" d="M445 208V96" markerEnd="url(#dg-arrow-accent)" />
      <text className="dg-label dg-label-accent" x={438} y={176} textAnchor="end">
        redesign breaks it
      </text>
      <text className="dg-label dg-label-accent" x={438} y={192} textAnchor="end">
        → self-heal
      </text>

      {/* Reuse */}
      <path className="dg-arrow dg-dashed" d="M270 30V12H878V242H873" markerEnd="url(#dg-arrow)" />
      <text className="dg-label" x={575} y={4} textAnchor="middle">
        same platform? adopt a library extractor — 0 tokens
      </text>
    </svg>
  );
}

function LoopList() {
  const steps = [
    ['Discover', 'Tavily finds the site; Nemotron 3 Nano picks the menu page.', 'llm'],
    ['Read the menu', 'Nemotron 3 Super reads every dish — the oracle.', 'llm'],
    ['Reuse?', 'A same-platform extractor from the library may already work — 0 tokens.', 'det'],
    ['Write code', 'Nemotron 3 Super writes a deterministic extractor; Ultra takes over if repairs stall.', 'llm'],
    ['Run & test', 'Sandboxed run, scored on precision, recall and F1. Fail → repair.', 'det'],
    ['Commit', 'The passing extractor is versioned in the library.', 'det'],
    ['Nightly fleet', 'Re-runs everything for $0. A redesign that breaks code triggers self-heal.', 'det'],
  ] as const;
  return (
    <ol className="loop-list">
      {steps.map(([t, d, k]) => (
        <li key={t} className={`is-${k}`}>
          <strong>{t}</strong>
          <span>{d}</span>
        </li>
      ))}
    </ol>
  );
}

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** The focused benchmarks: each one tests a single claim (see bench/*.ts). */
function MeasuredView({ m }: { m: Measured }) {
  const tiles: [string, string, string][] = [];
  const v = m.variance;
  if (v) tiles.push(['Same page, read 3×', `LLM identical on ${v.llmAllThreeIdentical}/${v.sites} · extractor ${v.extractorIdentical}/${v.sites}`, `Dish counts from the LLM moved by a median ${Math.round(Number(v.medianLlmCountSpreadPct))}% between readings of the identical page.${m.varianceT0 ? ` At temperature 0: still identical on only ${m.varianceT0.llmAllThreeIdentical}/${m.varianceT0.sites}.` : ''}`]);
  const h = m.heal;
  if (h) tiles.push(['Website redesigns healed', `${h.healed}/${h.sites} · F1 ${Number(h.avgF1AfterRedesign).toFixed(2)} vs. truth`, `Each fixture site was redesigned (new markup, real price changes); median repair $${Number(h.medianHealCostUsd).toFixed(3)} in ${Math.round(Number(h.medianHealSeconds))} s.`]);
  const c = m.coverage;
  if (c && typeof c.removal2 === 'object' && typeof c.weekly2 === 'object') {
    const ok = (k: string) => {
      const r = c[k];
      return typeof r === 'object' && r ? `${r.correctAfter}/${r.cases}` : '—';
    };
    tiles.push(['Silent dish loss caught', `${ok('removal2')} today · ${ok('weekly2')} weekly`, `Working extractors made to quietly drop 2 dishes; 5 dishes: ${ok('weekly5')}.${typeof c.shrinkRecordedNotRewritten === 'object' && c.shrinkRecordedNotRewritten ? ` Real menu shrinks recorded without a rewrite: ${(c.shrinkRecordedNotRewritten as unknown as { correct: number; cases: number }).correct}/${(c.shrinkRecordedNotRewritten as unknown as { cases: number }).cases}.` : ''}${m.falseAlarms ? ` False alarms on healthy real sites: ${m.falseAlarms.flagged}/${m.falseAlarms.healthyExtractorsChecked}.` : ''}`]);
  }
  const t = m.tavilyHoldout ?? m.tavily;
  if (t) tiles.push(['Name → official website', `${t.matchRate}% (${t.matched}/${t.sites})`, 'Tavily search plus brand/city/country ranking, on restaurants not used for tuning.']);
  const p = m.precision;
  if (p) tiles.push(['Precision vs. nearBite, explained', `${p.avgPrecision} · ${Math.round(Number(p.pctSectionNearBiteDoesNotHave))}% of misses are sections nearBite lacks`, `Of the dishes counted against precision: ${Math.round(Number(p.pctSectionNearBiteDoesNotHave))}% are from menu sections nearBite never stored, ${Math.round(Number(p.pctRepriced))}% re-priced, ${Math.round(Number(p.pctUnexplained))}% unexplained.`]);
  if (!tiles.length) return null;
  return (
    <Panel title="Measured" subtitle="Each claim has its own benchmark in bench/ — numbers are read from bench/results, not typed by hand.">
      <dl className="facts facts-grid">
        {tiles.map(([k, val, hint]) => (
          <div key={k} title={hint}>
            <dt>{k}</dt>
            <dd className="num">{val}</dd>
            <dd className="small muted">{hint}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function BenchView({ data }: { data: unknown }) {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { summary?: Record<string, unknown>; rows?: unknown };
  const sm = (d.summary && typeof d.summary === 'object' ? d.summary : {}) as Record<string, unknown>;
  const rescue = (sm.rescue && typeof sm.rescue === 'object' ? sm.rescue : {}) as Record<string, unknown>;
  const byMode = (rescue.byMode && typeof rescue.byMode === 'object' ? rescue.byMode : {}) as Record<string, unknown>;
  if (typeof sm.sites === 'number' && Array.isArray(d.rows)) {
    const rowsR = d.rows as Record<string, unknown>[];
    const tiles: [string, string][] = [
      ['Working extractor, from the homepage', String(rescue.successFromHomepageIncludingRescue ?? '—')],
      ['…from the stored menu link alone', `${sm.succeeded}/${sm.sites} (${sm.successRate}%)`],
      ['Pass on the first attempt', `${sm.firstTryPassRate}% of written extractors`],
      ['Average F1 vs. the reading', String(sm.avgF1Oracle)],
      ['Deterministic re-runs', `${sm.deterministicRate}% (${sm.deterministicMeasured ?? ''})`],
      ['Median re-run', `${sm.medianRerunMs} ms · $0`],
      ['PDF / image menus read', `${Number(sm.pdfMenus ?? 0) + Number(byMode['document (rescue)'] ?? 0)} / ${Number(sm.imageMenus ?? 0) + Number(byMode['vision (rescue)'] ?? 0)}`],
    ];
    const label = (r: Record<string, unknown>) =>
      r.ok ? `${r.mode}${r.sourceKind ? ' · ' + r.sourceKind : ''}` : (r.rescue as { ok?: boolean; mode?: string } | undefined)?.ok ? `rescued · ${(r.rescue as { mode?: string }).mode}` : String(r.category ?? 'failed');
    return (
      <Panel title="Benchmark — 120 real restaurant websites" subtitle="Benchmark run of Oct 23, 2026 across Oslo and Palo Alto, plus a homepage rescue pass. Failures are listed, not hidden.">
        <dl className="facts facts-grid">
          {tiles.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="table table-compact">
            <thead>
              <tr>
                <th scope="col">Restaurant</th>
                <th scope="col">City</th>
                <th scope="col">Result</th>
                <th scope="col" className="right">Rounds</th>
                <th scope="col" className="right">Dishes</th>
                <th scope="col" className="right">One-time cost</th>
              </tr>
            </thead>
            <tbody>
              {rowsR.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.name ?? '')}</td>
                  <td>{String(r.city ?? '')}</td>
                  <td className={r.ok || (r.rescue as { ok?: boolean } | undefined)?.ok ? 'pass-text' : 'muted'}>{label(r)}</td>
                  <td className="num right">{r.ok ? String(r.rounds ?? '') : ''}</td>
                  <td className="num right">{r.ok ? String(r.extracted ?? '') : ''}</td>
                  <td className="num right">{typeof r.costUsd === 'number' ? `$${(r.costUsd as number).toFixed(4)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    );
  }
  const summary = Object.entries(sm);
  const rows = Array.isArray(d.rows) ? (d.rows.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]) : [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 10);
  if (!summary.length && !rows.length) return null;
  return (
    <Panel title="Benchmark" subtitle="Latest results from the benchmark suite.">
      {summary.length > 0 && (
        <dl className="facts facts-grid">
          {summary.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{renderValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 480 }}>
          <table className="table table-compact">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c} className={typeof r[c] === 'number' ? 'num right' : ''}>
                      {renderValue(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
