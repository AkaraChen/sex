# e2e

End-to-end tests run against the built binaries (`sex`, `sex-lite`) and the packed npm packages, the way a user sees them.
CI runs them in `.github/workflows/e2e.yml`: one job builds the binaries, then each suite runs in its own job.

| Suite          | Covers                                                                                                                                              | Blocks a merge |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `e2e/lite`     | sex-lite: CLI, HTTP API, MCP, the Firecrawl SDK, SSRF refusals, config                                                                              | yes            |
| `e2e/sex`      | sex: browser (Lightpanda), documents (here-docs), LLM formats (mock LLM), map / crawl / batch / extract, webhooks, cache, change tracking, MCP, SDK | yes            |
| `e2e/infra`    | crash recovery, S3 documents, Chrome over CDP, SSRF on every outbound path, outbound and stealth proxies, process hygiene                           | yes            |
| `e2e/packages` | the published packages installed from their tarballs into fresh Node 24 and Bun projects                                                            | yes            |
| `e2e/load`     | the big test: a large generated site, thousands of pages, hundreds of concurrent requests; numbers in the job summary                               | yes            |
| `e2e/online`   | real websites and the real (managed) SearXNG                                                                                                        | no             |

## Running locally

```sh
bun run build && bun run build:lite      # dist/sex, dist/sex-lite
bun run e2e e2e/lite                     # one suite; `bun run e2e e2e` runs all of them
```

| Variable                                                                          | Meaning                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SEX_E2E_BIN_DIR`                                                                 | Directory with `sex` and `sex-lite` (default `dist/`)                                       |
| `SEX_E2E_TMP`                                                                     | Base for temporary files (default the OS temp dir)                                          |
| `SEX_E2E_CDP_URL`                                                                 | A Chrome with remote debugging, for `e2e/infra` (CI: the runner's Chrome on 127.0.0.1:9222) |
| `SEX_E2E_S3_ENDPOINT`, `SEX_E2E_S3_ACCESS_KEY_ID`, `SEX_E2E_S3_SECRET_ACCESS_KEY` | An S3 server for `e2e/infra` (CI: SeaweedFS)                                                |
| `SEX_E2E_REQUIRE_ALL=1`                                                           | A missing service fails the tests that need it instead of skipping them (set in CI)         |

`e2e/packages` needs `bun run build:packages` first. Locally Chrome can run in docker with host networking, so it can
reach sex's loopback egress proxy like the runner's Chrome does:

```sh
docker run -d --rm --network host chromedp/headless-shell --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

## Writing tests

Use the harness in `e2e/lib`: `bin()`, `run()` for a CLI command, `serve()` for a server on a free port, `api()`,
`until()`, `staticSite()` / `site()` for local websites, `startMockLlm()`, `tempDir()`. Every file cleans up in
`afterAll` (`killAll()`, `removeTempDirs()`). No fixed ports. A product bug found by a test is written as
`test.failing(...)` with a `// BUG:` comment until it is fixed.
