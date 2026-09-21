# 公開前に残る確認と機能境界

## 公開を妨げる upstream 不具合

固定ソースの stdio cold resume が、DB の `runtime/execution_state` に保存された mode / Plan を復元しない。`server-operations.ts` が過去のメッセージから得た mode を明示指定として渡し、Core の保存状態復元を抑止する。[再現と根拠](verification.md)を参照。Provider に補完ストアや旧 Host への切替は追加しない。upstream の修正されたソース・配布物で `test:stdio-runtime` が成功するまで公開しない。

## 検証の残項目

- 公式アカウントログイン・期限切れ・未認証、公式 TUI と複数 Server の共有データ同時利用。
- Desktop/Electron 起動下と daemon 単独、実 UI の入力・質問・承認・再起動復元。
- Linux/Windows/macOS x64 の実ランタイム、長時間ツール/MCP 子プロセスを含む異常終了時の回収。
- native の長い会話・世代変更・background continuation・子エージェントからの権限要求。現在の契約試験の結果と実行確認を混同しない。
- 統合 CLI の remote terminal 用 node-pty 配置。Provider はその terminal API を呼ばず、Agent Bash は検証済みだが、upstream 配布の問題として追跡する。

## 今回追加しない機能

Browser/Computer Use、一般的な rewind、独立した Paseo 子エージェント管理、Hook 信頼レビュー画面、Goal/Workflow 操作 UI、カスタム system prompt、非永続会話、モデルへの JSON Schema 出力制約。通常の ZCode tools / skills / MCP は native に委ねる。

Paseo 標準の quota/リセット時刻/初期 usage 表示は公開プラグイン API の範囲でのみ対応する。本体変更や別の表示への置き換えは提案・実装しない。新しい公開 API が導入された時に契約と実 UI の両方を再評価する。
