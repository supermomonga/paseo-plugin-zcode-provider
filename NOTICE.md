# ソースの由来

`server/discovery`、`server/host`、`server/protocol`、マッピングとセッション処理、および対応テストは、同じ所有者の [paseo-zcode-patcher](https://github.com/supermomonga/paseo-zcode-patcher/tree/572100368774df7632728a72568466ac3632d458) の `patches/paseo-v0.7.2-zcode.patch` に含まれる ZCode 実装を基にしています。Paseo の内部 AgentClient 依存を除去し、公開 Provider API、JSON 検証、接続の終了処理を追加・変更しています。

ZCode のプログラム、認証情報、モデル設定は同梱していません。利用者がインストール済みの公式 host を実行時に使用します。

開発とテストには公開済みの `@getpaseo/plugin@0.8.0-beta.1` を使用します。Provider API のソースコピーは削除しました。ビルドは `@getpaseo/plugin/server/provider` と `zod` を外部モジュールとして維持し、実行環境の Paseo に解決させます。`index.server.ts` は公開の `PluginServerContext` を使用します。

`icon.svg` は [Paseo main c424f829 の glm-acp-agent.svg](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/app/src/assets/acp-provider-icons/glm-acp-agent.svg) のコピーです。上流のライセンスに記載された第三者素材の扱いが適用されます。

アイコンの出典に対応する上流ライセンスを [vendor/paseo/LICENSE](vendor/paseo/LICENSE) に保持しています。Copyright (c) 2025-present Mohamed Boudra。

3 OS 対応の検出処理は [zcode-acp commit 7b3af187d7ee732e9043aed873a863fc855625c2](https://github.com/supermomonga/zcode-acp/tree/7b3af187d7ee732e9043aed873a863fc855625c2) の `src/zcode/discovery/discover.ts` と ADR 0003・0005 を参考にしています。OS 別の配置解決、metadata と実行環境の照合、同梱 Electron によるアプリバージョン取得を Node.js 向けに移植しています。macOS の plist 取得は既存方式を維持し、インストール先の環境変数には `PASEO_ZCODE_INSTALL` を使用します。ACP 層・Bun ランタイム・認証情報の移行処理は取り込んでいません。
