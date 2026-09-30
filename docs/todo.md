# 公開前に残る確認と機能境界

Paseo・ZCode 本体の改変は禁止。対応範囲はこの Provider に限定し、独自 fork・パッチ済みランタイムを対処案に含めない。公式の設定・通信 API を通じた操作と、無改変の公式ソースからの検証用ビルドは利用する。

## 保証対象外の upstream 復元不具合

固定ソースの stdio cold resume が、DB の `runtime/execution_state` に保存された mode / Plan を復元しない。`server-operations.ts` が過去のメッセージから得た mode を明示指定として渡し、Core の保存状態復元を抑止する。[再現と根拠](verification.md)を参照。

本体改変なしで保証する対応は、Paseo が保持する mode / Plan の両方を Provider から公式 API で再適用する経路であり、実装済み。ユーザー承認に従い、[ADR 14](adr/0014-paseoの保存設定を再適用する復元を保証範囲とする.md) でこの範囲に保証と必須 CI を限定した。`test:stdio-runtime` は保存設定を渡す復元を検証する。

設定省略時の復元不具合は保証対象外の制約として残す。Provider に補完ストアや旧 Host への切替は追加しない。`test:native-restore` はこの経路の失敗を非ゼロ終了で検出する別検証で、公開条件には含めない。公式ランタイムの更新時に再実行し、成功した場合に保証範囲を再評価する。

## 検証の残項目

- 公式アカウントログイン・期限切れ・未認証、公式 TUI と複数 Server の共有データ同時利用。
- Desktop ネイティブ画面とモバイル実機での操作。Electron Helper / 通常 Node の両 daemon 起動と、実 Web UI の入力・質問・承認・停止・再起動復元は確認済み（[検証記録](verification.md)）。
- 修正後 CI の Linux x64 での保存設定による復元と実モデル E2E。修正前 CI の非課金 runtime 項目は設定省略時の復元を除き成功。Windows/macOS x64、長時間ツール/MCP 子プロセスを含む異常終了時の回収は未検証。
- native の長い会話・世代変更・background continuation・子エージェントからの権限要求。現在の契約試験の結果と実行確認を混同しない。
- 統合 CLI の remote terminal 用 node-pty 配置。Provider はその terminal API を呼ばず、Agent Bash は検証済みだが、upstream 配布の問題として追跡する。

## 今回追加しない機能

Browser/Computer Use、一般的な rewind、独立した Paseo 子エージェント管理、Hook 信頼レビュー画面、Goal/Workflow 操作 UI、カスタム system prompt、非永続会話、モデルへの JSON Schema 出力制約。通常の ZCode tools / skills / MCP は native に委ねる。

Paseo 標準の quota/リセット時刻/初期 usage 表示は公開プラグイン API の範囲でのみ対応する。本体変更や別の表示への置き換えは提案・実装しない。新しい公開 API が導入された時に契約と実 UI の両方を再評価する。
