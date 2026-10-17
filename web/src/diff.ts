/** Line diff via longest common subsequence — enough for comparing extractor versions. */

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 1-based line number in the old text (same/del). */
  a?: number;
  /** 1-based line number in the new text (same/add). */
  b?: number;
}

const MAX_CELLS = 4_000_000;

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.replace(/\r\n?/g, '\n').split('\n');
  const b = newText.replace(/\r\n?/g, '\n').split('\n');

  // Trim the common prefix and suffix — cheap and keeps the LCS table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i]!, a: i + 1, b: i + 1 });

  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const n = ma.length;
  const m = mb.length;

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    // Too large to diff precisely — show as a replacement block.
    ma.forEach((t, i) => out.push({ kind: 'del', text: t, a: start + i + 1 }));
    mb.forEach((t, j) => out.push({ kind: 'add', text: t, b: start + j + 1 }));
  } else {
    // lcs[i][j] = LCS length of ma[i..] and mb[j..], flattened.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        out.push({ kind: 'same', text: ma[i]!, a: start + i + 1, b: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
        out.push({ kind: 'add', text: mb[j]!, b: start + j + 1 });
        j++;
      } else {
        out.push({ kind: 'del', text: ma[i]!, a: start + i + 1 });
        i++;
      }
    }
    // Present deletions before additions inside each changed hunk.
    reorderHunks(out);
  }

  for (let k = 0; k < a.length - endA; k++) out.push({ kind: 'same', text: a[endA + k]!, a: endA + k + 1, b: endB + k + 1 });
  return out;
}

function reorderHunks(lines: DiffLine[]) {
  let s = 0;
  while (s < lines.length) {
    if (lines[s]!.kind === 'same') {
      s++;
      continue;
    }
    let e = s;
    while (e < lines.length && lines[e]!.kind !== 'same') e++;
    const hunk = lines.slice(s, e);
    const sorted = [...hunk.filter((l) => l.kind === 'del'), ...hunk.filter((l) => l.kind === 'add')];
    lines.splice(s, hunk.length, ...sorted);
    s = e;
  }
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}
