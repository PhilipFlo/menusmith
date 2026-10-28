import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, type AgentEvent, type FleetReport, type ForgeSummary } from './api.ts';
import { forgeReducer, initialForgeState, STEP_INFO } from './forgeRun.ts';
import { duration, int, modelName, usd } from './format.ts';
import { parseData, postSse } from './sse.ts';

const AGENT_EVENTS = new Set(['step', 'log', 'llm', 'code', 'test', 'oracle', 'result', 'error']);

export interface ForgeRequest {
  url?: string;
  restaurant?: string;
  city?: string;
  noReuse?: boolean;
  /** Forge even when the restaurant is already in the library. */
  fresh?: boolean;
}

/** Owns the live forge run — lives in App so it survives navigating between screens. */
export function useForgeController() {
  const [state, dispatch] = useReducer(forgeReducer, initialForgeState);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (req: ForgeRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ kind: 'start', input: { url: req.url, restaurant: req.restaurant, city: req.city }, at: Date.now() });
    try {
      await postSse(
        '/api/forge',
        req,
        (m) => {
          if (m.event === 'summary') {
            const s = parseData<ForgeSummary>(m);
            if (s) dispatch({ kind: 'summary', summary: s, at: Date.now() });
          } else if (AGENT_EVENTS.has(m.event)) {
            const e = parseData<AgentEvent>(m);
            if (e) dispatch({ kind: 'event', event: e, at: Date.now() });
          }
        },
        ac.signal,
      );
      dispatch({ kind: 'end', at: Date.now() });
    } catch (e) {
      const err = e as Error;
      dispatch({ kind: 'fatal', message: err.name === 'AbortError' ? 'Cancelled.' : err.message || 'Network error', at: Date.now() });
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, start, cancel };
}
export type ForgeController = ReturnType<typeof useForgeController>;

// ---- Fleet ----------------------------------------------------------------------

export interface FleetLogLine {
  id: number;
  at: number;
  tone: 'info' | 'pass' | 'fail' | 'warn' | 'accent' | 'muted';
  text: string;
}

function describe(e: AgentEvent): Omit<FleetLogLine, 'id' | 'at'> | null {
  switch (e.type) {
    case 'log': {
      if (e.message.startsWith('Reasoning:')) return { tone: 'muted', text: `  thinking: ${e.message.slice(10).trim().slice(0, 220)}${e.message.length > 230 ? '…' : ''}` };
      const m = /\]\s*[^:]+:\s*(stable|changed|healed|review|broken|error)\b/.exec(e.message);
      const tone = m ? ({ stable: 'pass', changed: 'info', healed: 'accent', review: 'info', broken: 'fail', error: 'fail' } as const)[m[1] as 'stable'] : 'info';
      return { tone, text: e.message };
    }
    case 'step': {
      const label = STEP_INFO[e.step]?.label ?? e.step;
      const tone = e.status === 'fail' ? 'fail' : e.status === 'done' ? 'pass' : e.status === 'skip' ? 'muted' : 'warn';
      return { tone, text: `  ${label} ${e.status === 'start' ? '…' : `· ${e.status}`}${e.detail ? ` — ${e.detail}` : ''}` };
    }
    case 'llm':
      return { tone: 'muted', text: `  ${modelName(e.model)} (${e.role}) · ${int(e.promptTokens + e.completionTokens)} tokens · ${usd(e.costUsd)} · ${duration(e.ms)}` };
    case 'code':
      return { tone: 'muted', text: `  wrote extractor round ${e.round} (${e.code.split('\n').length} lines)` };
    case 'test':
      return { tone: e.score.pass ? 'pass' : 'fail', text: `  test round ${e.round}: F1 ${e.score.f1.toFixed(2)} — ${e.score.pass ? 'pass' : 'not yet'}` };
    case 'oracle':
      return { tone: 'muted', text: `  oracle read ${e.items.length} dishes` };
    case 'result':
      return e.ok ? { tone: 'accent', text: `  committed ${e.meta?.id ?? ''} v${e.meta?.version ?? '?'}` } : { tone: 'fail', text: `  ${e.reason ?? 'failed'}` };
    case 'error':
      return { tone: 'fail', text: e.message };
  }
}

export function useFleetController() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<FleetLogLine[]>([]);
  const [report, setReport] = useState<FleetReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const add = (l: Omit<FleetLogLine, 'id' | 'at'>) => setLog((xs) => [...xs, { ...l, id: seq.current++, at: Date.now() }]);

  const run = useCallback(async (opts: { heal: boolean; only?: string[] }) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setError(null);
    setReport(null);
    setLog([]);
    setStartedAt(Date.now());
    add({ tone: 'info', text: `Fleet run started${opts.heal ? ' — self-heal on' : ' — self-heal off'}` });
    let got = false;
    try {
      await postSse(
        '/api/fleet/run',
        opts,
        (m) => {
          if (m.event === 'report') {
            const r = parseData<FleetReport>(m);
            if (r) {
              got = true;
              setReport(r);
              add({ tone: 'pass', text: `Done in ${duration(r.totals.ms)} — ${r.totals.extractors} extractors, ${usd(r.totals.costUsd)} spent` });
            }
          } else if (AGENT_EVENTS.has(m.event)) {
            const e = parseData<AgentEvent>(m);
            const d = e && describe(e);
            if (d) add(d);
            if (e?.type === 'error') setError(e.message);
          }
        },
        ac.signal,
      );
      if (!got) setError((prev) => prev ?? 'The fleet run ended without a report.');
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'AbortError' ? 'Stopped watching the run (it may continue on the server).' : err.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  return { running, log, report, error, startedAt, run, stop };
}
export type FleetController = ReturnType<typeof useFleetController>;

// ---- Simple data loading -------------------------------------------------------

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
