import { z } from "zod";
import type { HostBridge, HostSubscription } from "../server/host/bridge.js";
import { AdapterError } from "../server/errors.js";
import { applyConversationDeltas } from "../server/vendor/zcode/packages/shared/src/zcode-protocol-v4/apply.js";
import {
  conversationSnapshotSchema,
  type GoalState,
  type SessionErrorInfo,
} from "../server/vendor/zcode/packages/shared/src/zcode-protocol-v4/snapshot.js";
import type { ConversationDelta } from "../server/vendor/zcode/packages/shared/src/zcode-protocol-v4/delta.js";
import type {
  ConversationRow,
  TurnHeaderRow,
} from "../server/vendor/zcode/packages/shared/src/zcode-protocol-v4/rows.js";
import type { ConversationTopicWireCandidate } from "../server/vendor/zcode/packages/shared/src/zcode-protocol-v4/transport.js";
import type {
  SessionSnapshot,
  ModelSelectionView,
} from "../server/host/schemas.js";
import draft from "./fixtures/v4-draft.json";
export function snapshot(workspace: string): SessionSnapshot {
  return {
    session: {
      sessionId: "session-1",
      status: "idle",
      workspace: { workspacePath: workspace },
      title: "Session",
      updatedAt: 1,
    },
    settings: {
      model: {
        current: {
          providerId: "provider",
          modelId: "model",
          options: { reasoningLevel: "high" },
        },
        available: [
          {
            ref: { providerId: "provider", modelId: "model" },
            label: "Model",
            providerLabel: "Provider",
            reasoningLevels: ["high"],
          },
        ],
      },
      thoughtLevel: {
        enabled: true,
        current: "high",
        available: [{ value: "high", label: "High" }],
      },
      mode: { current: "build" },
    },
    slashCommands: [
      { name: "plan", description: "Switch to Plan mode", inputHint: "[task]" },
      { name: "review", description: "Review", inputHint: "<path>" },
      { name: "goal", description: "Show or set the current session goal." },
    ],
  };
}
export class FakeBridge implements HostBridge {
  readonly diagnostic = {
    appVersion: "3.14.0",
    cliVersion: "0.16.9",
    platform: "darwin-arm64",
  };
  readonly calls: Array<{ method: string; params: any }> = [];
  state = conversationSnapshotSchema.parse(structuredClone(draft));
  selectionView: ModelSelectionView;
  ordinal = 0;
  closed = false;
  handler?: (frame: ConversationTopicWireCandidate) => void | Promise<void>;
  rowSequence = 0;
  goalTurns = 0;
  activeProductTurn?: string;
  deferConsumption = false;
  failAdmission?: "rejected" | "unknown";
  afterAdmit?: () => Promise<void>;
  private failures = new Set<(e: AdapterError) => void>();
  constructor(public current: SessionSnapshot) {
    this.selectionView = {
      revision: 1,
      models: current.settings.model.available.map((m) => ({
        ...m,
        reasoningLevels: ["high"],
      })),
      preferredSelection: current.settings.model.current,
    };
  }
  onFailure(handler: (error: AdapterError) => void) {
    this.failures.add(handler);
    return () => this.failures.delete(handler);
  }
  fail() {
    for (const f of this.failures)
      f(new AdapterError("NATIVE_EXITED", "test transport failure"));
  }
  wire(
    payload: unknown,
    deliveryKind = "online",
    fromSeq = 0,
  ): ConversationTopicWireCandidate {
    const ordinal = ++this.ordinal;
    return {
      wireVersion: 3,
      kind: "complete",
      deliveryKind,
      logicalFrameId: `frame-${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic: `conversation/${this.state.sessionId}`,
      subscriptionId: "sub",
      frame: {
        topic: `conversation/${this.state.sessionId}`,
        subscriptionId: "sub",
        sentAt: ordinal,
        fromSeq,
        toSeq: this.state.seq,
        payload,
      },
    };
  }
  async emitSnapshot(delivery = "online") {
    await this.handler?.(
      this.wire(
        { kind: "snapshot", snapshot: structuredClone(this.state) },
        delivery,
      ),
    );
  }
  async deltas(deltas: ConversationDelta[]) {
    const from = this.state.seq;
    this.state = {
      ...applyConversationDeltas(this.state, deltas),
      seq: from + 1,
      revision: this.state.revision + 1,
    };
    await this.handler?.(
      this.wire(
        {
          kind: "deltas",
          deltas: [
            ...deltas,
            { op: "state.updated", patch: { revision: this.state.revision } },
          ],
        },
        "online",
        from,
      ),
    );
  }
  async append(row: ConversationRow) {
    await this.deltas([{ op: "row.appended", row }]);
  }
  rowBase(turnId = this.activeProductTurn ?? "product-1") {
    return {
      rowId: ++this.rowSequence,
      turnId,
      productTurnId: turnId,
      entityId: `entity-${this.rowSequence}`,
      createdAt: 1,
      createdAtSeq: this.state.seq,
    };
  }
  async consume(commandId: string, text = "message", guide = false) {
    if (!guide) {
      this.activeProductTurn = `product-${commandId}`;
      await this.append({
        ...this.rowBase(),
        kind: "turnHeader",
        origin: "userInput",
        sourceCommandId: commandId,
        state: "running",
        startedAt: 1,
      });
    }
    await this.append({
      ...this.rowBase(),
      kind: "userInput",
      origin: "realUser",
      text,
      sourceCommandId: commandId,
      clientId: "paseo-zcode-provider",
    });
    await this.deltas([
      {
        op: "state.updated",
        patch: {
          control: {
            ...this.state.control,
            phase: "running",
            canStop: true,
            activeWorks: [
              {
                kind: "primaryTurn",
                foregroundExecutionId: this.activeProductTurn,
                startedAt: 1,
              },
            ],
          },
          queue: {
            ...this.state.queue,
            items: this.state.queue.items.filter(
              (i) => i.sourceCommandId !== commandId,
            ),
          },
        },
      },
    ]);
  }
  async finish(
    state: TurnHeaderRow["state"] = "completedSuccess",
    lastError?: SessionErrorInfo,
  ) {
    const header = this.state.rows.window.find(
      (r): r is TurnHeaderRow =>
        r.kind === "turnHeader" && r.productTurnId === this.activeProductTurn,
    );
    await this.deltas([
      ...(header
        ? [{ op: "row.upserted" as const, row: { ...header, state } }]
        : []),
      {
        op: "state.updated",
        patch: {
          control: {
            ...this.state.control,
            phase:
              state === "failed"
                ? "error"
                : state === "running"
                  ? "running"
                  : state,
            canStop: false,
            activeWorks: [],
            ...(lastError ? { lastError } : {}),
          },
          usage: {
            contextWindow: {
              usedTokens: 30,
              maxTokens: 100,
              autoCompactThresholdTokens: 80,
            },
            cumulative: {
              inputTokens: 20,
              outputTokens: 10,
              cacheReadTokens: 3,
              cacheWriteTokens: 0,
            },
          },
        },
      },
    ]);
  }
  // Goals as the 3.17.2 Server projects them (docs/verification.md).
  private async setGoal(goal: GoalState) {
    await this.deltas([
      {
        op: "state.updated",
        patch: {
          goal,
          availability: {
            ...this.state.availability,
            pauseGoal:
              goal.status === "active"
                ? { allowed: true }
                : { allowed: false, reasonCode: "goalNotActive" },
            resumeGoal:
              goal.status === "paused"
                ? { allowed: true }
                : { allowed: false, reasonCode: "goalNotPaused" },
          },
        },
      },
    ]);
  }
  /** The turn ZCode starts by itself to work toward the goal. */
  private async continueGoal(commandId: string) {
    this.activeProductTurn = `product-goal-${++this.goalTurns}`;
    await this.append({
      ...this.rowBase(),
      kind: "turnHeader",
      origin: "goalContinuation",
      executionKind: "agent",
      sourceCommandId: commandId,
      state: "running",
      startedAt: 1,
    });
    await this.deltas([
      {
        op: "state.updated",
        patch: {
          control: {
            ...this.state.control,
            phase: "running",
            canStop: true,
            activeWorks: [
              {
                kind: "goalContinuation",
                foregroundExecutionId: this.activeProductTurn,
                sourceCommandId: commandId,
                startedAt: 1,
              },
            ],
          },
        },
      },
    ]);
  }
  /**
   * Ends the goal's turn and verifies it. A goal that is not satisfied
   * continues in a new turn without the conversation becoming idle.
   */
  async verifyGoal(outcome: "pass" | "notSatisfied") {
    const header = this.state.rows.window.find(
      (r): r is TurnHeaderRow =>
        r.kind === "turnHeader" && r.productTurnId === this.activeProductTurn,
    )!;
    const iteration = this.state.goal!.iteration + 1;
    await this.deltas([
      { op: "row.upserted", row: { ...header, state: "completedSuccess" } },
      {
        op: "state.updated",
        patch: {
          goal: {
            ...this.state.goal!,
            status: "verifying",
            iteration,
            timeUsedSeconds: this.state.goal!.timeUsedSeconds + 60,
            activeRunStartedAtMs: null,
          },
          control: {
            ...this.state.control,
            activeWorks: [
              {
                kind: "goalVerifier",
                foregroundExecutionId: this.activeProductTurn,
                startedAt: 1,
              },
            ],
          },
        },
      },
    ]);
    const verified: GoalState = {
      ...this.state.goal!,
      verifications: [
        ...this.state.goal!.verifications,
        {
          iteration,
          outcome,
          at: 2,
          anchorRowId: null,
          ...(outcome === "pass" ? {} : { nextAction: "Finish the rest" }),
        },
      ],
    };
    if (outcome === "notSatisfied") {
      await this.setGoal({
        ...verified,
        status: "active",
        activeRunStartedAtMs: 1000,
      });
      await this.continueGoal(header.sourceCommandId!);
      return;
    }
    await this.setGoal({ ...verified, status: "verified" });
    await this.deltas([
      {
        op: "state.updated",
        patch: {
          control: {
            ...this.state.control,
            phase: "completedSuccess",
            canStop: false,
            activeWorks: [],
          },
        },
      },
    ]);
  }
  async request<Schema extends z.ZodType>(
    method: string,
    params: any,
    schema: Schema,
  ): Promise<z.output<Schema>> {
    this.calls.push({ method, params });
    let result: unknown;
    switch (method) {
      case "initialize":
        result = { available: true };
        break;
      case "readWorkspacePresentation":
        result = {
          workspace: this.current.session.workspace,
          mode: this.state.config.mode,
        };
        break;
      case "readModelSelection":
        result = {
          ...this.selectionView,
          ...(params?.selection
            ? { effectiveSelection: params.selection }
            : {}),
        };
        break;
      case "createSession":
      case "resumeSession": {
        if (params.model) {
          this.state.config.modelSelection = {
            ...params.model,
            options: {
              reasoningLevel:
                params.thoughtLevel ?? params.model.options?.reasoningLevel,
            },
          };
          this.state.config.provider = params.model.providerId;
          this.state.config.model = params.model.modelId;
          this.state.config.thought =
            params.thoughtLevel ?? params.model.options?.reasoningLevel;
          this.current.settings.model.current =
            this.state.config.modelSelection;
        }
        result = this.current;
        break;
      }
      case "closeSession":
        result = true;
        break;
      case "listSessions":
        result = [this.current.session];
        break;
      case "conversationRowsRangeV4": {
        const eligible = this.state.rows.window.filter(
          (r) =>
            params.beforeRowId === undefined || r.rowId < params.beforeRowId,
        );
        result = {
          rows: structuredClone(eligible.slice(-params.limit)),
          hasMore: eligible.length > params.limit,
          atSeq: this.state.seq,
          atRevision: this.state.revision,
          atLogEpoch: this.state.logEpoch,
        };
        break;
      }
      case "resyncConversationV4":
        await this.emitSnapshot("recovery");
        result = {
          ack: {
            subscriptionId: "sub",
            mode: "snapshot",
            logEpoch: this.state.logEpoch,
          },
        };
        break;
      case "attachmentBeginV4":
        result = {
          uploadId: params.uploadId,
          state: "staging",
          nextChunkIndex: 0,
        };
        break;
      case "attachmentChunkV4":
        result = {
          uploadId: params.uploadId,
          nextChunkIndex: params.chunkIndex + 1,
        };
        break;
      case "attachmentCommitV4":
        result = { ref: `artifact:${params.uploadId}` };
        break;
      case "attachmentAbortV4":
        result = {};
        break;
      case "sendConversationCommandV4": {
        const { commandId, type, payload } = params.envelope;
        result = {
          commandId,
          status: "accepted",
          revisionAtDecision: this.state.revision,
        };
        if (type === "sendText") {
          if (this.failAdmission === "rejected") {
            result = {
              commandId,
              status: "rejected",
              revisionAtDecision: this.state.revision,
            };
            break;
          }
          if (this.failAdmission === "unknown")
            throw new AdapterError(
              "NATIVE_TIMEOUT",
              "Test admission result unknown",
            );
          const busy = this.state.control.canStop;
          const delivery = busy ? payload.requestedDelivery : "startNow";
          if (delivery === "queue" || this.deferConsumption) {
            await this.deltas([
              {
                op: "state.updated",
                patch: {
                  queue: {
                    ...this.state.queue,
                    items: [
                      ...this.state.queue.items,
                      {
                        sourceCommandId: commandId,
                        queueItemId: commandId,
                        clientId: "paseo-zcode-provider",
                        kind: "sendText",
                        text: payload.text,
                        attachments: payload.attachments ?? [],
                        delivery: {
                          requested: payload.requestedDelivery,
                          admitted: "queue",
                        },
                        order: { admissionSeq: this.state.seq },
                        steer: { state: "notRequested" },
                        dispatch: { state: "queued" },
                        admittedAt: 1,
                      },
                    ],
                  },
                },
              },
            ]);
          } else await this.consume(commandId, payload.text, busy);
          await this.afterAdmit?.();
          result = {
            commandId,
            status: "accepted",
            revisionAtDecision: this.state.revision,
            result: { type: "inputAccepted", inputId: commandId, delivery },
          };
        } else if (type === "switchModelConfig") {
          await this.deltas([
            {
              op: "state.updated",
              patch: {
                config: {
                  ...this.state.config,
                  provider: payload.provider,
                  model: payload.model,
                  thought: payload.thought,
                  modelSelection: {
                    providerId: payload.provider,
                    modelId: payload.model,
                    options: { reasoningLevel: payload.thought },
                  },
                },
              },
            },
          ]);
        } else if (type === "switchCollaborationMode") {
          await this.deltas([
            {
              op: "state.updated",
              patch: {
                config: {
                  ...this.state.config,
                  ...(payload.mode === "plan"
                    ? { planEnabled: true }
                    : { mode: payload.mode, planEnabled: false }),
                },
              },
            },
          ]);
        } else if (type === "setAutoDrain")
          await this.deltas([
            {
              op: "state.updated",
              patch: {
                queue: { ...this.state.queue, autoDrain: payload.autoDrain },
              },
            },
          ]);
        else if (type === "deleteQueueItem")
          await this.deltas([
            {
              op: "state.updated",
              patch: {
                queue: {
                  ...this.state.queue,
                  items: this.state.queue.items.filter(
                    (i) => i.queueItemId !== payload.queueItemId,
                  ),
                },
              },
            },
          ]);
        else if (type === "stop") {
          if (
            payload.expectedForegroundExecutionId === this.activeProductTurn
          ) {
            await this.finish("completedInterrupted");
            // Stopping any foreground work pauses the goal it works toward.
            const goal = this.state.goal;
            if (goal?.status === "active" || goal?.status === "verifying")
              await this.setGoal({
                ...goal,
                status: "paused",
                activeRunStartedAtMs: null,
              });
          }
        } else if (type === "sendGoalCommand") {
          if (this.failAdmission === "rejected") {
            result = {
              commandId,
              status: "rejected",
              revisionAtDecision: this.state.revision,
            };
            break;
          }
          if (payload.planEnabled) {
            result = {
              commandId,
              status: "failed",
              reasonCode: "guard.planGoalMutuallyExclusive",
              revisionAtDecision: this.state.revision,
            };
            break;
          }
          // The command itself is a turn that runs nothing.
          const control = `product-${commandId}`;
          await this.append({
            ...this.rowBase(control),
            kind: "turnHeader",
            origin: "userInput",
            executionKind: "controlOnly",
            sourceCommandId: commandId,
            state: "completedSuccess",
            startedAt: 1,
          });
          await this.append({
            ...this.rowBase(control),
            kind: "userInput",
            origin: "realUser",
            text: payload.displayText ?? `/goal ${payload.text}`,
            sourceCommandId: commandId,
            clientId: "paseo-zcode-provider",
          });
          await this.setGoal({
            targetId: `target-${commandId}`,
            objective: payload.text,
            summaryTitle: null,
            timeUsedSeconds: 0,
            activeRunStartedAtMs: 1000,
            status: "active",
            iteration: 0,
            verifications: [],
            iterations: [],
          });
          await this.continueGoal(commandId);
          // The acknowledgement follows the start of the turn.
          await this.afterAdmit?.();
          result = {
            commandId,
            status: "accepted",
            revisionAtDecision: this.state.revision,
          };
        } else if (type === "resumeGoal") {
          const goal = this.state.goal;
          if (goal?.status === "paused") {
            await this.setGoal({
              ...goal,
              status: "active",
              activeRunStartedAtMs: 1000,
            });
            await this.continueGoal(commandId);
          }
        } else if (type === "pauseGoal") {
          const goal = this.state.goal;
          if (goal?.status === "active")
            await this.setGoal({
              ...goal,
              status: "paused",
              activeRunStartedAtMs: null,
            });
        } else if (type === "resolveInteraction")
          await this.deltas([
            {
              op: "state.updated",
              patch: {
                pendingInteractions: this.state.pendingInteractions.filter(
                  (i) => i.interactionId !== payload.interactionId,
                ),
              },
            },
          ]);
        else throw new Error(`Unimplemented test command ${type}`);
        break;
      }
      default:
        throw new Error(`Unexpected Host RPC ${method}`);
    }
    return schema.parse(structuredClone(result));
  }
  async subscribe(
    _target: { workspacePath: string; sessionId: string },
    handler: (frame: ConversationTopicWireCandidate) => void | Promise<void>,
  ): Promise<HostSubscription> {
    this.handler = handler;
    await this.emitSnapshot("initial");
    return {
      id: "sub",
      dispose: async () => {
        this.handler = undefined;
      },
    };
  }
  async close() {
    this.closed = true;
    this.handler = undefined;
  }
}
export async function completeTurn(host: FakeBridge) {
  await host.append({
    ...host.rowBase(),
    kind: "assistantText",
    text: "done",
    state: "complete",
  });
  await host.finish();
}
