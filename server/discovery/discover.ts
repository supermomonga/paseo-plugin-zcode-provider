import { spawn } from "node:child_process";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";

import { AdapterError } from "../errors.js";
import {
  resolveHostIndex,
  resolveHostImports,
  RPC_INSPECTION_SOURCE,
} from "./host-contract.js";
import {
  assessCompatibility,
  CURRENT_HOST_PROTOCOL,
  VERIFIED_ZCODE_ARTIFACT,
} from "./manifest.js";
import {
  diagnosticError,
  runtimeDiagnostic,
  type RuntimeDiagnostic,
} from "../diagnostics.js";
import type {
  BundleMetadata,
  DiscoveredRuntime,
  RuntimePaths,
  RuntimeSmokeResult,
} from "./types.js";

const BundleMetadataSchema = z
  .object({
    runtime: z.literal("electron-node"),
    entry: z.literal("zcode.cjs"),
    platform: z.string().min(1),
    source: z.literal("apps/zcode-cli/packages/cli/dist/zcode.cjs"),
  })
  .strict();

const HostInspectionSchema = z
  .object({
    hostIndexSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    hostRpcModuleSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    hostRpcModule: z.string().min(1),
    rpcExports: z
      .object({
        protocol: z.string().min(1),
        client: z.string().min(1),
        service: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export interface DiscoveryOptions {
  readonly installRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly signal?: AbortSignal;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
}

const INSPECTION_TIMEOUT_MS = 60_000;

async function run(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    maxOutputBytes?: number;
  },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment,
      signal: options.signal,
      timeout: INSPECTION_TIMEOUT_MS,
      killSignal: "SIGTERM",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > (options.maxOutputBytes ?? 1024 * 1024)) {
        child.kill("SIGTERM");
        reject(
          new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "ZCode inspection output is too large",
          ),
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(
          new AdapterError(
            "NATIVE_EXITED",
            `ZCode runtime terminated by ${signal}`,
          ),
        );
        return;
      }
      resolve({ exitCode: code ?? -1, stdout });
    });
  });
}

export async function discoverRuntime(
  options: DiscoveryOptions = {},
): Promise<DiscoveredRuntime> {
  const diagnostic: RuntimeDiagnostic = {
    stage: "discovery",
    platform: `${options.platform ?? process.platform}-${options.architecture ?? process.arch}`,
  };
  try {
    return await discoverRuntimeInternal(options, diagnostic);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw diagnosticError(error, diagnostic, "RUNTIME_DISCOVERY_FAILED");
  }
}

