import { defineConfig } from "tsdown";

// Private library: its dist exists so the Node tests can import it by name. Published packages inline it from source.
export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  dts: true,
  fixedExtension: false,
  tsconfig: "../tsconfig.build.json",
  clean: true,
  inputOptions: { resolve: { conditionNames: ["sex-source", "import", "default"] } },
});
