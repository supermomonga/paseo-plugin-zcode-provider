import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runMain } from "./releases/common.mjs";

// Applies patches/zcode to a ZCode checkout before the official build (ADR 19).
// Patches are plain unified diffs: they apply only when their context still
// matches, so any upstream change around them stops the release for review.
export const ZCODE_PATCH_DIRECTORY = resolve(
  import.meta.dirname,
  "../patches/zcode",
);

const git = (source, ...args) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });

export async function listZCodePatches(directory = ZCODE_PATCH_DIRECTORY) {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".patch"))
    .sort();
  if (files.length === 0) throw new Error(`No patches in ${directory}`);
  return Promise.all(
    files.map(async (file) => ({
      file,
      path: join(directory, file),
      sha256: createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex"),
    })),
  );
}

const touchedFiles = (source, patches) =>
  new Set(
    patches.flatMap(({ path }) =>
      git(source, "apply", "--numstat", path)
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[2]),
    ),
  );

export async function applyZCodePatches(source, directory) {
  const patches = await listZCodePatches(directory);
  if (git(source, "status", "--porcelain", "--untracked-files=no").trim())
    throw new Error(`ZCode checkout ${source} has local changes`);
  // Check every patch first so a failure leaves the checkout untouched.
  for (const { path } of patches) git(source, "apply", "--check", path);
  for (const { path } of patches) git(source, "apply", path);
  return patches;
}

// Confirms that exactly the listed patches modify the checkout.
export async function verifyAppliedZCodePatches(source, directory) {
  const patches = await listZCodePatches(directory);
  for (const { path } of [...patches].reverse())
    git(source, "apply", "--reverse", "--check", path);
  const expected = touchedFiles(source, patches);
  const changed = git(source, "diff", "--name-only").trim().split("\n");
  if (
    changed.length !== expected.size ||
    changed.some((file) => !expected.has(file))
  )
    throw new Error(
      `ZCode checkout changes ${changed.join(", ")}, expected only ${[...expected].join(", ")}`,
    );
  return patches;
}

runMain(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { source: { type: "string" } },
  });
  const command = positionals[0];
  if (!["apply", "check"].includes(command) || !values.source)
    throw new Error(
      "Usage: apply-zcode-patches.mjs apply|check --source <ZCode checkout>",
    );
  const source = resolve(values.source);
  if (command === "check")
    for (const { path } of await listZCodePatches())
      git(source, "apply", "--check", path);
  else await applyZCodePatches(source);
  for (const { file, sha256 } of await listZCodePatches())
    console.log(
      `${command === "check" ? "applies" : "applied"} ${file} ${sha256}`,
    );
});
