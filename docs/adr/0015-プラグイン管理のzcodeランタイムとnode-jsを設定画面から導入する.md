---
number: 15
title: プラグイン管理のZCodeランタイムとNode.jsを設定画面から導入する
status: accepted
date: 2026-10-06
links:
  - target: 13
    kind: amends
  - target: 8
    kind: amends
  - target: 10
    kind: supersedes
---

# プラグイン管理のZCodeランタイムとNode.jsを設定画面から導入する

## Context and Problem Statement

ADR 13 は統合 CLI 配布物と普通の Node.js 24.14.0+ の導入・更新を利用者に任せ、`PASEO_ZCODE_RUNTIME` と `PASEO_ZCODE_NODE` を必須にした。しかし ZCode は統合 CLI を配布しておらず、利用者は上流ソースのビルドと Node 24 の導入を自分で行う必要があり、導入の難度が高い。

2026-10-06 時点で次を確認した。

- GitHub Release `v3.14.3` の成果物は Desktop の dmg と exe だけである。公式 CDN の Linux 版 deb には Agent の `glm/zcode.cjs`（0.16.9）があるが、stdio Services Server の `zcode-server.cjs` と Node.js はない。
- Desktop が SSH 先へ配置する部品の `manifest-<platform>.json` は CDN で公開され、`server-bundle` と `node-runtime` を列挙するが、各成果物は 404 で取得できない。
- 上流は Apache-2.0 で、依存の大半は permissive license である。統合配布物は `agent/THIRD-PARTY-NOTICES.md` だけを含み、ルートの LICENSE・NOTICE を含まない。
- 統合配布物は `engines: node>=24`、`node:sqlite`、`process.exit` を使う。Paseo のプラグインは Node 22 または Electron の Helper で動くため、同一プロセスでは実行できない。
- npm 11 は依存の install スクリプトを既定で実行しない。Paseo は GitHub と npm の両方から導入できる。
- 利用者環境でのビルドは 1,859 パッケージの取得、Electron 本体の取得、node-pty などのネイティブコンパイル（Python と C/C++ ツールチェーン）を必要とする。

## Decision Drivers

- 利用者が Node 24 や ZCode CLI を自分で用意せずに使い始められる。
- ホストの PATH やグローバル環境を変更しない。
- 取得物を固定ハッシュで検証し、クライアントから取得先を指定させない。
- ダウンロードと実行の前に利用者が内容を確認して明示的に開始する。
- ZCode・Paseo 本体を改変せず、無改変の公式ソースだけを使う。
- 上流と依存のライセンス条件を満たす。

## Considered Options

- 自前 Release の統合 CLI 配布物と公式 Node.js を、設定画面のボタンで取得する。
- 利用者による導入を維持する。
- 公式 Desktop パッケージや CDN 部品から必要なファイルを取り出す。
- 利用者環境で ZCode をソースからビルドする。
- npm のライフサイクルスクリプトや Paseo の `build` 手順で取得する。
- Node を埋め込んだ SEA バイナリを使う、または `zcode.cjs` をプラグインのプロセス内で実行する。

## Decision Outcome

ユーザーの選択に従い、「自前 Release の統合 CLI 配布物と公式 Node.js を、設定画面のボタンで取得する」を採用する。公式の配布物だけでは stdio Server を入手できず、利用者環境のビルドや install スクリプトは前提条件・安全性・確実性で劣るためである。ADR 13 の stdio Server、V4、プロセス所有、保存形式は維持する。

**ZCode ランタイム.** このリポジトリの CI が、公開タグの無改変ソースから公式 `build-zcode.mjs` で統合配布物を作る。上流のルート `LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md` を配布物に追加し、プラグイン本体とは別のタグの GitHub Release として公開する。同じソースから再ビルドしてもバイト単位で一致する保証がないため、公開済みの成果物の URL と SHA-256 をプラグインのソースに固定する。最初の配布は `v3.14.3`（`29628c9`）とする。成果物は ZCode と Z.ai の非公式ビルドであると明示し、上流の商標を製品名として使わない。

**Node.js.** nodejs.org の公式成果物を、固定したバージョンとプラットフォーム別の SHA-256 で取得する。最初の固定は 24.21.0 とし、CI の実行時試験も同じ版を使う。プラグインは Node を再配布しない。

**対象.** darwin-arm64、linux-x64、linux-arm64、win-x64、win-arm64 とする。各ターゲットで固定した成果物の実行時契約試験を CI で行い、失敗したターゲットは提供しない。それ以外の環境は従来どおり環境変数で手動設定する。

