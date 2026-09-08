import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import TurndownService from "turndown";
import semver from "semver";

export function validateVersion(version) {
  if (typeof version !== "string" || semver.valid(version) !== version) {
    throw new Error(`Invalid exact release version: ${version}`);
  }
  return version;
}

export function newerReleases(releases, currentVersion) {
  validateVersion(currentVersion);
  return releases
    .filter(
      ({ version }) =>
        semver.compare(validateVersion(version), currentVersion) > 0,
    )
    .sort((a, b) => semver.compare(a.version, b.version));
}

export function releaseNotes(html, baseUrl) {
  const $ = load(html, {}, false);
  $("script, style").remove();
  $("a, img").each((_, element) => {
    const attribute = element.tagName === "a" ? "href" : "src";
    const target = $(element).attr(attribute);
    if (!target) throw new Error(`Missing changelog ${attribute}`);
    const url = new URL(target, baseUrl);
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new Error(`Unsupported changelog URL: ${url.protocol}`);
    }
    $(element).attr(attribute, url.href);
  });
  const markdown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  })
    .turndown($.html())
    .trim();
  if (!markdown) throw new Error("Empty changelog notes");
  return markdown;
}

export function collectRelease(releases, release) {
  validateVersion(release.version);
  if (releases.has(release.version)) {
    throw new Error(`Duplicate release: ${release.version}`);
  }
  releases.set(release.version, release);
}

export async function fetchHtml(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html",
      "user-agent": "paseo-plugin-zcode-provider-release-check",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

export function issueMarker(product, version) {
  validateVersion(version);
  return `<!-- paseo-plugin-zcode-provider:${product.id}-release:${version} -->`;
}

export function buildIssueDraft(product, release) {
  if (!release.markdown.trim())
    throw new Error(`Empty changelog for ${release.version}`);
  const title = `${product.name} ${release.version} に対応する`;
  const body = [
    `${product.name} ${release.version} がリリースされました。paseo-plugin-zcode-provider の互換性を確認し、必要な対応を行ってください。`,
    `Changelog: ${release.url}`,
    "## Changelog",
    release.markdown.trim(),
    issueMarker(product, release.version),
    "",
  ].join("\n\n");
  return { version: release.version, title, body };
}

export function hasMatchingIssue(product, draft, issues) {
  return issues.some(
    (issue) =>
      issue.title === draft.title ||
      issue.body?.includes(issueMarker(product, draft.version)),
  );
}

export function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        reject(
          new Error(`gh ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`),
        );
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

export function parseIssuePages(pages) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("Unexpected GitHub issue pages");
  }
  return pages.flat().filter((issue) => {
    if (!issue || typeof issue !== "object")
      throw new Error("Invalid GitHub issue");
    if ("pull_request" in issue) return false;
    if (
      typeof issue.title !== "string" ||
      (issue.body !== null && typeof issue.body !== "string") ||
      !["open", "closed"].includes(issue.state)
    ) {
      throw new Error("Invalid GitHub issue fields");
    }
    return true;
  });
}

export const ghIssueClient = {
  async listIssues(repository) {
    return parseIssuePages(
      JSON.parse(
        await runGh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/issues?state=all&per_page=100`,
        ]),
      ),
    );
  },
  async createIssue(repository, draft) {
    return runGh(
      [
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        draft.title,
        "--body-file",
        "-",
      ],
      draft.body,
    );
  },
};

export async function runReleaseCheck({
  product,
  currentVersion,
  repository,
  fetchImpl = fetch,
  issueClient = ghIssueClient,
  dryRun = false,
  log = console.log,
}) {
  const releases = await product.fetchNewReleases(currentVersion, fetchImpl);
  const drafts = releases.map((release) => buildIssueDraft(product, release));
  // Dry runs preview candidates without requiring GitHub credentials or writing issues.
  const issues = dryRun ? [] : await issueClient.listIssues(repository);
  const created = [];
  for (const draft of drafts) {
    if (hasMatchingIssue(product, draft, issues)) {
      log(`Skipping ${product.name} ${draft.version}: issue already exists`);
      continue;
    }
    if (dryRun) {
      log(`${draft.title}\n\n${draft.body}`);
      continue;
    }
    const url = await issueClient.createIssue(repository, draft);
    issues.push({ title: draft.title, body: draft.body, state: "open" });
    created.push(url);
    log(`Created ${product.name} ${draft.version}: ${url}`);
  }
  if (!drafts.length)
    log(`No ${product.name} release newer than ${currentVersion}`);
  return created;
}

export function cliOptions(args, env) {
  if (args.some((arg) => arg !== "--dry-run"))
    throw new Error("Usage: [--dry-run]");
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !env.GH_TOKEN) throw new Error("GH_TOKEN is required");
  if (!dryRun && !/^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be in owner/name format");
  }
  return { dryRun, repository: env.GITHUB_REPOSITORY };
}

export function runMain(moduleUrl, main) {
  if (process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
