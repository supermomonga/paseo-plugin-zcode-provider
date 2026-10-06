import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UsageReportSchema } from "@getpaseo/protocol/messages";
import { ProviderStatusSchema } from "@getpaseo/plugin/server/provider";

// Opt-in check of the Paseo 0.11 provider status and usage source (ADR 18)
// against the installed runtime and the existing ZCode sign-in. It reads
// Coding Plan quota through ZCode's usage service and writes no settings.
// Output omits account names and keys.
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "zcode-usage-runtime-"));
const abort = new AbortController();
let account, usage;
try {
  await build({
    entryPoints: {
      account: join(root, "server/account.ts"),
      provider: join(root, "server/provider.ts"),
      status: join(root, "server/provider-status.ts"),
      usage: join(root, "server/usage.ts"),
    },
    outdir: directory,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const load = (name) =>
    import(pathToFileURL(join(directory, `${name}.mjs`)).href);
  const { AccountService } = await load("account");
  const { createHost } = await load("provider");
  const { createRuntimeStatus } = await load("status");
  const { createUsageSource } = await load("usage");

  const status = ProviderStatusSchema.parse(await createRuntimeStatus()({}));
  account = new AccountService(() => createHost({}, abort.signal, homedir()));
  usage = createUsageSource(account);
  const accounts = await usage.source.discover({ kind: "global" });
  const reports = [];
  for (const entry of accounts) {
    const report = UsageReportSchema.parse(
      await usage.source.fetch(usage.source.input.parse(entry.input)),
    );
    reports.push(
      report.status === "available"
        ? {
            status: report.status,
            planLabel: report.planLabel,
            windows: report.windows.map((window) => ({
              id: window.id,
              label: window.label,
              usedPct: window.usedPct,
              resetsAt: window.resetsAt ? "set" : null,
              tone: window.tone,
            })),
          }
        : report,
    );
  }
  console.log(
    JSON.stringify(
      {
        status,
        accounts: accounts.map((entry) => ({
          key: entry.key.replace(/[0-9a-f]{24}$/, "<hash>"),
          harness: entry.harness,
          providerId: entry.input.providerId,
        })),
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  usage?.dispose();
  abort.abort();
  await account?.close();
  await rm(directory, { recursive: true, force: true });
}
