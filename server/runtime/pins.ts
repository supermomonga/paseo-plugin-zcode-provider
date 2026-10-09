// Fixed downloads for the managed runtime (ADR 15). Clients can only ask the
// server to install these exact artifacts; they never supply URLs or versions.
export type ManagedPlatform =
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "win-x64"
  | "win-arm64";

export interface PinnedArchive {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export const MANAGED_NODE_VERSION = "24.21.0";

// Checksums come from nodejs.org SHASUMS256.txt, whose signature was verified
// against the nodejs/release-keys active keyring when the version was pinned.
const nodeArchive = (file: string, sha256: string, size: number) => ({
  url: `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${file}`,
  sha256,
  size,
});
export const MANAGED_NODE_ARCHIVES: Readonly<
  Record<ManagedPlatform, PinnedArchive>
> = {
  "darwin-arm64": nodeArchive(
    `node-v${MANAGED_NODE_VERSION}-darwin-arm64.tar.gz`,
    "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    52_909_993,
  ),
  "linux-x64": nodeArchive(
    `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`,
    "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    58_088_022,
  ),
  "linux-arm64": nodeArchive(
    `node-v${MANAGED_NODE_VERSION}-linux-arm64.tar.gz`,
    "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    57_824_078,
  ),
  "win-x64": nodeArchive(
    `node-v${MANAGED_NODE_VERSION}-win-x64.zip`,
    "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    37_618_919,
  ),
  "win-arm64": nodeArchive(
    `node-v${MANAGED_NODE_VERSION}-win-arm64.zip`,
    "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
    33_679_608,
  ),
};

// Published by .github/workflows/zcode-runtime-release.yml from the pinned
// source with patches/zcode applied (ADR 19). The same archive serves every
// managed platform.
export const MANAGED_ZCODE_VERSION = "3.14.3";
const MANAGED_ZCODE_RELEASE = `${MANAGED_ZCODE_VERSION}-paseo.1`;
export const MANAGED_ZCODE_ARCHIVE: PinnedArchive = {
  url: `https://github.com/supermomonga/paseo-plugin-zcode-provider/releases/download/zcode-runtime-v${MANAGED_ZCODE_RELEASE}/zcode-runtime-${MANAGED_ZCODE_RELEASE}.tar.gz`,
  sha256: "c51e4547dc804894fd7d62766ab0ce3d759948b8b56cb515528691d75a8e09f9",
  size: 79_883_611,
};

export function managedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ManagedPlatform | undefined {
  const key = `${platform === "win32" ? "win" : platform}-${arch}`;
  return Object.hasOwn(MANAGED_NODE_ARCHIVES, key)
    ? (key as ManagedPlatform)
    : undefined;
}
