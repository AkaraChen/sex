# The firecrawl-local fork

sex runs upstream `firecrawl-local` unchanged except for the patches below. They are what the wrapper cannot add from
outside, kept as small, independent patches so a version bump is a rebase, not a merge.

| Patch | Adds | Why it cannot live in sex |
| --- | --- | --- |
| `--proxy` / `FIRECRAWL_LOCAL_PROXY` | proxy for `reqwest` and the browser's `proxy.chrome_args()` | Upstream has no proxy option; its cloud fallback is the competing feature |
| per-request network policy | `--allow-private` per request, CIDR allowlist | Upstream's policy is one boolean for the process |
| adblock | the `||domain^` / `@@||domain^` table sex already ships | Upstream has no adblocking |
| `actions` | CDP execution after load | Upstream deliberately ignores them |

Order: proxy, network policy, adblock, actions.

`/v2/parse` is **not** a patch: it is `packages/parse`, a separate `here-docs` subprocess (MIT, `@firecrawl/anydoc` and
`@firecrawl/pdf-inspector` underneath). No fork is needed for it, and no AGPL code is redistributed.

## Shape of a patch

- One module plus one hook plus one flag, **default off**: unset, the binary behaves exactly like upstream.
- Flag names follow upstream's (`FIRECRAWL_LOCAL_*`).
- No change to `Document` fields or to existing routes.

## Building and distributing

- Pin the fork by tag and SHA-256 in the release pipeline; `apps/sex/scripts/build.ts` embeds the binary when
  `SEX_LOCAL_BINARY` is set, and `packages/local` unpacks it to `$XDG_CACHE_HOME/sex/firecrawl-local-<version>-<hash>`.
- The binary is **AGPL-3.0**. A `dist/sex` that embeds it is distributing it: ship the licence and the exact
  source (fork commit + patch series + build command), or a written offer.
- sex itself stays MIT: separate processes, HTTP only. Linking `firecrawl_local` as a crate would make sex a
  derivative work and is forbidden here.
