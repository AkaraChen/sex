import type { SearchBackend } from "../chain.ts";
import type { CallTime, SearchData, SearchRequest } from "../search.ts";
import { searchWeb } from "../search.ts";
import type { Searxng } from "../searxng.ts";

/** The SearXNG backend: the full Firecrawl v2 shape (web/news/images, categories, tbs, per-domain fan-out). */
export class SearxngBackend implements SearchBackend {
  readonly id = "searxng";

  constructor(private readonly searxng: Searxng) {}

  async search(request: SearchRequest, time?: CallTime): Promise<{ data: SearchData; warnings: string[] }> {
    const { data, warnings } = await searchWeb(await this.searxng.client(), request, time);
    return { data, warnings };
  }
}
