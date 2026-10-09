import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ZCODE_PATCH_DIRECTORY,
  applyZCodePatches,
  listZCodePatches,
  verifyAppliedZCodePatches,
} from "../scripts/apply-zcode-patches.mjs";

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

// A checkout with one file and a patch directory holding a change to it.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-patches-"));
  directories.push(root);
  const source = join(root, "source"),
    patches = join(root, "patches");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(patches);
  // The change sits mid-file: git anchors hunks that start at line 1.
  const original =
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
  await writeFile(join(source, "src/index.ts"), original);
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(
    source,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=test",
    "commit",
    "-qm",
    "base",
  );
  await writeFile(
    join(source, "src/index.ts"),
    original.replace("line 10\n", "LINE 10\n"),
  );
  await writeFile(
    join(patches, "0001-change.patch"),
    `Explanation that git apply ignores.\n\n${git(source, "diff")}`,
  );
  git(source, "checkout", "-q", "--", ".");
  return { source, patches, original };
}

test("applies every patch only after all of them pass the check", async () => {
  const { source, patches, original } = await fixture();
  await writeFile(
    join(patches, "0002-stale.patch"),
    (await readFile(join(patches, "0001-change.patch"), "utf8")).replace(
      "-line 10",
      "-line 99",
    ),
  );
  await expect(applyZCodePatches(source, patches)).rejects.toThrow();
  expect(await readFile(join(source, "src/index.ts"), "utf8")).toBe(original);
});

test("applies after upstream moved the code and verifies the result", async () => {
  const { source, patches, original } = await fixture();
  await writeFile(join(source, "src/index.ts"), "new\nlines\n" + original);
  git(
    source,
    "-c",
    "user.email=t@e.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-qam",
    "upstream",
  );
  const applied = await applyZCodePatches(source, patches);
  expect(applied.map((p) => p.file)).toEqual(["0001-change.patch"]);
  expect(await readFile(join(source, "src/index.ts"), "utf8")).toContain(
    "LINE 10\n",
  );
  await expect(
    verifyAppliedZCodePatches(source, patches),
  ).resolves.toHaveLength(1);
});

test("refuses a dirty checkout and changes outside the patches", async () => {
  const { source, patches, original } = await fixture();
  await writeFile(join(source, "src/index.ts"), original + "local\n");
  await expect(applyZCodePatches(source, patches)).rejects.toThrow(
    "local changes",
  );
  git(source, "checkout", "-q", "--", ".");
  await applyZCodePatches(source, patches);
  await writeFile(join(source, "other.txt"), "untracked build output");
  await expect(
    verifyAppliedZCodePatches(source, patches),
  ).resolves.toHaveLength(1);
  git(source, "add", "other.txt");
  git(
    source,
    "-c",
    "user.email=t@e.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "track",
  );
  await writeFile(join(source, "other.txt"), "edited");
  await expect(verifyAppliedZCodePatches(source, patches)).rejects.toThrow(
    "other.txt",
  );
});

test("ships documented patches", async () => {
  const shipped = await listZCodePatches(ZCODE_PATCH_DIRECTORY);
  expect(shipped.map((p) => p.file)).toEqual([
    "0001-hide-suppressed-official-plugins.patch",
  ]);
  for (const { path } of shipped) {
    const text = await readFile(path, "utf8");
    for (const heading of ["Purpose:", "Target:", "Remove when:", "License:"])
      expect(text.split("diff --git")[0]).toContain(heading);
  }
});
