import type { ChangeTrackingResult } from "@sex/core/schemas.ts";
import { formatPatch, structuredPatch } from "diff";

type ChangeDiff = NonNullable<ChangeTrackingResult["diff"]>;

/** Lines of unchanged text around each change, as in `git diff`. */
const CONTEXT_LINES = 3;

/** The most one diff may block the event loop, whatever time the scrape has left (jsdiff is synchronous). */
const MAX_DIFF_MS = 5000;

/**
 * The line diff of two markdown versions, in Firecrawl's two forms: the unified diff text (`previous.md` -> `current.md`) and
 * the same as `{ files: [{ from, to, chunks: [{ content, changes }] }] }` with `normal` / `add` / `del` changes (the shape
 * of `parse-diff`, which Firecrawl runs over the text). jsdiff does the diffing and stops after `timeoutMs` (at most `MAX_DIFF_MS`), since the
 * cost of its Myers search grows with the number of edits; then, and when no line differs, the result is undefined.
 */
export function markdownDiff(previous: string, current: string, timeoutMs: number): ChangeDiff | undefined {
  const patch = structuredPatch("previous.md", "current.md", previous, current, "", "", {
    context: CONTEXT_LINES,
    timeout: Math.min(Math.max(1, timeoutMs), MAX_DIFF_MS),
  });
  if (!patch?.hunks.length) return undefined;
  const chunks = patch.hunks.map((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const changes: Array<Record<string, unknown>> = [];
    for (const line of hunk.lines) {
      // "\ No newline at end of file" belongs to the line before it and is no change of its own.
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) changes.push({ type: "add", content: line, add: true, ln: newLine++ });
      else if (line.startsWith("-")) changes.push({ type: "del", content: line, del: true, ln: oldLine++ });
      else changes.push({ type: "normal", content: line, normal: true, ln1: oldLine++, ln2: newLine++ });
    }
    const content = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    return { content, changes };
  });
  return { text: formatPatch(patch), json: { files: [{ from: "previous.md", to: "current.md", chunks }] } };
}
