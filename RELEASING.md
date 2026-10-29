# Releasing the npm packages

The published packages are the `packages/*` without `"private": true` (see `docs/architecture.md`), all under the
`@searxng-js` npm organisation. Until `0.1.0` they share one version.

## How a release happens

1. Set the version and merge it to `main`:
   ```sh
   bun run set-version 0.1.0-rc.1   # every published package
   ```
2. On the push to `main`, `.github/workflows/release.yml` builds the packages, runs their Node tests, and runs
   `bun run release`, which publishes every package whose version is not on npm yet, in dependency order. A prerelease
   (`-rc.N`) goes to the `next` dist-tag, a release to `latest`. It then pushes a `<name>@<version>` git tag per package.
   A push that changes no version publishes nothing.

`workflow_dispatch` with `dry_run` packs everything and runs `npm publish --dry-run`. Locally: `bun run build:packages`
then `bun run release --dry-run`.

## Trusted publishing

CI authenticates to npm with GitHub's OIDC token (no `NPM_TOKEN` secret) and npm adds provenance. Each package must name
this workflow as its trusted publisher. npm can only configure that for a package that already exists, so a new package
is published once by hand (`bun run release` with a logged-in `npm` that owns `@searxng-js`), then:

```sh
for p in egress page scrape searxng search map jobs llm store browser docs; do
  npm trust github "@searxng-js/sex-$p" --file release.yml --repo AkaraChen/sex --allow-publish --yes
  sleep 2
done
npm trust list @searxng-js/sex-scrape
```

The first call asks for two-factor authentication; npm offers to skip it for the next five minutes. Afterwards, consider
"Require two-factor authentication and disallow tokens" in each package's settings on npmjs.com, so that only the
workflow can publish.
