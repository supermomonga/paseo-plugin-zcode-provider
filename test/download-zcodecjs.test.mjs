import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  downloadOptions,
  downloadZCodeCjs,
  extractDebData,
  extractZCodeCjs,
  latestZCodeDownload,
  zcodeDebUrl,
} from "../scripts/download-zcodecjs.mjs";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Small USTAR archives compressed with xz, containing one regular file each.
const CLI_XZ = Buffer.from(
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AJtdABcLymeKE1FC+mouASt5Q7OzOdflQmLD9FjkNkfS2PB6QzuMM+Bi/8EoOeIdRMXh4LYMQ+Pu9Sh8G5M8zXnYDmpoyjcik7YSr4qxJw4GrstahdH4ZrvvsYfN3g0CAfwSLfMVANRO15jJHuAeYervD6dVMffOhJvMUIDDfzNfhDP2GPlhPj6CIjJFfvzo4XIbk23/ILmeZtJtHOcAAACSwWj6JvejKAABtwGAUAAAK0YfeLHEZ/sCAAAAAARZWg==",
  "base64",
);
const OTHER_XZ = Buffer.from(
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AKBdABcLymeKE1FC+mouASt5Q7OzOdflQmLD9FjkVL8Zh15jRThv4qR3Aqjk+cuQDbry2QsXnTXrzB3ZIos3wV1+89sXZERxQpMDwwVz38LGjEOEaaGJGxqabRUhIG7kizEXXGp4/nH4q8synhwzJ0eHC9tx4sQJ5zWTCf0cAan0Yk2e4vQHHE0NskegNK57pO5BXJpv4YIB2xAD52fBQj+UQAAAgYl1GOzm5SQAAbwBgFAAAOi22BKxxGf7AgAAAAAEWVo=",
  "base64",
);
const CLI_CONTENT = '// fixture zcode.cjs\nmodule.exports = "fixture";\n';

function member(name, content) {
  const body = Buffer.from(content);
  const header = `${`${name}/`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(body.length).padEnd(10)}\x60\n`;
  return Buffer.concat([
    Buffer.from(header),
    body,
    Buffer.from(body.length % 2 ? "\n" : ""),
  ]);
}

function deb(data = CLI_XZ) {
  return Buffer.concat([
    Buffer.from("!<arch>\n"),
    member("debian-binary", "2.0\n"),
    // Odd length exercises ar padding; this member is not used for extraction.
    member("control.tar.xz", "unused!"),
    member("data.tar.xz", data),
  ]);
}

const link = (version) => `<a href="${zcodeDebUrl(version)}">Linux x64</a>`;
let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcodecjs-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function options(extra = {}) {
  return { repositoryRoot: root, log: vi.fn(), ...extra };
}

