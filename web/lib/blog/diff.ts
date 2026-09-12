// Minimal line diff for the conflict dialog. ~40 lines instead of a dependency, because the only
// question it has to answer is "which lines differ between my version and theirs" — not patch
// generation, word-level highlighting, or merge.
//
// Standard LCS over lines. Blog bodies are hundreds of lines, so the O(n·m) table is fine; the cap
// below stops a pathological paste from freezing the tab.
const MAX_LINES = 2000;

export type DiffOp = "same" | "add" | "remove";
export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line numbers, null on the side where the line doesn't exist. */
  leftNo: number | null;
  rightNo: number | null;
}

export function diffLines(leftText: string, rightText: string): DiffLine[] {
  const a = leftText.split("\n");
  const b = rightText.split("\n");

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // Too big to diff interactively — say so rather than hanging.
    return [{ op: "same", text: `(${a.length} vs ${b.length} lines — too large to compare inline)`, leftNo: null, rightNo: null }];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i…] and b[j…]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i], leftNo: i + 1, rightNo: j + 1 });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "remove", text: a[i], leftNo: i + 1, rightNo: null });
      i++;
    } else {
      out.push({ op: "add", text: b[j], leftNo: null, rightNo: j + 1 });
      j++;
    }
  }
  while (i < a.length) out.push({ op: "remove", text: a[i], leftNo: ++i, rightNo: null });
  while (j < b.length) out.push({ op: "add", text: b[j], leftNo: null, rightNo: ++j });
  return out;
}

/** Collapse long runs of unchanged lines so the dialog shows the changes, not the whole post. */
export function collapseUnchanged(lines: DiffLine[], context = 3): (DiffLine | { op: "skip"; count: number })[] {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.op === "same") return;
    for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < lines.length) keep.add(k);
  });
  const out: (DiffLine | { op: "skip"; count: number })[] = [];
  let skipping = 0;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      if (skipping) { out.push({ op: "skip", count: skipping }); skipping = 0; }
      out.push(l);
    } else {
      skipping++;
    }
  });
  if (skipping) out.push({ op: "skip", count: skipping });
  return out;
}

export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "remove") removed++;
  }
  return { added, removed };
}
