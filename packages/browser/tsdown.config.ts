import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Node cannot `import ... with { type: "text" }`, which is how Bun gets Defuddle's browser bundle as a string: the build turns
// that import into a string module, so the published dist carries the bundle text and does not depend on defuddle at runtime.
const textImport = {
  name: "defuddle-bundle-as-text",
  load(id: string) {
    if (/[\\/]defuddle[\\/]dist[\\/]index\.full\.js$/.test(id)) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  },
};

export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  dts: true,
  fixedExtension: false,
  tsconfig: "../tsconfig.build.json",
  clean: true,
  plugins: [textImport],
  deps: { alwaysBundle: [/^@searxng-js\/sex-(errors|deadline|diagnostics)/, "defuddle/full"] },
  inputOptions: { resolve: { conditionNames: ["sex-source", "import", "default"] } },
});
