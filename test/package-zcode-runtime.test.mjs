import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  REQUIRED_RUNTIME_FILES,
  assertRuntimeLayout,
  parseRuntimeRelease,
  runtimeAssetName,
  runtimeReleaseFromTag,
} from "../scripts/package-zcode-runtime.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("runtime release naming", () => {
  test("requires an exact ZCode version and a patch revision from 1", () => {
    expect(runtimeReleaseFromTag("zcode-runtime-v3.14.3-paseo.1")).toBe(
      "3.14.3-paseo.1",
    );
    expect(runtimeReleaseFromTag("zcode-runtime-v3.15.0-beta.1-paseo.12")).toBe(
      "3.15.0-beta.1-paseo.12",
    );
    for (const tag of [
      "zcode-runtime-v3.14.3",
      "zcode-runtime-v3.14.3-paseo.0",
      "zcode-runtime-v3.14.3-paseo.01",
      "zcode-runtime-v3.14-paseo.1",
      "zcode-runtime-3.14.3-paseo.1",
      "zcode-runtime-v3.14.3-paseo.1 ",
    ])
      expect(() => runtimeReleaseFromTag(tag)).toThrow();
  });

  test("splits the release into the ZCode version and revision", () => {
    expect(parseRuntimeRelease("3.14.3-paseo.0")).toEqual({
      version: "3.14.3",
      revision: 0,
    });
  });

  test("derives the asset name from the release", () => {
    expect(runtimeAssetName("3.14.3-paseo.1")).toBe(
      "zcode-runtime-3.14.3-paseo.1.tar.gz",
    );
    expect(() => runtimeAssetName("3.14.3")).toThrow();
    expect(() => runtimeAssetName("../3.14.3-paseo.1")).toThrow();
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
