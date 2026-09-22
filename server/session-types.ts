import type {
  ProviderContent,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";

export type NativePromptInput = string | ProviderContent[];
export type NativeTimelineItem = ProviderTimelineItem;
export interface NativeTimelineEntry {
  item: NativeTimelineItem;
  timestamp?: string;
}

export type NativeSessionEvent =
  | {
      type: "prompt_accepted";
      clientMessageId: string;
      turnId: string;
      delivery: "turn" | "steer";
    }
  | ({ type: "timeline"; turnId?: string } & NativeTimelineEntry)
  | { type: "usage_updated"; usage: ProviderUsage; turnId?: string }
  | {
      type: "turn_started" | "turn_completed" | "turn_canceled";
      turnId: string;
      usage?: ProviderUsage;
      reason?: string;
    }
  | {
      type: "turn_failed" | "runtime_failed";
      turnId?: string;
      error: string;
      code?: string;
      diagnostic?: string;
    }
  | {
      type: "permission_requested";
      request: ProviderPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      requestId: string;
      resolution: ProviderPermissionResponse;
      turnId?: string;
    }
  | { type: "config_changed" };
