# ソースの由来

`server/discovery`、`server/host`、`server/protocol`、マッピングとセッション処理、および対応テストは、同じ所有者の [paseo-zcode-patcher](https://github.com/supermomonga/paseo-zcode-patcher/tree/572100368774df7632728a72568466ac3632d458) の `patches/paseo-v0.7.2-zcode.patch` に含まれる ZCode 実装を基にしています。Paseo の内部 AgentClient 依存を除去し、公開 Provider API、JSON 検証、接続の終了処理を追加・変更しています。

ZCode のプログラム、認証情報、モデル設定は同梱していません。利用者がインストール済みの公式 host を実行時に使用します。

`vendor/paseo/provider.ts` は [Paseo main c424f829 の公開 Provider API](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/plugin/src/provider.ts) の無変更コピーです。Copyright (c) 2025-present Mohamed Boudra。上流のライセンスを [vendor/paseo/LICENSE](vendor/paseo/LICENSE) に収録しています。ファイルの SHA-256 は `8c8fafa9d8b9e6bacc38cdc9e6d35397e2ea9e2784d3bc367f383bce7cc359f2` です。

このコピーは型検査とテストのためだけに使用します。ビルドは `@getpaseo/plugin/provider` と `zod` を外部モジュールとして維持し、実行環境の Paseo main に解決させます。古い SDK 向けの互換処理ではありません。`index.server.ts` は公開コンテキストのうち実際に使う `registerProvider` メンバーだけを型に記述しています。

`icon.svg` は [同じ Paseo main の glm-acp-agent.svg](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/app/src/assets/acp-provider-icons/glm-acp-agent.svg) のコピーです。上流のライセンスに記載された第三者素材の扱いが適用されます。
