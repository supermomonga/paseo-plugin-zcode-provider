import { PROVIDER_VERSION } from "../build-info.js";

const ZCODE_HOST_WORKER_SOURCE = String.raw`
import { parentPort, workerData } from "node:worker_threads";
if (!parentPort) throw new Error("ZCode host worker requires a parent port");
const outerListeners = new Map();
function wrapPort(port) {
  const listeners = new Map();
  return {
    on(event, listener) {
      const wrapped = event === "message" ? data => listener({ data }) : (...args) => listener(...args);
      listeners.set(listener, wrapped); port.on(event, wrapped); return this;
    },
    once(event, listener) {
      const wrapped = event === "message" ? data => listener({ data }) : (...args) => listener(...args);
      listeners.set(listener, wrapped); port.once(event, wrapped); return this;
    },
    off(event, listener) {
      const wrapped = listeners.get(listener) || listener;
      listeners.delete(listener); port.off(event, wrapped); return this;
    },
    postMessage(value, transferList) { port.postMessage(value, transferList); },
    start() { port.start(); },
    close() { port.close(); }
  };
}
const electronParentPort = {
  on(event, listener) {
    const wrapped = value => listener({ ...value, ports: value?.ports?.map(wrapPort) || [] });
    outerListeners.set(listener, wrapped); parentPort.on(event, wrapped); return this;
  },
  once(event, listener) {
    const wrapped = value => listener({ ...value, ports: value?.ports?.map(wrapPort) || [] });
    outerListeners.set(listener, wrapped); parentPort.once(event, wrapped); return this;
  },
  off(event, listener) {
    const wrapped = outerListeners.get(listener) || listener;
    outerListeners.delete(listener); parentPort.off(event, wrapped); return this;
  },
  postMessage(value, transferList) { parentPort.postMessage(value, transferList); }
};
Object.defineProperty(process, "parentPort", { value: electronParentPort, configurable: true });
await import(workerData.hostIndexUrl);
`;

export const HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE = String.raw`
worker.on("message", message => {
  if (
    message?.type !== "browser-execute-request" ||
    typeof message.requestId !== "string" ||
    message.requestId.length === 0
  ) {
    return;
  }
  worker.postMessage({
    data: {
      type: "browser-execute-result",
      requestId: message.requestId,
      result: {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "Browser control is unavailable in the Paseo ZCode provider",
          sideEffect: "none"
        },
        elapsedMs: 0
      }
    },
    ports: []
  });
});
`;

