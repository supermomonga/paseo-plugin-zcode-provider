import { load } from "cheerio";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import {
  cliOptions,
  collectRelease,
  fetchHtml,
  newerReleases,
  releaseNotes,
  runMain,
  runReleaseCheck,
  validateVersion,
} from "./releases/common.mjs";

export const ZCODE_CHANGELOG_URL = "https://zcode.z.ai/en/changelog";

export function parseZCodePage(html) {
  const $ = load(html);
  const releases = new Map();
  $("h2").each((_, element) => {
    const heading = $(element).text().replace(/\s+/g, " ").trim();
    if (!heading.startsWith("Release v")) return;
    const version = validateVersion(heading.slice("Release v".length));
    const article = $(element).next("article");
    if (article.length !== 1)
      throw new Error(`Missing ZCode article: ${version}`);
    collectRelease(releases, {
      version,
      markdown: releaseNotes(article.html(), ZCODE_CHANGELOG_URL),
      url: ZCODE_CHANGELOG_URL,
    });
  });
  if (!releases.size) throw new Error("No ZCode releases found");
  return [...releases.values()];
}

export async function fetchNewZCodeReleases(currentVersion, fetchImpl = fetch) {
  validateVersion(currentVersion);
  const collected = new Map();
  for (let page = 1; ; page += 1) {
    const url = new URL(ZCODE_CHANGELOG_URL);
    url.searchParams.set("page", String(page));
    const releases = parseZCodePage(await fetchHtml(url, fetchImpl));
    const previousCount = collected.size;
    for (const release of releases) {
      const existing = collected.get(release.version);
      if (existing && existing.markdown !== release.markdown) {
        throw new Error(`Conflicting ZCode notes: ${release.version}`);
      }
      collected.set(release.version, release);
    }
    if (collected.has(currentVersion) || collected.size === previousCount)
      break;
  }
  return newerReleases([...collected.values()], currentVersion);
}

export async function currentZCodeVersion() {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../server/discovery/manifest.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const manifest = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
  return validateVersion(manifest.VERIFIED_ZCODE_ARTIFACT.appVersion);
}

export const zcode = {
  id: "zcode",
  name: "ZCode",
  fetchNewReleases: fetchNewZCodeReleases,
};

runMain(import.meta.url, async () => {
  const options = cliOptions(process.argv.slice(2), process.env);
  await runReleaseCheck({
    ...options,
    product: zcode,
    currentVersion: await currentZCodeVersion(),
  });
});
