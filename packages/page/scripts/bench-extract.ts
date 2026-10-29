// Measures where Defuddle spends its time on big pages, and what the large-page fast path (page-script.js) saves.
//
//   bun --conditions sex-source packages/page/scripts/bench-extract.ts [stages|compare] [--runs 3]
//
// `stages`: Defuddle's own per-step profile (`profile: true`) for default extraction, at growing page sizes.
// `compare`: the whole page script with the fast path off (threshold Infinity) and on, plus a normal page to show it is unaffected.
// The pages are synthetic: a feed of cards (nested divs, links, images, lists) around one article, which is what makes
// real 2-3 MB pages slow. Sizes are bytes of HTML; "nodes" are elements.

import { extractFromHtmlInline } from "@searxng-js/sex-page";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

export function bigPage(cards: number, articleParagraphs = 6): string {
  const card = (i: number) =>
    `<div class="card item-${i % 7}"><div class="card-header"><a href="/u/${i}" class="user"><img src="/a/${i}.png" alt="u${i}" width="32" height="32"> user ${i}</a><span class="time">${i}h ago</span></div><div class="card-body"><h3><a href="/p/${i}">Post number ${i} about something</a></h3><p>${`Some text for card number ${i}. Quick brown fox jumps over the lazy dog. `}</p><ul class="tags"><li><a href="/t/a">a</a></li><li><a href="/t/b">b</a></li><li><a href="/t/c">c</a></li></ul></div><div class="card-footer"><button class="like">Like</button><button class="share">Share</button></div></div>`;
  const paras = Array.from(
    { length: articleParagraphs },
    (_, i) => `<p>Paragraph ${i} of the article. ${"The article body goes on for a while, with plenty of words to count. ".repeat(6)}</p>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><title>Big page</title><meta name="description" content="A big page"></head><body><header><nav>${Array.from({ length: 30 }, (_, i) => `<a href="/n/${i}">Nav ${i}</a>`).join("")}</nav></header><main><article><h1>Big page</h1>${paras}</article><section class="feed">${Array.from({ length: cards }, (_, i) => card(i)).join("")}</section></main><footer>footer</footer></body></html>`;
}

const SIZES = [100, 500, 1500, 3000, 6000]; // cards
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 3;
const mode = process.argv[2] === "compare" ? "compare" : "stages";
const ms = (t: number) => `${t.toFixed(0)}ms`;

/** Median CPU milliseconds of `runs` runs. */
async function median(fn: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    // CPU time of this process, not wall time: other work on the machine does not inflate it.
    const c = process.cpuUsage();
    await fn();
    const d = process.cpuUsage(c);
    times.push((d.user + d.system) / 1000);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
}

const opts = (url: string) => ({ url, onlyMainContent: true, removeBase64Images: true, wantLinks: false, wantImages: false });

if (mode === "stages") {
  for (const cards of SIZES) {
    const html = bigPage(cards);
    const t0 = performance.now();
    const { document } = parseHTML(html);
    const parse = performance.now() - t0;
    const nodes = document.querySelectorAll("*").length;
    const t1 = performance.now();
    const r = await Defuddle(document as Parameters<typeof Defuddle>[0], "https://example.com/", {
      separateMarkdown: true,
      useAsync: false,
      profile: true,
    } as never);
    const total = performance.now() - t1;
    console.log(
      `\n${(html.length / 1024).toFixed(0)} KB, ${nodes} nodes: linkedom parse ${ms(parse)}, Defuddle ${ms(total)}, ${r.wordCount} words`,
    );
    const profile = (r as { profile?: Record<string, number> }).profile ?? {};
    const top = Object.entries(profile)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k} ${v}ms`);
    console.log(`  slowest steps (last attempt): ${top.join(", ") || "(no profile in this build)"}`);
  }
} else {
  await extractFromHtmlInline(bigPage(6), opts("https://example.com/")); // warm-up, so the first row is not the JIT
  // Ordinary page first: the fast path must not touch it. `off` raises the threshold so that Defuddle's scoring always runs.
  for (const cards of [0, ...SIZES.slice(0, 5)]) {
    const html = bigPage(cards || 6);
    const nodes = parseHTML(html).document.querySelectorAll("*").length;
    const label = `${(html.length / 1024).toFixed(0)} KB, ${nodes} nodes${cards === 0 ? " (ordinary)" : ""}`;
    const off = await median(() =>
      extractFromHtmlInline(html, { ...opts("https://example.com/"), maxScoredElements: Number.POSITIVE_INFINITY }),
    );
    const on = await median(() => extractFromHtmlInline(html, opts("https://example.com/")));
    console.log(`${label.padEnd(38)} scoring always ${ms(off).padStart(7)}   default ${ms(on).padStart(7)}`);
  }
}
