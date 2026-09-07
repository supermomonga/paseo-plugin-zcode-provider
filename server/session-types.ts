import type {
  ProviderContent,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/provider";

export type NativePromptInput = string | ProviderContent[];
type WithoutIdentity<T> = T extends ProviderTimelineItem
  ? Omit<T, "id" | "revertToken">
  : never;
export type NativeTimelineItem = WithoutIdentity<ProviderTimelineItem>;

// Native text fragments are assembled into complete ProviderTimelineItem snapshots at the connection boundary.
export type NativeSessionEvent =
  | { type: "timeline"; item: NativeTimelineItem; turnId?: string }
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
