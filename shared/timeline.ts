import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const zcodeTimelineSettings = defineSettings({
  id: "timeline",
  scope: "host",
  version: 1,
  schema: z.object({ showModelChanges: z.boolean().default(false) }),
});
export type TimelinePreferences = z.output<typeof zcodeTimelineSettings.schema>;
export const defaultTimelinePreferences: TimelinePreferences =
  zcodeTimelineSettings.schema.parse({});