export const ZCODE_HOST_BRIDGE_SOURCE = String.raw`
import { MessageChannel, Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const hostIndex = process.env.PASEO_ZCODE_HOST_INDEX;
const hostRpcModule = process.env.PASEO_ZCODE_HOST_RPC_MODULE;
const rpcExportsJson = process.env.PASEO_ZCODE_RPC_EXPORTS;
const hostProtocolJson = process.env.PASEO_ZCODE_HOST_PROTOCOL;
if (!hostIndex || !hostRpcModule || !rpcExportsJson || !hostProtocolJson) {
  throw new Error("Missing ZCode host artifact or protocol");
}
const rpcExports = JSON.parse(rpcExportsJson);
const hostProtocol = JSON.parse(hostProtocolJson);

const workerSource = ${JSON.stringify(ZCODE_HOST_WORKER_SOURCE)};

const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(workerSource)), {
  workerData: { hostIndexUrl: pathToFileURL(hostIndex).href },
  stdout: true,
  stderr: true
});
worker.stdout.resume();
worker.stderr.resume();
${HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE}

const rpc = await import(pathToFileURL(hostRpcModule).href);
const ports = new MessageChannel();
const protocol = new rpc[rpcExports.protocol](ports.port1);
const client = new rpc[rpcExports.client](protocol);
const serviceFactory = rpc[rpcExports.service];
const services = new Map(Object.entries(hostProtocol.serviceChannels).map(([name, channel]) => [
  name,
  serviceFactory.toService(client.getChannel(channel))
]));
const agentService = services.get("agent");
if (!agentService) throw new Error("ZCode host protocol has no agent service");
const subscriptions = new Map();
const commonAgentMethods = new Set([
  "initialize", "readWorkspaceState", "createSession", "resumeSession", "listSessions",
  "readSession", "readSessionMessages", "readSessionEvents", "sendConversationCommandV4",
  "closeSession", "setModel", "setThoughtLevel", "setMode", "getTaskTokenUsage",
  "respondProviderRuntimeHeaders", "disposeWorkspace",
  "attachmentBeginV4", "attachmentChunkV4", "attachmentCommitV4", "attachmentAbortV4"
]);
const contractOperations = new Set(Object.values(hostProtocol.operations).map(operation =>
  operation.service + ":" + operation.method
));
let shuttingDown = false;
let conversationHandshake;

async function initializeConversation() {
  conversationHandshake ??= (async () => {
    const hello = await agentService.helloConversationV4();
    if (hello?.kind !== "hello" || hello.protocolVersion !== 3 || hello.clientMode !== "desktop-continuous")
      throw new Error("Unsupported V4 conversation handshake");
    await agentService.initializeConversationV4({ kind: "clientHello", protocolVersion: 3,
      clientId: "paseo-zcode-provider", appVersion: ${JSON.stringify(PROVIDER_VERSION)} });
  })();
  await conversationHandshake;
}

function write(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function dispatch(message) {
  const id = message?.id;
  if (!Number.isInteger(id) && typeof id !== "string") return;
  try {
    if (message.method === "__subscribe") {
      const subscriptionId = message.params?.subscriptionId;
      if (typeof subscriptionId !== "string" || !subscriptionId) throw new Error("Invalid subscription id");
      if (subscriptions.has(subscriptionId)) throw new Error("Duplicate subscription id");
      await initializeConversation();
      const target = message.params.target;
      const disposable = agentService.onDynamicSessionEvent(target)(event => {
        write({ method: "event", params: { subscriptionId, event } });
      });
      const conversation = agentService.onDynamicConversationFrame(target)(frame => {
        if (frame.topic === "conversation/" + target.sessionId)
          write({ method: "event", params: { subscriptionId, event: { type: "conversation.frame", frame } } });
      });
      let nativeSubscription;
      try {
        const result = await agentService.subscribeConversationV4(target);
        if (!result?.ack?.subscriptionId) throw new Error("Missing V4 conversation subscription");
        nativeSubscription = result.ack.subscriptionId;
      } catch (error) {
        conversation.dispose(); disposable.dispose(); throw error;
      }
      subscriptions.set(subscriptionId, { async dispose() {
        conversation.dispose(); disposable.dispose();
        await agentService.unsubscribeConversationV4({ ...target, subscriptionId: nativeSubscription });
      } });
      write({ id, result: { subscribed: true } });
      return;
    }
    if (message.method === "__unsubscribe") {
      const disposable = subscriptions.get(message.params?.subscriptionId);
      await disposable?.dispose();
      subscriptions.delete(message.params?.subscriptionId);
      write({ id, result: { unsubscribed: true } });
      return;
    }
    if (message.method !== "__call") throw new Error("Unsupported bridge method: " + message.method);
    const serviceName = message.params?.service;
    const nativeMethod = message.params?.method;
    const service = services.get(serviceName);
    if (!service) throw new Error("Unsupported bridge service: " + serviceName);
    const allowed = serviceName === "agent" && commonAgentMethods.has(nativeMethod) ||
      contractOperations.has(serviceName + ":" + nativeMethod) ||
      serviceName === "usage" && ["getEntitlementSnapshot", "getCodingPlanResetStatus"].includes(nativeMethod);
    if (!allowed) throw new Error("Unsupported native bridge method: " + serviceName + ":" + nativeMethod);
    const result = await service[nativeMethod](message.params?.params);
    write({ id, result: result === undefined ? null : result });
  } catch (error) {
    write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const disposable of subscriptions.values()) void Promise.resolve(disposable.dispose()).catch(() => {});
  subscriptions.clear();
  try { worker.postMessage({ data: { type: "dispose" }, ports: [] }); } catch {}
  setTimeout(() => process.exit(0), 2000).unref();
}

worker.on("error", error => {
  if (!shuttingDown) {
    process.stderr.write("ZCode host worker failed: " + error.message + "\n");
    process.exit(1);
  }
});
worker.on("exit", code => {
  if (!shuttingDown) process.exit(code === 0 ? 1 : code);
});

worker.postMessage({
  data: {
    type: "init-local",
    deviceMid: "paseo-zcode-provider",
    agentSpawnFallbackCwd: process.cwd()
  },
  ports: [ports.port2]
}, [ports.port2]);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", line => {
  if (!line.trim()) return;
  try { void dispatch(JSON.parse(line)); }
  catch { write({ id: null, error: { code: -32700, message: "Invalid JSON" } }); }
});
lines.on("close", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`;
