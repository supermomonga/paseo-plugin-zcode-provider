---
number: 30
title: Paseo 0.16を最低要件にし、Planを入力欄のコントロールで報告して、ゴールの変化をsubscriptionで送る
status: accepted
date: 2026-11-20
links:
  - target: 11
    kind: amends
  - target: 14
    kind: amends
  - target: 25
    kind: amends
  - target: 27
    kind: amends
---

# Paseo 0.16を最低要件にし、Planを入力欄のコントロールで報告して、ゴールの変化をsubscriptionで送る

## Context and Problem Statement

Paseo 0.16.0〜0.16.2（Issue #105〜#107）で、プラグインの API に次の変更が入った。0.16.1 と 0.16.2 は、プラグインの API を変えていない。

- **入力欄のオプション**：プロバイダーは、入力欄に出すオプションを `ProviderConfigState.controls`（`toggle`・`select`。ラベル、説明、Lucide のアイコン、既定値を持つ）で、今の値を `providerOptions` で報告するようになった（getpaseo/paseo#8744）。これまでの `settings` は非推奨になった。daemon は、`settings` を報告するプロバイダーを `plugin-provider-options.ts` で読み替え、値の変更を `changes.providerOptions` と `changes.settings` の両方で送る。この互換処理は 2027-05-01 以降に削除される。読み替えでは、アイコンと既定値が失われる。`session.open` には、0.16 から、エージェントのオプション（`config.json` のプロバイダーの既定値を含む）が `providerOptions` で届き、非推奨の `settings` にも同じ値が入る（Issue #108）。値の変更では、`null` がプロバイダーの既定値に戻す意味になった。
- **subscription**：`defineSubscription` と `server.handle` で、プラグインのサーバーからクライアントへイベントを送れるようになった（getpaseo/paseo#8527）。クライアントは `client.subscribe` か `useSubscription` で受け取り、再接続の後は Paseo が購読し直す。
- **設定画面**：Settings → Plugins の歯車から開き、`addSettingsScreen` の画面ごとにホストがタブを出す（getpaseo/paseo#8675）。

プラグインには、0.16 を最低要件にしてから行うと決めていた作業が二つ残っていた。`session.open` で `settings` を読むのをやめること（Issue #108 の修正）と、Goal のピルの 10 秒ごとの読み出しを通知に置き換えること（ADR 27 の見直しの条件）である。ADR 27 のピルは、ZCode のエージェントが Paseo で更新されたときと、進行中のゴールがある間の 10 秒ごとに RPC `zcode.goals` を読み、開いたポップオーバーは 3 秒ごとに読んでいた。題（`summaryTitle`）の変化のように、Paseo から見えないゴールの変化は、最大でその間隔だけ遅れて出ていた。

ユーザーは、最低要件を 0.16.0 に上げることを認めた。0.16.0 の公開は 2026-11-16 である。

## Decision Drivers

- 非推奨の API と、2027-05-01 以降に無くなる互換処理に依存しない。
- Plan を、Paseo の組み込みのプロバイダー（Codex の `plan_mode`）と同じ見た目と操作で出す。
- ゴールの変化を、間隔に依存せず、変化したときだけ送る。
- ADR 14 の復元の保証（Paseo が保存した mode と Plan を再び適用する）を保つ。
- 対応しない Paseo のための分岐を持たない。

## Considered Options

- 最低要件を 0.16.0 に上げ、Plan を `controls` と `providerOptions` だけで報告し、ゴールを subscription で送る。
- 最低要件を 0.15.0 のままにし、Plan を `settings` と `controls` の両方で報告する。ゴールの読み出しは残す。
- 何も変えず、`settings` の互換処理が削除されるまで待つ。

## Decision Outcome

Chosen option: "最低要件を 0.16.0 に上げ、Plan を `controls` と `providerOptions` だけで報告し、ゴールを subscription で送る", because 非推奨の API への依存と一定間隔の読み出しを、分岐を増やさずに同時に無くせる唯一の選択肢だからである。

### 最低要件

- `paseo-plugin.json` の最低要件を `>=0.16.0` に上げる。開発 SDK は 0.16.2、CI の上流チェックアウトは v0.16.2（`2ee30f4`）とする。

### Plan

- `session.config` で、Plan を `controls` の `toggle`（キー `plan_mode`、ラベル `Plan`、既定値 `false`）として報告し、今の値を `providerOptions.plan_mode` で報告する。`settings` は報告しない。ラベルとアイコンは、Paseo の Codex プロバイダーの `plan_mode` と同じにした（`server/session.ts` の `PLAN_CONTROL`）。
- `session.open` は `config.providerOptions` だけを読む。`settings` には同じ値が入るので読まない。知らないキーと、真偽値でない値は、これまでどおり `INVALID_CONFIGURATION` にする。新しいセッションで値が無いときは Plan をオフにし、再開で値が無いときは ZCode の状態を使う（ADR 11）。
- `session.configure` は `changes.providerOptions` だけを読む。`plan_mode: null` は、プロバイダーの既定値である Plan オフにする。
- ADR 14 の復元の保証の条件は、Paseo が保存した `mode` と `providerOptions.plan_mode` の両方を渡すこと、と読み替える。daemon は、保存した値を `providerOptions` で渡す。

