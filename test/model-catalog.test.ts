import { afterEach, expect, it } from "vitest";
import { providerFixture } from "./provider-fixture.js";
import { encodeModel } from "../server/mapping.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it("uses the Host model catalog and V4 model selection", async () => {
  const f = await providerFixture();
  cleanup.push(f.close);
  f.host.selectionView.models.push({
    ref: { providerId: "provider", modelId: "other" },
    label: "Other",
    reasoningLevels: ["high"],
  });
  await f.open();
  const model = encodeModel({ providerId: "provider", modelId: "other" });
  await f.send({
    type: "session.configure",
    sessionId: "public",
    requestId: "model",
    changes: { model },
  });
  await f.wait(
    (e) => e.type === "request.completed" && e.requestId === "model",
  );
  expect(
    f.events.filter((e) => e.type === "session.config").at(-1),
  ).toMatchObject({ config: { model } });
  expect(
    f.host.calls.some((c) => c.params?.envelope?.type === "switchModelConfig"),
  ).toBe(true);
  expect(f.host.calls.some((c) => c.method === "setModel")).toBe(false);
});
it("preserves native Plan state on resume and keeps mode independent", async () => {
  const f = await providerFixture();
  cleanup.push(f.close);
  f.host.state.config.planEnabled = true;
  await f.open(
    {},
    {
      version: 3,
      data: { kind: "native", sessionId: "session-1", cwd: f.cwd },
    },
  );
  expect(
    f.events.filter((e) => e.type === "session.config").at(-1),
  ).toMatchObject({
    config: { mode: "build", providerOptions: { plan_mode: true } },
  });
  await f.send({
    type: "session.configure",
    sessionId: "public",
    requestId: "plan",
    changes: { providerOptions: { plan_mode: false } },
  });
  await f.wait((e) => e.type === "request.completed" && e.requestId === "plan");
  expect(f.host.state.config).toMatchObject({
    mode: "build",
    planEnabled: false,
  });
});

it.each([
  ["build", false],
  ["build", true],
  ["edit", false],
  ["edit", true],
  ["yolo", false],
  ["yolo", true],
] as const)(
  "reapplies Paseo mode %s and Plan %s before reporting a restored session ready",
  async (mode, plan) => {
    const f = await providerFixture();
    cleanup.push(f.close);
    // The native resume may return stale configuration. Paseo's saved settings
    // are authoritative when provided, including an explicit false Plan value.
    f.host.state.config.mode = mode === "yolo" ? "build" : "yolo";
    f.host.state.config.planEnabled = !plan;
    const ready = await f.open(
      { mode, providerOptions: { plan_mode: plan } },
      {
        version: 3,
        data: { kind: "native", sessionId: "session-1", cwd: f.cwd },
      },
    );
    expect(ready.type).toBe("session.ready");
    expect(f.host.state.config).toMatchObject({ mode, planEnabled: plan });
    const configs = f.events.filter((e) => e.type === "session.config");
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      config: { mode, providerOptions: { plan_mode: plan } },
    });
    expect(f.events.indexOf(configs[0]!)).toBeLessThan(f.events.indexOf(ready));
  },
);

// Paseo repeats the options in the deprecated `settings`; only
// `providerOptions` is read.
it("ignores Plan given only in the deprecated settings", async () => {
  const f = await providerFixture();
  cleanup.push(f.close);
  const ready = await f.open({ settings: { plan_mode: true } });
  expect(ready.type).toBe("session.ready");
  expect(f.host.state.config).toMatchObject({ planEnabled: false });
});

it("reports Plan as a composer control with its value in providerOptions", async () => {
  const f = await providerFixture();
  cleanup.push(f.close);
  await f.open({ providerOptions: { plan_mode: true } });
  const config = f.events.filter((e) => e.type === "session.config").at(-1);
  expect(config).toMatchObject({
    config: {
      controls: [
        {
          type: "toggle",
          key: "plan_mode",
          label: "Plan",
          icon: "list-todo",
          defaultValue: false,
        },
      ],
      providerOptions: { plan_mode: true },
    },
  });
  expect(config).not.toHaveProperty("config.settings");
});

// Paseo returns an option to the provider's default with `null`.
it("turns Plan off when Paseo resets plan_mode", async () => {
  const f = await providerFixture();
  cleanup.push(f.close);
  await f.open({ providerOptions: { plan_mode: true } });
  expect(f.host.state.config).toMatchObject({ planEnabled: true });
  await f.send({
    type: "session.configure",
    sessionId: "public",
    requestId: "reset",
    changes: { providerOptions: { plan_mode: null } },
  });
  await f.wait(
    (e) => e.type === "request.completed" && e.requestId === "reset",
  );
  expect(f.host.state.config).toMatchObject({ planEnabled: false });
  expect(
    f.events.filter((e) => e.type === "session.config").at(-1),
  ).toMatchObject({ config: { providerOptions: { plan_mode: false } } });
});

it.each([
  ["an unknown option", { model_effort: "high" }],
  ["a Plan that is not a boolean", { plan_mode: "on" }],
])("rejects %s in a configuration change", async (_, providerOptions) => {
  const f = await providerFixture();
  cleanup.push(f.close);
  await f.open();
  await f.send({
    type: "session.configure",
    sessionId: "public",
    requestId: "bad",
    changes: { providerOptions },
  });
  await f.wait((e) => e.type === "request.failed" && e.requestId === "bad");
  expect(f.host.state.config).toMatchObject({ planEnabled: false });
});
