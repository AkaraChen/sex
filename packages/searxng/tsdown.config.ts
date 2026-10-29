import { defineConfig } from "tsdown";

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
