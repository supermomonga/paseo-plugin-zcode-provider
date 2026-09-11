# 検証記録

## 2026-09-11: 設定画面（読み取り専用の診断画面）

対象は [ADR 8](adr/0008-設定画面は読み取り専用の診断に限定しホスト状態を専用rpcで返す.md)。Paseo 0.8.0 の Settings API のうち、設定値の永続化はクライアントの `useSettings` に限定され、daemon 側サブプロセスから保存値を読む API はありません。そのため設定の保存は行わず、`client.addSettingsScreen` と専用 RPC `zcode.diagnostics` で、既存の `discoverRuntime` / `runRuntimeSmoke` の結果を要求時に返す画面を追加しました。

- 表示項目はインストール先とその由来（既定 / `PASEO_ZCODE_INSTALL`）、OS/CPU、ZCode 本体・同梱 CLI のバージョン、プラグインのバージョン、互換性と理由、検証済み artifact との一致、インストール先の書き込み可否、保存マッピング先、任意の host check 結果です。失敗時は `AdapterError` のコード、公開メッセージ、`formatDiagnostic` の sanitize 済み JSON のみを返します。
- `server/status.test.ts` を追加しました。検出成功、環境変数由来の表示、非対応 ZCode の成功応答、スモーク失敗、想定外エラーの各分岐と、生のエラーメッセージ・認証情報が RPC 応答と診断に含まれないことを確認しています。
- `npm run typecheck`（サーバー / クライアントの 2 プロジェクト）、`npm test`（14 ファイル・176 テスト）、`npm run build`、`npm run format:check` が成功しました。クライアントとサーバーは React Native のグローバル `AbortSignal` 宣言が Node と衝突するため別プロジェクトに分けています。
- Paseo `v0.8.0`、commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f` の一時チェックアウトで `npm run test:upstream` が成功しました。`NODE_ENV` 未設定と `production` の両方で、実コンパイラが client / server の両エントリをコンパイルし、server の provider 登録と client の `addSettingsScreen` 登録を実行して確認しています。
- `npx @getpaseo/cli@0.8.0` で分離した daemon（`--home` を一時ディレクトリ、`--listen 127.0.0.1:6789`、`--web-ui --no-relay`）を起動し、この worktree を `zcode-provider-ui` としてディレクトリインストールしました。同梱 Web UI の Settings → Plugins → zcode-provider-ui → Diagnostics で、実 ZCode 3.11.2 / CLI 0.16.5、darwin-arm64、互換性 Supported、検証済み fingerprint 一致、インストール先 `/Applications/ZCode.app`（Default location）、読み取り専用、保存先を表示できることを確認しました。**Run host check** は Result / Doctor ともに Passed になりました。幅 420px では設定の詳細画面として全項目が縦に表示されました。
- 分離 daemon は停止・一時ディレクトリごと削除し、検証用インストールは削除しました。実際の daemon で利用中の `zcode-provider` は検証中だけ無効化し、終了後に有効化して `running` に戻したことを確認しています。実会話の送信・ツール実行・セッション復元はこの検証では行っていません。
- Linux / Windows / macOS x64 の実機と、テーマ切替時の配色、エラー表示の実画面は未確認です。エラー分岐は自動テストのみで確認しています。

## 2026-09-11: 最低バージョン方式への変更

- ZCode本体3.11.2以上・同梱CLI 0.16.5以上の正式版を許可し、major更新にも上限を設けません。プレリリース、不正・不明なバージョン、最低バージョン未満は拒否します。動作確認済み情報と最低バージョンを分離し、リリース監視は `VERIFIED_ZCODE_ARTIFACT.appVersion` を参照します。
- RPCモジュールをホストの静的importとクラス名・必要メソッドから検出します。ファイル名・短縮export名の異なるJavaScriptファイルを一時ディレクトリに作り、実際の子プロセスで検出に成功することを確認しました。構造欠落、複数候補、読み込み失敗、インストール先外への参照・シンボリックリンクは拒否します。ハッシュ差分による起動拒否を廃止しました。
- 初期化RPCのエラー、応答形式不一致、通知の検証失敗、タイムアウト、プロセス終了で診断情報が保持されることをテストしました。公開Providerイベントの `diagnostic` への伝達、ネイティブの生エラー・認証情報・会話・動的なレコードキーをログや診断に含めないことも確認しました。
- `npm ci`、`npm run typecheck`、`npm test`（13ファイル・171テスト）、`npm run build`、`npm run format:check`、`git diff --check` が成功しました。`prepare` / `prebuild` が `package.json` から `server/build-info.ts` を生成し、バージョンの一致もテストで確認します。
- Paseo `v0.8.0`、commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f` の一時チェックアウトで `npm run test:upstream` が成功しました。実コンパイラによる登録、実アダプター、provider差し替え、保存情報からの再開、履歴復元、再開後のターンを確認しています。ZCode側はテスト用実装です。最初の検証で判明したrootの `package.json` 直接importに対する配置制約は、server内へのビルド情報生成で解消しました。
- macOS arm64の実 ZCode 3.11.2 / CLI 0.16.5で `npm run test:runtime` が成功しました。新しいRPC検出処理を通して初期化し、3モデル・3編集モード・既定モデルあり、正常終了を確認しました。会話作成・プロンプト送信は行っていません。
- ADR 7「最低バージョンと実行時検証でZCodeの更新を許可する」をAcceptedにし、ADR 2・3・4へのAmends / Amended byと管理対象の目次を更新しました。`adrs doctor` はエラー0。ADR 1の既存warning 1 / info 1は増えていません。

