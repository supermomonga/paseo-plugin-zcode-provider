# 検証記録

## 2026-09-09: Windowsの既定インストール先の修正

- Windowsの既定値を `%LOCALAPPDATA%\Programs\ZCode` に変更。検出処理と同じ環境を参照し、明示指定がある場合は `LOCALAPPDATA` を要求しません。既定値を使う場合の未設定・空・相対パスは `INVALID_CONFIGURATION` になります。
- 報告された `C:\Users\code\AppData\Local\Programs\ZCode` と、別ドライブ・空白・日本語を含む配置を模擬し、実行ファイル、CLI、metadata、host archiveの解決と起動引数・環境を確認しました。明示指定の優先順位と既定パス不在時に別の場所を探索しないことも検証しました。
- `npm run typecheck`、`npm test`（11ファイル・129テスト）、`npm run build` が成功。整形チェックと差分チェックも成功。
- ADR 6「Windowsの既定インストール先をユーザー別の場所にする」をAcceptedとし、ADR 3へのAmends / Amended byと目次を更新。doctorはエラー0、既存ADR 1のwarning 1 / info 1のみ。
- Windowsのファイルシステムと子プロセスは模擬しています。Windows実機でのZCode起動・モデル一覧取得は未実施であり、今回の成功結果は実機動作を証明しません。

## 2026-09-08: macOS・Linux・Windows 対応

zcode-acp `7b3af187d7ee732e9043aed873a863fc855625c2` を参照し、macOS arm64/x64、Linux arm64/x64、Windows x64 の検出・起動経路を実装しました。

- 自動テストは OS 別のファイルシステムと子プロセスを模擬し、5 対象の metadata 照合、3 OS の既定パスと明示パス、環境変数の優先順位、バージョン取得、host 起動への引数・環境変数の伝播を確認しています。Windows ケースは `node:path.win32` を用い、空白を含む Windows パスを検証します。
- 未対応環境、metadata 不一致、相対パス、ファイル欠落、インストール先外の参照、バージョン・host hash/export 不一致を検証しています。中断は開始前と子プロセス起動時を模擬し、タイムアウトは spawn の設定と SIGTERM 終了時の拒否を確認しています。60 秒の実時間待機や他 OS のプロセス終了動作を検証したものではありません。
- `npm run typecheck`、`npm test`（9 ファイル・70 テスト）、`npm run build`、`npm run format:check`、`git diff --check` が成功。
- macOS arm64 の実 ZCode 3.11.2 で `npm run test:runtime` が成功。公開 Provider 経由の初期化、3 モデル・4 モード・既定モデルあり、host 終了を確認。プロンプト送信・会話作成は行っていません。
- Linux、Windows、macOS x64 の実 ZCode 起動と UI 操作は未実施。上記の自動テストは各 OS の実機動作を証明しません。
- ADR 3 を Accepted とし、ADR 2 への Amends / Amended by 関係と生成済み目次を更新。doctor の既存 ADR 1 に関する warning 1 / info 1 は変更していません。

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

## 2026-09-08: 独立プラントグル・初回送信時の保存

Paseo 0.8.0-beta.1、ZCode 3.11.2 / CLI 0.16.5、macOS arm64で確認。Paseo本体とZCode本体は変更していません。

### 実装と自動テスト

- 編集モードはbuild / edit / yolo、プランはProvider設定 `plan_mode` の独立トグルに変更。`mode: plan` と `providerOptions.planReturnMode` は廃止。
- 初期状態、3編集モードでのON/OFF・ON中の移行先変更・承認後の同期、却下後のプラン維持、修正要求による送信、連続変更、途中のnative設定失敗を検証。
- 保存ハンドルversion 2のlogical/native区別、未送信の再開、初回送信前の対応保存、書き込み失敗時の送信抑止と再試行、破損、ワークスペース不一致、存在しない会話、旧形式の拒否、一覧からのインポートを検証。
- `/plan` はZCode desktop側でモード設定と任意のタスク送信へ分解するショートカットです。ホストの `sendPrompt` にそのまま渡すとモデルへの文字列入力になります。Providerでも同じくモード設定を行い、引数がなければ `completed`、あればタスク本文だけを送信します。command入力と通常のテキスト入力の両方をテストしています。

- 最終チェック: `npm run typecheck`、`npm test`（11ファイル・122テスト）、`npm run build`、`npm run format:check`、`git diff --check`が成功。実ZCodeの `npm run test:runtime` は3モデル・3編集モード・既定モデルありで成功。
- ADR 5をAcceptedとしてADR 2にAmendsを追加し、目次を生成。`adrs doctor` はエラー0。既存ADR 1のwarning 1 / info 1のみで、新規の診断はありません。

### 実ZCode・実Paseoの確認

- 完成したProviderを実PaseoのPluginAgentClientRegistry・AgentManager・AgentStorageへ接続し、未送信と初回応答中に検証プロセスをSIGKILL。別プロセスで同じ固定識別子から再開成功。未送信は対応ファイル0件・メッセージ0件、応答中は対応ファイル1件・送信メッセージ1件を確認しました。応答途中の未確定テキストの復元は保証しません。
- 正常完了後も別プロセスで再開し、送信メッセージ1件・応答メッセージ1件を確認。
- 実モデルGLM-5.3-Flashにファイル操作のない計画を提示させ、build / edit / yoloそれぞれで承認。すべて選択した編集モードへ移行し、プラントグルがOFFになり、応答完了を確認。却下の場合はeditを保持したままプランONで完了しました。
- 実Paseoアプリ同梱のWeb画面を隔離したdaemonへ接続。テスト用クライアント登録名はcodexですが、Provider実装とZCodeはこのリポジトリのものです。UIへの設定値・モード・保存方式をテスト側で差し替えていません。新規画面でSettings2の青いON表示、3つだけの編集モード、プランON中の編集モード変更、スラッシュコマンド一覧を確認。
- 既存会話のSettings2アイコンにポインターを置き、`Toggle plan mode` のツールチップが実際に表示されることを確認。
- 修正後の引数なし `/plan` を実ZCode接続で実行し、編集モードeditを保持してプランON、結果completed、ターン開始0件を確認。
- 未送信で画面を離れた段階で、情報取得用の4セッションすべてがclose済み、ZCode一覧に残った対象IDは0件でした。その後、画面から検証用メッセージを実送信し、応答 `ui-validation-ok` と、既存会話でのプランON・編集モード変更・OFFを確認しました。
- 検証用の会話は一時ディレクトリのワークスペースに限定しています。実送信した検証会話はZCodeに保存されます。ユーザーの通常会話を削除する処理は実施していません。

### 制約

- Linux / Windows / macOS x64の実機検証は未実施。Windowsではファイルを同期しますが、ディレクトリのfsyncは行いません。電源断・ディスク障害を模擬した試験ではありません。
- 対応情報の書き込みとZCode側の保存は別処理です。その間に終了した場合は再開エラーにし、新規会話へ自動切り替えしません。対応ファイルを手動削除すると未送信と区別できないため、state領域も保持してください。
