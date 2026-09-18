import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runMain } from "./releases/common.mjs";

const root = resolve(import.meta.dirname, "..");
const checks = ["check-model-plan-runtime.mjs", "check-steering-runtime.mjs"];

// ZCode 3.12.3 personal provider schema. No account login or existing user
// configuration is needed. Both models use the user's Z.ai Coding Plan key.
export function e2eProviderConfig(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error("GLM_API_KEY is required for real-model E2E tests");
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["paseo-e2e"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "paseo-e2e",
            providerName: "Paseo E2E",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "zhipu-coding-plan-api-key", apiKey },
              api: {
                type: "openai-chat-completions",
                baseUrl: "https://api.z.ai/api/coding/paas/v4",
              },
              personalModelIds: ["GLM-5.3-Flash", "GLM-5.3"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: "paseo-e2e",
        modelId: "GLM-5.3-Flash",
      },
    },
  };
}

async function runCheck(script, environment) {
  await new Promise((resolveResult, reject) => {
    // Each check closes its Provider connection on SIGTERM, which shuts down
    // the official host and its CLI before this runner removes the test data.
    const child = spawn(process.execPath, [join(root, "scripts", script)], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    let interrupted;
    const cancel = () => {
      interrupted = new Error(`${script} was cancelled`);
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      interrupted = new Error(`${script} exceeded the 8-minute E2E timeout`);
      child.kill("SIGTERM");
    }, 480_000);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      if (interrupted) reject(interrupted);
      else if (code !== 0) reject(new Error(`${script} failed: exit ${code}`));
      else resolveResult();
    });
  });
}

export async function runE2E({
  environment = process.env,
  run = runCheck,
} = {}) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("The isolated E2E runner requires macOS or Linux");
  const config = e2eProviderConfig(environment.GLM_API_KEY);
  // The native CLI puts Unix sockets below TMPDIR. macOS's long default temp
  // path plus a nested test directory exceeds sockaddr_un.sun_path (EINVAL).
  const directory = await realpath(await mkdtemp("/tmp/zcode-e2e-"));
  try {
    const configDirectory = join(directory, ".zcode", "v2");
    const temporary = join(directory, "tmp");
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    await writeFile(
      join(configDirectory, "provider_config.json"),
      JSON.stringify(config),
      { mode: 0o600, flag: "wx" },
    );
    // Do not pass GLM_API_KEY or unrelated credentials to the test subprocess.
    // Keep HOME unchanged; the official ZCODE_DATA_BASE_DIR isolates ZCode data.
    const childEnvironment = Object.fromEntries(
      ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "PASEO_ZCODE_INSTALL"]
        .filter((key) => environment[key] !== undefined)
        .map((key) => [key, environment[key]]),
    );
    Object.assign(childEnvironment, {
      ZCODE_DATA_BASE_DIR: directory,
      ZCODE_STORAGE_DIR: join(directory, ".zcode"),
      ZCODE_CUA_PRODUCT_HELPER: "0",
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    });
    for (const script of checks) {
      console.log(`E2E: ${script}`);
      await run(script, childEnvironment);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

runMain(import.meta.url, () => runE2E());