async function discoverRuntimeInternal(
  options: DiscoveryOptions,
  diagnostic: RuntimeDiagnostic,
): Promise<DiscoveredRuntime> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  options.signal?.throwIfAborted();
  const detectedPlatform = `${platform}-${architecture}`;
  if (
    ![
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ].includes(detectedPlatform)
  ) {
    throw new AdapterError(
      "UNSUPPORTED_PLATFORM",
      `Unsupported platform: ${detectedPlatform}`,
    );
  }
  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
  };
  const configuredRoot =
    options.installRoot ??
    environment.PASEO_ZCODE_INSTALL ??
    defaultInstallRoot(platform, environment);
  if (!isAbsolute(configuredRoot)) {
    throw new AdapterError(
      "INVALID_CONFIGURATION",
      "ZCode install root must be absolute",
    );
  }
  let installRoot: string;
  try {
    installRoot = await realpath(configuredRoot);
  } catch (error) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "ZCode install root does not exist",
      {},
      { cause: error },
    );
  }
  const paths = resolveRuntimePaths(installRoot, platform);
  await validatePaths(paths);
  const metadataValue: unknown = JSON.parse(
    await readFile(paths.metadata, "utf8"),
  );
  Object.assign(diagnostic, { check: "bundle-metadata" });
  const bundle = validateBundleMetadata(metadataValue, detectedPlatform);
  Object.assign(diagnostic, { stage: "version", check: "minimum-version" });
  const [appVersion, cliSha256, metadataSha256, cliResult] = await Promise.all([
    readAppVersion(paths, environment, options.signal),
    sha256(paths.cliEntry),
    sha256(paths.metadata),
    run(paths.executable, [paths.cliEntry, "version"], {
      cwd: installRoot,
      environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  ]);
  const cliVersion =
    cliResult.exitCode === 0 ? cliResult.stdout.trim() : undefined;
  const identity = {
    platform: detectedPlatform,
    appVersion,
    ...(cliVersion === undefined ? {} : { cliVersion }),
    cliSha256,
    metadataSha256,
    bundle,
  };
  const assessment = assessCompatibility(identity);
  Object.assign(diagnostic, { appVersion, cliVersion });
  if (assessment.status === "supported")
    Object.assign(diagnostic, {
      stage: "host-inspection",
      check: "host-entry",
    });
  const host =
    assessment.status === "supported"
      ? await resolveHost(paths, environment, options.signal)
      : undefined;
  const rootStat = await stat(installRoot);
  return {
    paths,
    identity,
    ...(host === undefined
      ? {}
      : {
          resolvedHost: {
            ...host,
            artifactMatch:
              appVersion === VERIFIED_ZCODE_ARTIFACT.appVersion &&
              cliVersion === VERIFIED_ZCODE_ARTIFACT.cliVersion &&
              cliSha256 === VERIFIED_ZCODE_ARTIFACT.cliSha256 &&
              host.hostIndexSha256 ===
                VERIFIED_ZCODE_ARTIFACT.hostIndexSha256 &&
              host.hostRpcModuleSha256 ===
                VERIFIED_ZCODE_ARTIFACT.hostRpcModuleSha256,
          },
        }),
    compatibility: assessment.status,
    compatibilityReason: assessment.reason,
    writableInstallRoot: (rootStat.mode & 0o022) !== 0,
  };
}

export async function runRuntimeSmoke(
  runtime: DiscoveredRuntime,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<RuntimeSmokeResult> {
  try {
    const commandEnvironment = { ...environment, ELECTRON_RUN_AS_NODE: "1" };
    const [version, doctor] = await Promise.all([
      run(runtime.paths.executable, [runtime.paths.cliEntry, "version"], {
        cwd: runtime.paths.installRoot,
        environment: commandEnvironment,
        ...(signal === undefined ? {} : { signal }),
      }),
      run(
        runtime.paths.executable,
        [runtime.paths.cliEntry, "doctor", "--json"],
        {
          cwd: runtime.paths.installRoot,
          environment: commandEnvironment,
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    ]);
    return {
      passed: version.exitCode === 0 && doctor.exitCode === 0,
      ...(runtime.identity.cliVersion === undefined
        ? {}
        : { cliVersion: runtime.identity.cliVersion }),
      doctorPassed: doctor.exitCode === 0,
      authentication: "unknown",
      ...(version.exitCode === 0 && doctor.exitCode === 0
        ? {}
        : { error: "Bundled version or doctor command failed" }),
    };
  } catch (error) {
    return {
      passed: false,
      doctorPassed: false,
      authentication: "unknown",
      error: error instanceof Error ? error.message : "Runtime smoke failed",
    };
  }
}

export function assertRuntimeSupported(runtime: DiscoveredRuntime): void {
  if (runtime.compatibility !== "supported") {
    throw new AdapterError(
      "UNSUPPORTED_ZCODE",
      runtime.compatibilityReason,
      {
        platform: runtime.identity.platform,
        appVersion: runtime.identity.appVersion,
        cliVersion: runtime.identity.cliVersion,
        hostProtocol: runtime.resolvedHost?.protocol.id,
      },
      undefined,
      {
        ...runtimeDiagnostic(runtime),
        stage: "version",
        check: "minimum-version",
      },
    );
  }
}

export function defaultInstallRoot(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  switch (platform) {
    case "darwin":
      return "/Applications/ZCode.app";
    case "linux":
      return "/opt/ZCode";
    case "win32": {
      const localAppData = environment.LOCALAPPDATA;
      if (!localAppData || !isAbsolute(localAppData)) {
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "Set LOCALAPPDATA to an absolute path or set PASEO_ZCODE_INSTALL to the absolute ZCode install root",
        );
      }
      return join(localAppData, "Programs", "ZCode");
    }
    default:
      throw new AdapterError(
        "UNSUPPORTED_PLATFORM",
        `Unsupported platform: ${platform}`,
      );
  }
}

export function validateBundleMetadata(
  value: unknown,
  detectedPlatform: string,
): BundleMetadata {
  const bundle = BundleMetadataSchema.parse(value);
  if (bundle.platform !== detectedPlatform) {
    throw new AdapterError(
      "UNSUPPORTED_PLATFORM",
      "ZCode bundle platform does not match the current process",
    );
  }
  return bundle;
}

export function resolveRuntimePaths(
  installRoot: string,
  platform: NodeJS.Platform,
): RuntimePaths {
  if (platform === "linux" || platform === "win32") {
    return {
      installRoot,
      executable: join(
        installRoot,
        platform === "win32" ? "ZCode.exe" : "zcode",
      ),
      cliEntry: join(installRoot, "resources/glm/zcode.cjs"),
      metadata: join(installRoot, "resources/glm/.node-bundle-meta.json"),
      appPackage: join(installRoot, "resources/app.asar/package.json"),
      hostArchive: join(installRoot, "resources/app.asar"),
    };
  }
  if (platform !== "darwin") {
    throw new AdapterError(
      "UNSUPPORTED_PLATFORM",
      `Unsupported platform: ${platform}`,
    );
  }
  return {
    installRoot,
    executable: join(
      installRoot,
      "Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper",
    ),
    cliEntry: join(installRoot, "Contents/Resources/glm/zcode.cjs"),
    metadata: join(
      installRoot,
      "Contents/Resources/glm/.node-bundle-meta.json",
    ),
    appMetadata: join(installRoot, "Contents/Info.plist"),
    appPackage: join(installRoot, "Contents/Resources/app.asar/package.json"),
    hostArchive: join(installRoot, "Contents/Resources/app.asar"),
  };
}

async function validatePaths(paths: RuntimePaths): Promise<void> {
  try {
    for (const candidate of [
      paths.executable,
      paths.cliEntry,
      paths.metadata,
      ...(paths.appMetadata === undefined ? [] : [paths.appMetadata]),
    ]) {
      const resolved = await realpath(candidate);
      ensureInside(paths.installRoot, resolved);
      await access(resolved, constants.R_OK);
    }
    const hostArchive = await realpath(paths.hostArchive);
    ensureInside(paths.installRoot, hostArchive);
    const hostArchiveStat = await stat(hostArchive);
    if (!hostArchiveStat.isFile() && !hostArchiveStat.isDirectory()) {
      throw new Error("ZCode host archive has an unsupported file type");
    }
    await access(paths.executable, constants.X_OK);
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Required ZCode runtime files are unavailable",
      {},
      { cause: error },
    );
  }
}

function ensureInside(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Resolved runtime path is outside the install root",
    );
  }
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function readAppVersion(
  paths: RuntimePaths,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  if (paths.appMetadata !== undefined) {
    return readPlist(
      paths.appMetadata,
      "CFBundleShortVersionString",
      environment,
      signal,
    );
  }
  const script =
    `const value=require(${JSON.stringify(paths.appPackage)});` +
    'if(typeof value.version!=="string")process.exit(2);process.stdout.write(value.version)';
  const result = await run(paths.executable, ["-e", script], {
    cwd: paths.installRoot,
    environment,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "ZCode app package version is unavailable",
    );
  }
  return result.stdout.trim();
}

async function readPlist(
  file: string,
  key: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const result = await run(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, file],
    {
      cwd: dirname(file),
      environment,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      `ZCode Info.plist is missing ${key}`,
    );
  }
  return result.stdout.trim();
}

