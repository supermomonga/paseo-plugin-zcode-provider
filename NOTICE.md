# ライセンスの適用範囲

本プロジェクトのオリジナルコードは [MIT License](LICENSE)（Copyright (c) 2026 supermomonga）で提供します。移植元の `paseo-zcode-patcher` と `zcode-acp` の該当コードも同じ著作者のオリジナルコードです。

第三者素材のライセンスや権利は変更しません。`icon.svg` には以下の Apache-2.0 の条件が適用されます。`images/zcode-conversation.png` は著作者提供のスクリーンショットで、含まれる第三者アプリの画面・ロゴ・商標への権利を本プロジェクトの MIT License で許諾するものではありません。

# ソースの由来

`server/discovery`、`server/host`、`server/protocol`、マッピングとセッション処理、および対応テストは、同じ所有者の [paseo-zcode-patcher](https://github.com/supermomonga/paseo-zcode-patcher/tree/572100368774df7632728a72568466ac3632d458) の `patches/paseo-v0.7.2-zcode.patch` に含まれる ZCode 実装を基にしています。Paseo の内部 AgentClient 依存を除去し、公開 Provider API、JSON 検証、接続の終了処理を追加・変更しています。

ZCode のプログラム、認証情報、モデル設定は同梱していません。利用者がインストール済みの公式 host を実行時に使用します。

開発とテストには公開済みの `@getpaseo/plugin@0.8.0` を使用します。Provider API のソースコピーは削除しました。ビルドは `@getpaseo/plugin/server/provider` と `zod` を外部モジュールとして維持し、実行環境の Paseo に解決させます。`index.server.ts` は公開の `PluginServerContext` を使用します。

`icon.svg` は [Paseo main c424f829 の glm-acp-agent.svg](https://github.com/getpaseo/paseo/blob/c424f82922fcd36aa9cc9e473644bca04417b420/packages/app/src/assets/acp-provider-icons/glm-acp-agent.svg) のコピーです。この SVG は [ACP Registry の glm-acp-agent/icon.svg](https://github.com/agentclientprotocol/registry/blob/f3826ddd6e35951ea9b7fd0cf43c35a30c3c64cd/glm-acp-agent/icon.svg) とバイト単位で一致します。ACP Registry は Apache-2.0 で配布されており、その [LICENSE](vendor/acp-registry/LICENSE) を保持しています。アイコンは変更していません。商標への権利や公式の承認を示すものではありません。

アイコンの出典に対応する上流ライセンスを [vendor/paseo/LICENSE](vendor/paseo/LICENSE) に保持しています。Copyright (c) 2025-present Mohamed Boudra。

3 OS 対応の検出処理は [zcode-acp commit 7b3af187d7ee732e9043aed873a863fc855625c2](https://github.com/supermomonga/zcode-acp/tree/7b3af187d7ee732e9043aed873a863fc855625c2) の `src/zcode/discovery/discover.ts` と ADR 0003・0005 を参考にしています。OS 別の配置解決、metadata と実行環境の照合、同梱 Electron によるアプリバージョン取得を Node.js 向けに移植しています。macOS の plist 取得は既存方式を維持し、インストール先の環境変数には `PASEO_ZCODE_INSTALL` を使用します。ACP 層・Bun ランタイム・認証情報の移行処理は取り込んでいません。

リリース監視スクリプトとワークフローは、[zcode-acp commit 7b3af187d7ee732e9043aed873a863fc855625c2](https://github.com/supermomonga/zcode-acp/tree/7b3af187d7ee732e9043aed873a863fc855625c2) の `scripts/check-zcode-releases.ts`、対応テスト、`.github/workflows/zcode-release-check.yml` を参考にしています。対応バージョンより新しいリリースの取得、変更履歴付きIssue作成、クローズ済みを含む重複防止をNode.js向けに実装し、Paseoのプレリリース・正式版にも適用しています。
