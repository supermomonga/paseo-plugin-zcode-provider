# 検証記録

## 2026-09-08: 公開 SDK 0.8.0-beta.1 への移行

インストール済み Paseo.app のバージョンは `0.8.0-beta.1`。npm 公開済みの `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` を同版に固定しました。Provider API の公開先は `@getpaseo/plugin/server/provider` です。リリースタグの Provider API ソースは従来の複製と一致しており、ADR 2 の移行条件を満たしたため複製と alias を削除しました。

- 型検査、8 ファイル・58 テスト、ビルドが成功。SDK と Zod の実行時参照が外部モジュールのままであることも検査しています。
- 上流検証はタグ `v0.8.0-beta.1`、commit `4eab53e24e1b57c74b00945aa48a89d68ed755e3` の実コンパイラ・アダプターと公開 SDK を使用して成功。Provider 登録、モデル取得、会話開始、ストリーミング、使用量更新、保存情報、終了を確認しました。ZCode host はテスト用実装です。
- 実際の ZCode host を公開 SDK 経由で初期化し、3 モデル・4 モード・既定モデルありを確認。一覧取得後に host が終了しました。会話作成・プロンプト送信は行っていません。
- `npm run format:check` と `git diff --check` が成功。
- 初期使用量は引き続き `initialUsageReplayed: false`、更新後は `liveUsage: passed`。既存 TODO は未解消です。

以下は移行前の検証記録です。

実施日: 2026-09-07。Paseo は GitHub API とローカル checkout の両方で main `c424f82922fcd36aa9cc9e473644bca04417b420` を確認しました。

## 自動検証

- `npm run typecheck`: 成功。
- `npm test`: 8 ファイル、58 テスト成功。公開イベントのスキーマ、モデル変換、計画・質問応答、画像送信、履歴再開、複数入力、ツール更新、コンテキスト通知、異常イベント、切断、割り込み期限、通信の書き込み停滞を含みます。
- `npm run build`: 成功。開発用 SDK コピーを実行用 bundle に含めないことも検査します。
- `npm run format:check`: 成功。
- `npm run test:upstream -- /absolute/path/to/paseo`: 上記 main の実コンパイラでサーバープラグインをコンパイルし、公開エントリーを評価して `zcode` が登録されることを確認しました。さらに実際の `PluginAgentClientRegistry` を通し、モデル取得、会話開始、ストリームの重複防止、使用量、保存情報、終了まで成功しました。ZCode host 部分にはテスト用実装を使用しています。

main の初期使用量の問題も再現しました。セッション購読直後は `initialUsageReplayed: false`、その後の native snapshot 更新は `liveUsage: passed` です。これは [TODO](todo.md) に残しています。

設計判断は ADR 2「ZCode公式hostを公開ProviderプラグインAPIへ直接接続する」を Accepted として記録し、生成済み目次を更新しました。既存 ADR との関係変更はありません。`adrs doctor` はエラー 0、既存 ADR 1 に起因する warning 1 / info 1 のみで、今回の追加に起因する指摘はありません。

## 実際の ZCode での検証

`/Applications/ZCode.app` の実ファイルを読み、実プロセスを起動して確認しました。

| 確認項目                                           | 結果                                         |
| -------------------------------------------------- | -------------------------------------------- |
| プラットフォーム                                   | darwin-arm64                                 |
| アプリ / 同梱 CLI                                  | 3.11.2 / 0.16.5                              |
| CLI の SHA-256                                     | manifest と一致                              |
| host index / RPC module の SHA-256 と export       | manifest と一致                              |
| 同梱 CLI の version / doctor                       | 成功。ただし認証の完了を証明するものではない |
| プラグイン接続からの実 host 初期化・モデル一覧取得 | 成功。3 モデル、4 モード、既定モデルあり     |
| 一覧取得後の host 終了                             | 成功                                         |

モデル一覧取得は最初にサンドボックスの `EPERM` で失敗しました。host の初期化が通常のユーザーデータにアクセスできないことを確認し、同じコードを通常の実行環境で実行して成功しました。実装への回避処理は追加していません。

実 host の一覧確認は `npm run test:runtime -- /absolute/path/to/workspace` で再実行できます。出力はモデル数などの結果に限定し、認証値・モデル設定の内容・プロンプトは記録しません。

## 未実施

Paseo daemon へのインストール、標準画面の操作、実モデルへのプロンプト送信、実ツールの実行、実際のアプリ再起動を伴う会話復元は未実施です。これらの一連の検証はリリース前の TODO として残しています。上記の成功結果は、この範囲の完了を意味しません。
