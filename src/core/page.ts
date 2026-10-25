import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import pageScript from "./page-script.js" with { type: "text" };

export interface PageExtractOptions {
  url: string;
  onlyMainContent: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  removeBase64Images: boolean;
  wantLinks: boolean;
  wantLinkTitles?: boolean;
  wantImages: boolean;
  attributes?: Array<{ selector: string; attribute: string }>;
}

export interface PageExtractResult {
  metadata: Record<string, unknown>;
  links?: string[];
  linkTitles?: Record<string, string>;
  images?: string[];
  attributes: Array<{ selector: string; attribute: string; values: string[] }>;
  /** Cleaned HTML (main content unless onlyMainContent=false). */
  html: string;
  markdown: string;
  defuddle: {
    title: string;
    description: string;
    author: string;
    published: string;
    site: string;
    image: string;
    language: string;
    wordCount: number;
  };
}

/** Source of the page-side extractor, for injection into a browser page. */
export const PAGE_SCRIPT = pageScript as unknown as string;

type PageFn = (
  doc: unknown,
  opts: PageExtractOptions,
  run: (doc: unknown, options: Record<string, unknown>) => Promise<{ content: string; contentMarkdown?: string }>,
) => Promise<PageExtractResult>;

let compiled: PageFn | undefined;

/**
 * Node engine: parse with linkedom and run the same page script + Defuddle's Node build, on the calling thread.
 * Use `ExtractPool` (extract-pool.ts) from request code; this is what the worker and the pool's inline mode call.
 */
export async function extractFromHtmlInline(html: string, opts: PageExtractOptions): Promise<PageExtractResult> {
  compiled ??= new Function(`return (${PAGE_SCRIPT})`)() as PageFn;
  const { document } = parseHTML(html);
  return compiled(document, opts, (doc, options) => Defuddle(doc as Parameters<typeof Defuddle>[0], opts.url, options));
}
