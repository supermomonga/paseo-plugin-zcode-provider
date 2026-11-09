---
number: 23
title: モデル切り替えの表示をPaseoの設定APIで選べるようにし最低要件を0.9.0に上げる
status: accepted
date: 2026-11-09
links:
  - target: 8
    kind: amends
---

# モデル切り替えの表示をPaseoの設定APIで選べるようにし最低要件を0.9.0に上げる

## Context and Problem Statement

ZCode は、ターンのプロバイダーとモデルが直前のターンと違うとき、そのターンの前に `modelChange` の `timelineMarker` 行を置く（3c5b227 の `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` の `onTurnStarted`）。プラグインはこれを Paseo の通知に変換していた。Issue #83 では、ターンのたびにこの行が二つずつ増えて会話が読みにくいと報告され、表示をやめるよう求められた。Paseo は受け取った通知を後から消せない。セッションで選んでいるモデルは Paseo のヘッダーに出る。

ADR 8 は、Paseo 0.8.0 には daemon 側から保存値を読む API が無いので設定値を保存しないとし、その API が公開されたら見直すとした。Paseo 0.9.0 から `server.registerSettings()` が `read()` と `subscribe()` を持つハンドルを返す。プラグインの最低要件は 0.8.0 で、0.8.0 の `registerSettings()` は何も返さない。

## Decision Drivers

- 既定では会話にこの行を出さず、必要な人は出せるようにする。
- 設定は Paseo の公式の保存と UI の仕組みで扱い、独自の保存先を作らない。
- 画面で変えた設定が、対応するすべての Paseo で実際に効くようにする。
- Paseo の会話で、行が後から末尾に並んだり、重なったりしないようにする。

## Considered Options

- マーカーを常に出さない。
- Paseo の設定 API で表示を選べるようにし、最低要件を 0.9.0 に上げる。
- Paseo の設定 API で表示を選べるようにし、最低要件は 0.8.0 のままにする。

## Decision Outcome

Chosen option: 「Paseo の設定 API で表示を選べるようにし、最低要件を 0.9.0 に上げる」。報告された不満を既定で解消しつつ、本当にモデルが変わったことを知りたい人の手段を残し、保存と画面を Paseo の仕組みだけで実現できるため。

- `shared/timeline.ts` に `defineSettings` でホスト単位の文書 `timeline`（版 1、`showModelChanges` の既定は `false`）を定義する。サーバーは `registerSettings()` のハンドルの `read()` と `subscribe()` で現在の値を追う。最初の読み込みが終わるまでと、保存値が不正な間は既定値を使う。
- 設定画面に Runtime・Account とは別の Timeline タブを置き、`useSettings` のスイッチで切り替える。不正な保存値は既定値に戻せる。
- 表示するかどうかは、マーカーを最初に見た時点の設定で決める。出した行はそのまま残し、非表示の間に来た行は後から出さない。セッションを開き直したときは、その時点の設定で履歴を作る。
- 行の文言は ZCode Desktop に合わせ、最初のモデルは `Using provider/model`、切り替えは `Model switched provider/model → provider/model` とする。推論レベルは出さない。
- `paseo-plugin.json` の最低要件を `>=0.9.0` に上げる。

### Consequences

- Good, because 既定の会話から、毎ターン増える行が無くなる。
- Good, because 設定の保存・不正値の扱い・クライアント間の同期を Paseo が担い、プラグインは保存先を持たない。
- Bad, because Paseo 0.8 系では新しい版を導入できなくなる。
- Bad, because 既定ではモデルが本当に切り替わったことも会話からは分からない。
- Bad, because 設定を変えても、すでに会話にある行は変わらない。

### Confirmation

`test/provider.test.ts` で、最初に見た時点の設定で表示が決まることと、開き直したときの履歴がその時点の設定に従うことを確認する。`server/timeline-settings.test.ts` で、既定値、保存値の追従、不正値、最初の読み込みより新しい保存を確認する。`npm run test:upstream` は実際のコンパイラで設定の登録を確認する。

## Pros and Cons of the Options

### マーカーを常に出さない

- Good, because 設定も画面も要らない。
- Bad, because ZCode がモデルを切り替えたことを Paseo で知る手段が無くなる。

### 設定 API で選べるようにし、最低要件を 0.9.0 に上げる

- Good, because 画面のスイッチが、対応するすべての Paseo で効く。
- Bad, because Paseo 0.8 系の利用者は更新できない。

### 設定 API で選べるようにし、最低要件は 0.8.0 のままにする

- Good, because Paseo 0.8 系でも新しい版を導入できる。
- Bad, because 0.8 系では画面のスイッチが保存されるだけで効かない。画面からはそれを見分けられない。

## More Information

ADR 8 のうち、設定値を保存しないという部分を変える。診断画面の項目と秘匿方針はそのままとする。Paseo 側の根拠は `public-docs/plugins/reference.md` の Persisted values と、v0.8.0 と v0.9.0 の `packages/plugin/src/server/contracts.ts`。[Issue #83](https://github.com/supermomonga/paseo-plugin-zcode-provider/issues/83)。ZCode が `modelChange` を出す条件を変えたとき、または Paseo が受け取った行を後から消せるようになったときに見直す。
