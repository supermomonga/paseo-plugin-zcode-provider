import type {
  PluginSettings,
  PluginSettingsState,
} from "@getpaseo/plugin/server";
import { logger } from "./logger.js";
import {
  defaultTimelinePreferences,
  type TimelinePreferences,
  type zcodeTimelineSettings,
} from "../shared/timeline.js";

type Schema = (typeof zcodeTimelineSettings)["schema"];

/**
 * Follows the saved timeline settings. The defaults apply until the first read
 * completes and while the stored document is invalid.
 */
export function followTimelineSettings(settings: PluginSettings<Schema>): {
  current: () => TimelinePreferences;
  dispose: () => void;
} {
  let current = defaultTimelinePreferences,
    changed = false,
    disposed = false;
  const apply = (state: PluginSettingsState<Schema>) => {
    if (disposed) return;
    if (state.status === "invalid")
      logger.log("warn", "zcode.settings.timeline.invalid");
    current =
      state.status === "ready" ? state.values : defaultTimelinePreferences;
  };
  const unsubscribe = settings.subscribe((state) => {
    changed = true;
    apply(state);
  });
  settings.read().then(
    (state) => {
      // A save notified meanwhile is newer than this read.
      if (!changed) apply(state);
    },
    (error: unknown) => logger.error("zcode.settings.timeline.failed", error),
  );
  return {
    current: () => current,
    dispose() {
      disposed = true;
      void unsubscribe();
    },
  };
}
