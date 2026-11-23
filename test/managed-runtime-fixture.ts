import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  MANAGED_ZCODE_FILES,
  ManagedRuntimeInstaller,
  managedLayout,
  type ManagedLayout,
} from "../server/runtime/managed.js";

const directories: string[] = [];

/** Removes the directories `temporary` created; call it after each test. */
export async function removeTemporaryDirectories(): Promise<void> {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
}

export async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

// Builds a .tar.gz with one top-level directory, like the real archives.
async function archive(top: string, files: readonly string[]) {
  const source = await temporary("zcode-archive-source-");
  for (const file of files) {
    await mkdir(join(source, top, file, ".."), { recursive: true });
    await writeFile(join(source, top, file), `${top}/${file}`);
  }
  const output = join(await temporary("zcode-archive-"), "archive.tgz");
  execFileSync("tar", ["-czf", output, "-C", source, top]);
  const bytes = await readFile(output);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

/** The pinned layout under a temporary data directory, served from local archives. */
export async function managedFixture() {
  const data = await temporary("zcode-managed-");
  const base = managedLayout({ XDG_DATA_HOME: data }, "linux-x64")!;
  const node = await archive("node-fixture", ["bin/node"]);
  const zcode = await archive("zcode", MANAGED_ZCODE_FILES);
  const layout: ManagedLayout = {
    ...base,
    node: {
      ...base.node,
      archive: { url: "https://example.test/node.tgz", ...node },
    },
    zcode: {
      ...base.zcode,
      archive: { url: "https://example.test/zcode.tgz", ...zcode },
    },
  };
  const bodies = new Map([
    [layout.node.archive.url, node.bytes],
    [layout.zcode.archive.url, zcode.bytes],
  ]);
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const body = bodies.get(String(url));
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body);
  });
  const nodeVersion = vi.fn(async () => `v${layout.node.version}`);
  const installer = new ManagedRuntimeInstaller({}, "linux-x64", {
    layout,
    fetch: fetch as typeof globalThis.fetch,
    nodeVersion,
  });
  return { data, layout, bodies, fetch, nodeVersion, installer };
}
