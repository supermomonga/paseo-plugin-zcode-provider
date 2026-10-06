import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runMain, validateVersion } from "./releases/common.mjs";
import { loadZCodeManifest } from "./zcode-manifest.mjs";

// Repackages the official integrated CLI archive built from unmodified source.
// Only upstream license material and build provenance are added.
export const RUNTIME_TAG_PREFIX = "zcode-runtime-v";
export const REQUIRED_RUNTIME_FILES = [
  "package.json",
  "bin/zcode.mjs",
  "server/remote/zcode-server.cjs",
  "agent/zcode.cjs",
  "agent/provider/zcode-builtin.json",
  "agent/THIRD-PARTY-NOTICES.md",
];
export const UPSTREAM_NOTICE_FILES = [
  "LICENSE",
  "NOTICE.md",
  "THIRD-PARTY-NOTICES.md",
];

export function runtimeVersionFromTag(tag) {
  if (!tag.startsWith(RUNTIME_TAG_PREFIX))
    throw new Error(`Runtime tags must start with ${RUNTIME_TAG_PREFIX}`);
  return validateVersion(tag.slice(RUNTIME_TAG_PREFIX.length));
}

export const runtimeAssetName = (version) =>
  `zcode-runtime-${validateVersion(version)}.tar.gz`;

export async function assertRuntimeLayout(root, files) {
  for (const file of files)
    try {
      await access(join(root, file));
    } catch {
      throw new Error(`Runtime archive is missing ${file}`);
    }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const git = (source, ...args) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();

function createArchive(staging, output, mtime) {
  // GNU tar (CI) gets stable ordering and ownership; bsdtar is enough locally.
  const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes(
    "GNU tar",
  );
  const options = gnu
    ? [
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        `--mtime=@${mtime}`,
        "--use-compress-program=gzip -n -9",
        "-cf",
      ]
    : ["-czf"];
  execFileSync("tar", [...options, output, "-C", staging, "zcode"]);
}

export async function packageRuntime({ source, out, tag }) {
  const { ZCODE_SOURCE_COMMIT } = await loadZCodeManifest();
  const commit = git(source, "rev-parse", "HEAD");
  if (commit !== ZCODE_SOURCE_COMMIT)
    throw new Error(
      `ZCode checkout ${commit} does not match pinned ${ZCODE_SOURCE_COMMIT}`,
    );
  const version = validateVersion(
    JSON.parse(await readFile(join(source, "package.json"), "utf8")).version,
  );
  if (tag !== undefined && runtimeVersionFromTag(tag) !== version)
    throw new Error(`Tag ${tag} does not match ZCode ${version}`);
  const releaseDirectory = join(source, "dist/zcode/releases", version);
  const upstreamArchive = join(releaseDirectory, `zcode-${version}.tar.gz`);
  const upstreamSha256 = await sha256File(upstreamArchive);
  const recorded = (
    await readFile(join(releaseDirectory, "sha256.txt"), "utf8")
  )
    .trim()
    .split(/\s+/u)[0];
  if (recorded !== upstreamSha256)
    throw new Error("Official archive does not match its sha256.txt");

  const staging = await mkdtemp(join(tmpdir(), "zcode-runtime-package-"));
  try {
    execFileSync("tar", ["-xzf", upstreamArchive, "-C", staging]);
    const root = join(staging, "zcode");
    await assertRuntimeLayout(root, REQUIRED_RUNTIME_FILES);
    for (const file of UPSTREAM_NOTICE_FILES) {
      try {
        await access(join(root, file));
        throw new Error(`Official archive already contains ${file}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await copyFile(join(source, file), join(root, file));
    }
    const run = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
    await writeFile(
      join(root, "BUILD-INFO.json"),
      JSON.stringify(
        {
          description:
            "Unofficial build of the ZCode integrated CLI distribution, packaged for paseo-plugin-zcode-provider. It is not endorsed or maintained by ZCode or Z.ai.",
          source: {
            repository: "https://github.com/zai-org/ZCode",
            commit,
            version,
            modified: false,
          },
          build: {
            script: "scripts/build-zcode.mjs",
            officialArchiveSha256: upstreamSha256,
            node: process.version,
            workflowRun: run,
          },
          license:
            "Apache-2.0 for ZCode first-party code. Third-party components keep their own terms; see LICENSE, NOTICE.md and THIRD-PARTY-NOTICES.md.",
        },
        null,
        2,
      ) + "\n",
    );
    await mkdir(out, { recursive: true });
    const asset = runtimeAssetName(version);
    const output = resolve(out, asset);
    createArchive(
      staging,
      output,
      git(source, "show", "-s", "--format=%ct", "HEAD"),
    );
    const sha256 = await sha256File(output);
    const { size } = await stat(output);
    await writeFile(join(out, "SHA256SUMS"), `${sha256}  ${asset}\n`);
    const result = { version, commit, asset, sha256, size };
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        Object.entries(result)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

runMain(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string" },
      out: { type: "string" },
      tag: { type: "string" },
    },
  });
  if (positionals[0] === "commit") {
    const { ZCODE_SOURCE_COMMIT } = await loadZCodeManifest();
    console.log(ZCODE_SOURCE_COMMIT);
    return;
  }
  if (positionals[0] !== "package" || !values.source || !values.out)
    throw new Error(
      "Usage: package-zcode-runtime.mjs commit | package --source <ZCode checkout> --out <directory> [--tag zcode-runtime-v<version>]",
    );
  console.log(
    JSON.stringify(
      await packageRuntime({
        source: resolve(values.source),
        out: resolve(values.out),
        tag: values.tag || undefined,
      }),
      null,
      2,
    ),
  );
});
