import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, TMP_BASE } from "../lib/bin.ts";
import { type Env, type RunResult, run } from "../lib/proc.ts";
import { site } from "../lib/sites.ts";

/**
 * What a project outside the repository does with the published packages: pack them (`bun pm pack`, which is what
 * `npm publish` would upload), install the tarballs into a fresh project, run programs against them.
 *
 * Everything here is made once per `bun test` process (the suites share the tarballs and the installed projects, since an
 * install is the slow part).
 */

/**
 * One directory for everything this suite makes (a stale one from an earlier run is wiped when this module loads, so a run
 * cut short leaks nothing for long; two runs at once on one machine would clash). `bun test` does not run `exit` handlers,
 * so the files call `sharedDone()` in `afterAll` and the last one removes it.
 */
const ROOT_DIR = join(TMP_BASE, "sex-e2e-packages");
rmSync(ROOT_DIR, { recursive: true, force: true });
mkdirSync(ROOT_DIR, { recursive: true });

const SUITES = readdirSync(import.meta.dir).filter((f) => f.endsWith(".test.ts")).length;
let finished = 0;

/** Call from every test file's `afterAll`: removes the shared directory once all the files have finished. */
export function sharedDone(): void {
  finished++;
  if (finished >= SUITES) rmSync(ROOT_DIR, { recursive: true, force: true });
}

process.on("exit", () => rmSync(ROOT_DIR, { recursive: true, force: true }));

function scratch(prefix: string): string {
  return mkdtempSync(join(ROOT_DIR, prefix));
}

export interface PackageInfo {
  /** `@searxng-js/sex-scrape` */
  name: string;
  /** `scrape` (the directory under packages/) */
  dir: string;
  path: string;
  json: Record<string, any>;
}

/** Every package under packages/ whose package.json is not private. */
export function publishedPackages(): PackageInfo[] {
  const out: PackageInfo[] = [];
  for (const dir of readdirSync(join(ROOT, "packages")).sort()) {
    const path = join(ROOT, "packages", dir);
    const file = join(path, "package.json");
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (json.private) continue;
    out.push({ name: json.name, dir, path, json });
  }
  return out;
}

/** Private libraries that are bundled into the published packages: no published file may name or depend on them. */
export const PRIVATE_PACKAGES = [
  "@searxng-js/sex-errors",
  "@searxng-js/sex-deadline",
  "@searxng-js/sex-diagnostics",
  "@searxng-js/sex-documents-s3",
  "@searxng-js/sex-server",
  "@searxng-js/sex-testing",
];

export interface Tarball {
  pkg: PackageInfo;
  file: string;
}

let packing: Promise<Tarball[]> | undefined;

