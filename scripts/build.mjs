import { build } from "esbuild";

const result = await build({
  entryPoints: ["index.server.ts"],
  outfile: "dist/index.server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@getpaseo/plugin/provider", "zod"],
  sourcemap: true,
  metafile: true,
});
if (
  Object.keys(result.metafile.inputs).some((path) => path.startsWith("vendor/"))
) {
  throw new Error(
    "The development SDK snapshot must not enter the runtime bundle",
  );
}
