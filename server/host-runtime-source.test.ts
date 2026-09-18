import { describe, expect, test } from "vitest";
import {
  HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE,
  MODEL_SELECTION_PROJECTION_SOURCE,
} from "./host/runtime-source.js";
import { ModelSelectionViewSchema } from "./protocol/v1/host-schemas.js";

test("projects model choices without provider credentials before writing bridge output", () => {
  const project = Function(
    `${MODEL_SELECTION_PROJECTION_SOURCE}; return projectModelSelection;`,
  )();
  const result = project({
    revision: 2,
    providers: [
      {
        providerId: "p",
        providerName: "Provider",
        config: {
          access: { apiKey: "PRIVATE_KEY" },
          api: { headers: { Authorization: "PRIVATE_HEADER" } },
        },
        models: [
          {
            modelId: "m",
            config: {
              optionSpecs: {
                reasoningLevel: {
                  values: ["low", "high"],
                  map: { high: "PRIVATE_MAP" },
                },
              },
            },
          },
        ],
      },
    ],
    preferredSelection: {
      providerId: "p",
      modelId: "m",
      options: { reasoningLevel: "high" },
      secret: "PRIVATE_SELECTION",
    },
  });
  expect(ModelSelectionViewSchema.parse(result)).toEqual({
    revision: 2,
    models: [
      {
        ref: { providerId: "p", modelId: "m" },
        label: "m",
        providerLabel: "Provider",
        reasoningLevels: ["low", "high"],
      },
    ],
    preferredSelection: {
      providerId: "p",
      modelId: "m",
      options: { reasoningLevel: "high" },
    },
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

type WorkerMessageHandler = (message: unknown) => void;

function createHarness() {
  let messageHandler: WorkerMessageHandler | undefined;
  const posted: unknown[] = [];
  const worker = {
    on(event: string, handler: WorkerMessageHandler) {
      if (event === "message") messageHandler = handler;
    },
    postMessage(message: unknown) {
      posted.push(message);
    },
  };

  Function("worker", HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE)(worker);
  if (messageHandler === undefined)
    throw new Error("message handler was not registered");
  return { handle: messageHandler, posted };
}

describe("headless ZCode host worker messages", () => {
  test("rejects browser execution immediately without copying the request payload", () => {
    const harness = createHarness();

    harness.handle({
      type: "browser-execute-request",
      requestId: "browser-request-1",
      command: { method: "navigate", url: "https://secret.example" },
    });

    expect(harness.posted).toEqual([
      {
        data: {
          type: "browser-execute-result",
          requestId: "browser-request-1",
          result: {
            ok: false,
            error: {
              code: "backend_unavailable",
              message:
                "Browser control is unavailable in the Paseo ZCode provider",
              sideEffect: "none",
            },
            elapsedMs: 0,
          },
        },
        ports: [],
      },
    ]);
    expect(JSON.stringify(harness.posted)).not.toContain("secret.example");
  });

  test("ignores unknown messages and invalid request IDs", () => {
    const harness = createHarness();

    harness.handle({ type: "log", requestId: "log-1" });
    harness.handle({ type: "browser-execute-request" });
    harness.handle({ type: "browser-execute-request", requestId: "" });
    harness.handle({ type: "browser-execute-request", requestId: 1 });

    expect(harness.posted).toEqual([]);
  });
});
