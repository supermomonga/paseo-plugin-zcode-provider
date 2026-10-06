# ライセンスの適用範囲

本プロジェクトのオリジナルコードは [MIT License](LICENSE)（Copyright (c) 2026 supermomonga）で提供します。移植元の `paseo-zcode-patcher` と `zcode-acp` の該当コードも同じ著作者のオリジナルコードです。

第三者素材のライセンスや権利は変更しません。`icon.svg` には以下の Apache-2.0 の条件が適用されます。`images/zcode-conversation.png` は著作者提供のスクリーンショットで、含まれる第三者アプリの画面・ロゴ・商標への権利を本プロジェクトの MIT License で許諾するものではありません。

# ソースの由来

`server/discovery`、`server/host`、`server/protocol`、マッピングとセッション処理、および対応テストは、同じ所有者の [paseo-zcode-patcher](https://github.com/supermomonga/paseo-zcode-patcher/tree/572100368774df7632728a72568466ac3632d458) の `patches/paseo-v0.7.2-zcode.patch` に含まれる ZCode 実装を基にしています。Paseo の内部 AgentClient 依存を除去し、公開 Provider API、JSON 検証、接続の終了処理を追加・変更しています。

プラグイン本体には ZCode の Agent・認証・ツール・保存エンジン、認証情報、モデル設定を同梱しません。統合 CLI の stdio Services Server は、利用者が設定画面でセットアップを開始したときに取得します。

# ZCode ランタイムの配布

ZCode は統合 CLI を配布していないため、このリポジトリは `zcode-runtime-v<version>` タグの GitHub Release で、統合 CLI 配布物の非公式ビルドを配布します（ADR 15）。CI が公開タグの無改変ソースを公式 `scripts/build-zcode.mjs` でビルドし、上流の `LICENSE`（Apache-2.0）、`NOTICE.md`、`THIRD-PARTY-NOTICES.md` と、出典・ビルド記録の `BUILD-INFO.json` を配布物に加えます。ソースは改変しません。第三者コンポーネントはそれぞれのライセンスに従い、上流が `third-party/inventory.json` で確認中とする項目もそのまま引き継ぎます。このビルドは ZCode・Z.ai の承認や保守を受けたものではなく、ZCode・Z.ai の商標の使用許諾も含みません。

Node.js は利用者のマシンが nodejs.org の公式成果物を直接取得します。このリポジトリは Node.js を再配布しません。

`server/vendor/zcode` は [zai-org/ZCode](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e) の RPC、V4 契約、wire 組み立てと純粋な差分適用、および必要なスキーマ依存を含みます。第一者コードは [上流 LICENSE](server/vendor/zcode/LICENSE) の Apache-2.0、RPC と wire codec の VS Code 由来部分は [MIT の通知](server/vendor/zcode/THIRD-PARTY-NOTICES.md) の条件を保持します。[上流 NOTICE](server/vendor/zcode/NOTICE.md) は全文を保持しており、上流製品全体の説明です。そこに記載された全機能・依存がプラグインへ同梱されることを意味しません。

ファイルごとの出典・SHA-256、private workspace import の変更、第三者通知の抽出範囲を [provenance.json](server/vendor/zcode/provenance.json) に記録しています。取得・照合は `scripts/sync-zcode-source.mjs` で行います。`npm run build` はこれらのライセンス・通知を `dist/licenses/zcode` にも配置します。

開発 SDK は `@getpaseo/plugin@0.9.0-beta.1` です。ビルドは `@getpaseo/plugin/server/provider` と `zod` を外部モジュールとして維持し、Paseo に解決させます。

`icon.svg` は [Paseo main c424f829 の glm-acp-agent.svg](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/app/src/assets/acp-provider-icons/glm-acp-agent.svg) のコピーです。この SVG は [ACP Registry の glm-acp-agent/icon.svg](https://github.com/agentclientprotocol/registry/blob/f3826ddd6e35951ea9b7fd0cf43c35a30c3c64cd/glm-acp-agent/icon.svg) とバイト単位で一致します。ACP Registry は Apache-2.0 で配布されており、その [LICENSE](vendor/acp-registry/LICENSE) を保持しています。アイコンは変更していません。商標への権利や公式の承認を示すものではありません。

アイコンの出典に対応する上流ライセンスを [vendor/paseo/LICENSE](vendor/paseo/LICENSE) に保持しています。Copyright (c) 2025-present Mohamed Boudra。

リリース監視スクリプトとワークフローは、[zcode-acp commit 7b3af187d7ee732e9043aed873a863fc855625c2](https://github.com/supermomonga/zcode-acp/tree/7b3af187d7ee732e9043aed873a863fc855625c2) の `scripts/check-zcode-releases.ts`、対応テスト、`.github/workflows/zcode-release-check.yml` を参考にしています。対応バージョンより新しいリリースの取得、変更履歴付きIssue作成、クローズ済みを含む重複防止をNode.js向けに実装し、Paseoのプレリリース・正式版にも適用しています。
