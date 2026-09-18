import { describe, expect, test } from "vitest";
import {
  assessCompatibility,
  MINIMUM_ZCODE_VERSION,
  VERIFIED_ZCODE_ARTIFACT,
} from "./discovery/manifest.js";
import type { RuntimeIdentity } from "./discovery/types.js";

const OFFICIAL_CLI_SHA256 =
  "da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01";

function identity(
  platform: string,
  overrides: Partial<RuntimeIdentity> = {},
): RuntimeIdentity {
  return {
    platform,
    appVersion: "3.12.3",
    appBuild: "3.12.3.7463",
    cliVersion: "0.16.5",
    cliSha256: OFFICIAL_CLI_SHA256,
    metadataSha256: `metadata-${platform}`,
    bundle: {
      runtime: "electron-node",
      entry: "zcode.cjs",
      platform,
      source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
    },
    ...overrides,
  };
}

describe("ZCode minimum versions", () => {
  test.each(["darwin-arm64", "linux-x64", "win32-x64"])(
    "accepts minimum versions on %s independently of artifact hashes",
    (platform) => {
      expect(
        assessCompatibility(
          identity(platform, {
            cliSha256: "different",
            metadataSha256: "different",
          }),
        ).status,
      ).toBe("supported");
    },
  );

  test.each([
    "3.12.3",
    "3.12.4",
    "3.13.0",
    "4.0.0",
    "10.0.0",
    "3.12.3+build.2",
  ])("allows stable app %s", (appVersion) => {
    expect(
      assessCompatibility(identity("darwin-arm64", { appVersion })).status,
    ).toBe("supported");
  });
  test.each(["0.16.5", "0.16.6", "0.17.0", "1.0.0", "10.0.0"])(
    "allows stable CLI %s",
    (cliVersion) => {
      expect(
        assessCompatibility(identity("linux-x64", { cliVersion })).status,
      ).toBe("supported");
    },
  );
  test.each([
    "3.12.2",
    "3.11.2",
    "3.11.1",
    "3.9.0",
    "3.12.0-beta.1",
    "4.0.0-rc.1",
    "3.11",
    "bad",
    "",
    undefined,
  ])("rejects app %s", (appVersion) => {
    expect(
      assessCompatibility(identity("darwin-arm64", { appVersion })).status,
    ).toBe("unsupported");
  });
  test.each([
    "0.16.4",
    "0.9.0",
    "1.0.0-beta.1",
    "0.16.6-rc.1",
    "0.16.5broken",
    "",
    undefined,
  ])("rejects CLI %s", (cliVersion) => {
    expect(
      assessCompatibility(identity("linux-x64", { cliVersion })).status,
    ).toBe("unsupported");
  });
  test("keeps verification evidence independent from the support floor", () => {
    expect(MINIMUM_ZCODE_VERSION).toEqual({ app: "3.12.3", cli: "0.16.5" });
    expect(VERIFIED_ZCODE_ARTIFACT.appVersion).toBe("3.12.3");
    expect(
      assessCompatibility(
        identity("darwin-arm64", { appVersion: "4.0.0", cliVersion: "1.0.0" }),
      ),
    ).toEqual({ status: "supported", reason: expect.any(String) });
  });
});
