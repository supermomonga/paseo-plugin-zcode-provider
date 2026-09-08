import { describe, expect, test, vi } from "vitest";
import { CURRENT_ZCODE_ARTIFACT } from "../server/discovery/manifest.ts";
import {
  buildIssueDraft,
  cliOptions,
  hasMatchingIssue,
  issueMarker,
  newerReleases,
  parseIssuePages,
  releaseNotes,
  runReleaseCheck,
  validateVersion,
} from "../scripts/releases/common.mjs";
import {
  currentZCodeVersion,
  fetchNewZCodeReleases,
  parseZCodePage,
  zcode,
} from "../scripts/check-zcode-releases.mjs";
import {
  currentPaseoVersion,
  fetchNewPaseoReleases,
  parsePaseoPage,
  paseo,
} from "../scripts/check-paseo-releases.mjs";
import pkg from "../package.json";

const zRelease = (version, notes = "<p>Release notes</p>") =>
  `<div><h2>Release v${version}</h2><article>${notes}</article></div>`;
const pRelease = (version, notes = "<p>Release notes</p>") =>
  `<section class="changelog-patch"><div id="release-${version}"><h3 class="changelog-patch-title">${version}</h3></div><div class="changelog-release-notes">${notes}</div></section>`;
const fetchPage = (html) => vi.fn(async () => new Response(html));
const release = (version) => ({
  version,
  markdown: "Notes",
  url: "https://paseo.sh/changelog",
});
const existingIssue = (product, version, state = "closed") => ({
  ...buildIssueDraft(product, release(version)),
  state,
});

function memoryClient(initial = []) {
  const issues = [...initial];
  return {
    issues,
    listIssues: vi.fn(async () => [...issues]),
    createIssue: vi.fn(async (_repo, draft) => {
      issues.push({ ...draft, state: "open" });
      return `https://github.test/issues/${issues.length}`;
    }),
  };
}

function options(html, client, extra = {}) {
  return {
    product: paseo,
    currentVersion: "0.8.0-beta.1",
    repository: "owner/repo",
    fetchImpl: fetchPage(html),
    issueClient: client,
    log: vi.fn(),
    ...extra,
  };
}

