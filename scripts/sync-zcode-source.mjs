import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import ts from "typescript";

export const ZCODE_SOURCE_COMMIT = "872ad960de7ec172591f7e1952f7849229f94521";
const checkout = resolve(
  process.argv.slice(2).find((arg) => arg !== "--write") ??
    `${process.env.HOME}/ghq/github.com/zai-org/ZCode`,
);
const write = process.argv.includes("--write");
const destination = resolve(import.meta.dirname, "../server/vendor/zcode");
const entries = [
  "packages/rpc/src/channelClient.ts",
  "packages/rpc/src/channelServer.ts",
  "packages/rpc/src/protocol.ts",
  "packages/rpc/src/proxy-channel.ts",
  ...["apply", "command", "transport", "wire", "wire-assembler"].map(
    (name) => `packages/shared/src/zcode-protocol-v4/${name}.ts`,
  ),
];
const files = new Map();
const hash = (value) => createHash("sha256").update(value).digest("hex");
function readSource(path) {
  return execFileSync(
    "git",
    ["-C", checkout, "show", `${ZCODE_SOURCE_COMMIT}:${path}`],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
}
function collect(path) {
  if (files.has(path)) return;
  const source = readSource(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const dependencies = [];
  function visit(node) {
    const literal =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : undefined;
    if (literal && ts.isStringLiteral(literal)) {
      const specifier = literal.text;
      let target;
      if (specifier.startsWith("."))
        target = posix
          .normalize(posix.join(posix.dirname(path), specifier))
          .replace(/\.js$/, ".ts");
      else if (specifier === "@zcode/model-option-map") {
        target = "packages/model-option-map/src/index.ts";
        const replacement = posix
          .relative(posix.dirname(path), target)
          .replace(/\.ts$/, ".js");
        edits.push([
          literal.getStart(ast) + 1,
          literal.getEnd() - 1,
          replacement.startsWith(".") ? replacement : `./${replacement}`,
        ]);
      } else if (specifier !== "zod" && !specifier.startsWith("node:"))
        throw new Error(
          `Unexpected upstream dependency ${specifier} in ${path}`,
        );
      if (target) dependencies.push(target);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let content = source;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
    content = content.slice(0, start) + replacement + content.slice(end);
  files.set(path, {
    content,
    sourceSha256: hash(source),
    vendoredSha256: hash(content),
  });
  for (const dep of dependencies) collect(dep);
}
for (const entry of entries) collect(entry);
for (const path of ["LICENSE", "NOTICE.md"]) {
  const content = readSource(path);
  files.set(path, {
    content,
    sourceSha256: hash(content),
    vendoredSha256: hash(content),
  });
}
const notices = readSource("THIRD-PARTY-NOTICES.md");
const noticeId =
  "9480271317925265e806a9a196aaa33410a962fa9d4d1e248a4a5187bc8c9df9";
const noticeStart = notices.indexOf(`### Notice ${noticeId}\n`);
const noticeEnd = notices.indexOf("\n### Notice ", noticeStart + 1);
if (noticeStart < 0 || noticeEnd < 0)
  throw new Error("Missing upstream Visual Studio Code license notice");
const notice =
  "# Notices for the vendored ZCode source subset\n\n" +
  "The following notice is reproduced from ZCode's THIRD-PARTY-NOTICES.md.\n" +
  "It applies to packages/rpc/src and packages/shared/src/zcode-protocol-v4/wire-codec.ts.\n" +
  "The adjacent NOTICE.md is the unmodified notice for the entire upstream project;\n" +
  "its description of other components does not imply their inclusion in this plugin.\n\n" +
  notices.slice(noticeStart, noticeEnd).trimEnd() +
  "\n";
files.set("THIRD-PARTY-NOTICES.md", {
  content: notice,
  sourceSha256: hash(notices),
  vendoredSha256: hash(notice),
});
const manifest = {
  repository: "https://github.com/zai-org/ZCode",
  commit: ZCODE_SOURCE_COMMIT,
  entries,
  modifications: [
    "Resolve the private @zcode/model-option-map workspace import to its vendored relative path.",
    `Select Visual Studio Code notice ${noticeId} from THIRD-PARTY-NOTICES.md and add a scope explanation; sourceSha256 hashes the complete upstream file. LICENSE and NOTICE.md are unchanged.`,
  ],
  files: Object.fromEntries(
    [...files]
      .sort()
      .map(([p, v]) => [
        p,
        { sourceSha256: v.sourceSha256, vendoredSha256: v.vendoredSha256 },
      ]),
  ),
};
files.set("provenance.json", {
  content: JSON.stringify(manifest, null, 2) + "\n",
});
const actual = await readdir(destination, {
  recursive: true,
  withFileTypes: true,
});
for (const entry of actual)
  if (entry.isFile()) {
    const path = posix.join(
      entry.parentPath.slice(destination.length + 1).replaceAll("\\", "/"),
      entry.name,
    );
    if (!files.has(path)) throw new Error(`Unexpected vendored file: ${path}`);
  }
for (const [path, { content }] of files) {
  const output = join(destination, path);
  if (write) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content);
  } else if ((await readFile(output, "utf8")) !== content)
    throw new Error(`Vendored source differs: ${path}`);
}
console.log(
  `${write ? "Synchronized" : "Verified"} ${files.size} files at ${ZCODE_SOURCE_COMMIT}`,
);