### ゴールの通知

- RPC `zcode.goals` を、同じ名前空間の subscription `zcode.goals.watch` に置き換える。イベントは、これまでの RPC の応答と同じく、`GoalView` の配列を `goals` に持つ。
- サーバーは、購読の開始時に今のゴールを送り、その後は、開いているセッションの V4 の `goal` が変わったときと、セッションの登録と削除のときに送る。経過秒は daemon の時計で、送るときに計算する。同じ時点の変化はまとめて一度だけ送る。
- クライアントのピルは、エージェントの一覧の購読でワークスペースを知り、ゴールは subscription のイベントだけから出す。一定間隔の読み出しをやめる。ラベルの経過時間は、これまでどおりクライアントの時計で進める。ポップオーバーは `useSubscription` で同じイベントを受ける。
- 購読がエラーで閉じたときは、少し待ってから購読し直す。

### 設定画面

- ホストが画面ごとにタブを出すので、自前の入れ子のタブをやめ、Runtime・Account・Timeline・Diagnostics の四つの設定画面として登録する。`paseo-plugin.json` に `name` と `description` を加え、見出しにプラグインの ID ではなく名前を出す。

### Consequences

- Good, because Plan がアイコンと説明付きで入力欄に出て、New workspace の画面にも出る。2027-05-01 以降の互換処理の削除の影響を受けない。
- Good, because ゴールの変化が、間隔の遅れなく、変化したときだけ届く。進行中のゴールがある間の定期的な RPC が無くなる。
- Good, because `session.open` の `settings` と `providerOptions` のマージ（Issue #108 の修正）が無くなり、オプションの読み方が一つになる。
- Bad, because Paseo 0.15 の利用者は、新しい版を導入できない。
- Bad, because ゴールの通知は、セッションが開いているエージェントにしか出ない。ADR 27 と同じく、アイドル時に解放された後と daemon の再起動の後は、開き直すまでピルが出ない。
- Neutral, because subscription は、プラグインのサーバーが動いている間だけ通知できる。プラグインが止まった後の購読し直しは、Paseo の再接続とクライアントの再試行に頼る。

### Confirmation

- `test/model-catalog.test.ts` で、Plan が `controls` と `providerOptions` で報告されること、`providerOptions` での作成・再開・変更、`null` でのオフ、非推奨の `settings` だけでは Plan が変わらないことを確認する。
- `test/goal-pills.test.ts` と `server/goal.test.ts` で、購読の開始時と変化時の通知、まとめての送信、ピルの登録と更新と削除、購読し直しを確認する。
- `npm run test:upstream`（v0.16.2）で、0.15.4 の daemon が最低要件で拒否すること、実アダプターの `controls` に Plan が出ること、`applyOptions` で Plan が切り替わること、実コンパイラでビルドしたクライアントの入口が購読を始めて片付けることを確認する。
- `npm run test:stdio-runtime` で、Plan を `providerOptions` で渡す復元を実ランタイムで確認する。

## Pros and Cons of the Options

### 最低要件を 0.16.0 に上げ、Plan を `controls` と `providerOptions` だけで報告し、ゴールを subscription で送る

- Good, because 非推奨の API と一定間隔の読み出しを同時に無くせる。
- Good, because 0.16 の API だけを使うので、互換の分岐が要らない。
- Bad, because 0.15 の利用者は更新できない。

### 最低要件を 0.15.0 のままにし、Plan を `settings` と `controls` の両方で報告する

- Good, because 0.15 の利用者も更新できる。
- Bad, because 0.15 の daemon は `settings` を必須とし、0.16 の daemon は `controls` があれば `settings` を読まない。両方を報告し、値の変更も `changes.settings` と `changes.providerOptions` の両方を読む分岐が要る。
- Bad, because subscription が無いので、ゴールの読み出しが残る。

### 何も変えない

- Good, because 作業が要らない。
- Bad, because Plan にアイコンも既定値も出ず、2027-05-01 以降に互換処理が削除されると Plan が出なくなる。
- Bad, because ゴールの読み出しの遅れと通信が残る。

## More Information

- ADR 25 の最低要件（0.15.0）を 0.16.0 に上げる。ADR 25 のアイドル時の解放の判断は変えない。
- ADR 27 の「状態の読み出し」と「ピル」の読む契機を、この ADR の通知に置き換える。コマンドの扱いと表示の内容は変えない。
- ADR 11 と ADR 14 の `settings.plan_mode` を `providerOptions.plan_mode` に読み替える。
- 検証の記録は [verification.md](../verification.md) にある。
