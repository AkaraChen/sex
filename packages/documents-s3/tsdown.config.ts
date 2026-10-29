import { defineConfig } from "tsdown";

// Private library: its dist exists so the Node tests can import it by name. sex-jobs inlines it from source.
export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  dts: true,
  fixedExtension: false,
  tsconfig: "../tsconfig.build.json",
  clean: true,
  deps: { alwaysBundle: [/^@searxng-js\/sex-errors/] },
  inputOptions: { resolve: { conditionNames: ["sex-source", "import", "default"] } },
});
