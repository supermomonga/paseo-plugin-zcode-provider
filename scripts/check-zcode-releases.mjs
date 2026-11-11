import { load } from "cheerio";
import semver from "semver";
import {
  cliOptions,
  collectRelease,
  fetchHtml,
  newerReleases,
  releaseNotes,
  runCommand,
  runMain,
  runReleaseCheck,
  validateVersion,
} from "./releases/common.mjs";
import { loadZCodeManifest } from "./zcode-manifest.mjs";

export const ZCODE_CHANGELOG_URL = "https://zcode.z.ai/en/changelog";
export const ZCODE_REPOSITORY_URL = "https://github.com/zai-org/ZCode";

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

// Reads `git ls-remote --tags --refs` output and returns the versions of `v<version>` tags.
export function parseZCodeTags(output) {
  const versions = new Set();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^[0-9a-f]+\trefs\/tags\/(\S+)$/.exec(line);
    if (!match) throw new Error("Unexpected ZCode tag listing");
    const version = match[1].slice(1);
    if (match[1].startsWith("v") && semver.valid(version) === version)
      versions.add(version);
  }
  return versions;
}

export async function listZCodeTagVersions(run = runCommand) {
  return parseZCodeTags(
    await run(
      "git",
      ["ls-remote", "--tags", "--refs", `${ZCODE_REPOSITORY_URL}.git`],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
    ),
  );
}

// The changelog can list a version before its source is tagged on GitHub, and the
// upstream maintainers publish the tags by hand. Support work needs that source, so
// an issue waits until both the changelog entry and the `v<version>` tag exist.
export async function fetchNewTaggedZCodeReleases(
  currentVersion,
  fetchImpl = fetch,
  listTagVersions = listZCodeTagVersions,
) {
  const releases = await fetchNewZCodeReleases(currentVersion, fetchImpl);
  if (!releases.length) return releases;
  const tagged = await listTagVersions();
  return releases.map((release) =>
    tagged.has(release.version)
      ? {
          ...release,
          sourceUrl: `${ZCODE_REPOSITORY_URL}/tree/v${release.version}`,
        }
      : {
          ...release,
          pending: `tag v${release.version} is not on ${ZCODE_REPOSITORY_URL} yet`,
        },
  );
}

export async function currentZCodeVersion() {
  const manifest = await loadZCodeManifest();
  return validateVersion(manifest.LAST_REVIEWED_ZCODE_RELEASE);
}

export const zcode = {
  id: "zcode",
  name: "ZCode",
  fetchNewReleases: fetchNewTaggedZCodeReleases,
};

runMain(import.meta.url, async () => {
  const options = cliOptions(process.argv.slice(2), process.env);
  await runReleaseCheck({
    ...options,
    product: zcode,
    currentVersion: await currentZCodeVersion(),
  });
});
