import { DEFAULT_SETTINGS } from "@searxng-js/searxng";
import type { CoreConfig as Config } from "./config.ts";

/**
 * The settings.yml sex writes for a managed SearXNG that has to go through `SEX_PROXY_URL`: the package's default settings
 * plus `outgoing.proxies` (SearXNG's documented format: a pattern, here `all://`, mapped to a list of proxy URLs). The URL is a
 * JSON string, which is also a valid YAML double-quoted scalar, so credentials with `:` `@` `#` or quotes survive.
 */
export const proxiedSettings = (proxyUrl: string): string =>
  `${DEFAULT_SETTINGS}outgoing:\n  proxies:\n    all://:\n      - ${JSON.stringify(proxyUrl)}\n`;

/**
 * The settings sex generates for the managed SearXNG, or undefined when the package's own default should be used.
 * Only a managed instance on sex's own settings gets the proxy: an external SearXNG (SEX_SEARXNG_URL) is not ours to configure,
 * and a settings file the operator wrote (SEX_SEARXNG_SETTINGS) keeps its own `outgoing`.
 */
export function generatedSettings(config: Pick<Config, "searxngUrl" | "searxngSettings" | "proxyUrl">): string | undefined {
  if (config.searxngUrl || config.searxngSettings || !config.proxyUrl) return undefined;
  return proxiedSettings(config.proxyUrl);
}

/** `text` with the proxy URL and its credentials replaced, for server output that goes to a log or an error message. */
export function redactProxy(text: string, proxyUrl: string | undefined): string {
  if (!proxyUrl) return text;
  const secrets = [proxyUrl];
  // The userinfo as written (what a tool echoing the configured string would print), and as the URL parser normalises it.
  const raw = /^[a-z][a-z0-9+.-]*:\/\/([^@/?#]*)@/i.exec(proxyUrl)?.[1];
  if (raw) secrets.push(raw, raw.slice(raw.indexOf(":") + 1));
  try {
    const url = new URL(proxyUrl);
    const decode = (v: string) => decodeURIComponent(v);
    if (url.password)
      secrets.push(
        url.href,
        `${url.username}:${url.password}`,
        url.password,
        decode(url.password),
        `${decode(url.username)}:${decode(url.password)}`,
      );
  } catch {
    // Not a URL (config validation prevents it) or a malformed escape: what was collected above is all there is to hide.
  }
  // Longest first, so `user:pass` goes before `pass`. Very short strings are left alone: they would mangle ordinary words.
  return secrets
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((out, s) => out.replaceAll(s, "<redacted>"), text);
}

/** `host:port` of the proxy, safe to log. */
export function proxyHost(proxyUrl: string): string {
  try {
    return new URL(proxyUrl).host;
  } catch {
    return "<invalid>";
  }
}
