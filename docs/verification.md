# 公開ソース・stdio / V4 移行の検証（2026-09-21）

接続方式と会話処理を置換し、通常テスト、実モデル E2E、隔離 daemon の実 Web UI 検証は成功した。ただし、固定した ZCode ソースに native cold resume の実行状態復元不具合があり、**公開条件は未達**。以下の成功と失敗を分けて扱う。

## 対象と成果物

| 項目                        | 実測値                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ZCode source                | `872ad960de7ec172591f7e1952f7849229f94521`                                                                                              |
| ビルド                      | source の git archive を一時領域へ展開。pnpm 10.33.2、Node 24.20.0、公式 `build-zcode.mjs`。元の clone は変更なし                       |
| ビルド前提                  | `pnpm exec tsc -b packages/shared` で公式 tsconfig の dist を生成。これがないと配布作成が `Missing @zcode/shared dist files` で停止する |
| 実行配置                    | tar.gz を checkout 外へ展開。Server と Agent とも明示した普通の Node 24.20.0 で実行                                                     |
| OS/CPU                      | macOS arm64                                                                                                                             |
| Server / Agent              | 3.14.0 / 0.16.9                                                                                                                         |
| 配布 tar.gz SHA-256         | `744e54e52437d62f2750ff9f96da9c7934c0db06b76fc157732f622848220f70`                                                                      |
| Server SHA-256              | `159c561495363afaa858bfd821b18e5a45cbb72353422daa0774e6082df73246`                                                                      |
| Agent SHA-256               | `b6d714bed80a2bbd260684ce5d63551913e7978ff0322876c838f33a468d417d`                                                                      |
| Plugin runtime / SDK        | Node 22.23.0 / `@getpaseo/plugin` 0.9.0-beta.1                                                                                          |
| Paseo 実 compiler / adapter | 0.9.0-beta.1 (`7c1958f5b0a4ae9f2cb12f77b0a754a644cd0081`) と最低対応 0.8.0 (`b8e24677e12b226c7c38c1c3a40649daa9f1152f`)                 |

この成果物は開発者が上記ソースから構築したものであり、公開済み CLI リリースの取得結果ではない。版番号から source SHA を推定していない。Node の最小境界は契約試験で確認し、実行に使った Node は 24.20.0 である。

## 成功した検証

- `npm run typecheck`、`npm test`（15 ファイル、122 tests）、`npm run build`。通常テストには課金 API 呼び出しを含めない。UI 検証で見つけた投稿時刻の回帰テストを含む。Unix socket を使う既存の 2 テストは sandbox 内では EPERM となり、通常環境で全件成功した。
- 固定 source SHA に対する vendored 91 ファイルの内容・出典ハッシュ照合。Apache-2.0 LICENSE、上流 NOTICE、該当する VS Code MIT 通知を保持し、ビルド出力にも配置。
- 公式 RPC のプロセス試験：hello / V4 negotiation、3-byte 分割フレーム、質問自動終了無効化、不正 handshake、RPC timeout、Server 異常終了、購読中の EOF close。
- V4 契約試験：重複、seq 欠落後の resync、壊れたフレーム、430 行のページング、異なる revision の拒否、新 epoch の履歴を揃えてから通知、購読解除後の通知無視。
- Provider 試験：ACK 前の row、guide 集約、キュー消失だけでは消費としない、受付不明時の再送禁止、対象 ID を付けた停止、失敗時の待機キュー取消、v1/v2 handle 拒否、mapping 破損・書込失敗、累積 usage、background continuation、複数質問・空回答・解決済み質問への遅延回答・拒否/取消・full access の意味分離、出力切詰め表示、v3 一覧、モデルを呼ばない `/plan`。
- Paseo 0.9.0-beta.1 と 0.8.0：実 compiler / adapter、`NODE_ENV` 未設定と production の Git preparation、server/client 登録、V4 本文差分、guide、添付 queue 集約、完了一回、provider replacement、履歴/設定の再開、停止。最低版は一時コピーの SDK 三パッケージだけを 0.8.0 に替えて検証し、作業ツリーの依存は変えていない。
- 公式 Server / Agent + ローカル模擬モデル：初期化、モデル一覧、draft、Bash の `printf`、受付/完了一回、履歴、AskUserQuestion、Write 承認、stop、stop 後の新規入力、`/plan`、v3 一覧、EOF cleanup。所有する Server を SIGKILL した場合も、事前に公式 API で取得した Agent PID が終了したことを確認。ツール/MCP の全異常終了形を確認したという意味ではない。
- `npm run test:e2e`：既存 GLM_API_KEY と公式 Z.ai Coding Plan endpoint、GLM-5.3-Flash / GLM-5.3。モデル変更、広告された推論選択肢、独立 Plan と build/edit/yolo、各 mode の Plan 承認、edit の却下、Paseo 明示設定による復元、実モデル guide・添付 queue・一完了・停止・再開・取消入力の非再生が成功。

