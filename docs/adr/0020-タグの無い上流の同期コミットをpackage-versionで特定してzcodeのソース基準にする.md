---
number: 20
title: タグの無い上流の同期コミットをpackage versionで特定してZCodeのソース基準にする
status: accepted
date: 2026-10-21
links:
  - target: 15
    kind: amends
---

# タグの無い上流の同期コミットをpackage versionで特定してZCodeのソース基準にする

## Context and Problem Statement

ADR 15 は、管理下ランタイムを「公開タグの無改変ソース」から作ると定めた（ADR 19 でパッチを許可）。上流 `zai-org/ZCode` のタグは `v3.14.3` と `v3.15.1` だけで、その後は `main` に `chore: sync ZCode source` という題のコミットが積まれている。2026-10-21 時点で、`0a1fc56` のルート `package.json` は 3.16.1、`3c5b227649371507ddc4eb46ac5133afe6db1cab` は 3.16.2 で、どちらにもタグや GitHub Release は無い。公式変更履歴は 3.16.2 を公開済みである。

3.16.2 は、プロバイダの更新を急ぐ理由を含む。設定の書き込みに CAS が必須になり、旧来の呼び方では Account タブのサインイン完了が失敗する。また、Desktop と共有する `~/.zcode` の保存領域を起動時に移行する。Desktop だけが新しい版へ進むと、共有データの版が管理下ランタイムとずれる。タグを待つ限り、上流が再びタグを付けるまで管理下ランタイムを更新できない。

## Decision Drivers

- 公式変更履歴の版と、ビルドに使うソースの対応を、後から第三者が検証できる形で記録する。
- ソースの版、リリースの版、成果物の同一性を、別々の事実として扱う（開発ガイドの方針）。
- 上流のタグの付け方が変わっても、Desktop との版のずれを長く放置しない。
- 由来の分からないソースや、版の文字列だけを書き換えた成果物を配布しない。

## Considered Options

- 上流がタグを付けるまで、ソース基準と管理下ランタイムを据え置く。
- 公開 `main` 上の同期コミットのうち、ルート `package.json` の版が変更履歴の版と一致するものを、SHA で固定して基準にする。
- その時点の `main` の先頭を、版にかかわらず基準にする。

## Decision Outcome

Chosen option: "公開 `main` 上の同期コミットのうち、ルート `package.json` の版が変更履歴の版と一致するものを、SHA で固定して基準にする", because 利用者がこの方針を承認し（2026-10-21）、変更履歴の版と対応が取れるソースで更新を続けられるのはこの方法だけである。ADR 15 の「公開タグ」を、次の条件を満たすコミットにも広げる。パッチ（ADR 19）、取得元、ハッシュの固定、配置、設定画面からの導入は変えない。

**採用の条件.** 次をすべて満たすコミットだけを採用する。

- 確認の時点で `git ls-remote https://github.com/zai-org/ZCode.git` の `main`（またはタグ）から到達できる。
- ルート `package.json` の `version` が、公式変更履歴に載った版と完全に一致する。プレリリースは対象にしない。
- 同じ版を持つコミットが `main` 上に複数ある場合は、採用せずに理由を調べる。

**記録.** コミットの SHA を `server/discovery/manifest.ts` と `scripts/sync-zcode-source.mjs` に固定し、CI はその SHA を取得する。検証記録には、`ls-remote` の結果、直前の同期コミットとその版、タグが無いことを残す。版の文字列から SHA を推測しない。

**タグが後から付いた場合.** 同じ版のタグが別のコミットを指したときは、差分を確認する。違いがあれば、`-paseo.<n>` の番号を上げた新しいランタイムとして扱う。公開済みのリリースは差し替えない。

### Consequences

- Good, because 上流がタグを付けなくなっても、変更履歴の版に合わせて管理下ランタイムを更新できる。
- Good, because SHA と `package.json` の版、リリースの `BUILD-INFO.json` から、どのソースで作ったかを誰でも確かめられる。
- Bad, because 同期コミットが Desktop の出荷物と同じソースであるという上流の表明は無い。版の一致は状況証拠にとどまる。
- Bad, because 上流が `main` を書き換えると、固定した SHA を GitHub から取得できなくなる可能性がある。その場合は CI の checkout が失敗し、公開済みの成果物はそのまま残る。

### Confirmation

採用の時点で、`git ls-remote` と `git show <SHA>:package.json` の結果を検証記録に残す。リリース用ワークフローは、ソースの `package.json` の版とタグの版が一致しないとパッケージ作成を拒む（`scripts/package-zcode-runtime.mjs`）。`npm run check:zcode-source` と `npm run check:zcode-patches` は固定した SHA のソースに対して実行する。

## Pros and Cons of the Options

### 上流がタグを付けるまで据え置く

- Good, because ADR 15 の条件をそのまま守れる。
- Bad, because 3.16.2 のサインインの変更や共有データの移行に追従できず、上流がタグを付ける見込みも分からない。

### 版が一致する同期コミットを SHA で固定する

- Good, because 変更履歴の版との対応を、公開された情報だけで確かめられる。
- Bad, because 上流の表明が無く、版の一致に頼る。

### `main` の先頭を版にかかわらず使う

- Good, because 常に最新のソースを使える。
- Bad, because 変更履歴のどの版にも対応しないソースを配布しうる。リリース名に付ける版も決められない。

## More Information

2026-10-21 の確認：`git ls-remote` で `main` = `3c5b227`、タグは `v3.14.3`（`29628c9`）と `v3.15.1`（`aac4755`）だけ。`3c5b227` の親 `0a1fc56` が 3.16.1、その親 `aac4755` が 3.15.1。3.14.4、3.14.5、3.15.3 に対応するソースは公開されていない。上流が再びタグや GitHub Release を付けるようになったら、タグを基準とする運用に戻すかを見直す。詳細は[検証記録](../verification.md)を参照する。
