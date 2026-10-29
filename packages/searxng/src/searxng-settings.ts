import { DEFAULT_SETTINGS } from "@searxng-js/searxng";
import { AppError } from "@searxng-js/sex-errors";

type Mapping = Record<string, unknown>;

interface Yaml {
  parse(text: string): unknown;
  stringify(value: unknown, indent: number): string;
}

let yaml: Promise<Yaml> | undefined;

/** Bun's built-in YAML; elsewhere the optional peer dependency `yaml`. */
function loadYaml(): Promise<Yaml> {
  if (typeof Bun !== "undefined")
    return Promise.resolve({ parse: (t) => Bun.YAML.parse(t), stringify: (v, n) => Bun.YAML.stringify(v, null, n) });
  yaml ??= import("yaml").then(
    (lib) => ({ parse: (t) => lib.parse(t), stringify: (v, n) => lib.stringify(v, null, n) }),
    (cause) => {
      yaml = undefined;
      throw new AppError(
        "NOT_SUPPORTED",
        "Generating SearXNG settings outside Bun needs the optional peer dependency `yaml`: run `npm install yaml`.",
        {
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      );
    },
  );
  return yaml;
}

const isMapping = (v: unknown): v is Mapping => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The settings.yml written for a managed SearXNG that has to go through a proxy: `base` (the package's default
 * settings) parsed, `outgoing.proxies["all://"] = [url]` merged in (SearXNG's documented format: a pattern mapped to a list of
 * proxy URLs; whatever `base` already has under `outgoing` and `outgoing.proxies` stays), and written out again. Merging the
 * parsed document, not appending text, means a key the defaults gain later is never duplicated, and the serializer does the
 * quoting, so credentials with `:` `@` `#` or quotes survive.
 */
export async function proxiedSettings(proxyUrl: string, base: string = DEFAULT_SETTINGS): Promise<string> {
  const { parse, stringify } = await loadYaml();
  const settings: unknown = parse(base);
  const root: Mapping = isMapping(settings) ? settings : {};
  const outgoing = isMapping(root.outgoing) ? root.outgoing : {};
  const proxies = isMapping(outgoing.proxies) ? outgoing.proxies : {};
  return stringify({ ...root, outgoing: { ...outgoing, proxies: { ...proxies, "all://": [proxyUrl] } } }, 2);
}

/**
 * The settings generated for the managed SearXNG, or undefined when the package's own default should be used.
 * Only a managed instance on the default settings gets the proxy: an external SearXNG (`url`) is not ours to configure,
 * and a settings file the operator wrote (`settingsPath`) keeps its own `outgoing`.
 */
export async function generatedSettings(options: { url?: string; settingsPath?: string; proxyUrl?: string }): Promise<string | undefined> {
  if (options.url || options.settingsPath || !options.proxyUrl) return undefined;
  return proxiedSettings(options.proxyUrl);
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
