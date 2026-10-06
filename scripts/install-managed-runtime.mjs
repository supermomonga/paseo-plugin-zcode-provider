import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runMain } from "./releases/common.mjs";

// Installs the pinned managed runtime with the plugin's own installer, so CI
// and local checks exercise the same downloads and verification as the
// Settings screen. Honors XDG_DATA_HOME for an isolated destination.
async function loadInstaller() {
  const result = await build({
    stdin: {
      contents:
        'export { ManagedRuntimeInstaller, resolveManagedRuntime } from "./server/runtime/managed.ts";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
}

runMain(import.meta.url, async () => {
  const { ManagedRuntimeInstaller, resolveManagedRuntime } =
    await loadInstaller();
  const installer = new ManagedRuntimeInstaller();
  installer.start();
  let last = "";
  const timer = setInterval(() => {
    const state = installer.state();
    const line =
      state.state === "running"
        ? `${state.component} ${state.phase} ${Math.floor((state.receivedBytes / Math.max(state.totalBytes, 1)) * 100)}%`
        : state.state;
    if (line !== last) console.log(line);
    last = line;
  }, 2000);
  try {
    await installer.settled();
  } finally {
    clearInterval(timer);
  }
  const state = installer.state();
  if (state.state !== "succeeded")
    throw new Error(
      `${state.code ?? "RUNTIME_SETUP_FAILED"}: ${state.message}`,
    );
  console.log(JSON.stringify(await resolveManagedRuntime(), null, 2));
});
