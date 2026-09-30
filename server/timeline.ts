import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { NativeTimelineItem } from "./session-types.js";
import { AdapterError } from "./errors.js";

/** V4 rows already carry complete text and stable IDs, including on resume. */
export class TimelineSnapshots {
  replay(item: NativeTimelineItem): ProviderTimelineItem {
    if (!item.id)
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        "ZCode timeline item has no stable row ID",
      );
    return { ...item, id: item.id };
  }
  live(item: NativeTimelineItem, _turnId?: string): ProviderTimelineItem {
    return this.replay(item);
  }
}