/** Packs every published package into one directory. Fails clearly when `bun run build:packages` was not run. */
export function packAll(): Promise<Tarball[]> {
  packing ??= (async () => {
    const pkgs = publishedPackages();
    const missing = pkgs.filter((p) => !existsSync(join(p.path, "dist/index.js")) || !existsSync(join(p.path, "dist/index.d.ts")));
    if (missing.length)
      throw new Error(`no dist/ in ${missing.map((p) => `packages/${p.dir}`).join(", ")}: run \`bun run build:packages\` first`);
    const dest = scratch("sex-e2e-tgz-");
    const out: Tarball[] = [];
    for (const pkg of pkgs) {
      const r = await run("bun", ["pm", "pack", "--destination", dest, "--quiet"], { cwd: pkg.path });
      if (r.code !== 0) throw new Error(`bun pm pack failed in packages/${pkg.dir}:\n${r.stdout}\n${r.stderr}`);
      const file = join(dest, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.json.version}.tgz`);
      if (!existsSync(file)) throw new Error(`expected ${file}; bun pm pack printed:\n${r.stdout}`);
      out.push({ pkg, file });
    }
    return out;
  })();
  return packing;
}

export type Runtime = "node" | "bun";

/** Runs a command to completion; throws with the output when it fails. */
export async function must(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<RunResult> {
  const r = await run(cmd, args, {
    cwd,
    timeoutMs,
    env: { npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
  });
  if (r.code !== 0)
    throw new Error(`${cmd} ${args.join(" ")} (in ${cwd}) exited ${r.code}:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  return r;
}

const CONSUMERS = join(import.meta.dir, "consumers");

/** A new project directory with a package.json (`"type": "module"`) and the consumer programs copied in. */
export function newProject(name: string): string {
  const dir = scratch(`sex-e2e-${name}-`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", private: true, type: "module" }, null, 2));
  cpSync(CONSUMERS, join(dir, "consumers"), { recursive: true });
  return dir;
}

/** Packages every Node consumer program imports besides ours (the READMEs' examples use p-limit). */
export const NODE_PEERS = ["undici", "marked", "yaml"];

const projects = new Map<string, Promise<string>>();

function once(key: string, make: () => Promise<string>): Promise<string> {
  let p = projects.get(key);
  if (!p) {
    p = make();
    projects.set(key, p);
  }
  return p;
}

/** The tarballs of every published package except the ones in `without`, as `npm install` arguments. */
async function tarballs(without: string[] = []): Promise<string[]> {
  return (await packAll()).filter((t) => !without.includes(t.pkg.name)).map((t) => t.file);
}

/** Node project: all tarballs, p-limit and the optional peers the READMEs name for Node (`peers`). */
export function nodeProject(peers: string[] = NODE_PEERS, label = "node"): Promise<string> {
  return once(`${label}:${peers.join(",")}`, async () => {
    const dir = newProject(label);
    await must("npm", ["install", "--no-audit", "--no-fund", ...(await tarballs()), "p-limit", ...peers], dir);
    return dir;
  });
}

/**
 * Bun project: the tarballs and p-limit, nothing else. `bun add <tarballs>` cannot resolve the packages' dependencies on each
 * other (the registry does not have them yet), so the tarballs are also `overrides`, which is the only difference from
 * installing the published versions.
 */
export function bunProject(): Promise<string> {
  return once("bun", async () => {
    const dir = newProject("bun");
    const files = await packAll();
    const deps: Record<string, string> = {};
    for (const t of files) deps[t.pkg.name] = `file:${t.file}`;
    const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    json.dependencies = { ...deps, "p-limit": "^7" };
    json.overrides = deps;
    writeFileSync(join(dir, "package.json"), JSON.stringify(json, null, 2));
    await must("bun", ["install"], dir);
    return dir;
  });
}

export interface Consumer {
  code: number;
  stdout: string;
  stderr: string;
  /** The `RESULT {json}` line the program printed. */
  result: any;
}

/** Runs `consumers/<script>` of a project with `runtime`; `cfg` reaches it as the `CFG` environment variable. */
export async function consume(
  project: string,
  runtime: Runtime,
  script: string,
  cfg: Record<string, unknown> = {},
  opts: { env?: Env; timeoutMs?: number } = {},
): Promise<Consumer> {
  const args = [join("consumers", script)];
  const r = await run(runtime, args, {
    cwd: project,
    timeoutMs: opts.timeoutMs ?? 120_000,
    env: { CFG: JSON.stringify(cfg), ...opts.env },
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  let result: unknown;
  if (line) result = JSON.parse(line.slice("RESULT ".length));
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, result };
}

/** Like `consume`, but fails with the program's output when it did not exit 0 or printed no result. */
export async function consumeOk(
  project: string,
  runtime: Runtime,
  script: string,
  cfg: Record<string, unknown> = {},
  opts: { env?: Env; timeoutMs?: number } = {},
) {
  const c = await consume(project, runtime, script, cfg, opts);
  if (c.code !== 0 || c.result === undefined)
    throw new Error(`${runtime} consumers/${script} exited ${c.code}:\n${c.stdout.slice(-3000)}\n${c.stderr.slice(-3000)}`);
  return c.result;
}

const PARAGRAPH = (topic: string) =>
  `<p>This paragraph is about ${topic}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}</p>`;

export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}"></head><body><nav><a href="/">Home</a></nav><main><article><h1>${title}</h1>${PARAGRAPH(title)}${PARAGRAPH(`${title} again`)}${body}</article></main><footer>footer</footer></body></html>`;

/** A small site on 127.0.0.1: `/`, `/docs/a`, `/docs/b`, `/docs/c`, a sitemap listing a, b and c, robots.txt. */
export function consumerSite() {
  const s = site((_req, url) => {
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    switch (url.pathname) {
      case "/":
        return html(
          page("Home", `<p><a href="/docs/a">Doc A</a> <a href="/docs/b">Doc B</a> <a href="https://elsewhere.example/out">Out</a></p>`),
        );
      case "/docs/a":
        return html(page("Doc A", `<p>Alpha unique marker. <a href="/docs/b">to b</a></p>`));
      case "/docs/b":
        return html(page("Doc B", `<p>Beta unique marker. <a href="/docs/a">to a</a></p>`));
      case "/docs/c":
        return html(page("Doc C", `<p>Gamma unique marker.</p>`));
      case "/report.docx":
        return new Response(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), {
          headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        });
      case "/private":
        return html(page("Private", ""));
      case "/robots.txt":
        return new Response(`User-agent: *\nAllow: /\nSitemap: ${s.url}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
      case "/sitemap.xml":
        return new Response(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${s.url}/docs/a</loc></url><url><loc>${s.url}/docs/b</loc></url><url><loc>${s.url}/docs/c</loc></url></urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      default:
        return new Response("not found", { status: 404 });
    }
  });
  return s;
}
