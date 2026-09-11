---
number: 9
title: V4入力受付とネイティブ待機キューを一つのPaseo実行へ対応付ける
status: accepted
date: 2026-09-11
links:
  - target: 2
    kind: amends
---

# V4入力受付とネイティブ待機キューを一つのPaseo実行へ対応付ける

## Context and Problem Statement

The legacy host sendPrompt path rejects input while generation is active. ZCode desktop uses sendConversationCommandV4 and its native admission, steering, and queue lifecycle instead. Paseo 0.8.0 exposes prompt.steer but has no public queued-turn result. Returning a new turn for accepted queued input would cause the adapter to treat steering as unavailable and risk replacement or resubmission.

## Decision Drivers

- Preserve the user's choice of inline text guidance and sequential attachment execution.
- Keep attachment storage, input consumption, queue ordering, and recovery owned by ZCode.
- Keep one public execution alive until all accepted native work has finished.
- Never acknowledge unknown delivery as success or retry it through another transport.
- Stop both active work and pending input without changing Paseo or ZCode.

## Considered Options

- Use native V4 admission and aggregate its native turns into one public turn.
- Stop and restart generation for every additional message.
- Store and replay an independent queue in the plugin.

## Decision Outcome

Use V4 sendText for all model input. Text requests guide; attachments request queue after their bytes have been committed through the host's attachment upload API. Initialize the host's conversation connection and subscribe to validated V4 control and queue state, while retaining legacy events for streaming, native turn identity, tools, and permissions. V4 currently uses wire protocol version 3; the API suffix is not the wire version.

Register each input before dispatch, correlate command, queue-item and native-turn identifiers, and acknowledge additions as steer with the current public turn ID only after native acceptance. Native queue promotion may start another native turn but must not finish the public turn. Complete it once no sends, native execution, or unconsumed inputs remain. Native usage is a cumulative snapshot, not a per-event increment. Delimit assistant text at native-turn boundaries and restore each persisted user message as one entry including its attachment parts.

Stop invalidates provider inputs waiting to be sent, disables native autoDrain, waits for admission already in progress, cancels generation and permissions, deletes remaining queue entries, and waits for native idle confirmation. Queue-control commands use native revision checks; only an explicit stale acknowledgement permits retry with the returned revision. Uncertain input admission fails the session and is never resubmitted.

On resume the inspected native implementation discards persisted, unconsumed steering inputs. Verify that the restored conversation is idle and replay its saved transcript only. Do not reconstruct cancelled queues or silently start unresolved native work. Permissions continue through their existing response path; steering cannot approve them. Reopening unfinished work does not automatically resume cancelled input.

### Consequences

- Good, because desktop steering and attachment persistence use the native implementation without core patches.
- Good, because the adapter recognizes accepted additions and sees exactly one final public completion.
- Bad, because native protocol changes must be diagnosed and supported deliberately; there is no legacy send fallback.
- Bad, because restoring an interrupted conversation cancels unconsumed input according to native recovery semantics. No queue editing or automatic replay is provided.

### Confirmation

Validate native envelopes, state projections, upload acknowledgements, event-before-response ordering, queue promotion, cancellation races, late terminal events, failed admission, and history grouping. Exercise the actual Paseo 0.8.0 adapter with scripts/check-upstream.mjs. Use the opt-in scripts/check-steering-runtime.mjs for real-model steering, attachments, stopping, restoration, and clean shutdown. Keep daemon/UI verification and unavailable environments separate in the verification record.

## More Information

This amends ADR 2's host integration and public capability mapping. See [verification](../verification.md) and [remaining work](../todo.md). Revisit aggregation if Paseo adds a public queued-input lifecycle, or if ZCode changes its admission or recovery contracts.