実ランタイム試験は HOME、provider configuration、SQLite DB、socket temp、workspace、Provider mapping を隔離した。元の ZCode clone・ユーザーの実データ・稼働中の Paseo プラグインは変更していない。キー値・native stderr・実モデルの会話は検証文書へ記録しない。

## 実 Web UI・起動形態の追加検証

Paseo CLI の実行制限解除後、macOS arm64 / Paseo 0.9.0-beta.2 の別 daemon で確認した。`--home` は一時ディレクトリ、listen は loopback、relay/MCP injection は無効、Web UI と plugins は有効。現在の worktree を `zcode-provider-ui` としてディレクトリ導入した。ZCode のソース・成果物・Node 24.20.0 は上記と同一で、認証は隔離した provider configuration の既存 Z.ai Coding Plan API キーを使用した。

- **Desktop 同梱 CLI の起動形態:** daemon は `/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper`、公式 Server は指定した通常の Node 24.20.0、その子に Agent が起動した。利用中の Desktop 管理 daemon は変更していない。
- **通常 Node の起動形態:** 前の daemon を正常停止し、公式 npm `@getpaseo/cli@0.9.0-beta.2` を Node 22.23.0 で起動。同じ一時ホームから同じ会話を復元し、実 Web UI の送信ボタンから継続入力して実モデルの応答・idle を確認した。
- **診断・選択:** Settings → Plugins → Diagnostics に Server/Agent 版、ハッシュ、明示 Node、v3 保存先を表示。Run host check は Passed。モデル選択には隔離設定の 2 モデルが表示され、GLM-5.3-Flash / Low / Ask before changes で会話を作成できた。
- **質問・承認:** 実 Agent の AskUserQuestion が選択フォームになり、回答後に Write の Allow once / Always allow in this project / Deny が表示された。承認前は対象ファイルが存在せず、Allow once 後に選択値と一致する内容が作成され、応答完了後は idle となった。
- **停止・再開:** Bash の待機コマンドを UI の停止ボタンで中断。Edit automatically と独立 Plan を指定した後、一時 daemon を `paseo daemon restart --home <isolated-home>` で再起動して画面も reload した。履歴を再表示でき、再入力への応答が以前の選択を保持していた。確認した SQLite の会話は 1 件で、`runtime/execution_state` は `edit / planEnabled:true`。Paseo が明示設定を再適用する経路の成功であり、下記 native-only restore の不具合解消を意味しない。
- **表示:** 1280px と 420px の画面で会話を確認した。質問・承認待ち、完了、再開後の本文・ツール表示を目視確認。Web UI の console に Provider 由来のエラーはなく、Web 版の通知・animation に関する警告のみだった。

最初の画面再読み込みでは過去の投稿時刻が復元時刻になった。V4 row の `createdAt` が `timeline.item.timestamp` へ渡らず、Paseo が受信時刻を採用していたためである。行とその元の時刻を一緒に保持し、履歴・ライブ差分・再開のいずれでも ISO 8601 の時刻を渡すよう修正した。修正前に回帰テストの失敗を確認し、修正後はテスト、実 compiler/adapter、実 UI で元の投稿時刻の表示が成功した。Paseo の Worked for 表示を ZCode の `activeMs` と完全一致させる保証は含まない。

検証終了後、一時 daemon を強制終了なしで停止し、検証用ブラウザタブを閉じ、認証を含む一時ホーム・DB・会話・ワークスペースを削除した。

## 公開を妨げる native Plan / mode 復元不具合

