---
number: 35
title: Paseoのプロバイダーの画面で管理下ランタイムの版を示し、固定した版に更新する
status: accepted
date: 2026-11-23
links:
  - target: 15
    kind: amends
  - target: 18
    kind: amends
---

# Paseoのプロバイダーの画面で管理下ランタイムの版を示し、固定した版に更新する

## Context and Problem Statement

Paseo 0.17.1 は、Provider の設定画面（Settings → Providers → ZCode）に、導入済みの版、新しい版があるか、更新のボタンを出す（getpaseo/paseo#9568）。プラグイン Provider は `ProviderRegistration.installation` で、`installUrl`・`updateUrl` と、`inspect`（導入の有無と版）、`checkForUpdates`（新しい版があるか）、`update`（更新を実行して、出力を `report` で知らせる）を渡す。三つはどれも利用者が画面を開くか押した時だけ呼ばれる。Paseo は `inspect` の結果を 30 秒、更新の確認の結果を 1 時間使い回し、版が変わると確認をやり直す。Update のボタンは確認の結果にかかわらず出る。更新が成功すると、Paseo は Provider をもう一度検出する。

このプラグインの ZCode は、プラグインが版を固定した管理下ランタイム（ADR 15）か、`PASEO_ZCODE_RUNTIME` と `PASEO_ZCODE_NODE` で指定したものである。管理下ランタイムは、プラグインの版を上げて固定する版が変わると、利用者が Runtime の画面で導入し直すまで使えない（PR #111 の 3.18.2 でも、既存の利用者に導入し直しを求めた）。0.16 までの Paseo の Provider の画面は、その時に「導入されていない」としか示せなかった。

`installation` を渡さないと、Paseo の Provider の画面には版も更新の入口も出ない。

## Decision Drivers

- ADR 15 の約束を保つ：取得するのはプラグインに固定した成果物だけで、クライアントから URL、パス、版を受け取らない。導入は利用者が始めた時だけ行う。
- Runtime の画面と、Paseo の Provider の画面で、導入の処理と状態を一つにする。
- `PASEO_ZCODE_RUNTIME` で指定したランタイムには手を加えない。

## Considered Options

- `installation` で、管理下ランタイムの版を示し、固定した版を Runtime の画面と同じ処理で導入する。
- `installUrl` だけを渡し、導入と更新は Runtime の画面に任せる。
- `installation` を渡さない。

## Decision Outcome

Chosen option: "`installation` で、管理下ランタイムの版を示し、固定した版を Runtime の画面と同じ処理で導入する", because 固定した版が変わった後に、利用者が Paseo の Provider の画面だけで原因と対処を知ることができ、ADR 15 の約束もそのまま保てるからである。

- **`inspect`**：管理下ランタイムでは、管理下のディレクトリの印（`.paseo-managed.json`）から、固定した版が導入されていればその版を、無ければ前に導入した版のうち最も新しいものを、`<ZCode の版> (Node.js <Node.js の版>)` の形で返す。ZCode のランタイムが一つも無ければ `not_installed` にする。管理下の導入が無いプラットフォームも `not_installed` にする。`PASEO_ZCODE_*` を設定している時は、ランタイムを検出して `Server <版>, Agent <版> (PASEO_ZCODE_RUNTIME)` を返し、検出の失敗はプラグインの固定の文言で返す。
- **`checkForUpdates`**：固定した ZCode と Node.js の両方が導入されていれば `current`、そうでなければ固定した版を `available` で返す。プラグインの版を上げれば固定した版が変わるので、ネットワークには問い合わせない。`PASEO_ZCODE_*` を設定している時は `unknown` にし、プラグインは管理下のものだけを更新すると伝える。
- **`update`**：Runtime の画面と同じ `ManagedRuntimeInstaller` を一つだけ作り、両方で共有する。Runtime の画面で始めた導入が動いていれば、それに合流する。進み具合は、部品と段階（取得・展開・検証）が変わった時に一行ずつ知らせる。固定した版が導入済みなら何もせずに成功を返す。`PASEO_ZCODE_*` を設定している時と、管理下の導入が無いプラットフォームでは、失敗を返す。Paseo が daemon の停止で中断を求めたら、待つのをやめる。
- **`installUrl` と `updateUrl`**：README の Setup を指す。導入されていない時の Install のボタンは、これを開く。
- **可用性**：導入と削除が終わったら、`status()` の結果の使い回し（30 秒、ADR 18）をやめる。Paseo は更新の後にすぐ Provider を検出し直すので、使い回すと、導入した直後も使えないと出る。

### Consequences

- Good, because プラグインの更新で固定した版が変わった時、Provider の画面に前の版と新しい版が並び、Update で導入できる。
- Good, because Runtime の画面と Provider の画面が同時に導入を始めても、取得は一度だけ行われる。
- Good, because クライアントから受け取るものは無く、取得するのはプラグインに固定した成果物だけである。
- Bad, because Paseo の Provider の画面は、Runtime の画面のように、取得する URL、SHA-256、サイズ、ライセンスを導入の前に示さない。Install のボタンは README を開くだけなので、初めての導入はこれまでどおり Runtime の画面で行う。
- Neutral, because 導入の後、前の版のディレクトリは削除される（ADR 15 のまま）。その版で動いているセッションは、プラグインの更新で既に閉じている。

### Confirmation

- `server/installation.test.ts` で、未導入、固定した版の導入済み、前の版からの更新と出力、Runtime の画面の導入への合流、取得の失敗、中断、管理下の導入が無いプラットフォーム、`PASEO_ZCODE_*` の版と検出の失敗を確かめる。
- `server/runtime/managed.test.ts` で、状態の通知と、前の版の読み取り（印の無い途中のディレクトリを数えない）を確かめる。
- `npm run test:upstream`（v0.17.3）で、実アダプターの `installation` が `installUrl` と `inspect` の結果を渡すこと、コンパイルした登録が三つの関数を持つことを確かめる。
- 一時の Paseo 0.17.3 の daemon で、Provider の画面の版、更新の確認、Update の実行を確かめ、[verification.md](../verification.md) に記録する。

## Pros and Cons of the Options

### `installation` で版を示し、固定した版を導入する

- Good, because 固定した版の変更を、Provider の画面で示して直せる。
- Bad, because 前の版を読むために、管理下のディレクトリの印を読む処理が増える。

### `installUrl` だけを渡す

- Good, because 実装が小さい。
- Bad, because 導入済みの版も、固定した版との違いも出ない。

### `installation` を渡さない

- Good, because 変更が要らない。
- Bad, because Paseo 0.17 の Provider の画面に、ZCode だけ版も更新の入口も出ない。

## More Information

- ADR 15 の「設定画面」の導入の入口に、Paseo の Provider の画面を加える。取得物、配置、クライアントから値を受け取らないことは変えない。
- ADR 18 の可用性の使い回しに、導入と削除で使い回しをやめる条件を加える。
