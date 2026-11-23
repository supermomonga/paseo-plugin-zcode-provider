---
number: 36
title: ZCodeが記録するターンとセッションの値をPaseoの統計として報告する
status: accepted
date: 2026-11-23
---

# ZCodeが記録するターンとセッションの値をPaseoの統計として報告する

## Context and Problem Statement

Paseo 0.17.2 は、ターンとセッションの統計を出す（getpaseo/paseo#10496）。Provider は、完了したターンの `session.turn` に `metrics`（ラベルと値の行）を付け、セッションの値を `session.metrics` で送る。`session.metrics` は、能力 `session.metrics` を取り決めた時だけ送れる。取り決めていない Paseo は、この知らない種類のイベントで接続を閉じる。ターンの `metrics` は既存のイベントの項目なので、古い Paseo は捨てるだけである。

完了したターンに `Model` の行が無いと、Paseo はエージェントのモデルの ID を `Model` として付ける。このプラグインのモデルの ID は、ZCode のプロバイダーとモデルを JSON で符号化したもの（`["zai","GLM-5.1",null]` など、`mapping.ts` の `encodeModel`）なので、何も報告しないと、すべての ZCode のターンにこの文字列が出る。

ZCode の V4 は、プロダクトのターンごとに `turnHeader` の行を持つ。開始と終了の時刻、承認や回答の待ちを除いた作業の時間（`activeMs`、Desktop の「Worked for」）、モデルの時間、ツールの時間、主の会話の出力トークン、ファイルの変更を、ZCode 自身が記録する（`packages/shared/src/zcode-protocol-v4/rows.ts`）。セッションの `usage` は、主の会話の入力・出力・キャッシュの読み書きのトークンの累計と、直近の要求のキャッシュの命中率（`contextWindow.cache.latestHitRate`、キャッシュの読み込み÷入力）を持つ。ZCode の入力トークンは、キャッシュから読んだ分を含む（`turn-model-step-usage.ts`）。

## Decision Drivers

- ZCode のターンに、符号化したモデルの ID が出ないこと。
- 値は ZCode が記録したものを使い、プラグインが推し量った値を出さない。
- 同じ量は、Paseo のほかの Provider と同じ書き方で読めること。

## Considered Options

- ZCode の `turnHeader` とセッションの `usage` から統計を作る。
- `Model` の行だけを報告する。
- セッションの累計の差分から、ターンごとの入力とキャッシュも作る。

## Decision Outcome

Chosen option: "ZCode の `turnHeader` とセッションの `usage` から統計を作る", because ZCode が記録した値だけで、モデルの名前と主な時間とトークンを出せるからである。

- **ターン**：Paseo の一つのターン（ゴールの継続や、バックグラウンドの結果で続いた ZCode のターンを含む）の `turnHeader` をまとめ、完了した時だけ次の行を付ける。
  - `Model`：モデル（Paseo のモデルの選択に出る名前）と思考の段階（`GLM-5.1 (high)`）。
  - `Speed`：出力トークン÷モデルの時間（0.1 秒以上の時だけ）。
  - `Elapsed`：最初の開始から最後の終了まで。`Worked`：ZCode の作業の時間。待ちがあって `Elapsed` より短い時だけ出す（ZCode は作業の時間を開始と終了とは別の出来事から測るので、待ちが無いと `Elapsed` と同じか少し長くなる）。
  - `Model time`、`Tool time`（0 より大きい時）、`Output tokens`。
  - `Files changed`：取り消していない変更のファイル数と、追加と削除の行数。
  - どれかのターンに値が無い量は、合計を出さない（一部だけの合計を出さない）。
- **セッション**：`Tokens`（入力の累計 ↑ · 出力の累計 ↓。入力はキャッシュの分を含む）と、`Cache (last reply)`（直近の要求の命中率。50% 以上で `ok` の色）。値が変わった時だけ、`session.metrics` を取り決めた時だけ送る。
- 書き方は Paseo の `providers/metrics.ts`（v0.17.3）に合わせる（`12.3s`、`2m 5s`、`12.3K`、`~45 tok/s`、`1.2K ↑ · 340 ↓`）。

### Consequences

- Good, because ZCode のターンに、モデルの名前と思考の段階が出る。
- Good, because 承認の待ちを除いた作業の時間や、ファイルの変更など、Desktop と同じ ZCode の値が Paseo で見える。
- Bad, because ターンごとの入力トークンとキャッシュの命中率は出ない。`turnHeader` に無く、累計の差分は、プラグインが見ていない間の要求（ほかのクライアントや Desktop からの入力）を区別できない。
- Bad, because ZCode の入力トークンはキャッシュの分を含むので、キャッシュの分を除いて数える Provider（Pi など）の `Tokens` とは同じ意味ではない。
- Neutral, because 開き直した履歴のターンには統計が付かない。このプラグインは履歴を項目だけで再生し、ターンの完了を送らない。

### Confirmation

- `server/metrics.test.ts` で、複数のターンの合算、一部だけの合計を出さないこと、待ちが無い時に `Worked` を省くこと、取り消した変更を数えないこと、ありえない速度を出さないこと、セッションの値と色を確かめる。
- `test/provider.test.ts` で、完了したターンの `metrics` と、`session.metrics` を取り決めた時だけ送ることを確かめる。
- `npm run test:upstream`（v0.17.3）で、実アダプターの `turn_completed` の `metrics` と `session_metrics_updated` を確かめる。
- 一時の Paseo 0.17.3 の daemon で、ターンのフッターとコンテキストの詳細の表示を確かめ、[verification.md](../verification.md) に記録する。

## Pros and Cons of the Options

### `turnHeader` と `usage` から統計を作る

- Good, because ZCode が記録した値だけを使う。
- Bad, because ターンの入力トークンは出せない。

### `Model` の行だけを報告する

- Good, because 小さい。
- Bad, because 0.17.2 の統計のほとんどが ZCode に出ない。

### 累計の差分からターンの入力も作る

- Good, because Paseo の `Tokens` と `Cache` の行をターンにも出せる。
- Bad, because ほかのクライアントの要求を区別できず、ZCode が記録していない値をプラグインが作ることになる。

## More Information

- `session.metrics` の能力は、0.17.1 の Paseo には無い。0.17.1 では、ターンの統計は捨てられ、セッションの統計は送らない。
