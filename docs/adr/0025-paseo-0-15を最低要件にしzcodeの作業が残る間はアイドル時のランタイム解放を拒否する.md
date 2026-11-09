---
number: 25
title: Paseo 0.15を最低要件にしZCodeの作業が残る間はアイドル時のランタイム解放を拒否する
status: accepted
date: 2026-11-09
links:
  - target: 17
    kind: amends
  - target: 18
    kind: amends
  - target: 24
    kind: amends
---

# Paseo 0.15を最低要件にしZCodeの作業が残る間はアイドル時のランタイム解放を拒否する

## Context and Problem Statement

Paseo 0.13.0-beta.1 から 0.15.3 まで（Issue #69、#75〜#82、#85、#87〜#89）が未確認で、開発 SDK と CI の上流チェックアウトは 0.12.0 のままだった。プラグインに影響する変更は次の二つである。

- 0.14.0 から、Paseo は 1 時間アイドルの再開可能なセッションを close し、次のプロンプトで保存済みの persistence から開き直す（getpaseo/paseo#7782、ホスト設定 `agents.idleRuntimeCleanup`、既定はオン）。プロバイダーが `session.can_stop_runtime` を宣言しなければ、Paseo は自分の基本条件だけで判断する。基本条件は、フォアグラウンドのターン、権限確認、配送待ちの入力、Paseo のサブエージェントの実行中などである（v0.15.3 の `agent-manager.ts` の `runtimeHasNoPendingWork`）。
- 0.15.0 から、任意の設定 **Resume agents after restart** をオンにすると、Paseo はホストの再起動で中断したエージェントを開き直し、`Resume working.` を送る（#8127、#8619）。

プラグインは、ZCode のバックグラウンドの Bash とサブエージェントを `tool_call` として表示している。Paseo のサブエージェントとしては公開していない。このため Paseo の基本条件はこれらの作業を検出できない。一方、プラグインの `close()` は割り込んだうえで、セッションごとの Server を止める。つまり 0.14 以降は、`run_in_background` で起動した開発サーバーなどが、Paseo から見て 1 時間動きが無いだけで止められる。

ZCode の V4 の状態（3c5b227 の `snapshot.ts`）には `backgroundWorks`（`running`・`resultPending`・`failed`・`cancelled`）、`subagents.running`、`pendingCommands`、`pendingInteractions`、`goal` がある。ZCode 自身は `hasBackgroundWork` を `backgroundWorks.some(w => w.status === "running")` として求める（`sessions-index-projection.ts`）。スキーマのコメントには、`resultPending` は結果を届けると消えるとある。しかし 3c5b227 の `product-projection.ts` の `onBackgroundTaskLifecycle` は、完了を `resultPending` に変えるだけで、項目を消す経路を持たない。管理下ランタイム 3.16.2 でも、結果を届けたターンが完了した後まで `resultPending` が残った。

プラグインには、Paseo 0.8〜0.10 向けの分岐も残っていた。daemon に `registerUsageSource` が有るか確かめてから登録する処理と、Account タブの `openExternalUrl`・`copyText`・`getPaseoClient` が無い場合の代替である。`copyText` は、0.13 で非推奨になった `@getpaseo/plugin/client/react-native`（2027-04-20 以降に削除）から読んでいた。ユーザーは、最低要件を 0.15 に上げることを認めた。

## Decision Drivers

- アイドル時の解放で、Paseo からは見えない ZCode の作業を失わない。
- 判断には ZCode が公式に投影する V4 の状態だけを使い、ZCode 自身と同じ基準にする。
- 完了した作業のせいで、ランタイムを解放できない状態が続かないようにする。
- 解放後の開き直しと、再起動後の再開を、ADR 14 の保証範囲の中に収める。
- 対応しない Paseo のための分岐を持たない。宣言する最低要件を、実際に検証した版に近づける。

## Considered Options

- `session.can_stop_runtime` を宣言し、V4 の状態に未完了の作業がある間は拒否する。最低要件を 0.15.0 に上げる。
- `session.can_stop_runtime` を宣言せず、Paseo の基本条件に任せる。
- 宣言したうえで、`resultPending` の作業も未完了として扱う。
- 宣言を加え、最低要件は 0.9.0 のままにする。

## Decision Outcome

Chosen option: 「`session.can_stop_runtime` を宣言し、V4 の状態に未完了の作業がある間は拒否する。最低要件を 0.15.0 に上げる」。ZCode の作業を失わない唯一の選択肢であり、かつ完了した作業のせいで解放が止まり続けることも無いため。

