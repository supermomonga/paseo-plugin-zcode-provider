import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const accountFamilySchema = z.enum(["zai", "bigmodel"]);
export type AccountFamily = z.output<typeof accountFamilySchema>;

export const apiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export type ApiFormat = z.output<typeof apiFormatSchema>;

export const planModeSchema = z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
]);

const modelSchema = z
  .object({
    modelId: z.string(),
    enabled: z.boolean(),
    /** Ready for new sessions: enabled, complete and entitled. */
    selectable: z.boolean(),
    /** Listed by ZCode's catalog rather than added by the user. */
    builtin: z.boolean(),
    contextWindow: z.number().optional(),
    vision: z.boolean(),
  })
  .strict();

const planSchema = z
  .object({
    providerId: z.string(),
    name: z.string(),
    mode: planModeSchema,
    availability: z.string(),
    entitled: z.boolean(),
    unavailableReason: z.string().optional(),
    models: z.array(z.string()),
  })
  .strict();

// API keys never leave the daemon: the view only reports whether one is set.
const customProviderSchema = z
  .object({
    providerId: z.string(),
    name: z.string(),
    templateId: z.string().optional(),
    enabled: z.boolean(),
    executable: z.boolean(),
    apiFormat: apiFormatSchema.optional(),
    baseUrl: z.string().optional(),
    apiKeySet: z.boolean(),
    apiKeyManagementUrl: z.string().optional(),
    issues: z.array(z.string()),
    models: z.array(modelSchema),
  })
  .strict();

const templateSchema = z
  .object({
    templateId: z.string(),
    name: z.string(),
    apiFormat: apiFormatSchema.optional(),
    baseUrl: z.string().optional(),
    apiKeyManagementUrl: z.string().optional(),
  })
  .strict();

export const signInStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z
    .object({
      state: z.literal("pending"),
      family: accountFamilySchema,
      /** Open it on any device; the daemon receives the result. */
      authorizeUrl: z.string(),
      expiresAt: z.number(),
    })
    .strict(),
  z.object({ state: z.literal("failed"), message: z.string() }).strict(),
]);

export const accountViewSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      account: z.discriminatedUnion("state", [
        z.object({ state: z.literal("signed-out") }).strict(),
        z
          .object({
            state: z.enum(["signed-in", "reauthentication-required"]),
            family: accountFamilySchema.optional(),
            displayName: z.string().optional(),
            username: z.string().optional(),
          })
          .strict(),
      ]),
      signIn: signInStateSchema,
      plans: z.array(planSchema),
      providers: z.array(customProviderSchema),
      templates: z.array(templateSchema),
    })
    .strict(),
]);

export type AccountView = z.output<typeof accountViewSchema>;
export type ReadyAccountView = Extract<AccountView, { status: "ready" }>;
export type CustomProvider = ReadyAccountView["providers"][number];
export type ProviderTemplate = ReadyAccountView["templates"][number];

const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(100);
// React Native's URL polyfill lacks protocol and host, so this is a pattern.
// ZCode parses the URL itself when it saves the provider.
export const isHttpUrl = (value: string) =>
  /^https?:\/\/[^\s/?#]+[^\s]*$/iu.test(value);
const baseUrl = z
  .string()
  .trim()
  .max(2048)
  .refine(isHttpUrl, "Enter an http(s) URL");
const apiKey = z.string().trim().min(1).max(4096);

export const accountChangeSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("signIn"), family: accountFamilySchema })
    .strict(),
  z.object({ action: z.literal("cancelSignIn") }).strict(),
  z.object({ action: z.literal("signOut") }).strict(),
  z
    .object({
      action: z.literal("createProvider"),
      templateId: id.optional(),
      name,
      apiFormat: apiFormatSchema,
      baseUrl,
      apiKey,
    })
    .strict(),
  z
    .object({
      action: z.literal("updateProvider"),
      providerId: id,
      name: name.optional(),
      apiFormat: apiFormatSchema.optional(),
      baseUrl: baseUrl.optional(),
      apiKey: apiKey.optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("deleteProvider"), providerId: id }).strict(),
  z
    .object({
      action: z.literal("addModel"),
      providerId: id,
      modelId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal("deleteModel"),
      providerId: id,
      modelId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal("setModelEnabled"),
      providerId: id,
      modelId: id,
      enabled: z.boolean(),
    })
    .strict(),
]);

export type AccountChange = z.input<typeof accountChangeSchema>;

export const zcodeAccountView = defineRpc({
  name: "zcode.account.view",
  input: z.object({}).strict(),
  output: accountViewSchema,
});

// Changes go through ZCode's own account and provider services, which own
// validation and storage. The result is the refreshed view.
export const zcodeAccountChange = defineRpc({
  name: "zcode.account.change",
  input: accountChangeSchema,
  output: accountViewSchema,
});