**配置.** 各 OS の利用者別データ領域の慣習に従い、Windows は `%LOCALAPPDATA%\paseo-plugin-zcode-provider\runtimes`、macOS と Linux は `~/.local/share/paseo-plugin-zcode-provider/runtimes` に、版とプラットフォームごとのディレクトリで置く。Windows の既定はローミングされない `%LOCALAPPDATA%` とし、ホーム直下に `.local` を作らない。絶対パスの `XDG_DATA_HOME` は全 OS で基点を上書きする明示的な指定として扱い、CI と試験の隔離に使う。XDG の仕様どおり相対パスは無視する。一時領域への取得、ハッシュ照合、展開、起動確認、rename による確定の順に行い、ロックで同時導入を防ぐ。Git checkout の外に置くため、プラグインの更新では再取得しない。PATH には追加せず、Server と Agent を絶対パスで起動する。

**選択.** `PASEO_ZCODE_RUNTIME` と `PASEO_ZCODE_NODE` の両方があれば、従来どおりそれを使う。片方だけの設定はエラーとする。どちらもなければ、プラグインが固定した版の管理下ランタイムを使い、未導入なら設定画面への案内付きのエラーにする。Electron と Desktop へのフォールバックは引き続き行わない。最低版の判定（ADR 7）は環境変数の経路に適用する。

**設定画面.** Settings → Plugins → zcode-provider に導入と削除の操作を加える。導入前に取得元、サイズ、配置先、ライセンスを表示する。RPC は入力に URL、パス、版を受け取らず、サーバー側の固定値だけを使う。導入は開始の RPC で受け付けて即時に返し、状態の RPC で進捗と結果を返す。診断情報の項目と秘匿方針（ADR 8）は維持する。導入後は、管理下の Node で公式 TUI を起動するログイン用コマンドをコピーできる形で表示する。プラグインは認証情報を扱わない。

### Consequences

- Good, because 利用者は Node 24、pnpm、コンパイラ、ZCode CLI を用意せずに導入できる。
- Good, because install スクリプトの有無や導入元（GitHub / npm）に左右されない。
- Good, because クライアントは固定値の取得しか起動できず、取得物はハッシュで検証される。
- Bad, because このリポジトリが ZCode 配布物の再配布者になり、ライセンス表示と上流の未解決の通知（`third-party/inventory.json` の `reviewRequired`）を引き継ぐ。
- Bad, because ZCode のセキュリティ修正を利用者へ届けるには、ランタイムの再公開とプラグインの更新が必要になる。
- Bad, because `paseo plugin remove` は管理下ディレクトリを削除しないため、削除の操作と手順を別に提供する必要がある。

### Confirmation

リリース用ワークフローの成果物に LICENSE、NOTICE、THIRD-PARTY-NOTICES が含まれることを検査する。固定した ZCode 成果物と Node で、対象の 5 ターゲットの `test:stdio-runtime` を CI で実行する。取得、ハッシュ不一致、展開失敗、中断後の再試行、同時実行、環境変数の優先順位、削除をユニット試験で確認する。実 UI で導入、セッション作成、ログイン用コマンドの表示を確認し、結果を [verification](../verification.md) に記録する。

## Pros and Cons of the Options

### 自前 Release の統合 CLI 配布物と公式 Node.js を、設定画面のボタンで取得する

- Good, because CI が成果物を作るため、利用者側にビルド用ツールチェーンが要らない。
- Good, because 取得と実行の開始を利用者が画面で明示的に選べる。
- Bad, because Release の運用とライセンス表示の責任を負う。

### 利用者による導入を維持する

- Good, because 再配布者にならない。
- Bad, because 公式 CLI が配布されていない現状では、利用者が上流をビルドして Node 24 を導入する必要がある。

### 公式 Desktop パッケージや CDN 部品から必要なファイルを取り出す

- Good, because 公式の成果物を利用者が直接取得するため、再配布にならない。
- Bad, because deb には stdio Server がなく、Agent への直接接続は ADR 13 で退けた構成に戻る。CDN 部品は取得できない。

### 利用者環境で ZCode をソースからビルドする

- Good, because 再配布者にならない。
- Bad, because Python と C/C++ ツールチェーンが必要で、多数の依存の install スクリプトが daemon の権限で実行される。時間とディスクも大きく消費する。

### npm のライフサイクルスクリプトや Paseo の `build` 手順で取得する

- Good, because 導入と同時に自動で準備できる。
- Bad, because install スクリプトは npm の設定でスキップされうる。利用者が取得を確認する機会もない。

### Node を埋め込んだ SEA バイナリを使う、または `zcode.cjs` をプラグインのプロセス内で実行する

- Good, because SEA は Node を別途必要としない。
- Bad, because SEA には stdio Server が含まれず、6 ターゲット分の署名と配布が必要になる。プロセス内実行は Node 24 の要件と ZCode のプロセス前提に反する。

## More Information

ADR 13 のうち、導入・更新を利用者に任せる前提と両環境変数の必須化を変更する。ADR 8 の診断項目と秘匿方針を維持し、読み取り専用の制限を変更する。診断専用画面の維持を決めた ADR 10 を置き換える。ZCode が統合 CLI か stdio Server を含む成果物を公式に配布した場合は、公式の成果物を直接取得する方式へ切り替えるかを再評価する。
