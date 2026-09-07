# paseo-plugin-zcode-provider

Paseo の公開 `registerProvider` API から ZCode を追加するプラグインです。Paseo 本体へのパッチ適用は不要です。ZCode との通信部分は `paseo-zcode-patcher` の実装を移植し、Paseo 側との接続を `ProviderRegistration` / `ProviderConnection` に置き換えています。

## 対応環境

- Paseo main **`c424f82922fcd36aa9cc9e473644bca04417b420`**（2026-09-07 確認、v0.8 preview の Provider API）。リリース済み v0.7.2 は対象外です。
- macOS / Apple Silicon、`/Applications/ZCode.app` の **ZCode 3.11.2 / 同梱 CLI 0.16.5**。
- 開発用 Node.js 22.12 以上。実行時には Paseo が SDK と Zod を供給します。

ZCode 公式 host のファイルと RPC export を検証してから起動します。ZCode のログイン・モデル設定は既存の ZCode アプリが管理し、このプラグインに認証情報をコピーする必要はありません。ZCode 自体の内部 API は公式な拡張 API ではないため、対応バージョンの更新時には再調査が必要です。

## 実装済み

- ZCode の Provider 表示とアイコン、ワークスペース別モデル・思考量・モードの取得。
- 保存型セッションの作成・再開・一覧・インポート。Paseo のタイトルは `session.opened` に反映します。
- テキスト、ワークスペース内のアップロードファイル、ZCode が公開するスラッシュコマンドの送信。
- 応答・思考・ツール・Todo・履歴の表示、トークン数とコンテキスト使用量の通知。
- ツール承認、質問、計画の承認・却下。応答は元の ZCode リクエストへ一度だけ返します。
- モデル・思考量・モードの変更、ZCode 自身が行う計画承認後のモード変更の同期。
- セッションごとの環境変数、MCP の stdio / HTTP / SSE 接続。
- 割り込み、接続断の通知、プラグイン停止時の host 終了。

完全同等にはならない項目は [docs/todo.md](docs/todo.md) に、原因・現状の挙動・完了条件を記録しています。標準画面のアカウント使用枠、開始前のモード選択履歴、復元直後の使用量、標準診断欄は Paseo 本体側の対応が必要です。

## 開発と検証

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run format:check
npm run test:upstream -- /absolute/path/to/paseo
```

`test:upstream` は指定した checkout を変更せず、実際のプラグインコンパイラと Provider アダプターを使います。ZCode host 部分だけをテスト用に差し替え、登録・モデル取得・セッション作成・ストリーム・保存情報・終了を確認します。SDK の保存済みソースと指定 checkout が異なる場合は、契約の再確認を求めて停止します。

`npm run build` は配布内容を検査するための `dist/index.server.js` を作ります。Paseo にインストールする対象は **`dist` ではなく、このリポジトリのルートディレクトリ**です。Paseo は `index.server.ts` をコンパイルします。

実機確認の範囲は [docs/verification.md](docs/verification.md) を参照してください。

任意の `npm run test:runtime -- /absolute/path/to/workspace` は、インストール済み ZCode の通常のユーザーデータを使い、host の初期化とモデル一覧取得まで確認します。会話作成・プロンプト送信は行いません。

## インストール

上記 main の API を含む Paseo で、[v0.8 プラグインのインストール手順](https://paseo.sh/docs/plugins/v0.8#install-and-try-it)に従い、このリポジトリの絶対パスを登録してください。登録 ID は `zcode-provider`、Provider ID は `zcode` です。

`zcode` を追加済みの patcher と同じ daemon へ併用しないでください。本体が重複 Provider ID を拒否します。旧 patcher の保存ハンドルを自動変換する機能はありません。ZCode 側に保存された会話は、対象ワークスペースのセッション一覧からインポートします。

## 設定上の制限

通常は ZCode の既存設定を使用します。`providerOptions` の独自設定は、初期モードが `plan` のときの `planReturnMode: "build" | "edit" | "yolo"` だけです。指定時には作成直後にそのモードを設定してから `plan` に入り、承認後の切替は ZCode 自身に任せます。再開時に過去のモード履歴を上書きしません。

独自の `systemPrompt`（Paseo daemon の追加指示を含む）、`persist: false`、独自 `settings` はエラーになります。MCP の stdio コマンドには絶対パスが必要です。`alwaysLoad` とツール単位の事前承認には対応していません。送信中の追加入力、会話の巻き戻し、構造化出力など未実装の機能は capability として宣言しません。

ソースの由来と SDK の固定方法は [NOTICE.md](NOTICE.md)、設計判断は [ADR 2](docs/adr/0002-zcode公式hostを公開providerプラグインapiへ直接接続する.md) を参照してください。
