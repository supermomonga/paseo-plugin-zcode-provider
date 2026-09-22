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
    config: { mode: "build", settings: [{ id: "plan_mode", value: true }] },
  });
  await f.send({
    type: "session.configure",
    sessionId: "public",
    requestId: "plan",
    changes: { settings: { plan_mode: false } },
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
      { mode, settings: { plan_mode: plan } },
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
      config: { mode, settings: [{ id: "plan_mode", value: plan }] },
    });
    expect(f.events.indexOf(configs[0]!)).toBeLessThan(f.events.indexOf(ready));
  },
);
