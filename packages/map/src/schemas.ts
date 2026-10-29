/** Request and response schemas of map, modelled on the Firecrawl v2 API. */
import { LocationConfig } from "@searxng-js/sex-scrape";
import { z } from "zod";

export const MapRequest = z.object({
  url: z.string(),
  search: z.string().max(2000).optional().describe("Rank/filter URLs by relevance to this term (max 2000 characters)"),
  sitemap: z.enum(["include", "skip", "only"]).optional().describe('Defaults to "include".'),
  includeSubdomains: z.boolean().optional().describe("Defaults to true."),
  ignoreQueryParameters: z.boolean().optional().describe("Defaults to true."),
  limit: z.number().int().min(1).max(100_000).optional().describe("Defaults to 5000."),
  timeout: z.number().int().min(1000).max(300_000).optional().describe("Timeout in milliseconds (1000-300000)"),
  location: LocationConfig.optional(),
  filterByPath: z.boolean().optional().describe("Only return URLs under the path of the (redirect-resolved) start URL. Defaults to true."),
  includePaths: z.array(z.string()).optional().describe("Regexes matched against the URL path; with any, one of them must match."),
  excludePaths: z.array(z.string()).optional().describe("Regexes matched against the URL path; a match drops the URL."),
  useIndex: z.boolean().optional().describe("Accepted for Firecrawl compatibility and ignored: there is no URL index."),
  ignoreCache: z.boolean().optional().describe("Accepted for Firecrawl compatibility and ignored: there is no map cache."),
});
export type MapRequest = z.infer<typeof MapRequest>;

export const MapLink = z.object({ url: z.string(), title: z.string().optional(), description: z.string().optional() });
export type MapLink = z.infer<typeof MapLink>;
export const MapResponse = z.object({
  success: z.literal(true),
  id: z.string().describe("Unique id of this map call."),
  links: z.array(MapLink),
  warning: z.string().optional(),
});
export const MapResult = MapResponse.omit({ success: true });
export type MapResult = z.infer<typeof MapResult>;
