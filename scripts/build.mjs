import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

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
  banner: {
    js: "/*! Includes ZCode Apache-2.0 code and Visual Studio Code MIT utilities. See licenses/zcode/LICENSE, NOTICE.md and THIRD-PARTY-NOTICES.md. */",
  },
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
await mkdir("dist/licenses/zcode", { recursive: true });
for (const file of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"])
  await cp(`server/vendor/zcode/${file}`, `dist/licenses/zcode/${file}`);