- 接続と `session.opened` の capabilities に `session.can_stop_runtime` を加える。問い合わせには、同じ `requestId` と `sessionId` を持つ `session.can_stop_runtime` で答える。`request.completed` は送らない。知らないセッションへの問い合わせは `request.failed` にする（Paseo は解放しない）。
- 次のすべてを満たすときだけ `canStop: true` を返す。Paseo の実行が無い。受付待ちの入力が無い。会話がアイドルである（`canStop`・`activeWorks`・`running`/`prewarming`・待機キュー・再同期が無い）。`pendingInteractions` と `pendingCommands` が空である。`backgroundWorks` に `running` が無い。`subagents.running` が空である。`goal` が `active` でも `verifying` でもない。
- `resultPending` は数えない。上記の理由で、届けた後も残るためである。結果を届けるターンが動いている間は、フォアグラウンドの条件で解放を拒否する。
- 解放後の開き直しも再起動後の再開も、Paseo が保存した `mode` と `settings.plan_mode` を渡す `session.open` を通る。ADR 14 の保証範囲は変えない。
- `paseo-plugin.json` の最低要件を `>=0.15.0` に上げる。開発 SDK を 0.15.3 にし、CI の上流チェックアウトを v0.15.3 に固定する。usage source は無条件に登録する。Account タブは `openExternalUrl`・`getPaseoClient` と `@getpaseo/plugin/client/ui` の `copyText` を直接使う。

### Consequences

- Good, because バックグラウンドの Bash・サブエージェント・workflow の実行と、進行中の goal が、アイドル時の解放で止められない。
- Good, because 古い Paseo のための分岐が無くなり、宣言する最低要件が、Paseo 自身の判定で確かめた範囲になる。
- Bad, because Paseo 0.9〜0.14 の利用者は、新しい版を導入できない。
- Bad, because 完了したがまだ届いていないバックグラウンドの結果は、状態から区別できない。結果がすぐに届かない状況で解放された場合に、その結果が失われるかは確認していない。
- Bad, because `active` のまま進まない goal があると、ランタイムと Server のプロセスが解放されずに残る。

### Confirmation

`test/provider.test.ts` で、capability の宣言、応答の形、`request.completed` を送らないこと、知らないセッションでの失敗を確認する。あわせて、フォアグラウンドの実行・`running` の作業・実行中のサブエージェント・`active`/`verifying` の goal では拒否し、`resultPending` と `paused` では拒否しないことも確認する。`npm run test:upstream`（v0.15.3）では、次の三つを確認する。Paseo の実アダプターの `canStopRuntime()` が `running` の作業の有無で答えを変えること。Paseo の `compileDirectoryPlugin` が 0.14.0 を拒否すること。クライアントのバンドルが `client/react-native` を読まないこと。`npm run test:stdio-runtime` は実ランタイムで次の二つを確認する。`run_in_background` の `sleep 3` が動いている間は拒否し、結果を届けたターンの完了後は拒否しないこと。実行中に Server を SIGKILL した会話を、保存した設定で開き直して `Resume working.` を送ると完了すること。

## Pros and Cons of the Options

### V4 の状態で拒否し、最低要件を 0.15.0 に上げる

- Good, because ZCode と同じ基準で、作業が残る間だけランタイムを保つ。
- Bad, because 古い Paseo を切り捨てる。

### 宣言せず Paseo の基本条件に任せる

- Good, because 実装が要らない。
- Bad, because バックグラウンドの作業が 1 時間後に止められる。

### `resultPending` も未完了として扱う

- Good, because 届いていない結果を確実に守れる。
- Bad, because 固定ソースでは届いた後も残るので、バックグラウンドの作業を一度使ったセッションは二度と解放されない。

### 宣言を加え、最低要件は 0.9.0 のままにする

- Good, because 古い Paseo の利用者も更新できる。capability の交渉により、古い daemon では問い合わせが来ないだけになる。
- Bad, because 0.8 系向けの分岐と非推奨の UI 入口が残る。また、宣言する最低要件を実コンパイラで検証できていない状態も続く。

## More Information

ADR 18 のうち「daemon が `registerUsageSource` を持つときだけ登録する」を、無条件の登録に変える。ADR 17 の互換性の段落（0.8 での代替）を取り下げる。ADR 24 で上げた最低要件 0.9.0 を、0.15.0 に上げる。ADR 14 は変えない。

- Paseo v0.15.3（`d91ae138cb931447635e94296023414a58bedcc5`）：`public-docs/plugins/providers.md` の Permit idle runtime cleanup、`packages/server/src/server/agent/idle-runtime-cleanup/index.ts`、`agent-manager.ts` の `getRuntimeCleanupCandidates` と `runtimeHasNoPendingWork`、`plugin-provider.ts` の `canStopRuntime`
- ZCode 3c5b227：`packages/shared/src/zcode-protocol-v4/snapshot.ts` の `backgroundWorkSummarySchema`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` の `onBackgroundTaskLifecycle`、`sessions-index-projection.ts` の `hasBackgroundWork`

ZCode が届けた結果の項目を消すようになったとき、または配送待ちの結果を状態に出すようになったときは、`resultPending` の扱いを見直す。Paseo が解放の契約を変えたときも見直す。
