import type { AgentEvent, ExtractorMeta, ForgeSummary, MenuItem, Score } from './api.ts';
import type { StepState } from './components/ui.tsx';

/**
 * Folds the forge SSE stream into UI state. Step events are turned into a timeline
 * of step *instances* (forge → test → repair → test … can repeat), with timings.
 */

export const PIPELINE = ['discover', 'fetch', 'locate', 'oracle', 'reuse', 'forge', 'test', 'repair', 'commit'] as const;

export const STEP_INFO: Record<string, { label: string; blurb: string }> = {
  discover: { label: 'Discover', blurb: 'Find the official website (Tavily search)' },
  fetch: { label: 'Fetch', blurb: 'Download the page' },
  locate: { label: 'Locate menu', blurb: 'Map the site, Nemotron 3 Nano triages links' },
  oracle: { label: 'Read the menu', blurb: 'Nemotron 3 Super reads every dish — the oracle' },
  reuse: { label: 'Reuse', blurb: 'Try same-platform extractors from the library (0 tokens)' },
  render: { label: 'Render', blurb: 'Headless browser: rendered page, captured menu API, or menu images' },
  vision: { label: 'Read images', blurb: 'Nemotron 3.5 Super VL reads menu pictures; fingerprints make re-runs free' },
  forge: { label: 'Forge', blurb: 'Nemotron 3 Super writes a deterministic extractor (Ultra if repairs stall)' },
  test: { label: 'Test', blurb: 'Run in the sandbox, score against the oracle' },
  repair: { label: 'Repair', blurb: 'Feed failures back, rewrite the code' },
  commit: { label: 'Commit', blurb: 'Save the extractor to the library' },
};

