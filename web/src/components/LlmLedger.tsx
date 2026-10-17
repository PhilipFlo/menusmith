import type { LlmCall } from '../forgeRun.ts';
import { duration, int, usd } from '../format.ts';
import { ModelChip } from './ui.tsx';

export function LlmLedger({ calls }: { calls: LlmCall[] }) {
  if (!calls.length) return <p className="small muted">No model calls yet.</p>;
  const tot = calls.reduce(
    (a, c) => ({ p: a.p + c.promptTokens, c: a.c + c.completionTokens, cost: a.cost + c.costUsd, ms: a.ms + c.ms }),
    { p: 0, c: 0, cost: 0, ms: 0 },
  );
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Model</th>
            <th scope="col" className="right">
              Tokens in / out
            </th>
            <th scope="col" className="right">
              Cost
            </th>
            <th scope="col" className="right">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={i} className="row-enter">
              <td className="nowrap">{c.role}</td>
              <td>
                <ModelChip model={c.model} />
              </td>
              <td className="right num nowrap">
                {int(c.promptTokens)} <span className="muted">/</span> {int(c.completionTokens)}
              </td>
              <td className="right num">{usd(c.costUsd)}</td>
              <td className="right num nowrap">{duration(c.ms)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              {calls.length} {calls.length === 1 ? 'call' : 'calls'}
            </th>
            <td className="right num nowrap">
              {int(tot.p)} <span className="muted">/</span> {int(tot.c)}
            </td>
            <td className="right num strong">{usd(tot.cost)}</td>
            <td className="right num nowrap">{duration(tot.ms)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
