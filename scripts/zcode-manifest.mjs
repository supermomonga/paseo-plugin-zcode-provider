import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Scripts read the provider's TypeScript manifest instead of duplicating its pins.
export async function loadZCodeManifest() {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../server/discovery/manifest.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
}
