import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
if (typeof version !== "string" || version.length === 0)
  throw new Error("Missing provider package version");
await writeFile(
  new URL("server/build-info.ts", root),
  `// Generated from package.json by npm prepare / prebuild.\nexport const PROVIDER_VERSION = ${JSON.stringify(version)};\n`,
);
