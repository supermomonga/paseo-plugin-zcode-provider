---
number: 34
title: Paseo 0.17.1を最低要件にし、診断を行で返して、利用量の予測とdocsのリンクに対応する
status: accepted
date: 2026-11-23
links:
  - target: 30
    kind: amends
  - target: 18
    kind: amends
---

# Paseo 0.17.1を最低要件にし、診断を行で返して、利用量の予測とdocsのリンクに対応する

## Context and Problem Statement

Paseo 0.17.1〜0.17.3（Issue #112〜#114）で、プラグインの Provider と usage source に次の変更が入った。0.17.0 は変更履歴に無く、正式版は 0.17.1 からである。0.17.3 は修正だけで、プラグインの API を変えていない。

- **診断のレポート**：0.16 のアダプターは、`status()` の `diagnostic` をそのまま Provider の診断として返した。0.17 は、Provider のラベルを見出しにし、起動コマンドの解決の行を加え、利用できる Provider の `diagnostic` を一行ずつ字下げして続け、利用できない Provider の `diagnostic` は `Error:` の行の値にする（`plugin-provider.ts` の `getDiagnostic`、getpaseo/paseo#10487）。このプラグインは、0.16 の形に合わせて見出しの `ZCode` と字下げを自分で付けていた。0.17.3 では見出しが二重になり、エラーの時は `Error: ZCode` の後に改行と本来の行が続いた。`npm run test:upstream` を v0.17.3 に対して実行して、この崩れを確かめた。
- **利用量の予測**：0.17.1 は、利用量の枠の長さ（`UsageWindow.durationSeconds`）と読み取りの時刻から、リセット前に使い切るかを予測して出す（getpaseo/paseo#10289）。長さの無い枠には予測が出ない。
- **カードの初期表示**：0.17.2 は、usage source の `providers` か、アカウントの `provider` が示す Provider が無効か使えないホストでは、カードを最初は隠す（getpaseo/paseo#10491）。
- **docs のリンク**：0.17.2 は、`ProviderRegistration.docsUrl` を Provider の設定画面の Troubleshooting から開く（getpaseo/paseo#10487）。
- そのほか、インストールの情報と更新（`installation`、ADR 35）、セッションとターンの統計（`session.metrics`、ADR 36）、プラグインがエージェントに指示を加える `appendSystemPrompt`、worktree の管理が加わった。

ユーザーは、最低要件を 0.17.1 に上げることを選んだ。

## Decision Drivers

- 0.17 の診断のレポートが、見出しの重複やエラーの崩れなく読めること。
- 対応しない Paseo のための分岐を持たない（ADR 30 と同じ方針）。
- 0.17 で増えた利用量の表示を、ZCode の情報で使えるものは使う。

## Considered Options

- 最低要件を 0.17.1 に上げ、診断を 0.17 の形（行だけ）で返し、利用量の予測、カードの初期表示、docs のリンクに対応する。
- 最低要件を 0.16.0 のままにし、診断を 0.17 の形で返す。
- 最低要件を 0.16.0 のままにし、診断を daemon の版で切り替える。

## Decision Outcome

Chosen option: "最低要件を 0.17.1 に上げ、診断を 0.17 の形（行だけ）で返し、利用量の予測、カードの初期表示、docs のリンクに対応する", because 0.17 のレポートを崩さずに出せ、版による分岐が要らず、ユーザーが選んだからである。

### 最低要件

- `paseo-plugin.json` の最低要件を `>=0.17.1` に上げる。開発 SDK は 0.17.3、CI の上流チェックアウトは v0.17.3（`dd7c0499a8c311fae7b3244722a64d73cc178e4a`）とする。

### 診断

- `status()` の `diagnostic` は、利用できる時は `Runtime: …`・`Node.js: …`・`Platform: …` の行だけにし、利用できない時は理由の文だけにする。見出しと字下げは Paseo が付ける。
- 文言の扱い（パスを出さない、想定外のエラーはログにだけ残す）は ADR 18 のまま変えない。

### 利用量

- 5 時間の枠に 5 時間、週の枠に週の長さ（ZCode の `number` が 2 以上ならその倍）を `durationSeconds` として付ける。月の枠（ツール呼び出し、ZCode MCP）は月によって長さが違うので付けない。Paseo の組み込みの usage source（Claude、Antigravity）も、月の枠には付けていない。
- usage source に `providers: ["zcode"]` を付ける。ZCode の Provider が無効か、ランタイムが無くて使えないホストでは、カードは最初は隠れる。利用者が出すことを選べば、これまでどおり出る。

### docs のリンク

- `docsUrl` に、このリポジトリの README（`#readme`）を指定する。

### Consequences

- Good, because Provider の診断のレポートが、見出し一つと字下げした行で読める。エラーの時も `Error:` の後に理由だけが出る。
- Good, because 5 時間と週の枠に、リセット前に使い切るかの予測が出る。
- Good, because ZCode を使わないホストに、ZCode のカードが最初から出ない。
- Bad, because Paseo 0.16 の利用者は、新しい版を導入できない。
- Neutral, because Paseo 0.17 のアダプターは、プラグイン Provider のセッションの `usageSession()` を、Provider に `command` がある時だけ返す。このプラグインは `command` を持たない（ランタイムは管理下の導入か `PASEO_ZCODE_*` で決まる）ので、エージェントのポップオーバーには、これまでどおり利用量が出ない。

### Confirmation

- `server/provider-status.test.ts` で、`diagnostic` が行だけ、または理由の文だけになることを確かめる。
- `server/usage.test.ts` で、枠の長さと `providers` を確かめる。
- `npm run test:upstream`（v0.17.3）で、0.16.2 の daemon が最低要件で拒否すること、実アダプターの `getDiagnostic` が見出し一つと字下げした行、エラーの時は `Error:` の行になること、コンパイルした登録の `docsUrl` と usage source の `providers` を確かめる。

## Pros and Cons of the Options

### 最低要件を 0.17.1 に上げ、診断を 0.17 の形で返す

- Good, because 0.17 の API だけを使うので、分岐が要らない。
- Bad, because 0.16 の利用者は更新できない。

### 最低要件を 0.16.0 のままにし、診断を 0.17 の形で返す

- Good, because 0.16 の利用者も更新できる。0.17 で加わったほかの項目（`durationSeconds`、`providers`、`docsUrl`、`installation`）は、0.16 では無視されるだけである。
- Bad, because 0.16 の診断に見出しと字下げが無くなる。

### 最低要件を 0.16.0 のままにし、診断を daemon の版で切り替える

- Good, because どちらの版でも診断が整う。
- Bad, because プラグインは daemon の版を直接知らず、対応しない Paseo のための分岐を持たない方針にも反する。

## More Information

- ADR 30 の最低要件（0.16.0）を 0.17.1 に上げる。ADR 30 の Plan とゴールの通知の判断は変えない。
- ADR 18 の Provider status の診断の形を、この ADR の形に置き換える。可用性の判断と usage source の読み出しは変えない。
- 0.17.1 から、ほかのプラグインが `agent.open.before` の `appendSystemPrompt` でエージェントに指示を加えられる。アダプターは、これをシステムプロンプトに結合して `session.open` の `config.systemPrompt` で渡す。ZCode の V4 の Server にはシステムプロンプトを渡す手段が無いので、これまでどおり `INVALID_CONFIGURATION` で断る。
- 検証の記録は [verification.md](../verification.md) にある。