describe("release parsing and versions", () => {
  test("reads comparison baselines directly from the manifest and dependency", async () => {
    expect(await currentZCodeVersion()).toBe(CURRENT_ZCODE_ARTIFACT.appVersion);
    expect(await currentPaseoVersion()).toBe(
      pkg.devDependencies["@getpaseo/plugin"],
    );
  });

  test("orders prereleases numerically and detects stable releases and newer prerelease series", () => {
    const versions = [
      "0.9.0-beta.1",
      "0.8.0",
      "0.8.0-rc.1",
      "0.8.0-beta.10",
      "0.8.0-beta.2",
      "0.8.0-beta.1",
      "0.7.2",
    ];
    expect(
      newerReleases(versions.map(release), "0.8.0-beta.1").map(
        (r) => r.version,
      ),
    ).toEqual([
      "0.8.0-beta.2",
      "0.8.0-beta.10",
      "0.8.0-rc.1",
      "0.8.0",
      "0.9.0-beta.1",
    ]);
    expect(
      newerReleases([release("0.8.0-beta.2"), release("0.8.0")], "0.8.0"),
    ).toEqual([]);
  });

  test.each(["^0.8.0", "v0.8.0", "0.8", "0.8.0-beta.01", "", undefined])(
    "rejects non-exact version %s",
    (version) => {
      expect(() => validateVersion(version)).toThrow(
        "Invalid exact release version",
      );
    },
  );

  test("extracts ZCode article content and keeps Markdown formatting and absolute links", () => {
    const [parsed] = parseZCodePage(
      zRelease(
        "3.11.3",
        '<h2>Changes</h2><ul><li><strong>Bold</strong> &amp; <code>code</code><ul><li><a href="/en/docs">Guide</a></li></ul></li></ul>',
      ),
    );
    expect(parsed.version).toBe("3.11.3");
    expect(parsed.markdown).toContain("## Changes");
    expect(parsed.markdown).toContain("**Bold** & `code`");
    expect(parsed.markdown).toContain("[Guide](https://zcode.z.ai/en/docs)");
  });

  test("extracts each Paseo patch independently without series headings or dates", () => {
    const parsed = parsePaseoPage(
      "<article><h2>Paseo 0.8</h2>" +
        pRelease("0.8.0", '<h4>Fixed</h4><p><a href="/docs">Docs</a></p>') +
        pRelease("0.8.0-beta.1") +
        "</article>",
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      version: "0.8.0",
      markdown: "#### Fixed\n\n[Docs](https://paseo.sh/docs)",
      url: "https://paseo.sh/changelog#release-0.8.0",
    });
  });

  test.each([
    [parseZCodePage, "<h1>Changed layout</h1>"],
    [parseZCodePage, "<h2>Release v3.11.3</h2><div>Missing article</div>"],
    [parseZCodePage, zRelease("3.11.3", "")],
    [parseZCodePage, zRelease("3.11.3") + zRelease("3.11.3")],
    [parseZCodePage, zRelease("invalid")],
    [parsePaseoPage, "<h1>Changed layout</h1>"],
    [
      parsePaseoPage,
      '<section class="changelog-patch"><h3 class="changelog-patch-title">0.8.0</h3></section>',
    ],
    [parsePaseoPage, pRelease("0.8.0", "")],
    [parsePaseoPage, pRelease("0.8.0") + pRelease("0.8.0")],
    [parsePaseoPage, pRelease("invalid")],
  ])("rejects invalid or incomplete changelog %#", (parse, html) => {
    expect(() => parse(html)).toThrow();
  });

  test("rejects invalid link protocols instead of silently dropping the link", () => {
    expect(() =>
      releaseNotes(
        '<a href="javascript:alert(1)">Link</a>',
        "https://paseo.sh/changelog",
      ),
    ).toThrow("Unsupported");
  });

  test("paginates ZCode until the supported release, returning oldest new release first", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const page = Number(url.searchParams.get("page"));
      return new Response(
        page === 1
          ? zRelease("3.11.4")
          : zRelease("3.11.3") + zRelease("3.11.2"),
      );
    });
    expect(
      (await fetchNewZCodeReleases("3.11.2", fetchImpl)).map((r) => r.version),
    ).toEqual(["3.11.3", "3.11.4"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("stops when the site repeats a page without the baseline", async () => {
    const fetchImpl = fetchPage(zRelease("3.11.3"));
    expect(await fetchNewZCodeReleases("3.11.2", fetchImpl)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("rejects conflicting content for the same release across pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(zRelease("3.11.3")))
      .mockResolvedValueOnce(
        new Response(zRelease("3.11.3", "<p>Different</p>")),
      );
    await expect(fetchNewZCodeReleases("3.11.2", fetchImpl)).rejects.toThrow(
      "Conflicting",
    );
  });

  test.each([fetchNewPaseoReleases, fetchNewZCodeReleases])(
    "propagates HTTP and network failures",
    async (fetchReleases) => {
      await expect(
        fetchReleases(
          "0.8.0",
          async () => new Response("Unavailable", { status: 503 }),
        ),
      ).rejects.toThrow("HTTP 503");
      await expect(
        fetchReleases("0.8.0", async () => {
          throw new Error("Network failure");
        }),
      ).rejects.toThrow("Network failure");
    },
  );
});

describe("issue creation", () => {
  test("creates a stable issue after beta support even if the beta issue exists; never creates it twice", async () => {
    const client = memoryClient([existingIssue(paseo, "0.8.0-beta.1")]);
    const opts = options(pRelease("0.8.0") + pRelease("0.8.0-beta.1"), client);
    expect(await runReleaseCheck(opts)).toHaveLength(1);
    expect(client.createIssue.mock.calls[0][1]).toMatchObject({
      title: "Paseo 0.8.0 に対応する",
      version: "0.8.0",
    });
    expect(client.issues[1].body).toContain(
      "https://paseo.sh/changelog#release-0.8.0",
    );
    client.issues[1].state = "closed";
    expect(await runReleaseCheck(opts)).toEqual([]);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
  });

  test("creates beta, RC, and stable issues in version order", async () => {
    const client = memoryClient();
    await runReleaseCheck(
      options(
        ["0.8.0", "0.8.0-rc.1", "0.8.0-beta.2"]
          .map((v) => pRelease(v))
          .join(""),
        client,
      ),
    );
    expect(client.issues.map((i) => i.version)).toEqual([
      "0.8.0-beta.2",
      "0.8.0-rc.1",
      "0.8.0",
    ]);
  });

  test("resumes after partial failure without duplicating the first issue", async () => {
    const client = memoryClient();
    const create = client.createIssue.getMockImplementation();
    client.createIssue
      .mockImplementationOnce(create)
      .mockRejectedValueOnce(new Error("GitHub failure"));
    const opts = options(pRelease("0.8.0-beta.2") + pRelease("0.8.0"), client);
    await expect(runReleaseCheck(opts)).rejects.toThrow("GitHub failure");
    await runReleaseCheck(opts);
    expect(client.issues.map((i) => i.version)).toEqual([
      "0.8.0-beta.2",
      "0.8.0",
    ]);
  });

  test("matches open/closed exact titles or markers, keeping products and versions separate", () => {
    const draft = buildIssueDraft(paseo, release("0.8.0"));
    expect(
      hasMatchingIssue(paseo, draft, [
        { title: draft.title, body: null, state: "open" },
      ]),
    ).toBe(true);
    expect(
      hasMatchingIssue(paseo, draft, [
        {
          title: "Renamed",
          body: issueMarker(paseo, "0.8.0"),
          state: "closed",
        },
      ]),
    ).toBe(true);
    expect(
      hasMatchingIssue(paseo, draft, [
        existingIssue(zcode, "0.8.0"),
        existingIssue(paseo, "0.8.0-beta.1"),
      ]),
    ).toBe(false);
  });

  test("lists all issue pages, including closed issues, while excluding PRs", () => {
    const issue = { title: "Issue", body: null, state: "closed" };
    expect(
      parseIssuePages([[issue], [{ ...issue, pull_request: {} }], [issue]]),
    ).toEqual([issue, issue]);
    expect(() => parseIssuePages([issue])).toThrow();
    expect(() => parseIssuePages([[{ title: "invalid" }]])).toThrow();
  });

  test("does not create issues when existing issue lookup fails", async () => {
    const client = memoryClient();
    client.listIssues.mockRejectedValue(new Error("List failed"));
    await expect(
      runReleaseCheck(options(pRelease("0.8.0"), client)),
    ).rejects.toThrow("List failed");
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  test("validates all notes before creating any issue", async () => {
    const client = memoryClient();
    await expect(
      runReleaseCheck(
        options(pRelease("0.8.0-beta.2") + pRelease("0.8.0", ""), client),
      ),
    ).rejects.toThrow("Empty");
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  test("creates nothing when current, and logs the baseline", async () => {
    const client = memoryClient();
    const opts = options(pRelease("0.8.0-beta.1"), client);
    expect(await runReleaseCheck(opts)).toEqual([]);
    expect(client.createIssue).not.toHaveBeenCalled();
    expect(opts.log).toHaveBeenCalledWith(
      "No Paseo release newer than 0.8.0-beta.1",
    );
  });

  test("dry-run prints drafts without GitHub access", async () => {
    const client = memoryClient();
    const opts = options(pRelease("0.8.0"), client, { dryRun: true });
    expect(await runReleaseCheck(opts)).toEqual([]);
    expect(opts.log.mock.calls[0][0]).toContain("Paseo 0.8.0 に対応する");
    expect(client.listIssues).not.toHaveBeenCalled();
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  test("requires credentials for writes, and rejects unknown CLI arguments", () => {
    expect(cliOptions(["--dry-run"], {})).toEqual({
      dryRun: true,
      repository: undefined,
    });
    expect(() => cliOptions([], {})).toThrow("GH_TOKEN");
    expect(() =>
      cliOptions([], { GH_TOKEN: "token", GITHUB_REPOSITORY: "invalid" }),
    ).toThrow("owner/name");
    expect(() => cliOptions(["--dryrun"], {})).toThrow("Usage");
  });
});
