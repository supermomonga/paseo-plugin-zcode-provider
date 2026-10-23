---
number: 22
title: Paseoが求めるときは受け付けたSteerが読まれるまで保留中の権限確認を拒否する
status: accepted
date: 2026-10-23
links:
  - target: 9
    kind: amends
---

# Paseoが求めるときは受け付けたSteerが読まれるまで保留中の権限確認を拒否する

## Context and Problem Statement

Paseo は、アプリで入力したメッセージや音声入力を実行中のターンへ Steer するとき、常に `clearPendingPermissions: true` を付ける（Paseo の `session.ts`、#3585 で導入）。Paseo の Provider 仕様（`docs/providers.md`）では、このフラグ付きの Steer を受け付けた Provider は、まず入力をキューに入れ、配送を妨げている権限確認を拒否し、Steer が読まれたら拒否をやめる。

ADR 9 は、権限確認は既存の応答経路で扱い、Steer では承認しないとした。実装はフラグ付きの Steer を一律に失敗として返していた。Paseo の `PluginAgentSession.steerActiveTurn` は失敗を `unavailable` とみなし、同じ `clientMessageId` のまま、実行中のターンを中断して送り直す。プラグインはこの ID を重複として拒否したため、アプリからの Steer はすべて `Duplicate ZCode clientMessageId` で失敗した。

3c5b227 の確認では、ZCode は権限確認を待っている間も `requestedDelivery: "guide"` の `sendText` を受け付け、実行中のターンの `pendingInputs` に積む（`prompt-admission.ts`、`steering.ts`）。これを読むのは、そのモデルステップのツール呼び出しがすべて終わった区切り（`turn-tools.ts`）か、テキストだけのステップの終わり（`turn-stop.ts`）である。権限確認で止まったターンはこの区切りに達しないので、Steer は読まれない。公式 Desktop は対話の保留中は入力欄を隠すので、この状況でメッセージを送ること自体が無い（`ConversationComposer.tsx`）。

## Decision Drivers

- Paseo の公開 Provider 仕様に従い、アプリからの Steer を受け付ける。
- 入力を失ったり二重に送ったりしない。Steer は先に ZCode に受け付けさせる。
- ZCode の公式の対話の答え方だけを使い、Paseo と ZCode を改変しない。
- Steer が読まれた後に出た権限確認には、ユーザーが自分で答えられるようにする。

## Considered Options

- フラグ付きの Steer を失敗として返し、Paseo の中断と送り直しに任せる。
- Steer を受け付けた後、読まれるまで保留中の対話を拒否の操作で答える。
- 拒否に `freeText` でメッセージを付ける。

## Decision Outcome

Chosen option: 「Steer を受け付けた後、読まれるまで保留中の対話を拒否の操作で答える」。Paseo の仕様をそのまま満たし、ZCode の公式の答え方だけで実現できるため。

- フラグ付きの Steer も通常の Steer と同じく `guide` として送り、ZCode の受付確認の後にだけ拒否を始める。
- その入力の `userInput` 行（`sourceCommandId` が一致）が現れるまで、保留中の対話と、その間に新しく出た対話を拒否する。同じモデルステップの後続のツールが新しい権限確認を出すことがあるため、一度では足りない。行が現れたとき、または実行が停止・終了したときにやめる。
- 権限確認は、提示した最初の拒否の操作（ZCode の `deny`。`workflowRefine` より前に並ぶ）で答える。質問と Plan 承認は `decline` で答え、`cancel` は使わない。サブエージェントの権限確認も対象にする。親の Agent ツールの呼び出しが終わるまで Steer は読まれないため。
- `freeText` は付けない。ZCode は拒否のツール結果に「ユーザーの指示を待つ」よう求める定型文を返し、その直後に Steer がユーザーのメッセージとして読まれる。
- 拒否のコマンドが失敗したときは、ユーザーが答えた権限確認の失敗と同じく、セッションの実行時エラーとして扱う。
- 受け付けなかったプロンプトの `clientMessageId` は再利用できるようにする。Paseo の中断と送り直しが同じ ID を使うため。

フラグの無い Steer では、これまでどおり権限確認に触れない。Steer で権限を承認することは無い。

### Consequences

- Good, because アプリからの Steer が、権限確認で止まったターンでも同じ実行の中で読まれる。
- Good, because 受付・拒否・読み込みを、ZCode の公式の答え方と V4 の状態だけで確認できる。
- Bad, because Plan モードで Plan 承認を拒否すると ZCode のターンが終わる（`turn-control.ts` の `stopTurnAfterResult`）。Steer は `guide.noToolBoundary` でキューに回り、次の ZCode のターンとして始まる。Paseo の実行は ADR 9 のとおり一つのまま続く。
- Bad, because ZCode Desktop には無い使い方なので、ZCode が対話中の guide の扱いを変えると影響を受ける。

### Confirmation

`test/provider.test.ts` で、フラグ付きの Steer の受付、読まれるまでの拒否（後から出た権限確認を含む）、読まれた後の権限確認がユーザーの答えで解決されること、受け付けなかった Steer の ID を再利用できることを確認する。`server/presentation.test.ts` で各対話の拒否の答えを確認する。`npm run test:upstream` は Paseo の実際のアダプターから `clearPendingPermissions: true` 付きの Steer を送る。

## Pros and Cons of the Options

### フラグ付きの Steer を失敗として返す

- Good, because 権限確認に一切触れない。
- Bad, because Paseo は実行中のターンを中断して送り直すので、作業が止まる。ZCode に Steer の機能があるのに使えない。

### 受け付けた後に拒否の操作で答える

- Good, because Paseo の仕様に一致し、Codex・Claude の Provider と同じ挙動になる。
- Bad, because 自動で拒否される権限確認が増え、その理由はユーザーのメッセージにしか表れない。

### 拒否に `freeText` でメッセージを付ける

- Good, because ツール結果にユーザーの意図が残る。
- Bad, because 同じ本文が Steer と合わせて二度モデルに渡る。Steer は先に受け付けているので、配送の役には立たない。

## More Information

ADR 9 を補う。ZCode 側の根拠は 3c5b227 の `apps/zcode-cli/packages/core/src/runtime/methods/`（`prompt-admission.ts`、`steering.ts`、`turn-tools.ts`、`turn-stop.ts`）、`core/src/tool/executor/turn-control.ts`、`bootstrap/src/zcode-protocol/interaction-broker.ts`、`bootstrap/src/zcode-protocol-v4/product-projection.ts`。Paseo 側は `docs/providers.md` の steering の節と `plugin-provider.ts` の `steerActiveTurn`。ZCode が対話中の guide を公式に扱うようになったとき、または Paseo の仕様が変わったときに見直す。
