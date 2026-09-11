import { execFile } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  resolveHostImports,
  resolveHostIndex,
  RPC_INSPECTION_SOURCE,
} from "./discovery/host-contract.js";

const exec = promisify(execFile);
const rpcSource = (aliases: string[]) => `
class MessagePortProtocol { send() {} disconnect() {} }
class ChannelClient { getChannel() {} dispose() {} }
const service = { fromService() {}, toService() {} };
export { MessagePortProtocol as ${aliases[0]}, ChannelClient as ${aliases[1]}, service as ${aliases[2]} };
`;

async function fixture(
  files: Record<string, string>,
  run: (root: string, index: string) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zcode-inspection-")),
  );
  try {
    const directory = join(root, "out/host");
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    for (const [name, content] of Object.entries(files))
      await writeFile(join(directory, name), content);
    await run(root, join(directory, "index.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function inspect(root: string, index: string, modules: string[]) {
  const { stdout } = await exec(process.execPath, [
    "-e",
    RPC_INSPECTION_SOURCE +
      `
inspectRpcModules(${JSON.stringify(root)}, ${JSON.stringify(index)}, ${JSON.stringify(modules)})
.then(result => process.stdout.write(JSON.stringify({result})))
.catch(error => process.stdout.write(JSON.stringify({failure: error.message})));`,
  ]);
  return JSON.parse(stdout);
}

describe("installed RPC discovery", () => {
  test.each([
    ["a", "b", "c"],
    ["newProtocol", "renamedClient", "factory"],
  ])(
    "resolves renamed chunks and exports %j without known hashes",
    async (...aliases) => {
      const source = `import { ${aliases[0]} as protocol } from "./new-build.mjs";`;
      await fixture(
        { "index.js": source, "new-build.mjs": rpcSource(aliases) },
        async (root, index) => {
          const modules = await resolveHostImports(source, index, root);
          const output = await inspect(root, index, modules);
          expect(output.result).toMatchObject({
            hostRpcModule: join(root, "out/host/new-build.mjs"),
            rpcExports: {
              protocol: aliases[0],
              client: aliases[1],
              service: aliases[2],
            },
            hostIndexSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          });
        },
      );
    },
  );
  test("parses static imports and reexports without treating comments, strings, or dynamic imports as candidates", async () => {
    const source = `import './a.js'; export { x } from './b.js'; import('./dynamic.js'); const text = "import './fake.js'"; /* import './comment.js'; */ import.meta.url;`;
    expect(
      await resolveHostImports(
        source,
        "/install/out/host/index.js",
        "/install",
      ),
    ).toEqual(["/install/out/host/a.js", "/install/out/host/b.js"]);
  });
  test("rejects paths escaping the installation", async () => {
    expect(() => resolveHostIndex("/install", "/elsewhere")).toThrow("outside");
    await expect(
      resolveHostImports(
        "import '../../../secret.js'",
        "/install/out/host/index.js",
        "/install",
      ),
    ).rejects.toThrow("outside");
  });
  test.each(["missing", "ambiguous", "shape", "load"])(
    "rejects %s RPC contracts",
    async (mode) => {
      const source = 'import "./a.mjs"; import "./b.mjs";';
      const valid = rpcSource(["x", "y", "z"]);
      await fixture(
        {
          "index.js": source,
          "a.mjs":
            mode === "missing"
              ? "export const x = 1;"
              : mode === "shape"
                ? valid.replace("getChannel() {}", "")
                : mode === "load"
                  ? 'throw new Error("secret");'
                  : valid,
          "b.mjs": mode === "ambiguous" ? valid : "export const other = true;",
        },
        async (root, index) => {
          const output = await inspect(
            root,
            index,
            await resolveHostImports(source, index, root),
          );
          expect(output).toEqual({
            failure:
              mode === "ambiguous"
                ? "rpc-ambiguous"
                : mode === "load"
                  ? "rpc-module-load"
                  : "rpc-missing",
          });
        },
      );
    },
  );
  test("rejects symlinks outside the installation before importing candidates", async () => {
    const outside = await mkdtemp(join(tmpdir(), "zcode-outside-"));
    try {
      await writeFile(join(outside, "rpc.mjs"), rpcSource(["a", "b", "c"]));
      await fixture(
        { "index.js": 'import "./link.mjs";' },
        async (root, index) => {
          await symlink(
            join(outside, "rpc.mjs"),
            join(root, "out/host/link.mjs"),
          );
          expect(
            await inspect(root, index, [join(root, "out/host/link.mjs")]),
          ).toEqual({ failure: "host-path" });
        },
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
