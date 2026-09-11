# 未実装項目

当初の調査基準は Paseo main `c424f82922fcd36aa9cc9e473644bca04417b420`、patcher `572100368774df7632728a72568466ac3632d458`（2026-09-07）です。Paseo 0.8.0 で再確認した項目は個別に記載しています。

## Paseo 本体の公開 API に不足がある項目

- [ ] **標準アカウント欄の ZCode 使用枠・リセット時刻**
  - patcher は標準の使用量取得処理へ ZCode を追加し、認証済み host の entitlement / Coding Plan reset を表示します。
  - main の使用量取得サービスは本体の fetcher を固定登録します。プラグインの `session.usage` はトークン・費用・コンテキスト用で、アカウント枠の提供口ではありません。登録画面の RPC を増やしても標準欄と同等にはなりません。
  - 現在はセッションの使用量のみを通知します。アカウント枠の独自画面や認証情報の再取得処理は追加していません。
  - 完了条件: 本体に使用枠の Provider 登録 API と host セッションに対応する取得経路、リセット日時の表示契約が追加されること。その後に ZCode の取得処理を接続し、標準 UI を検証すること。
  - 根拠: [quota service](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/server/src/services/quota-fetcher/service.ts)、[公開 Provider 契約](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/plugin/src/provider.ts)。

- [ ] **作成・再開直後のコンテキスト使用量を標準 UI に反映**
  - プラグインは native snapshot の使用量を `session.ready` より前に `session.usage` として送信します。
  - main のアダプターは初期イベントを内部履歴に取り込みますが、その後の `subscribe` で使用量を再通知しません。AgentManager の履歴復元も timeline 以外を使用量として反映しません。以降に到着する使用量更新は通知できます。
  - 現在は実際の初期値を通常どおり送信します。購読時点に合わせるタイマーや架空の変化通知は使いません。
  - Paseo `v0.8.0` の実アダプターでも初期使用量の再通知がないことと、その後の更新が届くことを確認しました。詳細は [検証記録](verification.md) を参照してください。
  - 完了条件: 本体が最新の使用量を保持し、新規購読・復元時に反映すること。会話を送信しなくても初期表示できることを UI で確認すること。
  - 根拠: [PluginAgentSession](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/server/src/server/agent/plugin-provider.ts#L1020)、[AgentManager](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/server/src/server/agent/agent-manager.ts)。

- [ ] **標準 Provider 診断欄**
  - main の標準診断欄は AgentClient の `getDiagnostic()` を呼びます。公開 Provider API とそのアダプターには対応する診断 hook がありません。
  - 現在は ZCode の最低バージョン・RPC の構造・同梱 CLI の動作を起動前に検証し、実行中の応答・イベントも検証します。host hash は診断情報です。失敗時の ProviderError.diagnostic とプラグインログには報告用の情報を出しますが、標準診断欄との同等性はありません。
  - 完了条件: 診断要求と応答の公開 API が追加され、本体の標準診断欄へ接続できること。認証値やプロンプトを表示しないことも検証すること。
  - 根拠: [標準診断の処理](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/server/src/server/agent/provider-snapshot-manager.ts#L790)。

## ZCode の確認済み host で対応できない指定

- [ ] **独自 system prompt と保存しないセッション**
  - 3.11.2 の host `createSession` から渡される作成パラメーターには `systemPrompt` がありません。`persistence: "deferred"` は保存を遅延する指定であり、非永続セッションではありません。
  - 元の patcher もこれらを native 作成時に適用していません。本プラグインは無視せず、非空の `systemPrompt` と `persist: false` を `INVALID_CONFIGURATION` として拒否します。daemon の追加指示や該当する Agent Profile を設定した場合も対象です。
  - 完了条件: 対応 ZCode host に実際の適用経路があることを確認し、通常のユーザーメッセージへの挿入や保存後の削除に頼らず実装できること。
  - 根拠: 対応 artifact の `out/host/index.js` 内 `M8` / `createSession`。確認した hash は [manifest](../server/discovery/manifest.ts) の動作確認済み情報に記録しています。

## リリース前の確認

- [ ] **実際の Paseo 画面からの一連の確認**
  - 未パッチの対応 main でプラグインをインストールし、実モデルへの送信、ツール、質問、計画承認・却下、割り込み、Paseo 再起動後の復元を確認すること。
  - 現時点の検証結果と未実施範囲は [verification.md](verification.md) を参照してください。

## 完了済み

- [x] **Provider API を含む SDK リリースへの開発依存の切替**
  - 2026-09-08 に公開 SDK `0.8.0-beta.1` へ切り替え、Provider API の保存済みソースと alias を削除しました。
  - 2026-09-11 に SDK 3パッケージを正式版 `0.8.0` に固定し、同版の実コンパイラ・アダプターとの互換性を確認しました。実行時は引き続き Paseo が提供する `@getpaseo/plugin/server/provider` を使用します。

## 自動対応しない事項

旧 patcher の保存ハンドルの変換、未検証の ZCode バージョンや OS、ZCode host 自身の仕様を超える steering / rewind / 構造化出力 / 子セッションの独立管理は対象外です。必要になった場合に別途仕様を調査します。既存の ZCode 保存会話のインポートは実装済みです。
