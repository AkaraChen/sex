/**
 * Cuts page Markdown into the units the line selection (highlights, directQuote) numbers and quotes. A unit is one
 * line, except that a code fence or a table is kept whole (a quote of half a table is useless) and a long
 * paragraph is cut into sentences (one number for a wall of text makes the quote as long as the wall).
 */

/** A code block or table longer than this is cut into groups of whole lines. */
const BLOCK_MAX_CHARS = 2000;
/** A line longer than this is cut into sentences. */
const LONG_LINE_CHARS = 400;

const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** After `.!?` before a capital, digit, quote or bracket (so "e.g. foo" stays whole), or after a CJK full stop. */
const SENTENCE_END = /(?<=[.!?]["')\]]?)\s+(?=["'([A-Z0-9])|(?<=[。！？])/u;

export function splitSegments(content: string): string[] {
  const lines = content.split("\n").map((l) => l.trimEnd());
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string;
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      // Up to the closing fence of the same kind (or the end of the page); blank lines are part of the code.
      let end = i + 1;
      while (end < lines.length && !(lines[end] as string).trimStart().startsWith(fence)) end++;
      pushBlock(out, lines.slice(i, Math.min(end + 1, lines.length)));
      i = end + 1;
    } else if (TABLE_ROW.test(line)) {
      let end = i + 1;
      while (end < lines.length && TABLE_ROW.test(lines[end] as string)) end++;
      pushBlock(out, lines.slice(i, end));
      i = end;
    } else {
      if (line.trim()) out.push(...(line.length > LONG_LINE_CHARS ? splitSentences(line) : [line]));
      i++;
    }
  }
  return out;
}

/** One unit, or consecutive lines grouped under `BLOCK_MAX_CHARS` when the block is bigger. */
function pushBlock(out: string[], lines: string[]): void {
  let group: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (group.length && size + line.length + 1 > BLOCK_MAX_CHARS) {
      out.push(group.join("\n"));
      group = [];
      size = 0;
    }
    group.push(line);
    size += line.length + 1;
  }
  if (group.length) out.push(group.join("\n"));
}

function splitSentences(line: string): string[] {
  const parts = line.split(SENTENCE_END).filter((s) => s.trim());
  return parts.length ? parts : [line];
}
