import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { AdapterError } from "../errors.js";
import {
  MANAGED_NODE_ARCHIVES,
  MANAGED_NODE_VERSION,
  MANAGED_ZCODE_ARCHIVE,
  MANAGED_ZCODE_VERSION,
  managedPlatform,
  type ManagedPlatform,
  type PinnedArchive,
} from "./pins.js";

export type ManagedComponentId = "node" | "zcode";

export interface ManagedComponent {
  readonly id: ManagedComponentId;
  readonly version: string;
  readonly archive: PinnedArchive;
  /** Final directory; it exists only after a verified, complete install. */
  readonly directory: string;
}

export interface ManagedLayout {
  readonly root: string;
  readonly platform: ManagedPlatform;
  readonly node: ManagedComponent & { readonly executable: string };
  readonly zcode: ManagedComponent;
}

// Files the provider launches or must ship with the redistributed runtime.
export const MANAGED_ZCODE_FILES = [
  "package.json",
  "bin/zcode.mjs",
  "server/remote/zcode-server.cjs",
  "agent/zcode.cjs",
  "agent/provider/zcode-builtin.json",
  "LICENSE",
  "NOTICE.md",
  "THIRD-PARTY-NOTICES.md",
] as const;

const MARKER = ".paseo-managed.json";
const markerSchema = z
  .object({ version: z.string(), archiveSha256: z.string() })
  .strict();

// Outside the plugin checkout so plugin updates do not download the runtime
// again. Each OS uses its per-user data convention: Windows' non-roaming
// %LOCALAPPDATA%, otherwise ~/.local/share. An absolute XDG_DATA_HOME is an
// explicit override everywhere (CI isolates with it); relative values are
// ignored as the XDG specification requires.
export function managedRuntimeRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const absolute = (value: string | undefined) =>
    value !== undefined && isAbsolute(value) ? value : undefined;
  const base =
    absolute(environment.XDG_DATA_HOME) ??
    (platform === "win32"
      ? (absolute(environment.LOCALAPPDATA) ??
        join(homedir(), "AppData", "Local"))
      : join(homedir(), ".local", "share"));
  return join(base, "paseo-plugin-zcode-provider", "runtimes");
}

export function managedLayout(
  environment: NodeJS.ProcessEnv = process.env,
  platform: ManagedPlatform | undefined = managedPlatform(),
): ManagedLayout | undefined {
  if (platform === undefined) return undefined;
  const root = managedRuntimeRoot(environment);
  const nodeDirectory = join(root, `node-v${MANAGED_NODE_VERSION}-${platform}`);
  return {
    root,
    platform,
    node: {
      id: "node",
      version: MANAGED_NODE_VERSION,
      archive: MANAGED_NODE_ARCHIVES[platform],
      directory: nodeDirectory,
      executable: platform.startsWith("win-")
        ? join(nodeDirectory, "node.exe")
        : join(nodeDirectory, "bin", "node"),
    },
    zcode: {
      id: "zcode",
      version: MANAGED_ZCODE_VERSION,
      archive: MANAGED_ZCODE_ARCHIVE,
      directory: join(
        root,
        `zcode-${MANAGED_ZCODE_VERSION}-${MANAGED_ZCODE_ARCHIVE.sha256.slice(0, 12)}`,
      ),
    },
  };
}

export async function isInstalled(
  component: ManagedComponent,
): Promise<boolean> {
  try {
    const marker = markerSchema.parse(
      JSON.parse(await readFile(join(component.directory, MARKER), "utf8")),
    );
    return (
      marker.version === component.version &&
      marker.archiveSha256 === component.archive.sha256
    );
  } catch {
    return false;
  }
}

/** Paths for discovery when both pinned components are installed. */
export async function resolveManagedRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ installRoot: string; executable: string } | undefined> {
  const layout = managedLayout(environment);
  if (
    layout === undefined ||
    !(await isInstalled(layout.node)) ||
    !(await isInstalled(layout.zcode))
  )
    return undefined;
  return {
    installRoot: layout.zcode.directory,
    executable: layout.node.executable,
  };
}

