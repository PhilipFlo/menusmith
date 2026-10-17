/**
 * A tiny JavaScript tokenizer for syntax highlighting — good enough for the
 * extractor functions Menusmith writes (cheerio code), no dependencies.
 */

export type TokenType = 'comment' | 'string' | 'regex' | 'number' | 'keyword' | 'literal' | 'fn' | 'prop' | 'ident' | 'punct' | 'space';

export interface Token {
  type: TokenType;
  text: string;
}

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield', 'from',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
/** After these keywords a "/" starts a regex, not a division. */
const REGEX_AFTER_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

const isIdStart = (c: string) => /[A-Za-z_$À-￿]/.test(c);
const isId = (c: string) => /[A-Za-z0-9_$À-￿]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  /** Last non-space token, for regex-vs-division and property detection. */
  let prev: Token | null = null;
  const push = (type: TokenType, text: string) => {
    const t = { type, text };
    out.push(t);
    if (type !== 'space' && type !== 'comment') prev = t;
  };
  const regexAllowed = () => {
    const p = prev as Token | null;
    if (!p) return true;
    if (p.type === 'keyword') return REGEX_AFTER_KEYWORDS.has(p.text);
    if (p.type === 'punct') return !/^[)\]}]$/.test(p.text);
    return false;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1;
      while (j < n && /[ \t\n\r]/.test(src[j]!)) j++;
      push('space', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && next === '/') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      j = Math.min(n, j + 1);
      push('string', src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/.test(src[j]!)) j++;
        push('regex', src.slice(i, j));
        i = j;
        continue;
      }
    }
    if (isDigit(c) || (c === '.' && next !== undefined && isDigit(next))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObBn_.eE]/.test(src[j]!)) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '-' || src[j + 1] === '+')) j++;
        j++;
      }
      push('number', src.slice(i, j));
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(src[j]!)) j++;
      const word = src.slice(i, j);
      const p = prev as Token | null;
      const afterDot = p?.type === 'punct' && (p.text === '.' || p.text === '?.');
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      const call = src[k] === '(';
      if (!afterDot && KEYWORDS.has(word)) push('keyword', word);
      else if (!afterDot && LITERALS.has(word)) push('literal', word);
      else if (call) push('fn', word);
      else if (afterDot) push('prop', word);
      else push('ident', word);
      i = j;
      continue;
    }
    // Punctuation / operators: group common multi-char operators.
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['===', '!==', '...', '**=', '>>>', '&&=', '||=', '??='].includes(three)) {
      push('punct', three);
      i += 3;
    } else if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '**'].includes(two)) {
      push('punct', two);
      i += 2;
    } else {
      push('punct', c);
      i += 1;
    }
  }
  return out;
}

/** Tokenize and split into lines (tokens never span a line in the result). */
export function highlightLines(src: string): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokenize(src.replace(/\r\n?/g, '\n'))) {
    const parts = t.text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ type: t.type, text: part });
    });
  }
  return lines;
}
