import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { load } from "cheerio";
import { fetchHtml, runMain, validateVersion } from "./releases/common.mjs";

const DOWNLOAD_PAGE = "https://zcode.z.ai/en";
const CDN_ROOT = "https://cdn-zcode.z.ai/zcode/electron/releases";
const CLI_ENTRY = "./opt/ZCode/resources/glm/zcode.cjs";
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function downloadOptions(args) {
  const { values, tokens } = parseArgs({
    args,
    options: { "zcode-version": { type: "string" } },
    allowPositionals: false,
    strict: true,
    tokens: true,
  });
  if (tokens.filter((token) => token.kind === "option").length > 1)
    throw new Error("--zcode-version must be specified only once");
  return {
    version:
      values["zcode-version"] === undefined
        ? undefined
        : validateVersion(values["zcode-version"]),
  };
}

export function zcodeDebUrl(version) {
  validateVersion(version);
  return `${CDN_ROOT}/${version}/linux-x64/ZCode-${version}-linux-x64.deb`;
}

export function latestZCodeDownload(html) {
  const $ = load(html);
  const downloads = new Map();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const match = href.match(
      /^https:\/\/cdn-zcode\.z\.ai\/zcode\/electron\/releases\/([^/]+)\/linux-x64\/ZCode-\1-linux-x64\.deb$/,
    );
    if (match) downloads.set(validateVersion(match[1]), href);
  });
  if (downloads.size !== 1)
    throw new Error(
      "Expected one latest Linux x64 deb download on ZCode's official page",
    );
  const [[version, url]] = downloads;
  return { version, url };
}

// Read the ar container without loading the full desktop application into memory.
export async function extractDebData(debPath, dataPath) {
  const file = await open(debPath, "r");
  let dataMember;
  try {
    const { size: archiveSize } = await file.stat();
    const magic = Buffer.alloc(8);
    await file.read(magic, 0, magic.length, 0);
    if (magic.toString("ascii") !== "!<arch>\n")
      throw new Error("Invalid deb: missing ar signature");
    let offset = 8;
    while (offset < archiveSize) {
      const header = Buffer.alloc(60);
      const { bytesRead } = await file.read(header, 0, 60, offset);
      if (bytesRead !== 60 || header.toString("ascii", 58) !== "`\n")
        throw new Error("Invalid deb: truncated or malformed ar header");
      const name = header.toString("ascii", 0, 16).trim().replace(/\/$/, "");
      const sizeText = header.toString("ascii", 48, 58).trim();
      if (!/^\d+$/.test(sizeText))
        throw new Error("Invalid deb: malformed ar member size");
      const size = Number(sizeText);
      const start = offset + 60;
      const next = start + size + (size % 2);
      if (next > archiveSize)
        throw new Error("Invalid deb: truncated ar member");
      if (offset === 8) {
        const version = Buffer.alloc(4);
        await file.read(version, 0, 4, start);
        if (
          name !== "debian-binary" ||
          size !== 4 ||
          version.toString() !== "2.0\n"
        )
          throw new Error("Invalid deb: expected debian-binary version 2.0");
      }
      if (name === "data.tar.xz") {
        if (dataMember || size === 0)
          throw new Error("Invalid deb: duplicate or empty data.tar.xz");
        dataMember = { start, end: start + size - 1 };
      }
      offset = next;
    }
    if (!dataMember) throw new Error("Invalid deb: missing data.tar.xz");
    await pipeline(
      createReadStream(debPath, dataMember),
      createWriteStream(dataPath, { flags: "wx" }),
    );
  } finally {
    await file.close();
  }
}

export async function extractZCodeCjs(dataPath, outputPath) {
  const child = spawn("tar", ["-xJOf", dataPath, CLI_ENTRY], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(
        new Error(
          `Could not run tar; install tar with xz support: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `tar extraction failed (requires xz support): ${stderr.trim() || `exit ${code}`}`,
          ),
        );
    });
  });
  const output = pipeline(
    child.stdout,
    createWriteStream(outputPath, { flags: "wx" }),
  ).catch((error) => {
    child.kill();
    throw error;
  });
  // Wait for the process and output file to close before cleanup (also on Windows).
  const results = await Promise.allSettled([completion, output]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  if ((await stat(outputPath)).size === 0)
    throw new Error("Extracted zcode.cjs is empty or is not a regular file");
}

export async function downloadZCodeCjs({
  version,
  repositoryRoot = REPOSITORY_ROOT,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const download =
    version === undefined
      ? latestZCodeDownload(await fetchHtml(DOWNLOAD_PAGE, fetchImpl))
      : { version: validateVersion(version), url: zcodeDebUrl(version) };
  const temporary = await mkdtemp(join(tmpdir(), "zcode-download-"));
  let staging;
  try {
    log(`Downloading ZCode ${download.version}: ${download.url}`);
    const response = await fetchImpl(download.url, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok)
      throw new Error(
        `Failed to download ${download.url}: HTTP ${response.status}`,
      );
    if (!response.body) throw new Error("ZCode download has no response body");
    const debPath = join(temporary, "zcode.deb");
    await pipeline(response.body, createWriteStream(debPath, { flags: "wx" }));
    const dataPath = join(temporary, "data.tar.xz");
    await extractDebData(debPath, dataPath);
    const directory = join(repositoryRoot, "libs", "zcode", download.version);
    await mkdir(directory, { recursive: true });
    // Stage on the destination filesystem so replacing an existing file is atomic.
    staging = await mkdtemp(join(directory, ".download-"));
    const stagedPath = join(staging, "zcode.cjs");
    await extractZCodeCjs(dataPath, stagedPath);
    const outputPath = join(directory, "zcode.cjs");
    await rename(stagedPath, outputPath);
    log(`Saved ZCode ${download.version}: ${outputPath}`);
    return outputPath;
  } finally {
    await Promise.all([
      rm(temporary, { recursive: true, force: true }),
      staging ? rm(staging, { recursive: true, force: true }) : undefined,
    ]);
  }
}

runMain(import.meta.url, () =>
  downloadZCodeCjs(downloadOptions(process.argv.slice(2))),
);