describe("download CLI and release selection", () => {
  test("accepts latest and exact versions in either option syntax", () => {
    expect(downloadOptions([])).toEqual({ version: undefined });
    expect(downloadOptions(["--zcode-version", "3.12.3"])).toEqual({
      version: "3.12.3",
    });
    expect(downloadOptions(["--zcode-version=3.12.3"])).toEqual({
      version: "3.12.3",
    });
  });

  test.each([
    ["--zcode-version"],
    ["--zcode-version", ""],
    ["--zcode-version", "../outside"],
    ["--zcode-version", "latest"],
    ["--zcode-version", "3.12"],
    ["--zcode-version", "3.12.3", "--zcode-version", "3.11.2"],
    ["--unknown"],
    ["3.12.3"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => downloadOptions(args)).toThrow();
  });

  test("selects the official x64 deb, ignoring other platforms and duplicate links", () => {
    const html = `${link("3.12.3")}${link("3.12.3")}
      <a href="https://other.example/ZCode-9.0.0-linux-x64.deb">Other host</a>
      <a href="${zcodeDebUrl("3.12.3").replaceAll("linux-x64", "linux-arm64")}">ARM</a>`;
    expect(latestZCodeDownload(html)).toEqual({
      version: "3.12.3",
      url: zcodeDebUrl("3.12.3"),
    });
    expect(() => latestZCodeDownload("<html></html>")).toThrow(
      "Expected one latest",
    );
    expect(() => latestZCodeDownload(link("3.12.3") + link("3.11.2"))).toThrow(
      "Expected one latest",
    );
  });

  test("CLI reports invalid arguments with a nonzero exit code", async () => {
    const script = fileURLToPath(
      new URL("../scripts/download-zcodecjs.mjs", import.meta.url),
    );
    await expect(
      promisify(execFile)(process.execPath, [
        script,
        "--zcode-version",
        "../outside",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Invalid exact release version"),
    });
  });
});

describe("download and extraction", () => {
  test("resolves latest, writes exact contents, and overwrites an existing version", async () => {
    const fetchImpl = vi.fn(
      async (url) =>
        new Response(url === "https://zcode.z.ai/en" ? link("3.12.3") : deb()),
    );
    const path = await downloadZCodeCjs(options({ fetchImpl }));
    expect(path).toBe(join(root, "libs", "zcode", "3.12.3", "zcode.cjs"));
    expect(await readFile(path, "utf8")).toBe(CLI_CONTENT);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://zcode.z.ai/en",
      zcodeDebUrl("3.12.3"),
    ]);
    await writeFile(path, "old content");
    fetchImpl.mockClear();
    await downloadZCodeCjs(options({ version: "3.12.3", fetchImpl }));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      zcodeDebUrl("3.12.3"),
    ]);
    expect(await readFile(path, "utf8")).toBe(CLI_CONTENT);
    expect(await readdir(join(root, "libs", "zcode", "3.12.3"))).toEqual([
      "zcode.cjs",
    ]);
  });

  test.each([
    [
      "HTTP failure",
      () => new Response("Not found", { status: 404 }),
      "HTTP 404",
    ],
    ["invalid deb", () => new Response("not a deb"), "Invalid deb"],
    [
      "invalid xz",
      () => new Response(deb(Buffer.from("not xz"))),
      "tar extraction failed",
    ],
    [
      "missing entry",
      () => new Response(deb(OTHER_XZ)),
      "tar extraction failed",
    ],
    [
      "interrupted download",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("Download interrupted"));
            },
          }),
        ),
      "Download interrupted",
    ],
  ])(
    "preserves existing content and removes staging after %s",
    async (_, response, message) => {
      const directory = join(root, "libs", "zcode", "3.12.3");
      await mkdir(directory, { recursive: true });
      const path = join(directory, "zcode.cjs");
      await writeFile(path, "keep me");
      await expect(
        downloadZCodeCjs(
          options({ version: "3.12.3", fetchImpl: async () => response() }),
        ),
      ).rejects.toThrow(message);
      expect(await readFile(path, "utf8")).toBe("keep me");
      expect(await readdir(directory)).toEqual(["zcode.cjs"]);
    },
  );

  test("does not attempt a download if the latest page request fails", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Unavailable", { status: 503 }),
    );
    await expect(downloadZCodeCjs(options({ fetchImpl }))).rejects.toThrow(
      "HTTP 503",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["truncated archive", deb().subarray(0, -10)],
    ["truncated header", Buffer.concat([deb(), Buffer.from("short")])],
    [
      "missing data",
      Buffer.concat([
        Buffer.from("!<arch>\n"),
        member("debian-binary", "2.0\n"),
      ]),
    ],
    ["duplicate data", Buffer.concat([deb(), member("data.tar.xz", CLI_XZ)])],
    ["empty data", deb(Buffer.alloc(0))],
    [
      "invalid deb version",
      Buffer.concat([
        Buffer.from("!<arch>\n"),
        member("debian-binary", "9.0\n"),
        member("data.tar.xz", CLI_XZ),
      ]),
    ],
  ])("rejects %s", async (_, bytes) => {
    const input = join(root, "input.deb");
    await writeFile(input, bytes);
    await expect(
      extractDebData(input, join(root, "data.tar.xz")),
    ).rejects.toThrow("Invalid deb");
  });

  test("reports a missing tar command", async () => {
    const archive = join(root, "data.tar.xz");
    await writeFile(archive, CLI_XZ);
    const { spawn: realSpawn } = await vi.importActual("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_, args, options) =>
      realSpawn(join(root, "missing-tar"), args, options),
    );
    await expect(
      extractZCodeCjs(archive, join(root, "zcode.cjs")),
    ).rejects.toThrow("Could not run tar");
  });
});
