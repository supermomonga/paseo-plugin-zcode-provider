---
number: 29
title: リリースPRをGitHub Appのトークンで作り、CIを承認なしで実行する
status: accepted
date: 2026-11-12
links:
  - target: 16
    kind: amends
---

# リリースPRをGitHub Appのトークンで作り、CIを承認なしで実行する

## Context and Problem Statement

ADR 16 は、Version Bump ワークフローが `GITHUB_TOKEN` でリリース PR を作り、`pull_request` の CI が自動では始まらないため、CI を `workflow_dispatch` で起動すると定めた。

2026-11-12 に v0.5.1 のリリース PR（#100）で、この前提が現在の GitHub の挙動と合わないことを確認した。

- GitHub は `GITHUB_TOKEN` で作られた PR に対して `pull_request` の実行を作り、メンテナーの承認待ち（`action_required`）にする。PR の画面には「Some checks are waiting for approval」と表示される。
- `workflow_dispatch` で起動した CI は同じコミットで動くが、その結果は PR のチェック一覧に出ない（コミットにはチェックが 6 件付いていたが、PR の一覧は 0 件だった）。結果は Actions タブで確認するしかない。
- PR の画面で結果を見るには承認が必要で、承認すると同じ CI がもう一度動く。実モデルの E2E（ADR 12）も 2 回分の費用がかかる。v0.5.0 のリリース PR（#96）でも両方の実行が動いていた。

利用者は毎回の承認を無くすことを求め、GitHub App のトークンを使う方法を選んだ（2026-11-12）。あわせて、同じ App をメンテナーの他のリポジトリでも使えるかを尋ねた。

## Decision Drivers

- リリース PR の CI を承認なしで 1 回だけ動かし、結果を PR の画面で確認できるようにする。
- ADR 16 の手順（バージョン更新 PR のマージでタグ付けと公開を行う）と npm の trusted publishing は変えない。
- リポジトリに置く認証情報の権限と、それを使える箇所を最小にする。

## Considered Options

- GitHub App のトークンで PR を作る
- fine-grained PAT で PR を作る
- `GITHUB_TOKEN` のまま、承認せずに `workflow_dispatch` の結果を Actions タブで確認する

## Decision Outcome

Chosen option: "GitHub App のトークンで PR を作る", because 利用者がこの方法を選び（2026-11-12）、PR が個人のアカウントに結び付かず、トークンが実行ごとに発行されて短時間で失効するためである。この決定は ADR 16 の「`GITHUB_TOKEN` で PR を作り、CI を `workflow_dispatch` で起動する」部分を修正する。版の更新方法、Release ワークフロー、npm の認証は変えない。

**App.** メンテナーのアカウントが所有する非公開の GitHub App `supermomonga-release` を使う。リポジトリの権限は Contents と Pull requests の読み書きだけにし、Webhook は使わない。インストール先は選択したリポジトリに限り、すべてのリポジトリには広げない。記録時点のインストール先はこのリポジトリだけである。App の名前は特定のリポジトリに結び付けていないので、メンテナーの他のリポジトリもインストール先に加えて共用できる。Client ID をリポジトリの変数 `RELEASE_APP_CLIENT_ID` に、秘密鍵を secret `RELEASE_APP_PRIVATE_KEY` に置く。

**ワークフロー.** Version Bump は `actions/create-github-app-token`（コミット SHA で固定）でインストールトークンを発行し、`peter-evans/create-pull-request` に渡す。トークンの権限は `permission-contents: write` と `permission-pull-requests: write` に絞る。`owner` と `repositories` は指定しないので、トークンは実行中のリポジトリだけに効く。ジョブの `GITHUB_TOKEN` は `contents: read` だけにし、`gh workflow run ci.yml` のステップは削除する。CI は App が開いた PR の `pull_request` で動く。

### Consequences

- Good, because リリース PR の CI が承認なしで 1 回だけ動き、結果が PR のチェック一覧に出る。
- Good, because 実モデルの E2E が二重に動かない。
- Good, because Version Bump の `GITHUB_TOKEN` から書き込み権限が無くなり、GitHub Actions に PR の作成を許可するリポジトリ設定にも依存しなくなる。
- Bad, because 長期間有効な秘密鍵をリポジトリの secret に置く。漏れると、App の権限の範囲で、インストール先のすべてのリポジトリのブランチと PR を書き換えられる。App を共用するとこの範囲が広がる。
- Bad, because App の作成、インストール、鍵の更新という手作業の管理対象が増える。
- Bad, because コミット SHA で固定して更新に追従するアクションが 1 つ増える（GitHub 公式の `actions/create-github-app-token`）。
- Neutral, because リリース PR の作成者が `github-actions[bot]` から App の bot に変わる。

### Confirmation

2026-11-12 に App を作成し、変数と secret を登録した。秘密鍵で App として認証し、インストール先がこのリポジトリだけであること、権限が Contents と Pull requests の書き込みと Metadata の読み取りであること、Webhook が設定されていないことを API で確認した。

Version Bump を実行して、リリース PR の `pull_request` の CI が承認待ちにならずに始まること、PR のチェック一覧に結果が出ること、`workflow_dispatch` の CI が起動されないことを確認する。この確認は変更を `main` に入れたあとに行うもので、この ADR の記録時点では未実施である。

## Pros and Cons of the Options

### GitHub App のトークンで PR を作る

- Good, because トークンは実行ごとに発行され、ジョブの終了時に失効する。
- Good, because 権限をリポジトリと 2 種類の権限に限定できる。
- Bad, because App の作成と秘密鍵の管理が必要になる。

### fine-grained PAT で PR を作る

- Good, because 設定が secret 1 つで済む。
- Bad, because PR がメンテナー個人の名義になり、トークンに有効期限の更新が必要になる。
- Bad, because 有効期間中ずっと使えるトークンそのものを secret に置く。

### `GITHUB_TOKEN` のまま、承認せずに `workflow_dispatch` の結果を Actions タブで確認する

- Good, because 追加の認証情報が要らない。
- Bad, because PR の画面に承認待ちの表示が残り、CI の結果が PR から分からない。
- Bad, because 誤って承認すると CI と E2E が二重に動く。
