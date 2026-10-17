import { useMemo, useState, type ReactNode } from 'react';
import { highlightLines } from '../highlight.ts';

export function CodeViewer({ code, label, toolbar, maxHeight = 520 }: { code: string; label?: string; toolbar?: ReactNode; maxHeight?: number }) {
  const lines = useMemo(() => highlightLines(code), [code]);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="code">
      <div className="code-bar">
        <span className="code-label">{label ?? 'extractor.js'}</span>
        <span className="code-meta num">{lines.length} lines</span>
        <div className="code-tools">
          {toolbar}
          <button type="button" className="btn btn-ghost btn-xs" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className="code-body" style={{ maxHeight }} tabIndex={0} aria-label={`${label ?? 'Code'}, ${lines.length} lines`}>
        <code>
          {lines.map((toks, i) => (
            <span className="code-line" key={i}>
              <span className="ln" aria-hidden="true">
                {i + 1}
              </span>
              <span className="lc">
                {toks.length === 0 ? ' ' : toks.map((t, j) => (t.type === 'space' || t.type === 'punct' || t.type === 'ident' ? t.text : <span key={j} className={`tk-${t.type}`}>{t.text}</span>))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
