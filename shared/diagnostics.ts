import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const smokeResultSchema = z
  .object({
    passed: z.boolean(),
    cliVersion: z.string().optional(),
    doctorPassed: z.boolean(),
    authentication: z.enum(["present", "missing", "unknown"]),
    error: z.string().optional(),
  })
  .strict();

export const diagnosticsResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      providerVersion: z.string(),
      installRoot: z.string(),
      installRootSource: z.enum(["environment", "default"]),
      platform: z.string(),
      appVersion: z.string().optional(),
      cliVersion: z.string().optional(),
      compatibility: z.enum(["supported", "unsupported"]),
      compatibilityReason: z.string(),
      artifactMatch: z.boolean().optional(),
      writableInstallRoot: z.boolean(),
      sessionsDirectory: z.string(),
      smoke: smokeResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      providerVersion: z.string(),
      code: z.string(),
      message: z.string(),
      diagnostic: z.string(),
    })
    .strict(),
]);

export type DiagnosticsResult = z.output<typeof diagnosticsResultSchema>;

// Read-only status report for the Settings screen. The handler sanitizes every
// field; no credentials, conversation text, or raw native output cross this RPC.
export const zcodeDiagnostics = defineRpc({
  name: "zcode.diagnostics",
  input: z.object({ smoke: z.boolean().default(false) }).strict(),
  output: diagnosticsResultSchema,
});
