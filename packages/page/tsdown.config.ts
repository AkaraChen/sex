import { readFileSync, rmSync } from "node:fs";
import { defineConfig, type UserConfig } from "tsdown";

// The pool starts the worker from `dist/extract-worker.js`, next to `dist/index.js`. It is a separate build, not a second
// entry of the first, so index.js stays one file with no shared chunk. dist is cleared here because the two builds run side by side.
rmSync("dist", { recursive: true, force: true });

// Node cannot `import ... with { type: "text" }`, which is how Bun gets page-script.js as a string: the build turns that
// import into a string module, so the published dist carries the script text.
const textImport = {
  name: "page-script-as-text",
  load(id: string) {
    if (id.endsWith("/page-script.js")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  },
};

const shared: UserConfig = {
  format: "esm",
  fixedExtension: false,
  tsconfig: "../tsconfig.build.json",
  clean: false,
  plugins: [textImport],
  deps: { alwaysBundle: [/^@searxng-js\/sex-errors/] },
  inputOptions: { resolve: { conditionNames: ["sex-source", "import", "default"] } },
};

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts" }, dts: true },
  { ...shared, entry: { "extract-worker": "src/extract-worker.ts" }, dts: false },
]);
