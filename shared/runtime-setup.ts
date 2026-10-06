import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const runtimeComponentSchema = z
  .object({
    id: z.enum(["node", "zcode"]),
    name: z.string(),
    version: z.string(),
    url: z.string(),
    sha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    license: z.string(),
    installed: z.boolean(),
  })
  .strict();

export const setupJobSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z
    .object({
      state: z.literal("running"),
      component: z.enum(["node", "zcode"]),
      phase: z.enum(["download", "extract", "verify"]),
      receivedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ state: z.literal("succeeded") }).strict(),
  z
    .object({
      state: z.literal("failed"),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
]);

export const runtimeSetupStatusSchema = z
  .object({
    platform: z.string(),
    /** Managed setup exists for this daemon's OS/CPU. */
    supported: z.boolean(),
    /** PASEO_ZCODE_RUNTIME / PASEO_ZCODE_NODE take precedence when set. */
    override: z.boolean(),
    directory: z.string(),
    components: z.array(runtimeComponentSchema),
    job: setupJobSchema,
    /** Present once both components are installed; run it on the daemon machine. */
    loginCommand: z.string().optional(),
  })
  .strict();

export type RuntimeSetupStatus = z.output<typeof runtimeSetupStatusSchema>;

// Inputs are empty on purpose: the server installs only its pinned artifacts.
export const zcodeRuntimeStatus = defineRpc({
  name: "zcode.runtime.status",
  input: z.object({}).strict(),
  output: runtimeSetupStatusSchema,
});

export const zcodeRuntimeInstall = defineRpc({
  name: "zcode.runtime.install",
  input: z.object({}).strict(),
  output: z.object({ started: z.boolean() }).strict(),
});

export const zcodeRuntimeRemove = defineRpc({
  name: "zcode.runtime.remove",
  input: z.object({}).strict(),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("removed") }).strict(),
    z.object({ status: z.literal("failed"), message: z.string() }).strict(),
  ]),
});
