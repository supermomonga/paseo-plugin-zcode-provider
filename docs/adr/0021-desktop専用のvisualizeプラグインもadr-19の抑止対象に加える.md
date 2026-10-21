---
number: 21
title: Desktop専用のvisualizeプラグインもADR 19の抑止対象に加える
status: accepted
date: 2026-10-21
links:
  - target: 19
    kind: amends
---

# Desktop専用のvisualizeプラグインもADR 19の抑止対象に加える

## Context and Problem Statement

ZCode 3.15.1 から、公式プラグイン `visualize@zcode-plugins-official` が統合 CLI に同梱され、既定で有効になった（`apps/zcode-cli/packages/visualize-plugin`、`official-plugin-definitions.ts`）。スキルは、Agent が渡された可視化用ディレクトリに HTML の断片を書き、応答に `::visualize` で始まる行（ファイルの絶対パスを JSON で渡す）を書くよう指示する。Desktop の UI がこれを解釈し、専用のサンドボックスで描画する。

3c5b227（3.16.2）の確認では、可視化用ディレクトリは Agent が Desktop の surface（`--surface desktop`）で動くときだけ渡される（`core/src/runtime/helpers/gen-ui-output.ts`）。このプロバイダの Agent は `app-server --stdio` の terminal surface で動くので、ディレクトリは渡らない。それでも protocol 入口は `includeVisualize: true` でスキルを残す（`workspace-model-runtime.ts`）。ZCode 自身は、ターミナルの会話からは「インラインビューのホストが無い」としてこのスキルを外している（`visualize-skill-gate.ts`）。結果として、モデルには使えないスキルが提示される。

## Decision Drivers

- モデルに、このプロバイダでは働かない能力を提示しない（ADR 19 と同じ動機）。
- Paseo・ZCode を改変せず、Paseo の公開プラグイン API の範囲に収める。
- Paseo のすべてのクライアント（Web、Electron、iOS、Android）で同じ挙動にする。

## Considered Options

- 何もしない。
- `visualize` を ADR 19 の抑止対象（`SUPPRESSED_OFFICIAL_PLUGINS`）に加える。
- Agent を `--surface desktop` で起動し、プラグインで `::visualize` を描画する。

## Decision Outcome

Chosen option: "`visualize` を ADR 19 の抑止対象に加える", because 利用者がこの扱いを選び（2026-10-21）、パッチを変えずに既存の仕組みで隠せるからである。`server/unsupported-capabilities.ts` の `SUPPRESSED_OFFICIAL_PLUGINS` に `visualize@zcode-plugins-official` を加え、ADR 19 のパッチがそれを `PASEO_ZCODE_SUPPRESSED_PLUGINS` から読んで探索から外す。パッチ、`ZCODE_CUA_PRODUCT_HELPER=0`、`toolDisallowlist` は変えない。visualize はツールを持たずスキルだけなので、パッチの無い `PASEO_ZCODE_RUNTIME` のランタイムには提示されたまま残る。

描画の実装は見送る。Paseo 0.12.0 のプラグインのクライアント API は React Native の部品だけで、WebView や iframe を提供しない。Web と Electron では規則外の `<iframe>` で描けるが、iOS と Android では描けない。可視化用ディレクトリを得るための `--surface desktop` は、すべての会話のシステムプロンプトに Desktop 向けの節（Gen UI 対応の宣言、`::code-comment` の指示など）を加える。

### Consequences

- Good, because 使えないスキルの読み込みや、描画されない `::visualize` の出力を避けられる。
- Good, because 変更が定数 1 つで、ADR 19 の契約試験の枠組みでそのまま確かめられる。
- Bad, because Desktop と同じ対話的な可視化は Paseo では使えない。Markdown の表や Mermaid などの通常の応答に頼る。
- Bad, because 共有の `~/.zcode` で利用者が visualize を有効にしていても、このプロバイダからは見えない。Desktop には影響しない。

### Confirmation

`npm run test:stdio-runtime` が、隔離した保存領域に visualize の模擬キャッシュを置く。パッチ済みのランタイムでは一覧とモデルへのスキル提示から消え、無改変のランタイムでは見えることを要求する。2026-10-21 に、パッチ済み 3.16.2（ローカルビルド）、3.14.3-paseo.1、無改変 3.14.3 で確認した。

## Pros and Cons of the Options

### 何もしない

- Good, because 変更が無い。
- Bad, because ディレクトリが無いと分かっているスキルを、モデルが読み込む場合がある。

### 抑止対象に加える

- Good, because 既存のパッチと試験で完結する。
- Bad, because 将来 Paseo が描画手段を提供しても、この決定を見直すまで使えない。

### `--surface desktop` で起動して描画する

- Good, because Web と Electron では Desktop に近い表示ができる。
- Bad, because モバイルでは描けず、SDK の規則外の iframe は Paseo の更新で壊れうる。
- Bad, because システムプロンプトが Desktop 向けになり、`::code-comment` など他の指示への対応も要る。D3 などの同梱、ライセンス表記、widget 状態の保存も必要になる。

## More Information

ZCode の参照元（3c5b227）：`apps/zcode-cli/packages/visualize-plugin/skills/visualize/SKILL.md`、`apps/zcode-cli/packages/bootstrap/src/app/visualize-skill-gate.ts`、`apps/zcode-cli/packages/core/src/runtime/helpers/gen-ui-output.ts`、`packages/ui/src/gen-ui/domain/references.ts`。Paseo の公開プラグイン API が WebView などの描画手段を提供した場合や、ZCode が Desktop 以外の描画ホストを公式に用意した場合に見直す。
