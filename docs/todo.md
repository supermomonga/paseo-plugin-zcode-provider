# 公開前に残る確認と機能境界

Paseo・ZCode 本体の改変は禁止。対応範囲はこの Provider に限定し、独自 fork・パッチ済みランタイムを対処案に含めない。公式の設定・通信 API を通じた操作と、無改変の公式ソースからの検証用ビルドは利用する。

## 保証対象外の upstream 復元不具合

固定ソースの stdio cold resume が、DB の `runtime/execution_state` に保存された mode / Plan を復元しない。`server-operations.ts` が過去のメッセージから得た mode を明示指定として渡し、Core の保存状態復元を抑止する。[再現と根拠](verification.md)を参照。

本体改変なしで保証する対応は、Paseo が保持する mode / Plan の両方を Provider から公式 API で再適用する経路であり、実装済み。ユーザー承認に従い、[ADR 14](adr/0014-paseoの保存設定を再適用する復元を保証範囲とする.md) でこの範囲に保証と必須 CI を限定した。`test:stdio-runtime` は保存設定を渡す復元を検証する。

設定省略時の復元不具合は保証対象外の制約として残す。Provider に補完ストアや旧 Host への切替は追加しない。`test:native-restore` はこの経路の失敗を非ゼロ終了で検出する別検証で、公開条件には含めない。公式ランタイムの更新時に再実行し、成功した場合に保証範囲を再評価する。

## 検証の残項目

- 公式アカウントログイン・期限切れ・未認証、公式 TUI と複数 Server の共有データ同時利用。Account タブの Sign in による Z.ai アカウントのサインイン完了、プランのモデル表示、そのプランでのセッション実行は確認済み。BigModel、daemon 以外の端末（スマートフォンなど）で認可した場合に完了まで進むことは未確認（ADR 17）。
- 管理下セットアップの実 UI（Desktop・Web・モバイルからの開始、進捗表示、削除）と、Paseo daemon を Windows / Linux arm64 で動かした場合の導入。CI の 5 プラットフォーム契約試験は daemon を介さない。
- プロキシや社内ミラーのみの環境での取得。現状は nodejs.org と GitHub への直接接続が必要で、失敗時は環境変数の上書きで回避する。
- Desktop ネイティブ画面とモバイル実機での操作。Electron Helper / 通常 Node の両 daemon 起動と、実 Web UI の入力・質問・承認・停止・再起動復元は確認済み（[検証記録](verification.md)）。
- macOS x64（管理下セットアップの対象外）、長時間ツール/MCP 子プロセスを含む異常終了時の回収は未検証。
- native の長い会話・世代変更・background continuation・子エージェントからの権限要求。現在の契約試験の結果と実行確認を混同しない。
- 統合 CLI の remote terminal 用 node-pty 配置。Provider はその terminal API を呼ばず、Agent Bash は検証済みだが、upstream 配布の問題として追跡する。

## 今回追加しない機能

Browser/Computer Use、一般的な rewind、独立した Paseo 子エージェント管理、Hook 信頼レビュー画面、Goal/Workflow 操作 UI、カスタム system prompt、非永続会話、モデルへの JSON Schema 出力制約。通常の ZCode tools / skills / MCP は native に委ねる。

Paseo 標準の quota/リセット時刻/初期 usage 表示は公開プラグイン API の範囲でのみ対応する。本体変更や別の表示への置き換えは提案・実装しない。新しい公開 API が導入された時に契約と実 UI の両方を再評価する。

## Paseo 0.11 で追加された公開 API の評価（0.11.0-beta.5 時点）

互換性の追従（[検証記録](verification.md)）とは分けて扱い、どちらもまだ採用していない。

- **Provider の `status()`**（0.11.0-beta.1、getpaseo/paseo#5707）：標準の Provider 診断欄に可用性と診断文を出せる。未実装の Provider は `connect()` の成否で判定される。このプラグインの `connect()` はランタイムを検査しないため、管理下ランタイムが未導入でも「Provider is available」と表示され、未導入はセッション作成時の案内付きエラーで初めて分かる。採用するときは、検査の範囲（`discoverRuntime` だけか smoke まで行うか）と所要時間を決め、診断文に ADR 7・8 の秘匿方針を適用する。0.8〜0.10 の daemon は登録の `status` を読まないので、最低要件を変えずに追加できる。`command` は宣言しない。宣言すると daemon が PATH を検索し、管理下ランタイムを使う前に失敗する。
- **usage source**（`server.registerUsageSource`、0.11.0-beta.1）：ZCode には Coding Plan の quota を返す公式 `usage-stats` サービスがある。ただし契約が beta ごとに変わっている（beta.3 で `discover()` / `fetch()`、beta.4 で `discover(scope)`）。beta.5 でもプラグイン Provider のセッションではアカウント探索が動かず、表示は全体の Usage 画面に限られる。0.11.0 正式版で契約が固まってから評価する。
- **初期 usage**：0.10.3 と 0.11.0-beta.5 でも、`session.ready` 前に送った使用量は購読者へ再通知されない。0.11.0-beta.4 の変更（getpaseo/paseo#6089）は、初回ターン前のメーターをアプリ側で空表示にするものである。制約は残る。