export interface StepRow {
  key: number;
  step: string;
  state: Exclude<StepState, 'pending'>;
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

export type LlmCall = Extract<AgentEvent, { type: 'llm' }> & { at: number };
export type TestRound = Extract<AgentEvent, { type: 'test' }>;
export interface CodeRound {
  round: number;
  version: number;
  code: string;
}

export interface ForgeState {
  phase: 'idle' | 'running' | 'success' | 'failed';
  input: { url?: string; restaurant?: string; city?: string } | null;
  startedAt: number;
  endedAt?: number;
  steps: StepRow[];
  logs: { at: number; message: string }[];
  llm: LlmCall[];
  code: CodeRound[];
  tests: TestRound[];
  oracle: MenuItem[] | null;
  result: { ok: boolean; meta?: ExtractorMeta; items?: MenuItem[]; reason?: string } | null;
  summary: ForgeSummary | null;
  error: string | null;
  seq: number;
}

export const initialForgeState: ForgeState = {
  phase: 'idle',
  input: null,
  startedAt: 0,
  steps: [],
  logs: [],
  llm: [],
  code: [],
  tests: [],
  oracle: null,
  result: null,
  summary: null,
  error: null,
  seq: 0,
};

export type ForgeAction =
  | { kind: 'start'; input: NonNullable<ForgeState['input']>; at: number }
  | { kind: 'event'; event: AgentEvent; at: number }
  | { kind: 'summary'; summary: ForgeSummary; at: number }
  | { kind: 'fatal'; message: string; at: number }
  | { kind: 'end'; at: number };

const closeRunning = (steps: StepRow[], at: number, state: StepRow['state'] = 'done'): StepRow[] =>
  steps.map((s) => (s.state === 'running' ? { ...s, state, endedAt: at } : s));

function applyStep(s: ForgeState, e: Extract<AgentEvent, { type: 'step' }>, at: number): ForgeState {
  let steps = s.steps;
  let seq = s.seq;
  if (e.status === 'start') {
    steps = [...closeRunning(steps, at), { key: seq++, step: e.step, state: 'running', detail: e.detail, startedAt: at }];
  } else {
    const state = e.status === 'done' ? 'done' : e.status === 'fail' ? 'fail' : 'skip';
    const idx = findLastIndex(steps, (r) => r.step === e.step && r.state === 'running');
    if (idx >= 0) {
      steps = steps.map((r, i) => (i === idx ? { ...r, state, detail: e.detail ?? r.detail, endedAt: at } : r));
    } else {
      // A step that only reports its outcome (e.g. "commit") — close whatever was running and record it.
      const prevEnd = steps.length ? (steps[steps.length - 1]!.endedAt ?? at) : at;
      steps = [...closeRunning(steps, at), { key: seq++, step: e.step, state, detail: e.detail, startedAt: Math.min(prevEnd, at), endedAt: at }];
    }
  }
  return { ...s, steps, seq };
}

export function forgeReducer(s: ForgeState, a: ForgeAction): ForgeState {
  switch (a.kind) {
    case 'start':
      return { ...initialForgeState, phase: 'running', input: a.input, startedAt: a.at, seq: s.seq + 1000 };
    case 'fatal':
      return { ...s, phase: 'failed', error: a.message, steps: closeRunning(s.steps, a.at, 'fail'), endedAt: a.at };
    case 'summary': {
      const ok = a.summary.ok;
      return { ...s, summary: a.summary, phase: ok ? 'success' : 'failed', steps: closeRunning(s.steps, a.at, ok ? 'done' : 'fail'), endedAt: a.at };
    }
    case 'end':
      if (s.phase !== 'running') return s;
      // Stream ended without a summary.
      return {
        ...s,
        phase: s.result?.ok ? 'success' : 'failed',
        error: s.result || s.error ? s.error : 'The connection closed before the agent finished.',
        steps: closeRunning(s.steps, a.at, s.result?.ok ? 'done' : 'fail'),
        endedAt: a.at,
      };
    case 'event': {
      const e = a.event;
      switch (e.type) {
        case 'step':
          return applyStep(s, e, a.at);
        case 'log':
          return { ...s, logs: [...s.logs, { at: a.at, message: e.message }] };
        case 'llm':
          return { ...s, llm: [...s.llm, { ...e, at: a.at }] };
        case 'code': {
          // The forge/repair step is done once code arrives; the test step starts now.
          const forgeIdx = findLastIndex(s.steps, (r) => (r.step === 'forge' || r.step === 'repair') && r.state === 'running');
          let steps = s.steps;
          let seq = s.seq;
          if (forgeIdx >= 0) {
            const lines = e.code.split('\n').length;
            steps = steps.map((r, i) => (i === forgeIdx ? { ...r, state: 'done', endedAt: a.at, detail: `${r.detail ? `${r.detail} — ` : ''}${lines} lines of JavaScript` } : r));
            steps = [...steps, { key: seq++, step: 'test', state: 'running', detail: 'Running in the sandbox…', startedAt: a.at }];
          }
          return { ...s, steps, seq, code: [...s.code.filter((c) => c.round !== e.round), { round: e.round, version: e.version, code: e.code }] };
        }
        case 'test':
          return { ...s, tests: [...s.tests.filter((t) => t.round !== e.round), e] };
        case 'oracle':
          return { ...s, oracle: e.items };
        case 'result':
          return { ...s, result: { ok: e.ok, meta: e.meta, items: e.items, reason: e.reason } };
        case 'error':
          return { ...s, error: e.message };
        default:
          return s;
      }
    }
  }
}

function findLastIndex<T>(arr: T[], fn: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i]!)) return i;
  return -1;
}

/** Canonical steps not reached yet — shown as ghosts while running. */
export function upcomingSteps(s: ForgeState): string[] {
  if (s.phase !== 'running') return [];
  const order: string[] = [...PIPELINE];
  const seen = s.steps.map((r) => order.indexOf(r.step)).filter((i) => i >= 0);
  const max = seen.length ? Math.max(...seen) : -1;
  return order.filter((step, i) => {
    if (i <= max) return false;
    if (step === 'repair') return false; // only appears when needed
    if (step === 'discover' && (s.input?.url || seen.length)) return false;
    return true;
  });
}

export function bestTest(tests: TestRound[]): TestRound | null {
  let best: TestRound | null = null;
  for (const t of tests) if (!best || t.score.f1 > best.score.f1) best = t;
  return best;
}

export function isReasoning(message: string) {
  return message.startsWith('Reasoning:');
}

export type { Score };
