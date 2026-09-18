import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runE2E } from "../scripts/check-e2e.mjs";

test("requires explicit real-model credentials before starting a check", async () => {
  const run = vi.fn();
  await expect(runE2E({ environment: {}, run })).rejects.toThrow(
    "GLM_API_KEY is required",
  );
  expect(run).not.toHaveBeenCalled();
});

test.each([false, true])(
  "isolates credentials and removes data, including after failure=%s",
  async (fail) => {
    let dataDirectory;
    const calls = [];
    const run = async (script, environment) => {
      calls.push(script);
      dataDirectory = environment.ZCODE_DATA_BASE_DIR;
      expect(environment.HOME).toBe("/unchanged-home");
      expect(environment.GLM_API_KEY).toBeUndefined();
      expect(environment.UNRELATED_SECRET).toBeUndefined();
      expect(environment.ZCODE_STORAGE_DIR).toBe(join(dataDirectory, ".zcode"));
      const path = join(dataDirectory, ".zcode", "v2", "provider_config.json");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const config = JSON.parse(await readFile(path, "utf8"));
      const provider =
        config.config.providerConfigRules.providerRules[0].config;
      expect(provider.access.apiKey).toBe("test-only-key");
      expect(provider.api.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
      // Represent a native database written during a real check.
      expect((await stat(environment.TMPDIR)).isDirectory()).toBe(true);
      await writeFile(join(dataDirectory, ".zcode", "test.sqlite"), "test");
      // Reproduce the native CLI socket name, including its UUID. A long macOS
      // temp path used to make listen fail with EINVAL before any model call.
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          join(environment.TMPDIR, `znr-${randomUUID()}.sock`),
          resolve,
        );
      });
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (fail) throw new Error("simulated native failure");
    };
    const result = runE2E({
      environment: {
        HOME: "/unchanged-home",
        GLM_API_KEY: "test-only-key",
        UNRELATED_SECRET: "not-for-the-model",
        ZCODE_DATA_BASE_DIR: "/existing-data",
        ZCODE_STORAGE_DIR: "/existing-storage",
      },
      run,
    });
    if (fail) await expect(result).rejects.toThrow("simulated native failure");
    else await result;
    expect(calls).toHaveLength(fail ? 1 : 2);
    await expect(stat(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
