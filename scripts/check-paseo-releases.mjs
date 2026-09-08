import { readFile } from "node:fs/promises";
import { load } from "cheerio";
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

export const PASEO_CHANGELOG_URL = "https://paseo.sh/changelog";

export function parsePaseoPage(html) {
  const $ = load(html);
  const releases = new Map();
  $("section.changelog-patch").each((_, element) => {
    const section = $(element);
    const heading = section.find(".changelog-patch-title");
    const notes = section.children(".changelog-release-notes");
    if (heading.length !== 1 || notes.length !== 1)
      throw new Error("Missing Paseo release heading or notes");
    const version = validateVersion(heading.text().trim());
    collectRelease(releases, {
      version,
      markdown: releaseNotes(notes.html(), PASEO_CHANGELOG_URL),
      url: `${PASEO_CHANGELOG_URL}#release-${version}`,
    });
  });
  if (!releases.size) throw new Error("No Paseo releases found");
  return [...releases.values()];
}

export async function fetchNewPaseoReleases(currentVersion, fetchImpl = fetch) {
  validateVersion(currentVersion);
  return newerReleases(
    parsePaseoPage(await fetchHtml(PASEO_CHANGELOG_URL, fetchImpl)),
    currentVersion,
  );
}

export async function currentPaseoVersion() {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  return validateVersion(pkg.devDependencies["@getpaseo/plugin"]);
}

export const paseo = {
  id: "paseo",
  name: "Paseo",
  fetchNewReleases: fetchNewPaseoReleases,
};

runMain(import.meta.url, async () => {
  const options = cliOptions(process.argv.slice(2), process.env);
  await runReleaseCheck({
    ...options,
    product: paseo,
    currentVersion: await currentPaseoVersion(),
  });
});