export interface SetupProgress {
  readonly component: ManagedComponentId;
  readonly phase: "download" | "extract" | "verify";
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

export type SetupState =
  | { readonly state: "idle" }
  | ({ readonly state: "running" } & SetupProgress)
  | { readonly state: "succeeded" }
  | {
      readonly state: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface InstallerDependencies {
  /** Replaces the pinned layout; tests use it to install local archives. */
  readonly layout?: ManagedLayout;
  readonly fetch?: typeof fetch;
  readonly extract?: (archive: string, destination: string) => Promise<void>;
  readonly nodeVersion?: (executable: string) => Promise<string>;
}

function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    ),
  );
}

// System tar reads .tar.gz everywhere and .zip on Windows. Windows uses its own
// bsdtar by path: a Git-for-Windows GNU tar on PATH cannot read zip archives.
export function extractWithSystemTar(
  archive: string,
  destination: string,
): Promise<void> {
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  return execute(tar, ["-xf", archive, "-C", destination]).then(() => {});
}

const setupFailure = (message: string, cause?: unknown) =>
  new AdapterError("RUNTIME_SETUP_FAILED", message, {}, { cause });

/**
 * Installs the pinned Node.js and ZCode runtime. One job runs at a time per
 * plugin process; a lock directory also guards other processes sharing the root.
 */
