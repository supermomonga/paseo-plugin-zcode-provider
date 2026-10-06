---
number: 16
title: プラグインをnpmで配布しバージョン更新PRのマージでtrusted publishingにより公開する
status: accepted
date: 2026-10-06
---

# プラグインをnpmで配布しバージョン更新PRのマージでtrusted publishingにより公開する

## Context and Problem Statement

これまでプラグインは Git リポジトリからだけ導入でき、利用者は `main` の最新コミットを取得していた。Paseo は 0.9.0-beta.1 から npm パッケージをプラグインの導入元として扱う（`npm:<name>[@<version>]`）。版を区切って配布するため npm で公開したいが、手作業の公開はメンテナーの端末、npm のログインと二要素認証に依存し、タグや GitHub Release との対応もずれやすい。

2026-10-06 時点で Paseo（`7c1958f5`、upstream `main`）の実装と公開ガイドを確認した。

- Paseo は npm パッケージを `npm install` に `--ignore-scripts` と `--omit=dev` を付けて取得する。ライフサイクルスクリプトは実行されず、devDependencies も入らない。
- 取得したパッケージでも manifest の `build` を実行する。npm パッケージには `package-lock.json` が入らないため、Git 用の `["npm", "ci", "--include=dev"]` は失敗する。公開ガイドは、Git 専用の依存導入コマンドを公開する manifest から除くよう求めている。
- サーバーバンドルでは `@getpaseo/plugin/*` と `zod` だけが Paseo から供給される。サーバーが実行時に使う `semver` は devDependencies にあった。
- `server/build-info.ts` は `prepare` が生成する Git 管理外のファイルである。
- npm の trusted publisher は既存パッケージにしか設定できない。2026-09-03 以降に作成した設定は `npm stage publish` だけを既定で許可するため、`npm publish` を明示的に許可する必要がある。

## Decision Drivers

- 公開する版を CI とレビューを通した変更として扱い、タグ、GitHub Release、npm の版を同じコミットから作る。
- リポジトリに長期間有効な npm トークンを置かない。
- メンテナーの他のプロジェクト（`supermomonga/shadcnui-hono-jsx` の ADR 0032）と同じ手順にする。
- Git からの導入を引き続き使えるようにする。
- npm から導入したプラグインが Paseo の取得条件（スクリプトなし、devDependencies なし、lockfile なし）で動作する。

## Considered Options

- バージョン更新 PR を作り、マージ時にタグ付けと npm 公開を行う
- タグの push で公開する
- 手作業で公開する

## Decision Outcome

ユーザーの依頼に従い、「バージョン更新 PR を作り、マージ時にタグ付けと npm 公開を行う」を採用する。公開する版が必ず CI とレビューを通り、ローカルの認証情報を必要としないためである。

**手順.** Version Bump ワークフロー（`workflow_dispatch`、patch / minor / major または `MAJOR.MINOR.PATCH` の明示版）が `npm version` で `package.json` と `package-lock.json` を更新し、`release/v<version>` の PR を作って CI を `workflow_dispatch` で起動する。`GITHUB_TOKEN` で作った PR では `pull_request` の CI が自動では始まらないためである。Release ワークフローは `main` への push ごとに動き、`package.json` の版が直前のコミットから変わったときだけ `salsify/action-detect-and-tag-new-version` で `v<version>` タグを作り、`npm publish` と、生成したノート付きの GitHub Release の作成を行う。参考の構成は `supermomonga/action-bump-cli` で `package.json` だけを更新するが、npm プロジェクトでは `package-lock.json` にも版が入るため `npm version` を使う。プレリリース版は npm 11 で `--tag` が必要になるため、明示版は `MAJOR.MINOR.PATCH` に限る。ZCode ランタイムの `zcode-runtime-v<version>` タグ（ADR 15）とはタグ名で区別する。

**認証.** npm の trusted publishing（OIDC、`id-token: write`）で公開し、provenance を付ける。trusted publisher は `supermomonga/paseo-plugin-zcode-provider` の `release.yml` とし、`npm publish` を許可する。最初の版は既存パッケージにしか trusted publisher を設定できないため手作業で公開し、タグと GitHub Release も手作業で作る。

**パッケージ.** `files` で Paseo が読む manifest、エントリ、`client/`・`server/`・`shared/`（試験を除く）、`icon.svg`、ライセンスと通知（`NOTICE.md`、`vendor/` の LICENSE）を公開する。実行時に使う `semver` は `dependencies` に移す。`prepack` は公開する `paseo-plugin.json` から `build` を除き、`postpack` で元に戻す。Git からの導入は従来どおり `build` で `npm ci --include=dev` を実行する。`server/build-info.ts` は `npm pack` 中の `prepare` が生成してパッケージに含める。

### Consequences

- Good, because 公開に npm トークンもローカルのログインも要らず、各版に provenance が付く。
- Good, because タグ、GitHub Release、npm の版が同じコミットから作られる。
- Good, because 利用者は版を指定して導入・更新でき、Git からの導入も残る。
- Bad, because タグ付け後に公開が失敗した場合は、手作業の `npm publish` か次のパッチ版が必要になる。ワークフローは版の変更にしか反応しない。
- Bad, because 公開する manifest がリポジトリの manifest と異なる。`npm pack` が中断されると作業ツリーに書き換え後の manifest と `paseo-plugin.json.git` が残る。
- Bad, because サードパーティのアクションを 2 つ追加する（コミット SHA で固定する）。
- Neutral, because 版を変えない `main` への push でも、何もしない短いジョブが動く。

### Confirmation

`npm run test:upstream` が作業ツリーのコピーを `npm pack` し、Paseo の npm 取得と同じオプションで別ディレクトリに導入する。そのうえで Paseo の manifest 読み込み、`build` の実行、コンパイラ、Provider アイコンの検証を通し、サーバーとクライアントの登録を確認する。`prepack` で `build` を除かない状態では `npm ci` が lockfile なしで失敗することを確認した。リリース PR では CI が必須の検査として動き、npm の各版には provenance が表示される。

## Pros and Cons of the Options

### バージョン更新 PR を作り、マージ時にタグ付けと npm 公開を行う

- Good, because 版の変更が CI とレビューを通ってから公開される。
- Bad, because ワークフローが 2 つ増え、サードパーティのアクションに依存する。

### タグの push で公開する

- Good, because ワークフローが 1 つで済む。
- Bad, because ローカルの clone からタグを push するため、版の変更に CI が動かず、タグと `package.json` の版が食い違いうる。

### 手作業で公開する

- Good, because ワークフローが要らない。
- Bad, because メンテナーの端末と二要素認証に依存し、タグ付けが別の手順になる。

## More Information

公開する manifest の扱いでは、次の案も検討した。

- `build` に、lockfile があるときだけ `npm ci` を実行するスクリプトを置き、Git と npm で同じ manifest を使う。npm 経由の導入でも余分なプロセスが動き、Git 専用の処理を公開パッケージに含めることになる。Paseo の公開ガイドとも異なる。
- Git からの導入をやめ、`build` を削除する。`build-info.ts` を Git に含めるか生成方法を変える必要があり、`main` を追う導入手段がなくなる。
- 公開用のパッケージを別ディレクトリで組み立てる。リポジトリで `npm pack` した内容と公開する内容が一致しなくなる。

npmjs.com のパッケージ設定、または `npm trust github paseo-plugin-zcode-provider --file release.yml --repo supermomonga/paseo-plugin-zcode-provider --allow-publish` で trusted publisher を設定する。その後、公開には二要素認証を必須にし、トークンを禁止できる。手順は [development](../development.md#plugin-releases) に記載する。
