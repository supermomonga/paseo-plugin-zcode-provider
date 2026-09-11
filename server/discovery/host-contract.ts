import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { init, parse } from "es-module-lexer";
import { AdapterError } from "../errors.js";
import { HOST_INDEX_RELATIVE_PATH } from "./manifest.js";

export function resolveHostIndex(
  installRoot: string,
  hostArchive: string,
): string {
  const hostIndex = join(hostArchive, HOST_INDEX_RELATIVE_PATH);
  ensureInsideInstallRoot(installRoot, hostIndex);
  return hostIndex;
}

export async function resolveHostImports(
  source: string,
  hostIndex: string,
  installRoot: string,
): Promise<string[]> {
  await init;
  const [imports] = parse(source);
  const paths = new Set<string>();
  for (const entry of imports) {
    if (entry.d !== -1 || entry.n === undefined || !/^\.{1,2}\//u.test(entry.n))
      continue;
    const path = resolve(dirname(hostIndex), entry.n);
    ensureInsideInstallRoot(installRoot, path);
    paths.add(path);
  }
  return [...paths];
}

export function ensureInsideInstallRoot(root: string, path: string): void {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Resolved runtime path is outside the install root",
    );
  }
}

// Runs only in the installed Electron process. No ZCode source is copied into the plugin.
// Names and callable members describe the required RPC contract, independently of bundler aliases.
export const RPC_INSPECTION_SOURCE = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function inside(root, file) {
  const resolved = fs.realpathSync(file);
  const child = path.relative(root, resolved);
  if (child === ".." || child.startsWith(".." + path.sep) || path.isAbsolute(child)) {
    throw new Error("host-path");
  }
  return resolved;
}
function selectRpcExports(rpc) {
  const entries = Object.entries(rpc);
  const constructors = (name, methods) => entries.filter(([, value]) =>
    typeof value === "function" && value.name === name &&
    methods.every(method => typeof value.prototype?.[method] === "function")
  );
  const protocol = constructors("MessagePortProtocol", ["send", "disconnect"]);
  const client = constructors("ChannelClient", ["getChannel", "dispose"]);
  const service = entries.filter(([, value]) => value !== null && typeof value === "object" &&
    typeof value.fromService === "function" && typeof value.toService === "function");
  if (protocol.length === 0 || client.length === 0 || service.length === 0) return;
  if (protocol.length !== 1 || client.length !== 1 || service.length !== 1) throw new Error("rpc-ambiguous");
  return { protocol: protocol[0][0], client: client[0][0], service: service[0][0] };
}
async function inspectRpcModules(root, hostIndex, modules) {
  inside(root, hostIndex);
  // Validate every candidate before importing any of them, including unpacked/symlinked installations.
  const paths = [...new Set(modules.map(file => inside(root, file)))];
  const candidates = [];
  for (const file of paths) {
    let rpc;
    try { rpc = await import(pathToFileURL(file).href); }
    catch { throw new Error("rpc-module-load"); }
    const rpcExports = selectRpcExports(rpc);
    if (rpcExports) candidates.push({ hostRpcModule: file, rpcExports });
  }
  if (candidates.length !== 1) throw new Error(candidates.length === 0 ? "rpc-missing" : "rpc-ambiguous");
  return {
    ...candidates[0],
    hostIndexSha256: hash(hostIndex),
    hostRpcModuleSha256: hash(candidates[0].hostRpcModule),
  };
}
`;
