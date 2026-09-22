import { execFile } from "node:child_process";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { gte, valid } from "semver";
import { z } from "zod";
import { AdapterError } from "../errors.js";
import { assessCompatibility, MINIMUM_NODE_VERSION } from "./manifest.js";
import type { DiscoveredRuntime, RuntimeSmokeResult } from "./types.js";

export interface DiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}
export function runtimeEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.ELECTRON_RUN_AS_NODE;
  return result;
}
async function run(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        env: environment,
        signal,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error)
          reject(
            new AdapterError(
              "RUNTIME_SMOKE_FAILED",
              "Configured ZCode executable failed its runtime check",
            ),
          );
        else resolve(stdout.trim());
      },
    );
  });
}
export async function discoverRuntime({
  environment = process.env,
  signal,
}: DiscoveryOptions = {}): Promise<DiscoveredRuntime> {
  const configured = ["PASEO_ZCODE_RUNTIME", "PASEO_ZCODE_NODE"] as const;
  for (const name of configured) {
    if (!environment[name] || !isAbsolute(environment[name]!))
      throw new AdapterError(
        "RUNTIME_DISCOVERY_FAILED",
        `${name} must be an absolute path`,
      );
  }
  try {
    const installRoot = await realpath(environment.PASEO_ZCODE_RUNTIME!);
    const executable = await realpath(environment.PASEO_ZCODE_NODE!);
    if (
      !(await stat(installRoot)).isDirectory() ||
      !(await stat(executable)).isFile()
    )
      throw new Error("Invalid runtime path");
    await access(executable, constants.X_OK);
    const paths = {
      installRoot,
      executable,
      serverEntry: join(installRoot, "server/remote/zcode-server.cjs"),
      cliEntry: join(installRoot, "agent/zcode.cjs"),
      appPackage: join(installRoot, "package.json"),
      builtinProviderConfig: join(
        installRoot,
        "agent/provider/zcode-builtin.json",
      ),
    };
    for (const file of [
      paths.serverEntry,
      paths.cliEntry,
      paths.appPackage,
      paths.builtinProviderConfig,
    ])
      if (!(await stat(file)).isFile()) throw new Error("Missing runtime file");
    // Run Electron in Node mode only during identification, so a mistaken path
    // cannot launch its desktop UI. It is rejected before any Server starts.
    const node = z
      .object({
        node: z.string(),
        electron: z.string().optional(),
        platform: z.string(),
        arch: z.string(),
      })
      .parse(
        JSON.parse(
          await run(
            executable,
            [
              "-e",
              "console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch}))",
            ],
            { ...environment, ELECTRON_RUN_AS_NODE: "1" },
            signal,
          ),
        ),
      );
    if (
      node.electron ||
      !valid(node.node) ||
      !gte(node.node, MINIMUM_NODE_VERSION)
    )
      throw new AdapterError(
        "UNSUPPORTED_ZCODE",
        `PASEO_ZCODE_NODE requires ordinary Node.js >=${MINIMUM_NODE_VERSION}; Electron is unsupported`,
      );
    const pkg = z
      .object({ name: z.literal("zcode-runtime"), version: z.string() })
      .parse(JSON.parse(await readFile(paths.appPackage, "utf8")));
    const env = runtimeEnvironment(environment);
    const [serverVersion, cliOutput, serverBytes, cliBytes] = await Promise.all(
      [
        run(executable, [paths.serverEntry, "--version"], env, signal),
        run(executable, [paths.cliEntry, "--version"], env, signal),
        readFile(paths.serverEntry),
        readFile(paths.cliEntry),
      ],
    );
    if (serverVersion !== pkg.version)
      throw new AdapterError(
        "UNSUPPORTED_ZCODE",
        "ZCode runtime package and Server versions differ",
      );
    const cliVersion = cliOutput.match(
      /^(?:zcode\s+)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/i,
    )?.[1];
    if (!cliVersion)
      throw new AdapterError(
        "UNSUPPORTED_ZCODE",
        "ZCode Agent returned an invalid version",
      );
    const identity = {
      platform: `${node.platform}-${node.arch}`,
      appVersion: serverVersion,
      cliVersion,
      nodeVersion: node.node,
      cliSha256: createHash("sha256").update(cliBytes).digest("hex"),
      serverSha256: createHash("sha256").update(serverBytes).digest("hex"),
    };
    const compatibility = assessCompatibility(identity);
    return {
      paths,
      identity,
      compatibility: compatibility.status,
      compatibilityReason: compatibility.reason,
      writableInstallRoot: await access(installRoot, constants.W_OK).then(
        () => true,
        () => false,
      ),
    };
  } catch (error) {
    if (error instanceof AdapterError || signal?.aborted) throw error;
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Configured ZCode runtime is missing required files or has invalid metadata",
    );
  }
}
export function assertRuntimeSupported(runtime: DiscoveredRuntime): void {
  if (runtime.compatibility !== "supported")
    throw new AdapterError("UNSUPPORTED_ZCODE", runtime.compatibilityReason);
}
export async function runRuntimeSmoke(
  runtime: DiscoveredRuntime,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<RuntimeSmokeResult> {
  // Discovery checks both executable versions. Protocol and V4 are checked by
  // the real Server connection, without inspecting an embedded bundle export.
  try {
    assertRuntimeSupported(runtime);
    const version = await run(
      runtime.paths.executable,
      [runtime.paths.serverEntry, "--version"],
      runtimeEnvironment(environment),
      signal,
    );
    return {
      passed: version === runtime.identity.appVersion,
      cliVersion: runtime.identity.cliVersion,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { passed: false, error: "ZCode runtime check failed" };
  }
}
