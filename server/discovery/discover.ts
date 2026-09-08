import { spawn } from "node:child_process";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";

import { AdapterError } from "../errors.js";
import {
  resolvedHostMismatch,
  resolveHostContractPaths,
} from "./host-contract.js";
import { assessCompatibility } from "./manifest.js";
import type {
  BundleMetadata,
  DiscoveredRuntime,
  HostArtifactDescriptor,
  HostProtocolDescriptor,
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
    exports: z.array(z.string()),
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
    let stderrBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > 1024 * 1024) {
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
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
    });
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
    defaultInstallRoot(platform);
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
  const bundle = validateBundleMetadata(metadataValue, detectedPlatform);
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
    cliResult.exitCode === 0
      ? cliResult.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0]
      : undefined;
  const identity = {
    platform: detectedPlatform,
    appVersion,
    ...(cliVersion === undefined ? {} : { cliVersion }),
    cliSha256,
    metadataSha256,
    bundle,
  };
  const assessment = assessCompatibility(identity);
  const host =
    assessment.hostArtifact === undefined ||
    assessment.hostProtocol === undefined
      ? undefined
      : await resolveHost(
          paths,
          assessment.hostArtifact,
          assessment.hostProtocol,
          environment,
          options.signal,
        );
  const mismatch =
    host === undefined
      ? undefined
      : resolvedHostMismatch(host.artifact, host.protocol, {
          hostIndexSha256: host.hostIndexSha256,
          hostRpcModuleSha256: host.hostRpcModuleSha256,
          exports: host.rpcExports,
        });
  const rootStat = await stat(installRoot);
  return {
    paths,
    identity,
    ...(assessment.expectedCliSha256 === undefined
      ? {}
      : { expectedCliSha256: assessment.expectedCliSha256 }),
    ...(assessment.cliIntegrity === undefined
      ? {}
      : { cliIntegrity: assessment.cliIntegrity }),
    ...(host === undefined ? {} : { resolvedHost: host }),
    compatibility: mismatch === undefined ? assessment.status : "unsupported",
    compatibilityReason: mismatch ?? assessment.reason,
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
    throw new AdapterError("UNSUPPORTED_ZCODE", runtime.compatibilityReason, {
      platform: runtime.identity.platform,
      appVersion: runtime.identity.appVersion,
      cliVersion: runtime.identity.cliVersion,
      hostArtifact: runtime.resolvedHost?.artifact.id,
      hostProtocol: runtime.resolvedHost?.protocol.id,
    });
  }
}

export function defaultInstallRoot(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Applications/ZCode.app";
    case "linux":
      return "/opt/ZCode";
    case "win32":
      return "C:\\Program Files\\ZCode";
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
  artifact: HostArtifactDescriptor,
  protocol: HostProtocolDescriptor,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<NonNullable<DiscoveredRuntime["resolvedHost"]>> {
  const { hostIndex, hostRpcModule } = resolveHostContractPaths(
    paths.installRoot,
    paths.hostArchive,
    artifact,
  );
  const script = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const hash = value => crypto.createHash("sha256").update(fs.readFileSync(value)).digest("hex");
(async () => {
  const rpc = await import(pathToFileURL(${JSON.stringify(hostRpcModule)}).href);
  process.stdout.write(JSON.stringify({
    hostIndexSha256: hash(${JSON.stringify(hostIndex)}),
    hostRpcModuleSha256: hash(${JSON.stringify(hostRpcModule)}),
    exports: Object.keys(rpc),
  }));
})().catch(() => process.exit(1));`;
  const result = await run(paths.executable, ["-e", script], {
    cwd: paths.installRoot,
    environment,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.exitCode !== 0) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Failed to inspect the manifest-selected ZCode host artifact",
    );
  }
  const inspection = HostInspectionSchema.parse(JSON.parse(result.stdout));
  return {
    artifact,
    protocol,
    hostIndex,
    hostRpcModule,
    hostIndexSha256: inspection.hostIndexSha256,
    hostRpcModuleSha256: inspection.hostRpcModuleSha256,
    rpcExports: inspection.exports,
  };
}
