import type { Score } from '../api.ts';
import { price, score as fmtScore } from '../format.ts';

export function Bar({ label, value, pass }: { label: string; value: number; pass?: boolean }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={v} aria-label={label}>
        <span className={`bar-fill ${pass === undefined ? '' : pass ? 'is-pass' : 'is-fail'}`} style={{ width: `${v * 100}%` }} />
      </span>
      <span className="bar-value num">{fmtScore(v)}</span>
    </div>
  );
}

export function ScoreBars({ score }: { score: Pick<Score, 'precision' | 'recall' | 'f1'> & { pass?: boolean } }) {
  return (
    <div className="bars">
      <Bar label="Precision" value={score.precision} pass={score.pass} />
      <Bar label="Recall" value={score.recall} pass={score.pass} />
      <Bar label="F1" value={score.f1} pass={score.pass} />
    </div>
  );
}

const CAP = 12;

export function ScoreDetails({ score }: { score: Score }) {
  const { missing, wrongPrice, extra } = score;
  if (!missing.length && !wrongPrice.length && !extra.length) {
    return <p className="small muted">Every dish the oracle read was found with the right price.</p>;
  }
  return (
    <div className="score-lists">
      {missing.length > 0 && (
        <div>
          <h4 className="list-title">
            Missing <span className="count">{missing.length}</span>
          </h4>
          <ul className="mini-list">
            {missing.slice(0, CAP).map((m, i) => (
              <li key={i}>
                <span>{m.name}</span>
                <span className="num muted">{price(m.price)}</span>
              </li>
            ))}
            {missing.length > CAP && <li className="muted">+{missing.length - CAP} more</li>}
          </ul>
        </div>
      )}
      {wrongPrice.length > 0 && (
        <div>
          <h4 className="list-title">
            Wrong price <span className="count">{wrongPrice.length}</span>
          </h4>
          <ul className="mini-list">
            {wrongPrice.slice(0, CAP).map((w, i) => (
              <li key={i}>
                <span>{w.name}</span>
                <span className="num">
                  <span className="fail-text">{price(w.got)}</span>
                  <span className="muted"> → {price(w.expected)}</span>
                </span>
              </li>
            ))}
            {wrongPrice.length > CAP && <li className="muted">+{wrongPrice.length - CAP} more</li>}
          </ul>
        </div>
      )}
      {extra.length > 0 && (
        <div>
          <h4 className="list-title">
            Extra <span className="count">{extra.length}</span>
          </h4>
          <ul className="mini-list">
            {extra.slice(0, CAP).map((m, i) => (
              <li key={i}>
                <span>{m.name}</span>
                <span className="num muted">{price(m.price)}</span>
              </li>
            ))}
            {extra.length > CAP && <li className="muted">+{extra.length - CAP} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
