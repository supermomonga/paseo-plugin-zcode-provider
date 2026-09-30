import { z } from "zod";

export const InitializeResultSchema = z
  .object({
    available: z.boolean(),
    workspaceKey: z.string().min(1).optional(),
    protocolName: z.string().optional(),
    protocolVersion: z.number().int().optional(),
    transportKind: z.string().optional(),
    reason: z.string().optional(),
    reasonCode: z.string().optional(),
  })
  .passthrough();

export const ModelSelectionSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    options: z
      .object({ reasoningLevel: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();

const ModelOptionSchema = z
  .object({
    ref: ModelSelectionSchema,
    label: z.string().min(1),
    providerLabel: z.string().optional(),
    reasoningLevels: z.array(z.string().min(1)).min(1).optional(),
  })
  .passthrough();

const ThoughtLevelOptionSchema = z
  .object({ value: z.string().min(1), label: z.string().min(1) })
  .passthrough();

export const SessionSettingsSchema = z
  .object({
    model: z
      .object({
        current: ModelSelectionSchema.optional(),
        available: z.array(ModelOptionSchema),
      })
      .passthrough(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: z.string().optional(),
        defaultLevel: z.string().optional(),
        available: z.array(ThoughtLevelOptionSchema),
      })
      .passthrough(),
    mode: z.object({ current: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export const WorkspacePresentationSchema = z
  .object({
    workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
    mode: z.string().min(1),
  })
  .passthrough();

export const ModelSelectionViewSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    models: z.array(
      ModelOptionSchema.extend({
        reasoningLevels: z.array(z.string().min(1)).min(1),
      }),
    ),
    preferredSelection: ModelSelectionSchema.optional(),
    effectiveSelection: ModelSelectionSchema.nullable().optional(),
    selectionIssue: z.string().optional(),
  })
  .strict();

export const SessionSnapshotSchema = z
  .object({
    session: z
      .object({
        sessionId: z.string().min(1),
        status: z.string(),
        workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
        title: z.string().optional(),
        updatedAt: z.number().optional(),
      })
      .passthrough(),
    settings: SessionSettingsSchema,
    slashCommands: z.array(
      z
        .object({
          name: z.string().min(1),
          description: z.string(),
          inputHint: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .strip();

export const SessionListSchema = z.array(
  z
    .object({
      sessionId: z.string().min(1),
      workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
      title: z.string().optional(),
      updatedAt: z.number().optional(),
    })
    .passthrough(),
);

export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type ModelSelectionView = z.infer<typeof ModelSelectionViewSchema>;
