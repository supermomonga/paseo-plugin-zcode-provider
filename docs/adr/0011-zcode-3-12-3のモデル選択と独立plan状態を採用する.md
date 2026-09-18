---
number: 11
title: ZCode 3.12.3のモデル選択と独立Plan状態を採用する
status: accepted
date: 2026-09-18
links:
  - target: 5
    kind: amends
  - target: 7
    kind: amends
  - target: 9
    kind: amends
---

# ZCode 3.12.3のモデル選択と独立Plan状態を採用する

## Context and Problem Statement

ZCode 3.12.3 は `readWorkspaceState` を廃止し、モデル選択を専用サービスへ移した。モデル参照の `variantId` は廃止され、推論レベルは `ModelSelection.options.reasoningLevel` になった。Plan は編集モードと独立した `planEnabled` で表されるため、従来の mode だけから推定する処理では承認後の権限と復元状態を正しく表示できない。

## Decision Drivers

- Paseo の公開 Provider API とプラグインの範囲で対応する。
- 候補一覧、現在の選択、推論レベル、編集権限と Plan の状態を混同しない。
- 不明な選択を別モデルへ置換せず、契約の不一致を検出する。
- プロバイダー設定に含まれる認証情報を通信境界の外へ出さない。

## Considered Options

- 旧 workspace 状態や variant を補完して複数バージョンを扱う。
- 3.12.3 の専用サービスと独立 Plan 状態へ移行し、最低対応版も更新する。

## Decision Outcome

Chosen option: "3.12.3 の専用サービスと独立 Plan 状態へ移行し、最低対応版も更新する", because 旧契約の補完は状態の推測を必要とし、承認済みの単一契約による対応方針に反する。

本体の最低対応版を **3.12.3**、CLI を **0.16.5** とする。ADR 7 の最低版以上の正式版を許可する方針、実行時検証、検証済みハッシュとの分離は維持する。旧版への分岐や variant の自動移行は追加しない。

モデル一覧は `model-selection.getView`、workspace の表示情報は `agent.readWorkspacePresentation` から取得する。セッションの現在モデルだけを含む snapshot を候補一覧として使わない。モデルごとの推論レベルを公開し、native の `projectAppModelOption` と同じく最後の候補を既定値とする。明示選択は `getView({selection})` で解決し、`selectionIssue` や別モデル・別レベルへの解決を拒否する。

`getView` の生データには API キーやヘッダーが含まれる。Electron 内で識別子・表示名・推論レベル・解決結果だけを抽出してからブリッジへ出力する。現在モデル未選択は設定取得時には許容し、モデル確定前の送信は拒否する。新規作成では native `session/create` がモデルを文字列化するため、解決済み推論レベルを `thoughtLevel` 引数にも渡し、返された状態を照合する。

Plan の正本は V4 `config.planEnabled`、編集モードは V4 `config.mode` とする。native の `setMode("plan")` は既存の編集モードを保持し、通常モード指定は Plan を解除する。Plan 中の編集モード変更は通常モード指定から Plan を再有効化し、最終状態の通知まで待つ。初期化時に `independentPlanState` capability を要求する。Paseo の `settings.plan_mode` は維持し、復元時に指定がなければ再開後の native の状態を使用し、指定があれば適用する。3.12.3 の native 単独再開は Plan を永続化しないため、Paseo が保存した `featureValues.plan_mode` を `settings.plan_mode` として渡す経路で復元する。独自の設定保存・補完処理は追加しない。

V4 `sendText` に確定した `modelSelection`・`mode`・`planEnabled` を付け、待機中の入力にも受付時の意図を保持させる。認証更新通知も新しい `modelSelection` と任意の `accountAccess` に従う。ホスト起動には公式アプリと同じ同梱 `config/provider/zcode-builtin.json` のパスを明示する。

### Consequences

- Good, because モデル候補と現在値を分離し、推論レベルや Plan を native の状態と一致させられる。
- Good, because 認証設定をプラグインの出力に含めずにモデルを選べる。
- Bad, because ZCode 3.12.3 未満は使用できず、更新が必要になる。
- Bad, because 引き続き公式ホストの非公開契約に依存し、今後の意味的な変更には実機検証が必要になる。

### Confirmation

候補一覧の取得・再取得、未選択、モデル別の推論レベル、不正な解決結果、作成時の適用不一致、購読順序と独立 Plan の復元をテストする。Paseo の実コンパイラ・Provider アダプターで開発版 SDK と最低対応版を検証する。実 ZCode でモデル変更、推論レベル変更、Plan 承認・却下、追加指示・添付キュー・停止・復元を確認し、環境と未検証範囲を[検証記録](../verification.md)へ残す。

## More Information

[Issue #16](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/16) に対応する。ADR 5 の独立トグルと保存方式、ADR 9 の実行・キュー対応は維持し、状態取得と送信契約を補足する。Paseo 0.8.0 の最低対応版と開発 SDK 0.9.0-beta.1 は変更しない。公式 SDK がモデル選択・会話状態・起動 API を公開した場合、非公開ホストへの依存を再評価する。
