import { expect, it } from "vitest";
import type { PluginSettingsState } from "@getpaseo/plugin/server";
import { followTimelineSettings } from "./timeline-settings.js";
import type { zcodeTimelineSettings } from "../shared/timeline.js";

type State = PluginSettingsState<(typeof zcodeTimelineSettings)["schema"]>;

function settings() {
  let resolveRead!: (state: State) => void;
  const listeners = new Set<(state: State) => void>();
  return {
    handle: {
      read: () => new Promise<State>((r) => (resolveRead = r)),
      subscribe(listener: (state: State) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    read: async (state: State) => {
      resolveRead(state);
      await new Promise((r) => setTimeout(r));
    },
    notify: (state: State) => listeners.forEach((l) => l(state)),
    listeners,
  };
}
const ready = (showModelChanges: boolean, revision = "1"): State => ({
  status: "ready",
  revision,
  values: { showModelChanges },
});

it("hides model changes until saved settings say otherwise", async () => {
  const s = settings();
  const timeline = followTimelineSettings(s.handle);
  expect(timeline.current()).toEqual({ showModelChanges: false });
  await s.read(ready(true));
  expect(timeline.current()).toEqual({ showModelChanges: true });
  s.notify(ready(false, "2"));
  expect(timeline.current()).toEqual({ showModelChanges: false });
});

it("uses the defaults while the stored document is invalid", async () => {
  const s = settings();
  const timeline = followTimelineSettings(s.handle);
  await s.read({ status: "invalid", revision: "1", error: "bad" });
  expect(timeline.current()).toEqual({ showModelChanges: false });
});

it("keeps a save notified before the first read completes", async () => {
  const s = settings();
  const timeline = followTimelineSettings(s.handle);
  s.notify(ready(true, "2"));
  await s.read(ready(false, "1"));
  expect(timeline.current()).toEqual({ showModelChanges: true });
});

it("stops following after disposal", () => {
  const s = settings();
  const timeline = followTimelineSettings(s.handle);
  timeline.dispose();
  expect(s.listeners.size).toBe(0);
});
