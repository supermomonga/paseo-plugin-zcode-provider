import { build } from "esbuild";

const result = await build({
  entryPoints: ["index.server.ts"],
  outfile: "dist/index.server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@getpaseo/plugin", "@getpaseo/plugin/server/provider", "zod"],
  sourcemap: true,
  metafile: true,
});
const output = result.metafile.outputs["dist/index.server.js"];
for (const module of [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server/provider",
  "zod",
]) {
  if (
    !output.imports.some((entry) => entry.path === module && entry.external)
  ) {
    throw new Error(`Runtime module must remain external: ${module}`);
  }
}