`npm run test:stdio-runtime` は **exit 1**。独立した試験は続けるが、native-only restore が失敗した事実を非ゼロ終了で保持する。CI もこの失敗を無視しない。

再現手順は同スクリプト内に固定した。

1. 新しい会話を yolo で作成して一度実行する。
2. Plan を有効にし、通常 mode を edit に変更する。V4 が `edit / planEnabled:true` を通知したことを確認する。
3. `session.close` と Server 終了を行い、別 Server から同じ handle を再開する。mode / Plan は明示指定しない。
4. 再開は `yolo / planEnabled:false` となる。

隔離 DB の `session_entry` に `runtime/execution_state` = `{"mode":"edit","planEnabled":true}` が存在することも確認した。保存漏れではない。

原因の追跡：

- [server-operations.ts:1459](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L1459) は古い messages から mode を導出し、materialize の引数へ渡す。
- [create-app.ts:490](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/bootstrap/src/app/create-app.ts#L490) はそれを `modeOverride` として Core へ渡す。
- [resume.ts:213](https://github.com/zai-org/ZCode/blob/872ad960de7ec172591f7e1952f7849229f94521/apps/zcode-cli/packages/core/src/runtime/methods/resume.ts#L213) は `modeOverride !== undefined` の場合、保存した実行状態を適用しない。

この経路が新しい保存状態より古い message mode を優先する。Paseo が明示した mode / Plan を適用する E2E は成功しており、native-only restore の成功を示すものではない。Provider に別の Plan 保存や自動復元を加えて隠していない。upstream の根本修正と、そのソース・成果物での再検証が必要。

## 配布の node-pty 問題

公式 remote Server の terminal.create は native module を `server/remote/prebuilds/...` または build/Release から探すが、統合 CLI 配布は node-pty の prebuild を `node_modules/node-pty/prebuilds` に配置するため、端末作成が失敗した。参照は `packages/server/build-remote.ts`、`scripts/zcode-distribution/assets.mjs`、`packages/services/src/terminal/terminalService.ts`。

Provider はこの terminal API を使用しない。別経路の Agent Bash は実際のコマンド出力まで成功したため、stdio Provider の検証は継続できた。native バイナリのコピーや Desktop への切替は追加していない。

## 未検証と環境による制限

- 公式アカウントログイン/期限切れ/未認証、公式 TUI と複数プロセスの共有データ同時利用。独自 API キー設定の実モデル試験とは別。
- Linux、Windows、macOS x64。更新した GitHub Actions は未 push のためリモート実行結果なし。
- Desktop ネイティブ画面とモバイル実機での操作。今回操作したのは Desktop 内ブラウザの実 Web UI であり、Desktop 同梱 Electron Helper と通常 Node の両 daemon 起動を確認した。
- native の長大履歴、世代変更、子からの承認、background continuation は契約試験中心。全 OS での強制終了、長時間ツール/MCP 子プロセスを含む回収は未検証。

ADR 13 は Accepted。ADR 3/6 を Superseded とし、2/7/9/11/12 に双方向の Amends リンクを設定した。管理対象 TOC を CLI で更新。`adrs doctor` は 0 errors、既存 ADR 1 の 1 warning / 1 info のみ。設計の採用と、未達の公開条件を区別する。

---

# 旧 Desktop Host 構成の過去記録

以下は旧構成の履歴であり、上記 stdio / V4 構成の動作保証には使用しない。

# 検証記録

## 2026-09-18: 実モデル E2E と PR CI

- `npm run test:e2e` を追加。既存のモデル・Plan と追加指示・添付・停止・復元のスクリプトを順番に実行します。通常の `npm test` には含めません。実ホストと **Paseo 0.9.0-beta.1** の公開 Provider SDK を使い、daemon / UI は起動しません。
- ユーザー指定の **Z.ai Coding Plan** (`https://api.z.ai/api/coding/paas/v4`) と既存の `GLM_API_KEY` を使用。既定モデルは `GLM-5.3-Flash`、モデル変更の相手は `GLM-5.3`。API キーをモード `0600` の一時 personal provider 設定へ書き、公式の `ZCODE_DATA_BASE_DIR` / `ZCODE_STORAGE_DIR` でデータを分離します。子プロセス環境にはキーを渡さず、Computer Use helper は無効にしています。
- 最初の隔離実行は macOS の長い既定一時パスによりネイティブ CLI の `listen EINVAL` が発生しました。公式 CLI が `TMPDIR/znr-<UUID>.sock` を作ることとホストの終了診断から原因を確認し、短い `/tmp` 配下に変更しました。実際の Unix ソケットを作る回帰テストも追加しました。
- 自動テストで認証未設定時の失敗、環境変数の制限、設定ファイルの権限、成功・失敗時の削除を確認。全体の **19ファイル・284テスト**、型検査、ビルド、Prettier が成功しました。ソケット回帰テストは sandbox 内では `EPERM` となったため、通常環境で再実行して成功しています。
- macOS arm64 / ZCode **3.12.3** / CLI **0.16.5** で隔離 E2E が成功。2モデルの変更と推論レベル、独立 Plan、build / edit / yolo の承認、edit の却下、別接続での Plan とモデルの復元、追加指示、添付キュー、単一の完了通知、停止、キャンセル入力を除いた履歴4件の復元、再開後の応答、正常終了を確認しました。通常の ZCode 認証や会話は使用していません。
- 公式ホスト起動中に E2E ランナーへ `SIGTERM` を送り、非ゼロ終了・Provider 接続終了・その実行の一時認証ディレクトリ削除を確認しました。
- CI に独立した **Real ZCode E2E** ジョブを追加。同一リポジトリの PR、`main` push、手動起動で実行し、secret が渡らない fork / Dependabot PR は除外します。`pull_request_target` は使いません。公式 Ubuntu 向け deb **3.12.3-7463** を SHA-256 `631fbd69fcefe5d57c607bbfd047bb7a474af6017464681b99ccb7b15749c60e` で検証し、パッケージが宣言する依存関係とともにインストールします。`actionlint 1.7.12` で workflow の検証が成功しました。
- `gh secret set GLM_API_KEY --app actions --repo supermomonga/paseo-plugin-zcode-provider` の標準入力から承認済みの環境変数値を登録し、名前と更新日時だけを読み戻しました（2026-09-18 05:24:35 UTC）。値はログやリポジトリに出力していません。
- [ADR 12: 実モデルE2Eを隔離した認証設定でPRのCIに組み込む](adr/0012-実モデルe2eを隔離した認証設定でprのciに組み込む.md) は Accepted。既存 ADR の意味は変更せず、新しい運用判断として記録し、CLI 生成の目次を更新しました。doctor はエラー0、ADR 1 の既存 warning 1 / info 1 のみです。

**未検証範囲:** workflow はまだ push していないため、GitHub-hosted Ubuntu 上の実行結果は未確認です。公式 deb の取得・依存宣言・チェックサムと workflow の静的検証までを確認しました。Linux 実行、Paseo daemon / UI、アプリ再起動、認証期限切れはローカル E2E の成功に含めません。

## 2026-09-18: Issue #16 の ZCode 3.12.3 対応

[Issue #16](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/16) に対応。主対象は **Paseo 0.9.0-beta.1**、実機は **ZCode 3.12.3（build 3.12.3.7463）/ CLI 0.16.5、macOS arm64、Node.js 22.23.0** です。最低 ZCode 本体を 3.12.3 へ上げ、CLI は 0.16.5、開発 SDK は 0.9.0-beta.1、Paseo の最低要件は 0.8.0 を維持しました。

### 契約変更と調査根拠

- `libs/zcode/3.12.3/zcode.cjs` と、インストール済みアプリの `out/host/index.js`・同梱モジュールを確認しました。旧 `readWorkspaceState` を `model-selection.getView` と `readWorkspacePresentation` に置き換えています。モデル選択・未選択 snapshot・認証更新通知について、変更前の実装が新契約を扱えない回帰テスト3件を先に再現しました。
- 生のモデル選択応答はプロバイダーの API キーやヘッダーを含みます。Electron 内で候補の識別子・表示名・推論レベル・選択結果へ絞ってからブリッジへ出力し、秘密値が含まれないことをテストしました。
- native の `projectAppModelOption` と同じく、モデルごとに提示された推論レベルの最後を既定値とします。`getView({selection})` の解決結果・エラーを確認し、別モデル・別レベルへの暗黙置換を拒否します。旧 variant ID の変換は追加していません。
- 実機の初期化タイムアウトは、3.12.3 の `init-local` に必須の `zcodeBuiltinProviderConfigFilePath` が欠けていたことが原因でした。公式 main の `resolveZCodeBuiltinProviderConfigFilePath` と同じ同梱パスを渡し、OS別のパス解決・読取確認を追加しました。
- 新規作成時、native `session/create` は `setModel` に provider/model 文字列を渡し、モデル内の推論レベルを落とします。公式の作成呼び出しと同様、解決したレベルを別の `thoughtLevel` 引数にも渡し、初期値を照合しています。模擬ホストもこの契約を再現するよう変更しました。
- Plan の状態は V4 `config.planEnabled`、編集モードは `config.mode` を使用します。最終状態の到着を待ち、旧 snapshot の到着で Plan を上書きしません。V4 `sendText` にモデル選択・編集モード・Plan を付けます。認証更新通知の `modelSelection` と任意の `accountAccess` も検証します。対話的な認証復旧を行わず、非対応として停止する既存方針は維持しています。

### 自動・結合検証

- `npm run typecheck`、`npm test`（18ファイル・281テスト）、`npm run build`、`npm run format:check`、`git diff --check` が成功。モデル別の推論候補、未選択、適用不一致、不正な解決結果、候補再取得、独立 Plan 状態、承認、キュー・停止・復元を含みます。
- **Paseo 0.9.0-beta.1**、commit `7c1958f5b0a4ae9f2cb12f77b0a754a644cd0081` の実コンパイラ・Provider アダプターで `test:upstream` が成功。server/client のコンパイルと登録、モデル変更、Plan 設定と復元、追加指示・添付キュー、Provider 差し替え、履歴再生と再送信を確認しました。Git 準備は `NODE_ENV` 未設定 / `production` の両方で成功しました。
- 最低要件維持の追加確認として **Paseo 0.8.0**、commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f` でも同じ結合検証が成功しました。作業ツリーを一時 Git リポジトリへコピーし、実行用 SDK のみ `--no-save --package-lock=false` で 0.8.0 に差し替えました。原本の SDK・lockfile・CI 基準は変更していません。最初の sandbox 内の npm 取得は HTTP 403 となり、通常の実行環境で成功しました。
- 両版の初期使用量の再通知は引き続き `false`、後続使用量更新は成功。既存の制約として [TODO](todo.md) に残しています。
- [ADR 11](adr/0011-zcode-3-12-3のモデル選択と独立plan状態を採用する.md) を Accepted とし、ADR 5・7・9 を Amends / Amended by で補足、生成目次を更新しました。`adrs doctor` はエラー0、既存 ADR 1 の warning 1 / info 1 のみです。

### 実 ZCode 検証

- `test:runtime`: 初期化、3モデル・3編集モード・既定モデルあり、正常終了が成功。
- `test:model-plan-runtime`: 非デフォルトモデルでの作成、モデルの往復変更、対象2モデルの全推論レベル変更、Plan 中の編集モード変更と解除、build / edit / yolo それぞれの Plan 承認、edit での却下、別 Provider 接続でのモデル・推論レベル・Plan の復元と正常終了が成功。
- **復元条件:** ZCode 3.12.3 の native `resumeSession` 単独では Plan が OFF になります。CLI の `resumeSession` は最後の assistant の編集モードから実行状態を作り、Plan を別途復元しないことをソースと実機で確認しました。Paseo は保存済み `featureValues` を Provider の `settings` に渡すため、この契約に合わせて保存済み `mode` と `settings.plan_mode` を指定して復元を検証しました。プラグイン独自の設定保存や Plan の推測は追加していません。
- `test:steering-runtime`: 実モデルによる追加指示の反映、添付内容の処理、開始・完了の単一通知、待機入力付き停止、消費済みユーザー入力4件の復元、キャンセルした入力の不在、復元後の応答と正常終了が成功。
- 検証用 workspace とマッピングストアは一時領域に作成し、終了時に削除しました。承認済みの実モデル送信によるテスト会話は ZCode の保存領域に残ります。通常の会話は変更していません。

検証済み artifact を以下へ更新しました。ハッシュは許可リストではなく、検証環境を識別する情報です。

| ファイル        | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| CLI             | `da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01` |
| host index      | `c8f7b2e50f2c8f7eeb030a377cfc4779b2a0e2037af2239e065157dc2e3e422e` |
| host RPC module | `718fdf848fb173372264fd40c0d155d3953cb737a4439c64ff1ef7c2a33f9c82` |

**未検証範囲:** Paseo daemon/UI からの一連の操作、アプリ・daemon 再起動後の復元、Linux / Windows / macOS x64 実機、認証期限切れを起こした復旧は未検証です。実アダプター検証の ZCode 部分は模擬で、実 ZCode 検証は分離した公開 Provider 接続から行っています。利用中の daemon・プラグインのインストール先は変更していません。リモート CI・コミット・公開は実施していません。

## 2026-09-18: Issue #15 の Paseo 0.9.0-beta.1 対応

対象は [Issue #15](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/15)。開発用 SDK の `@getpaseo/plugin`・`@getpaseo/client`・`@getpaseo/protocol` を `0.9.0-beta.1` に固定し、CI の上流 checkout を同リリースの commit `7c1958f5b0a4ae9f2cb12f77b0a754a644cd0081` に更新しました。Provider 実装・保存形式・manifest の最低要件 `>=0.8.0` は変更していません。上限も追加していませんが、未検証の将来版の動作を保証するものではありません。

- macOS arm64 / Node.js 22.23.0 で `npm ci --include=dev`、`npm ls`（SDK 3パッケージすべて `0.9.0-beta.1`）、`npm run typecheck`、`npm test`（17ファイル・235テスト）、`npm run build` が成功しました。SDK と Zod の実行時参照を bundle に含めない検査も成功しています。
- `npm run test:upstream -- <0.9.0-beta.1 checkout>` が成功しました。`NODE_ENV` 未設定 / `production` の両方で、新規ディレクトリへの依存導入、実コンパイラによる server/client コンパイル、Provider 登録と診断画面の登録を確認しました。実アダプターではモデル一覧・非デフォルト選択・モデル変更、送信・ストリーミング、後続使用量更新、テキストのステアリング、添付キュー、最後の一回だけの完了通知、Provider 差し替え、永続化情報からの再開、履歴再生、復元後の送信が成功しました。
- 最低要件の **0.8.0**（commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f`）でも同じ結合検証が成功しました。更新後の作業ツリーを一時 Git リポジトリへコピーし、`npm ci --include=dev` 後、`npm install --no-save --package-lock=false` で実行用 SDK 3パッケージだけを `0.8.0` に差し替えました。`package.json` / `package-lock.json` が更新後の原本と一致し、インストール済み SDK は3つとも `0.8.0` であることを別途確認しました。Git 準備の候補ディレクトリはそのままの lockfile から **0.9.0-beta.1** の開発依存を入れ、コンパイルされた server は **0.8.0** の Provider SDK で評価しています。検証スクリプトの SDK と上流版の一致検査は変更していません。再現手順は [開発ガイド](development.md#minimum-runtime-compatibility) を参照してください。
- 各版の公開 `assertPluginCompatibility` に現行 manifest と当該バージョンを渡し、daemon / app の両方で受理することを確認しました。
- 両版とも初期使用量は `initialUsageReplayed: false` / `resumedInitialUsageReplayed: false`、後続更新は `liveUsage: "passed"` でした。既存の初期使用量の制約は未解消です。
- 0.9.0-beta.1 の `server.registerSettings()` が返す `read()` / `subscribe()` をリリースの型定義と公式ドキュメントで確認しました。[ADR 10](adr/0010-サーバー設定apiの追加後も診断専用画面を維持する.md) を Accepted とし、ADR 8 を Amends / Amended by で補足、管理対象の目次を再生成しました。サーバー側で設定を読めない制約は解消していますが、今回の要求範囲に設定編集を含めないため診断専用画面を維持します。README の公式ガイドへのリンクは現行 URL に修正しました。
- `npm run format:check` と `git diff --check` が成功しました。`adrs doctor` はエラー0、ADR 1 の既存 warning 1 / info 1 のみです。

**検証の範囲:** ZCode 側はテスト用 host で、Paseo 側は各版の実コンパイラ・Provider アダプター・Provider SDK を使用しました。クライアント登録は UI モジュールを模擬しています。今回、実 daemon/UI 操作、実モデル送信、Paseo アプリや daemon の再起動後の復元、Linux / Windows / macOS x64 実機は検証していません。利用中の daemon とインストール済みプラグインは変更していません。ローカルで CI 相当の検証を実施した結果であり、リモート CI の実行結果ではありません。0.8.0 の過去の実機確認は以下の各日付の記録と区別します。

## 2026-09-18: Issue #13 のモデル選択修正

[Issue #13](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/13) の原因は、現在モデルだけを含むセッション snapshot の `settings.model.available` を完全な候補一覧として使っていたことです。調査では PR #12 前のセッション実装と同じ遅延 snapshot 条件で比較し、main `a186a1d` だけが非デフォルトモデルを拒否することを確認しました。インストール済み ZCode 3.11.2 / CLI 0.16.5 のソースでも、購読・`readSession`・設定変更後の応答が `modelAvailability: "current"` を指定することを確認しています。

- 候補一覧は `readWorkspaceState.modelCatalog.available` を検証して取得し、セッション snapshot と分離しました。現在のモデル・mode・thinking は snapshot から取得します。現在モデルが候補から削除されても、現在値を保持したまま別モデルを選べます。
- Provider のカタログ要求、新規作成・復元、モデル指定時に完全なカタログを取得します。再取得した一覧は全件置換し、追加・削除・同数の入れ替えを反映します。取得失敗時に古い一覧で設定を続行せず、未知のモデルは native `setModel` 前に拒否します。V4 の待機処理、公開 API、永続化形式、ログの情報保護方針は変更していません。
- テスト用 host の workspace カタログをセッションと独立させ、購読・読み取り・設定変更後は現在モデルだけを返すようにしました。追加した21ケースは、非デフォルト指定の新規作成・復元、イベント到着順、指定なし・デフォルト指定、開始後の往復切り替え、mode/thinking 変更、カタログの追加・削除、取得失敗・不正応答、native 拒否・適用不一致、取得中のセッション終了を検証します。修正前はこのうち17ケースが失敗し、修正後はすべて成功しました。
- `npm run typecheck`、`npm test`（17ファイル・235テスト）、`npm run build`、`npm run format:check` が成功しました。
- Paseo **0.8.0**、commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f` の実コンパイラ・Provider アダプターで `npm run test:upstream` が成功しました。複数モデルのカタログ、非デフォルト指定での作成、開始後の往復切り替え、復元時のモデル指定・変更を追加し、既存のステアリング・キュー・履歴復元と合わせて確認しています。Git インストール準備も `NODE_ENV` 未設定 / `production` の両方で成功しました。
- macOS arm64 の実 **ZCode 3.11.2 / CLI 0.16.5**（検証済み artifact と一致）で、一時 workspace・一時マッピングストア・分離した Provider 接続を使用しました。完全な候補3件、非デフォルト指定での新規作成、デフォルトへの切り替え、非デフォルトへの切り戻し、全段階で候補3件の維持を確認しました。プロンプトは送信せず、未送信セッションを閉じ、一時ディレクトリを削除しました。実行には既存の認証とホストの通信先へのネットワーク接続が必要です。

**未実施範囲:** 今回の実ホスト検証は未送信セッションのモデル選択までです。保存済み会話の復元・プロンプト生成・ステアリングの実機再検証、daemon/UI 操作、モデル設定の実際の追加・削除、Linux / Windows / macOS x64 では確認していません。復元・追加・削除は自動テストで検証しました。利用中のプラグインへの反映・コミット・公開は行っていません。

## 2026-09-12: V4ステアリングと添付メッセージの待機送信

[ADR 9](adr/0009-v4入力受付とネイティブ待機キューを一つのpaseo実行へ対応付ける.md)でADR 2を補足しました。Paseo本体・公開SDK・ZCodeのファイルは変更していません。

- 通常送信を公式hostの `sendConversationCommandV4` / `sendText` へ統一し、`prompt.steer` を公開。テキストは `guide`、添付はnative uploadで保存した参照を `queue` に渡します。旧 `sendPrompt` への再送経路はありません。
- 会話購読には `helloConversationV4` / `initializeConversationV4` が必要です。API名はV4ですが、確認したwire protocolは **3**。V4の `fromSeq` は直前の適用済みseqを指す排他的な下限です。キュー・制御状態と分割フレームを検証し、本文・ツール・承認には既存のイベント購読を使います。
- `turn.steerQueued.targetTurnId` は、待機受付では直前のassistantターン、初回なら `deferred` を指す場合があります。これを新しい実行先とは扱わず、受付済みコマンドID・キューIDを照合した後、`turn.started` / `turn.steerDrained` で取り込み先を確定します。
- 公開ターンとnativeターンを分離。受付前に追跡情報を登録し、ACKより先のイベント、待機入力の昇格、nativeターン終了直前・最終使用量取得中の追加に対応します。受付は一度だけ返し、すべての待機分が終わるまで完了を通知しません。本文はnativeターン間で分け、累積使用量は重複加算しません。
- 停止は、Provider内の未送信分を無効化してnative autoDrainを止め、受付中の送信を照合し、生成と承認をキャンセルして残ったキュー項目を削除します。nativeの停止状態を確認してから一度だけキャンセルを通知。遅れて届く同じnativeターンの終了イベントにも対応します。
- ホスト切断や受付結果不明では成功扱い・再送をしません。native `resume` が未消費の保存済み入力を破棄することを `zcode.cjs` の `discardPersistedPendingSteerInputs` 呼び出しで確認。復元状態がidleであることを検証し、消費済みの履歴だけを表示します。本文と添付パートはnativeユーザーメッセージ一件にまとめます。
- ACK前イベント、連続追加、添付の複数ターン実行、空入力・コマンド・重複ID・拒否、未確定ACK、停止の各段階、RPC障害、native失敗、承認の維持、CASのstale応答、分割フレームの順序・サイズ・CRC不整合、添付の分割保存と中止を自動テストしています。
- Paseo **0.8.0**、commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f` の実コンパイラ・実 `PluginAgentClientRegistry` / アダプターで結合検証。`steerActiveTurn` がテキスト・添付とも `{ status: "accepted" }` を返し、追加の送信・置き換えを起こさず、公開ターンが一回だけ完了することを確認しました。ZCode側はテスト用実装です。Git準備の検証は未追跡の追加ソースも含む作業ツリーをコピーし、`NODE_ENV` 未設定 / `production` の両方を使用します。
- macOS arm64の実 **ZCode 3.11.2 / CLI 0.16.5** と既存の認証を使い、`npm run test:steering-runtime` を実行。一時workspace・一時マッピングストア・分離したProvider接続で、Bashのsleep実行、追加指示への `STEERING_OK` 応答、添付内容の `QUEUE_ATTACHMENT_OK` 応答、公開ターンの開始一回・完了一回を確認しました。
- 同じ実機検証で、実行中と添付待機分の停止、接続を作り直した復元、消費済み4入力が各一回だけ表示されること、キャンセルした入力が履歴・次の実行に混入しないこと、復元後の `RESUMED_OK` 応答、正常終了を確認しました。ZCodeのテスト会話は保存されますが、検証用のローカルworkspaceとマッピングファイルは終了時に削除します。
- 実機確認で見つかった終了時の競合も修正。購読解除と進行中の状態取得が終わってからnativeセッションを破棄します。

- 最終チェックは `npm run typecheck`、`npm test`（16ファイル・214テスト）、`npm run build`、`npm run format:check`、`npm run test:upstream`、`npm run test:steering-runtime`、`git diff --check` が成功。実機試験はBashの実行開始イベントを待ってからテキスト追加・添付送信・停止を行っています。`adrs doctor` はエラー0で、ADR 1の既存warning 1 / info 1は増えていません。

**未実施範囲:** 分離したPaseo daemonと画面からのステアリング操作は未検証です。このCodexセッションのPreToolUseフックがPaseo CLIを禁止し、Paseo MCPにも分離daemonの起動機能がないため実施できませんでした。CLIの呼び替えで制約を回避せず、実ホストと実アダプターを別々に検証しています。利用中daemonへの反映・コミット・公開は行っていません。Linux / Windows / macOS x64実機、アプリ再起動、電源断・ディスク障害も未検証です。

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
