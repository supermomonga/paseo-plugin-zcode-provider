import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  REQUIRED_RUNTIME_FILES,
  assertRuntimeLayout,
  runtimeAssetName,
  runtimeVersionFromTag,
} from "../scripts/package-zcode-runtime.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("runtime release naming", () => {
  test("accepts only exact stable or prerelease versions after the prefix", () => {
    expect(runtimeVersionFromTag("zcode-runtime-v3.14.3")).toBe("3.14.3");
    for (const tag of [
      "v3.14.3",
      "zcode-runtime-3.14.3",
      "zcode-runtime-v3.14",
      "zcode-runtime-v3.14.3 ",
    ])
      expect(() => runtimeVersionFromTag(tag)).toThrow();
  });

  test("derives the asset name from the version", () => {
    expect(runtimeAssetName("3.14.3")).toBe("zcode-runtime-3.14.3.tar.gz");
    expect(() => runtimeAssetName("../3.14.3")).toThrow();
  });
});

describe("runtime archive layout", () => {
  test("requires the Server, Agent, provider configuration and launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-layout-"));
    directories.push(root);
    for (const file of REQUIRED_RUNTIME_FILES) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "");
    }
    await expect(
      assertRuntimeLayout(root, REQUIRED_RUNTIME_FILES),
    ).resolves.toBeUndefined();
    await rm(join(root, "server/remote/zcode-server.cjs"));
    await expect(
      assertRuntimeLayout(root, REQUIRED_RUNTIME_FILES),
    ).rejects.toThrow("server/remote/zcode-server.cjs");
  });
});
