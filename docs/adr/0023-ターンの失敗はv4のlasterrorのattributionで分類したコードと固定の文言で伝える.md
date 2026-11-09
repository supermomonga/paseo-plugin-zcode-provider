---
number: 23
title: ターンの失敗はV4のlastErrorのattributionで分類したコードと固定の文言で伝える
status: accepted
date: 2026-11-09
links:
  - target: 7
    kind: amends
---

# ターンの失敗はV4のlastErrorのattributionで分類したコードと固定の文言で伝える

## Context and Problem Statement

ZCode のターンが失敗すると、Paseo には `[System Error] ZCode turn failed` と `code: NATIVE_PROTOCOL_ERROR` だけが表示されていた（[Issue #86](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/86)）。プラグインは失敗した turnHeader だけを見て、固定の文言とコードを返していた。利用者もオーケストレーターのエージェントも、利用上限・認証・ネットワークのどれが原因かを判断できなかった。`NATIVE_PROTOCOL_ERROR` は通信の形式の誤りを表すコードなので、プラグインの不具合のようにも見えた。

3c5b227 の CLI は、TurnError を受けると、turnHeader を `failed` にするのと同じフレームで `control.lastError`（`sessionErrorInfoSchema`）を設定し、次のターンの開始時に `null` に戻す（`product-projection.ts`）。Desktop の `ChatErrorBanner` はこの値を表示する。`lastError` には ZCode の `message`・`detail`・`underlyingErrorMessage` と、列挙値と数値からなる `attribution`（`source`、`reason`、`errorPhase`、`exceptionKind`、`statusCode`、`providerErrorCode`、`retryable` など）がある。

管理下ランタイム 3.16.2 で、ローカルのモデルから GLM の 429（エラーコード 1310）を返して確認した。`message` はプロバイダーの原文（週・月の利用上限とリセット時刻を伝える中国語の文）、`code` は `"1310"`、`attribution.reason` は `rate_limited`、`statusCode` は 429 だった。`recoverable` は `true` で、`attribution.retryable: false` と食い違っていた。

ADR 7 は、ネイティブのエラーメッセージを ProviderError.diagnostic とログに出さないと決めている。プロバイダーのエラー文には、プロバイダーによって API キーの一部やリクエストの内容が入ることがある。Paseo はターンの失敗の文言・コード・診断をタイムラインに保存し、オーケストレーターのエージェントにも渡す（`agent-manager.ts` の `formatTurnFailedMessage`）。

## Decision Drivers

- 利用者とエージェントが、失敗の種類と次に取る行動を判断できるようにする。
- ADR 7 のとおり、ネイティブの文字列を出力に含めない。
- ZCode が公式に投影する V4 の状態だけを使う。旧プロトコルのイベントやエラー文の照合には頼らない。

## Considered Options

- `lastError.attribution` で分類したコードと、プラグインの固定の文言を返す。
- Desktop と同じく `lastError.message`（プロバイダーの原文）を表示する。
- 旧プロトコルの `turn.failed` イベントのエラー詳細を使う（Issue #86 の提案）。

## Decision Outcome

Chosen option: 「`lastError.attribution` で分類したコードと、プラグインの固定の文言を返す」。ADR 7 を変えずに、失敗の種類と対処を伝えられるため。

- ターンが失敗したら、そのフレームの `control.lastError` を読む。分類には `attribution.source`（無ければ `lastError.source`）と `attribution.reason` だけを使う。`lastError.code` にはプロバイダー固有のコードがそのまま入ることがあるので使わない。
- `source` が `provider` か `network` のとき、`reason`（ZCode の `ModelFailureReason`）を次のコードに対応付ける。`MODEL_RATE_LIMITED`（`rate_limited`、`offpeak_queued`）、`MODEL_AUTH_FAILED`（`auth_failed`、`auth_refresh`、`provider_not_configured`）、`MODEL_CONTEXT_EXCEEDED`（`context_exceeded`）、`MODEL_NETWORK_ERROR`（`network_error`、`timeout`、`stream_idle_timeout`、`stale_connection`、`proxy_error`、`tls_error`）、`MODEL_PROVIDER_ERROR`（`server_error`、`provider_overloaded`）。それ以外の `reason` は、`network` なら `MODEL_NETWORK_ERROR`、`provider` なら `MODEL_REQUEST_FAILED` とする。
- `runtime`・`tool` の失敗と、`lastError` が無い失敗は `NATIVE_TURN_FAILED`（`ZCode turn failed.`）とする。ターンの失敗に `NATIVE_PROTOCOL_ERROR` は使わない。
- 文言はプラグインの固定の英文とし、HTTP ステータスと、数字だけか英字の語だけからなるプロバイダーのエラーコードを添える。利用上限では、Coding Plan のリセット時刻を Paseo 0.11 以降の Usage 画面で確認できると案内する（ADR 18）。
- ProviderError.diagnostic に `stage: "turn"` と `failure` を加える。`failure` には、許可リストに一致した `source`・`reason`・`errorPhase`・`exceptionKind`、100〜599 の `statusCode`、上記の条件を満たす `providerErrorCode`、`retryable` だけを入れる。`providerId`・`modelId` は利用者が付けた名前を含みうるので入れない。

### Consequences

- Good, because 利用上限・認証・ネットワークなどの失敗を、コードと文言で見分けられる。
- Good, because ネイティブの文字列は、文言にも診断にも入らない。
- Bad, because プロバイダーの原文にしか無い情報（Coding Plan 以外の利用上限のリセット時刻など）は伝わらない。
- Bad, because ZCode が `reason` の語彙を変えると、分類が `MODEL_REQUEST_FAILED` などの汎用のコードに落ちる。

### Confirmation

`server/turn-failure.test.ts` で、各 `reason` と `source` の分類、ネイティブの文字列が文言と診断に入らないこと、報告できないプロバイダーのエラーコードを落とすことを確認する。`test/provider.test.ts` で、3.16.2 の 429 と同じ形の `lastError` が分類されて Paseo の `session.turn` に届くことと、`lastError` が無いときの汎用の失敗を確認する。`npm run test:stdio-runtime` は、ローカルのモデルが 429（1310）を返したときに `MODEL_RATE_LIMITED` が届き、原文が含まれず、次のプロンプトが完了することを実ランタイムで確認する。

## Pros and Cons of the Options

### 分類したコードと固定の文言を返す

- Good, because ADR 7 の範囲で実現でき、表示する内容をプラグインが決められる。
- Bad, because 固定の文言では、プロバイダーごとの事情までは表せない。

### `lastError.message` を表示する

- Good, because Desktop と同じ内容になり、リセット時刻などがそのまま分かる。
- Bad, because ADR 7 の見直しが要る。プロバイダーの原文がタイムラインに保存され、エージェントにも渡る。原文はプロバイダーの言語（GLM なら中国語）で返る。

### 旧プロトコルの `turn.failed` イベントを使う

- Good, because エラー詳細の構造は `lastError` と同じである。
- Bad, because ADR 13 によりプラグインは V4 の会話状態だけを使い、旧プロトコルのイベントを購読していない。同じ内容は V4 の `lastError` に公式に投影されている。

## More Information

ADR 7 の診断の方針を補う。ZCode 側の根拠は 3c5b227 の `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`（TurnError の投影と、ターン開始時の消去）、`packages/shared/src/zcode-protocol-v4/snapshot.ts`（`sessionErrorInfoSchema`、`errorAttributionSchema`）、`apps/zcode-cli/packages/contracts/src/model/index.ts`（`ModelFailureReason`）、`apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts`、`packages/ui/src/ChatErrorBanner.tsx`。Paseo 側は `packages/server/src/server/agent/agent-manager.ts` の `formatTurnFailedMessage`。ZCode が `lastError` にリセット時刻などを構造化して加えたとき、または Paseo がエラーコードに応じた表示を持ったときに見直す。
