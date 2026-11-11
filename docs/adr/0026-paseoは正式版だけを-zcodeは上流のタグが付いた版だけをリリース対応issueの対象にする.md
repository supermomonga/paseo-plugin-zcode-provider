---
number: 26
title: Paseoは正式版だけを、ZCodeは上流のタグが付いた版だけをリリース対応Issueの対象にする
status: accepted
date: 2026-11-11
links:
  - target: 4
    kind: amends
---

# Paseoは正式版だけを、ZCodeは上流のタグが付いた版だけをリリース対応Issueの対象にする

## Context and Problem Statement

ADR 4 は、公式変更履歴に載った対応バージョンより新しい版ごとに、リリース対応 Issue を自動で作ると定めた。Paseo はベータ・RC・正式版を区別してすべて通知し、ZCode は変更履歴だけを見ていた。2026-11-11 に利用者が二つの変更を求めた。

- **Paseo.** ベータ版を対象外にする。これまでベータ版ごとに Issue が作られてきた（0.12.0-beta.1〜3、0.13.0-beta.1〜2、0.14.0-beta.1〜2、0.15.0-beta.1 など。0.16.0-beta.1 の #99 は未対応のまま開いている）。
- **ZCode.** 変更履歴に載っていても、上流 `zai-org/ZCode` にその版のタグが無ければ Issue を作らない。利用者の説明では、上流の公開リポジトリは Z.ai の社員が社内リポジトリの変更をまとめて手で反映しており、反映し忘れやタグ付けの遅れがある。そのため、変更履歴の最新版と、実際に入手できる OSS 版のソースが一致しないことがある。

2026-11-11 時点の上流のタグは `v3.14.3`、`v3.15.1`、`v3.17.1`、`v3.17.2` で、GitHub Release は `v3.14.3`、`v3.17.1`、`v3.17.2` にある。変更履歴の 1 ページ目は 3.17.2、3.16.3、3.16.2、3.15.3、3.15.1、3.14.5、3.14.4、3.14.3 で、3.16.3 などにはタグが無い。

## Decision Drivers

- 対応作業はソースが入手できる版から始める（ADR 15、ADR 19 のビルドとパッチは上流のソースを前提にする）。
- 対応しない版の Issue を作らない。
- ADR 4 の重複防止、再実行、失敗時にワークフローを失敗させる方針はそのまま守る。
- dry-run は GitHub の認証情報なしで動かせるままにする。

## Considered Options

- Paseo: 正式版だけを対象にする。
- Paseo: ベータ・RC・正式版をすべて対象にする（現状）。
- ZCode: 変更履歴に載り、上流に `v<version>` タグがある版だけを対象にする。
- ZCode: 変更履歴に載り、GitHub Release がある版だけを対象にする。
- ZCode: 変更履歴だけを見る（現状）。

## Decision Outcome

Chosen option: "Paseo: 正式版だけを対象にする" と "ZCode: 変更履歴に載り、上流に `v<version>` タグがある版だけを対象にする", because 利用者がこの方針を求め（2026-11-11）、ソースを入手できる版だけを対応の起点にできる。この決定は ADR 4 の「ベータ・RC・正式版を区別してすべて通知する」と「変更履歴だけで新リリースを判定する」部分を修正する。比較の基準（Paseo は SDK の依存バージョン、ZCode は `LAST_REVIEWED_ZCODE_RELEASE`）、Issue のタイトルとマーカーによる重複防止、失敗時の扱いは変えない。

**Paseo.** 変更履歴から SemVer のプレリリース（`-beta.N` や `-rc.N` など）を除いてから、基準より新しい版を選ぶ。基準がベータ版のとき、その正式版は引き続き通知する。

**ZCode.** 変更履歴から基準より新しい版を選び、その版があるときだけ `git ls-remote --tags --refs https://github.com/zai-org/ZCode.git` でタグを取得する。`v` に SemVer の版が完全一致で続くタグだけを数える。タグがあれば GitHub Release が無くても対象にする（`v3.15.1` はタグだけがある）。タグの無い版は Issue を作らず、`Waiting for ZCode <version>: tag v<version> is not on https://github.com/zai-org/ZCode yet` をログに残す。次の定期実行でタグが見つかれば Issue を作る。タグが無い古い版があっても、タグのある新しい版の Issue は作る。Issue の本文には `Source: https://github.com/zai-org/ZCode/tree/v<version>` を加える。タグの取得に失敗したときはワークフローを失敗させ、Issue を作らない。`git` は認証情報を求めない設定（`GIT_TERMINAL_PROMPT=0`）で動かし、公開リポジトリだけを読む。

ADR 20 のソース基準の採用条件は変えない。ADR 20 は 2026-11-09 の見直しで、版が一致するタグがあればタグを使い、タグの無い同期コミットを採る手順はタグが付かない版のために残すとした。タグの無い版にその手順で対応する場合は、Issue を待たずに保守者が判断する。

### Consequences

- Good, because ソースが手に入らない版の Issue が作られず、対応に着手できる状態の版だけが Issue になる。
- Good, because Paseo のベータ版ごとの Issue が無くなり、正式版の対応に集中できる。
- Good, because タグの確認に GitHub API や認証情報を使わず、dry-run も今までどおり動く。
- Bad, because 上流がある版にタグを付けないままだと、その版の Issue は作られない。待機中のログは成功したワークフローの中にしか残らない。
- Bad, because 上流がタグの名前を `v<version>` 以外に変えると、すべての版が待機中のままになる。
- Bad, because Paseo のベータ版で互換性が壊れても、正式版の公開まで Issue では気付けない。

### Confirmation

Vitest で、Paseo のプレリリースの除外、基準がベータ版のときの正式版の通知、`git ls-remote` の出力の解析と不正な出力の拒否、タグの無い版の待機と後からタグが付いたときの作成、タグの取得失敗、dry-run を検証する。実サイトでは dry-run で、Paseo 0.16.0-beta.1 が候補から外れること（基準は 0.15.3）と、ZCode 3.16.3 が待機、3.17.2 が `Source` 付きの候補になること（基準を 3.17.2 へ上げる前の 3.16.2）を確認した。

## Pros and Cons of the Options

### Paseo: 正式版だけを対象にする

- Good, because 対応する予定の無いベータ版の Issue が作られない。
- Bad, because ベータ版での変更を前もって知る手段が Issue からは無くなる。

### Paseo: ベータ・RC・正式版をすべて対象にする（現状）

- Good, because 互換性の問題に早く気付ける。
- Bad, because 対応しないベータ版の Issue が積み上がる。

### ZCode: 変更履歴に載り、上流に `v<version>` タグがある版だけを対象にする

- Good, because ソースが入手できることを、タグという固定された参照で確かめられる。
- Good, because タグだけがあり GitHub Release の無い版（`v3.15.1`）も対象にできる。
- Bad, because タグ付けを忘れた版は対象にならない。

### ZCode: 変更履歴に載り、GitHub Release がある版だけを対象にする

- Good, because 上流が公開を明示した版だけに絞れる。
- Bad, because タグがありソースを入手できても、Release が無い版（`v3.15.1`）を見落とす。

### ZCode: 変更履歴だけを見る（現状）

- Good, because 上流のタグ付けの遅れに左右されない。
- Bad, because ソースが公開されていない版の Issue が作られ、対応に着手できない。

## More Information

上流のタグ付けの運用が変わった場合（タグの名前の変更、タグの付与の停止）や、Paseo のベータ版への対応が必要になった場合に見直す。