将来のpatch・minor・major更新は模擬テストです。実機で確認したZCodeは3.11.2のみであり、新しい正式版の動作保証ではありません。Linux / Windows / macOS x64の実機、実モデルへの送信、アプリUIは今回検証していません。データ形式を保った意味の変更は検出できるとは限りません。

## 2026-09-11: Paseo 0.8.0 正式版への対応

対象は [Issue #7](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/7)。Paseo のリリースタグ `v0.8.0`、commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f` と、npm 公開済みの `@getpaseo/plugin`・`@getpaseo/client`・`@getpaseo/protocol` の `0.8.0` を使用しました。

- SDK 3パッケージとロックファイルを正式版に更新し、manifest の要求を `>=0.8.0` に変更。`index.server.ts` と実行時別の import は移行済みで、利用する Provider API の型・スキーマにベータ版からの変更はありません。Provider 実装・保存形式の変更は行っていません。
- `npm ci` が成功し、`npm ls` でも SDK 3パッケージがすべて `0.8.0` であることを確認。`npm run typecheck`、`npm test`（11ファイル・129テスト）、`npm run build` が成功しました。SDK と Zod が外部モジュールのままであることも検査しています。
- `npm run test:upstream -- /absolute/path/to/paseo-v0.8.0` が成功。正式版の実コンパイラによるサーバーエントリーのコンパイル・登録と、実アダプター経由のモデル取得、送信、ストリーミング、使用量更新、終了を確認しました。
- 上流検証にプロバイダー差し替えのケースを追加。旧接続の終了が1回であること、旧セッションへの送信が `StaleProviderSessionError` になること、旧セッションを終了できることを確認しました。別の Provider と保存ストアのインスタンスで同じ保存情報を読み直し、新規会話を作らず native ID `session-1` を再開。ユーザー・アシスタントの履歴を復元し、次の送信とターン完了、host 終了まで成功しました。ZCode host と native 履歴はテスト用実装です。対応情報は検証用一時ディレクトリに保存し、終了時に削除します。
- 初期使用量は作成時 `initialUsageReplayed: false`、再開時 `resumedInitialUsageReplayed: false`。その後の更新は `liveUsage: passed` です。初期値が再通知されない既存の制約は未解消として残し、回避処理は追加していません。
- macOS arm64 の実 ZCode 3.11.2 / CLI 0.16.5 に対する `npm run test:runtime` が成功。公開 Provider 経由で初期化し、3モデル・3編集モード・既定モデルあり、host の正常終了を確認しました。会話作成・プロンプト送信は行っていません。
- `npm run check:paseo-releases -- --dry-run` は `No Paseo release newer than 0.8.0`。対応基準が正式版になり、同版が候補に出ないことを確認しました。GitHub Issue の作成は行っていません。
- `npm run format:check` と `git diff --check` が成功しました。

今回の検証範囲は自動テストと実ホストの一覧取得までです。上流テストはアダプターを通じて明示的に再開しており、daemon が自動で復旧する一連の動作、実モデルへの送信、実画面からの操作・復元、アプリや daemon の再起動は検証していません。Linux / Windows / macOS x64 の実機検証も未実施です。ベータ版で行った実モデル・画面検証は、下記の過去記録と区別しています。

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