async function resolveHost(
  paths: RuntimePaths,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<
  Omit<NonNullable<DiscoveredRuntime["resolvedHost"]>, "artifactMatch">
> {
  const hostIndex = resolveHostIndex(paths.installRoot, paths.hostArchive);
  const commandOptions = {
    cwd: paths.installRoot,
    environment,
    ...(signal ? { signal } : {}),
  };
  // ASAR contents are read by bundled Electron, not the system Node filesystem.
  const source = await run(
    paths.executable,
    [
      "-e",
      RPC_INSPECTION_SOURCE +
        `
inside(${JSON.stringify(paths.installRoot)}, ${JSON.stringify(hostIndex)});
process.stdout.write(fs.readFileSync(${JSON.stringify(hostIndex)}, "utf8"));`,
    ],
    { ...commandOptions, maxOutputBytes: 16 * 1024 * 1024 },
  );
  if (source.exitCode !== 0)
    throw diagnosticError(
      new Error(),
      { stage: "host-inspection", check: "host-entry" },
      "RUNTIME_DISCOVERY_FAILED",
    );
  let modules: string[];
  try {
    modules = await resolveHostImports(
      source.stdout,
      hostIndex,
      paths.installRoot,
    );
  } catch (error) {
    throw diagnosticError(
      error,
      { stage: "host-inspection", check: "host-imports" },
      "RUNTIME_DISCOVERY_FAILED",
    );
  }
  const script =
    RPC_INSPECTION_SOURCE +
    `
console.log = console.info = console.warn = console.error = () => {};
inspectRpcModules(${JSON.stringify(paths.installRoot)}, ${JSON.stringify(hostIndex)}, ${JSON.stringify(modules)})
  .then(result => process.stdout.write(JSON.stringify({ result }), () => process.exit(0)))
  .catch(error => process.stdout.write(JSON.stringify({ failure: ["host-path", "rpc-module-load", "rpc-missing", "rpc-ambiguous"].includes(error.message) ? error.message : "host-inspection-result" }), () => process.exit(0)));`;
  const result = await run(paths.executable, ["-e", script], commandOptions);
  try {
    if (result.exitCode !== 0) throw new Error();
    const envelope = z
      .union([
        z.object({ result: HostInspectionSchema }).strict(),
        z
          .object({
            failure: z.enum([
              "host-path",
              "rpc-module-load",
              "rpc-missing",
              "rpc-ambiguous",
              "host-inspection-result",
            ]),
          })
          .strict(),
      ])
      .parse(JSON.parse(result.stdout));
    if ("failure" in envelope)
      throw diagnosticError(
        new Error(),
        { stage: "host-inspection", check: envelope.failure },
        "RUNTIME_DISCOVERY_FAILED",
      );
    if (!modules.includes(envelope.result.hostRpcModule)) {
      // realpath can normalize an in-root symlink; validate the returned path independently.
      const child = relative(paths.installRoot, envelope.result.hostRpcModule);
      if (child.startsWith("..") || isAbsolute(child))
        throw diagnosticError(
          new Error(),
          { check: "host-path" },
          "RUNTIME_DISCOVERY_FAILED",
        );
    }
    return { ...envelope.result, hostIndex, protocol: CURRENT_HOST_PROTOCOL };
  } catch (error) {
    throw diagnosticError(
      error,
      { stage: "host-inspection", check: "host-inspection-result" },
      "RUNTIME_DISCOVERY_FAILED",
    );
  }
}