export class ManagedRuntimeInstaller {
  private current: SetupState = { state: "idle" };
  private job: Promise<void> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly extract: (
    archive: string,
    destination: string,
  ) => Promise<void>;
  private readonly nodeVersion: (executable: string) => Promise<string>;
  private readonly fixedLayout: ManagedLayout | undefined;

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    // null disables managed setup; tests use it for unsupported hosts.
    private readonly platform: ManagedPlatform | null = managedPlatform() ??
      null,
    dependencies: InstallerDependencies = {},
  ) {
    this.fixedLayout = dependencies.layout;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.extract = dependencies.extract ?? extractWithSystemTar;
    this.nodeVersion =
      dependencies.nodeVersion ??
      ((executable) => execute(executable, ["--version"]));
  }

  layout(): ManagedLayout | undefined {
    if (this.fixedLayout !== undefined) return this.fixedLayout;
    return this.platform === null
      ? undefined
      : managedLayout(this.environment, this.platform);
  }

  state(): SetupState {
    return this.current;
  }

  /** Starts setup unless it is already running; returns whether it started. */
  start(): boolean {
    if (this.job !== undefined) return false;
    this.current = {
      state: "running",
      component: "node",
      phase: "download",
      receivedBytes: 0,
      totalBytes: this.layout()?.node.archive.size ?? 0,
    };
    this.job = this.install()
      .then(
        () => {
          this.current = { state: "succeeded" };
        },
        (error: unknown) => {
          this.current = {
            state: "failed",
            code:
              error instanceof AdapterError
                ? error.code
                : "RUNTIME_SETUP_FAILED",
            message:
              error instanceof AdapterError
                ? error.message
                : "ZCode runtime setup failed",
          };
        },
      )
      .finally(() => {
        this.job = undefined;
      });
    return true;
  }

  /** Resolves when the current job, if any, has finished. */
  async settled(): Promise<void> {
    await this.job;
  }

  async remove(): Promise<void> {
    const layout = this.layout();
    if (this.job !== undefined)
      throw setupFailure("ZCode runtime setup is still running");
    const root = layout?.root ?? managedRuntimeRoot(this.environment);
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      throw setupFailure(
        "The managed runtime could not be removed. Stop running ZCode sessions and try again.",
        error,
      );
    }
    this.current = { state: "idle" };
  }

  private async install(): Promise<void> {
    const layout = this.layout();
    if (layout === undefined)
      throw new AdapterError(
        "UNSUPPORTED_PLATFORM",
        "Managed ZCode setup is not available on this platform",
      );
    if (!/^[0-9a-f]{64}$/u.test(layout.zcode.archive.sha256))
      throw setupFailure("This plugin build has no pinned ZCode runtime");
    await mkdir(layout.root, { recursive: true });
    const lock = await acquireLock(join(layout.root, ".lock"));
    try {
      await this.installComponent(layout, layout.node, async (directory) => {
        const executable = join(
          directory,
          relative(layout.node.directory, layout.node.executable),
        );
        if ((await this.nodeVersion(executable)) !== `v${layout.node.version}`)
          throw setupFailure("The downloaded Node.js failed its version check");
      });
      await this.installComponent(layout, layout.zcode, async (directory) => {
        for (const file of MANAGED_ZCODE_FILES)
          await access(join(directory, file)).catch((error) => {
            throw setupFailure(
              `The ZCode runtime archive is missing ${file}`,
              error,
            );
          });
      });
      await this.removeStaleVersions(layout);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private async installComponent(
    layout: ManagedLayout,
    component: ManagedComponent,
    verify: (directory: string) => Promise<void>,
  ): Promise<void> {
    if (await isInstalled(component)) return;
    const stagingRoot = join(layout.root, ".staging");
    await mkdir(stagingRoot, { recursive: true });
    const staging = await mkdtemp(join(stagingRoot, `${component.id}-`));
    try {
      const archive = join(
        staging,
        component.archive.url.endsWith(".zip") ? "archive.zip" : "archive.tgz",
      );
      await this.download(component, archive);
      this.progress(component, "extract");
      const extracted = join(staging, "extracted");
      await mkdir(extracted);
      await this.extract(archive, extracted).catch((error) => {
        throw setupFailure(
          `The ${label(component)} archive could not be extracted`,
          error,
        );
      });
      const entries = await readdir(extracted);
      if (entries.length !== 1)
        throw setupFailure(
          `The ${label(component)} archive has an unexpected layout`,
        );
      const top = join(extracted, entries[0]!);
      if (!(await stat(top)).isDirectory())
        throw setupFailure(
          `The ${label(component)} archive has an unexpected layout`,
        );
      this.progress(component, "verify");
      await verify(top);
      await writeFile(
        join(top, MARKER),
        JSON.stringify({
          version: component.version,
          archiveSha256: component.archive.sha256,
        }),
      );
      // A directory without a valid marker is an interrupted earlier attempt.
      await rm(component.directory, { recursive: true, force: true });
      await rename(top, component.directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async download(
    component: ManagedComponent,
    destination: string,
  ): Promise<void> {
    const { url, sha256, size } = component.archive;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { redirect: "follow" });
    } catch (error) {
      throw setupFailure(
        `Cannot download ${label(component)} from ${url}`,
        error,
      );
    }
    if (!response.ok || response.body === null)
      throw setupFailure(
        `Download of ${label(component)} failed with HTTP ${response.status}`,
      );
    const hash = createHash("sha256");
    let received = 0;
    this.progress(component, "download", received);
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        hash.update(chunk);
        received += chunk.length;
        if (received > size)
          return callback(
            setupFailure(`${label(component)} is larger than the pinned size`),
          );
        this.progress(component, "download", received);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
        meter,
        createWriteStream(destination, { flags: "wx" }),
      );
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw setupFailure(
        `Download of ${label(component)} was interrupted`,
        error,
      );
    }
    if (hash.digest("hex") !== sha256)
      throw setupFailure(
        `${label(component)} does not match its pinned SHA-256`,
      );
  }

  private progress(
    component: ManagedComponent,
    phase: SetupProgress["phase"],
    receivedBytes = component.archive.size,
  ): void {
    this.current = {
      state: "running",
      component: component.id,
      phase,
      receivedBytes,
      totalBytes: component.archive.size,
    };
  }

  private async removeStaleVersions(layout: ManagedLayout): Promise<void> {
    const keep = new Set([layout.node.directory, layout.zcode.directory]);
    for (const entry of await readdir(layout.root)) {
      const path = join(layout.root, entry);
      if (
        !keep.has(path) &&
        (entry === ".staging" || /^(node-v|zcode-)/u.test(entry))
      )
        await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// A crashed setup leaves its lock behind; reclaim it only when its owner is gone.
async function acquireLock(lock: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), String(process.pid));
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw setupFailure(
          "Cannot create the managed runtime directory",
          error,
        );
    }
    const owner = Number(
      await readFile(join(lock, "owner"), "utf8").catch(() => ""),
    );
    if (Number.isSafeInteger(owner) && owner > 0 && processExists(owner))
      throw setupFailure("Another ZCode runtime setup is running");
    await rm(lock, { recursive: true, force: true });
  }
  throw setupFailure("Another ZCode runtime setup is running");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const label = (component: ManagedComponent) =>
  component.id === "node"
    ? `Node.js ${component.version}`
    : `ZCode runtime ${component.version}`;
