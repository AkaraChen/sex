# sex

Firecrawl v2 compatible web search (SearXNG) + fetch (Defuddle) as a CLI, HTTP API (Hono + oRPC) and MCP server (fastmcp). See README.md for usage.

## Layout

- `src/cli.ts` — citty CLI: `search`, `fetch`, `http`, `mcp`, `worker`
- `src/core/` — engine shared by all front-ends (scrape, search, map, crawl, batch, extract, browser, llm)
- `src/core/page-script.js` — page-side extractor, imported as text. Runs inside the browser (injected next to Defuddle's bundle) and in Node (via `new Function` on a linkedom document). Keep it a single self-contained function expression.
- `src/core/jobs/` — `JobStore` + `TaskQueue` interfaces with memory and Redis/BullMQ implementations; `src/core/tasks.ts` dispatches tasks to the crawl/batch/extract handlers. Job logic must only go through these interfaces (no in-process job state), so it works across workers.
- `src/http/` — oRPC router + Hono app; `src/mcp/` — fastmcp tools
- `src/schemas.ts` — Zod schemas mirroring Firecrawl v2 (OpenAPI + MCP params)

## Gotchas

- Never pass JS *functions* to `page.evaluate`: Bun's bundler can rename globals like `document` inside them. Pass strings.
- Browser and LLM are optional; features needing them must fail with `browserRequired()` / `llmRequired()` (501).
- Screenshots (format and action) and the pdf action are deliberately unsupported (501), even with a browser.
- Logs go to stderr only (stdout carries MCP stdio and CLI output).
- `bun run build` marks xsschema's optional imports (effect, sury, @valibot/to-json-schema) as external.

---


Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
