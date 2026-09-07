import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Opt-in local integration check: initializes the installed host and reads its catalog.
// It uses the host's existing user data and never submits a prompt or creates a session.
const root = resolve(import.meta.dirname, "..");
const cwd = resolve(process.argv[2] ?? root);
const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-"));
let connection;
try {
  await build({
    entryPoints: [join(root, "server/provider.ts")],
    outfile: join(directory, "provider.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    alias: {
      "@getpaseo/plugin/provider": join(root, "vendor/paseo/provider.ts"),
    },
  });
  const { createZCodeProvider, CAPABILITIES } = await import(
    pathToFileURL(join(directory, "provider.mjs")).href
  );
  connection = await createZCodeProvider().connect({
    versions: [1],
    capabilities: CAPABILITIES,
  });
  const result = new Promise((resolveResult, reject) =>
    connection.onEvent((event) => {
      if (event.type === "catalog")
        resolveResult({
          models: event.catalog.models.length,
          modes: event.catalog.modes.length,
          defaultModelPresent: Boolean(event.catalog.defaultModel),
        });
      if (event.type === "request.failed") reject(new Error(event.error.code));
    }),
  );
  await connection.send({ type: "catalog", requestId: "runtime-check", cwd });
  console.log(JSON.stringify({ actualHostCatalog: await result }, null, 2));
} finally {
  await connection?.close();
  await rm(directory, { recursive: true, force: true });
}
