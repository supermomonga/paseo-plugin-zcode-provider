// Process fixture using the pinned upstream RPC implementation, not the plugin transport.
import { Emitter } from "../server/vendor/zcode/packages/rpc/src/foundation.js";
import { VSBuffer } from "../server/vendor/zcode/packages/rpc/src/buffer.js";
import { SocketProtocol } from "../server/vendor/zcode/packages/rpc/src/protocol.js";
import { ChannelServer } from "../server/vendor/zcode/packages/rpc/src/channelServer.js";
import { ProxyChannel } from "../server/vendor/zcode/packages/rpc/src/proxy-channel.js";
const scenario = process.env.STDIO_SCENARIO;
if (scenario === "bad-hello") {
  process.stdout.write('{"type":"wrong"}\n');
  process.stdin.resume();
} else {
  process.stdout.write(
    JSON.stringify({
      type: "zcode-hello",
      version: "3.14.0",
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    }) + "\n",
  );
  let header = Buffer.alloc(0);
  function handshake(chunk: Buffer) {
    header = Buffer.concat([header, chunk]);
    const end = header.indexOf(10);
    if (end < 0) return;
    const ack = JSON.parse(header.subarray(0, end).toString());
    if (ack.type !== "zcode-hello-ack") process.exit(2);
    process.stdin.off("data", handshake);
    const input = new Emitter<VSBuffer>(),
      close = new Emitter<void>();
    const protocol = new SocketProtocol({
      onData: input.event,
      onClose: close.event,
      onEnd: close.event,
      write: (b) => {
        const bytes = Buffer.from(b.buffer);
        for (let i = 0; i < bytes.length; i += 3)
          process.stdout.write(bytes.subarray(i, i + 3));
      },
      end: () => process.stdout.end(),
      drain: async () => {},
      dispose: () => {},
    });
    const server = new ChannelServer(protocol, "test");
    let autoResolution: unknown;
    const frames = new Emitter<unknown>();
    server.registerChannel(
      "zcode-agent",
      ProxyChannel.fromService({
        async helloConversationV4() {
          return {
            kind: "hello",
            protocolVersion: 3,
            connectionId: "fixture",
            clientMode: "desktop-continuous",
            deliveryProfile: "continuous",
            serverTime: 1,
            capabilities: {
              nativeDialogs: true,
              localTerminal: true,
              binaryFrames: false,
              compression: "none",
              independentPlanState: scenario !== "bad-v4",
            },
            auth: {},
          };
        },
        async initializeConversationV4() {},
        async syncAppRuntimePreferences(value: unknown) {
          autoResolution = value;
        },
        async initialize() {
          return { available: true, autoResolution };
        },
        onDynamicConversationFrame() {
          return frames.event;
        },
        async subscribeConversationV4() {
          return {
            ack: {
              subscriptionId: "test-sub",
              mode: "snapshot",
              logEpoch: "test-epoch",
            },
          };
        },
        async unsubscribeConversationV4() {
          throw new Error(
            "close must use EOF, not issue RPC after shutdown begins",
          );
        },
        async never() {
          return new Promise(() => {});
        },
        async crash() {
          process.exit(5);
        },
      }),
    );
    process.stdin.on("data", (b) => input.fire(VSBuffer.wrap(b)));
    if (header.length > end + 1)
      input.fire(VSBuffer.wrap(header.subarray(end + 1)));
    process.stdin.on("end", () => {
      server.dispose();
      process.exit(0);
    });
  }
  process.stdin.on("data", handshake);
}
process.stdin.on("end", () => process.exit(0));
