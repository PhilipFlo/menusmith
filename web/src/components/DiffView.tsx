import { useMemo, useState } from 'react';
import { diffLines, diffStats, type DiffLine } from '../diff.ts';

type Row = { type: 'line'; line: DiffLine } | { type: 'gap'; count: number; from: number };

const CONTEXT = 3;

export function DiffView({ oldCode, newCode, oldLabel, newLabel }: { oldCode: string; newCode: string; oldLabel: string; newLabel: string }) {
  const lines = useMemo(() => diffLines(oldCode, newCode), [oldCode, newCode]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const rows = useMemo<Row[]>(() => {
    // Keep CONTEXT lines around each change; collapse longer unchanged runs.
    const keep = new Array<boolean>(lines.length).fill(false);
    lines.forEach((l, i) => {
      if (l.kind !== 'same') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true;
    });
    const out: Row[] = [];
    let i = 0;
    while (i < lines.length) {
      if (keep[i] || expanded.has(i)) {
        out.push({ type: 'line', line: lines[i]! });
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && !keep[j]) j++;
      if (j - i <= 2) {
        for (let k = i; k < j; k++) out.push({ type: 'line', line: lines[k]! });
      } else {
        out.push({ type: 'gap', count: j - i, from: i });
      }
      i = j;
    }
    return out;
  }, [lines, expanded]);

  const expand = (from: number, count: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      for (let k = from; k < from + count; k++) n.add(k);
      return n;
    });

  return (
    <div className="code diff">
      <div className="code-bar">
        <span className="code-label">
          {oldLabel} → {newLabel}
        </span>
        <span className="code-meta num">
          <span className="diff-add-count">+{stats.added}</span> <span className="diff-del-count">−{stats.removed}</span>
        </span>
      </div>
      {stats.added === 0 && stats.removed === 0 ? (
        <p className="diff-identical">The two versions are identical.</p>
      ) : (
        <pre className="code-body" style={{ maxHeight: 560 }} tabIndex={0} aria-label={`Diff: ${stats.added} lines added, ${stats.removed} removed`}>
          <code>
            {rows.map((r, idx) =>
              r.type === 'gap' ? (
                <button type="button" key={`g${idx}`} className="diff-gap" onClick={() => expand(r.from, r.count)}>
                  ⋯ {r.count} unchanged lines — show
                </button>
              ) : (
                <span key={idx} className={`code-line diff-${r.line.kind}`}>
                  <span className="ln" aria-hidden="true">
                    {r.line.a ?? ''}
                  </span>
                  <span className="ln" aria-hidden="true">
                    {r.line.b ?? ''}
                  </span>
                  <span className="diff-sign" aria-hidden="true">
                    {r.line.kind === 'add' ? '+' : r.line.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="lc">{r.line.text || ' '}</span>
                </span>
              ),
            )}
          </code>
        </pre>
      )}
    </div>
  );
}
