import { STEP_INFO, type StepRow } from '../forgeRun.ts';
import { duration } from '../format.ts';
import { StateIcon } from './ui.tsx';

export function Pipeline({ steps, upcoming, now }: { steps: StepRow[]; upcoming: string[]; now: number }) {
  // Number forge/repair/test instances so repeated rounds read clearly.
  let testN = 0;
  let repairN = 0;
  return (
    <ol className="pipeline" aria-label="Agent pipeline">
      {steps.map((r) => {
        const info = STEP_INFO[r.step] ?? { label: r.step, blurb: '' };
        let label = info.label;
        if (r.step === 'test') label = `${info.label} · round ${++testN}`;
        if (r.step === 'repair') label = `${info.label} ${++repairN}`;
        const ms = (r.endedAt ?? now) - r.startedAt;
        return (
          <li key={r.key} className={`pipe-step is-${r.state}`}>
            <span className="pipe-rail" aria-hidden="true" />
            <StateIcon state={r.state} />
            <div className="pipe-body">
              <div className="pipe-head">
                <span className="pipe-label">{label}</span>
                <span className="pipe-time num">{r.state === 'skip' ? 'skipped' : ms > 30 || r.state === 'running' ? duration(ms) : ''}</span>
              </div>
              <div className="pipe-detail">{r.detail || info.blurb}</div>
            </div>
          </li>
        );
      })}
      {upcoming.map((step) => {
        const info = STEP_INFO[step] ?? { label: step, blurb: '' };
        return (
          <li key={`ghost-${step}`} className="pipe-step is-pending">
            <span className="pipe-rail" aria-hidden="true" />
            <StateIcon state="pending" />
            <div className="pipe-body">
              <div className="pipe-head">
                <span className="pipe-label">{info.label}</span>
              </div>
              <div className="pipe-detail">{info.blurb}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
