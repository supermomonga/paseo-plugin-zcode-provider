import { expect, it } from "vitest";
import {
  assessCompatibility,
  MINIMUM_ZCODE_VERSION,
} from "./discovery/manifest.js";
const base = {
  platform: "darwin-arm64",
  appVersion: MINIMUM_ZCODE_VERSION.app,
  cliVersion: MINIMUM_ZCODE_VERSION.cli,
  nodeVersion: "24.20.0",
  cliSha256: "a".repeat(64),
  serverSha256: "b".repeat(64),
};
it.each(["3.14.0", "3.14.1", "4.0.0", "10.0.0"])(
  "allows stable Server %s without claiming verification",
  (appVersion) =>
    expect(assessCompatibility({ ...base, appVersion }).status).toBe(
      "supported",
    ),
);
it.each(["3.13.9", "3.14.0-beta.1", "4.0.0-rc.1", "bad", ""])(
  "rejects Server %s",
  (appVersion) =>
    expect(assessCompatibility({ ...base, appVersion }).status).toBe(
      "unsupported",
    ),
);
it.each(["0.16.8", "0.17.0-rc.1", "bad", ""])(
  "rejects Agent %s",
  (cliVersion) =>
    expect(assessCompatibility({ ...base, cliVersion }).status).toBe(
      "unsupported",
    ),
);
it("allows newer stable Agent", () =>
  expect(assessCompatibility({ ...base, cliVersion: "1.0.0" }).status).toBe(
    "supported",
  ));
