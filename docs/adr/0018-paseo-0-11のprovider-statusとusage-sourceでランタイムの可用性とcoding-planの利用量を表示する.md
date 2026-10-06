---
number: 18
title: Paseo 0.11のProvider statusとusage sourceでランタイムの可用性とCoding Planの利用量を表示する
status: accepted
date: 2026-10-06
links:
  - target: 17
    kind: amends
  - target: 8
    kind: amends
---

# Paseo 0.11のProvider statusとusage sourceでランタイムの可用性とCoding Planの利用量を表示する

## Context and Problem Statement

Paseo 0.11.0-beta.1 で、プラグイン Provider に `ProviderRegistration.status()` と `server.registerUsageSource()` が加わった（getpaseo/paseo#5707、#5465）。`status()` は Paseo 標準の Provider スナップショットと診断欄に可用性と診断文を出す。usage source は Usage 画面とサイドバーの利用量表示に、アカウントごとの利用枠を出す。ADR 2 と ADR 8 は、これらの標準表示に接続する公開 API が無いことを制約として記録していた。

0.11 の daemon は、`status()` の無い Provider を `connect()` の成否で判定する。このプラグインの `connect()` はランタイムを検査しないため、管理下ランタイムが未導入でも ZCode は available と表示され、未導入はセッション作成時に初めて分かる。Coding Plan の利用枠は ZCode Desktop では表示されるが、Paseo には表示する手段が無かった。

2026-10-06 時点で次を確認した（Paseo `v0.11.0-beta.5` = `15d774d`、ZCode `29628c9`）。

- daemon は `status()` を、カタログの読み込み、エージェントの作成・再開、診断欄の表示のたびに呼び、結果をキャッシュしない。プラグイン RPC の期限は 30 秒である。`available:false` の Provider は Settings → Providers で「Not installed」と表示され、セッションを作れない。診断文はその行の診断シートと `paseo provider diagnostic` に出る。
- `command` を宣言すると daemon は PATH から実行ファイルを探し、見つからなければ `connect()` の前に失敗する。このプラグインのランタイムは PATH 上に無い。
- 0.8〜0.10 の daemon は、登録の `status` を読まずに捨てる。サーバー側コンテキストは通常のオブジェクトで、`registerUsageSource` は存在しない。`@getpaseo/plugin/server/usage` は型だけの import でもコンパイルに失敗する。
- daemon は Usage 画面を表示している間、約 60 秒ごとにすべての source の `discover()` を呼ぶ。`fetch()` の結果は 5 分キャッシュし、各取得に 20 秒の期限を設ける。0.11.0-beta.5 ではプラグイン Provider のセッションに対するアカウント探索が動かないため、表示先は全体の Usage 画面とサイドバーになる。source の ID `zai` は Paseo の組み込み source が使っており、重複するとプラグイン全体が停止する。
- ZCode の stdio Server は公式の `usage-stats` サービスを公開している。Desktop は `getEntitlementSnapshot` に対象のプランと静的なアカウントアクセスを渡し、環境変数の API キーを使わない設定で Coding Plan の利用枠を読む（`packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`）。プランの API キーは ZCode が自分の保存先から解決し、プラグインには返らない。

## Decision Drivers

- 標準の表示に、ランタイムの状態と利用枠を正しく出す。
- ZCode・Paseo 本体を改変せず、公式のサービスと公開 API だけを使う。認証情報をプラグインで扱わない（ADR 17）。
- 頻繁な呼び出しで ZCode Server の起動や外部 API への要求を増やさない。
- 最低要件 Paseo `>=0.8.0` を維持する。
- 診断の秘匿方針（ADR 7・8）を守る。

## Considered Options

- `status()` はランタイムの検出結果を短時間キャッシュして返し、usage source は設定用 Server の公式 `usage-stats` から読む。
- `status()` で Server を起動し、サインインと使えるモデルまで確認する。
- `command` を宣言し、daemon の起動解決に可用性の判定を任せる。
- Z.ai / BigModel の利用枠 API をプラグインから直接呼ぶ。
- Paseo の組み込み `zai` usage source に任せ、プラグインでは実装しない。

## Decision Outcome

Chosen option: "`status()` はランタイムの検出結果を短時間キャッシュして返し、usage source は設定用 Server の公式 `usage-stats` から読む", because 呼び出しの頻度に耐え、ZCode が Desktop と同じ経路で認証と取得を行い、古い daemon でも無害に追加できる唯一の組み合わせだからである。

**status.** セッション開始と同じランタイム検出（`discoverRuntime` と最低版の判定）を行い、結果を 30 秒再利用する。同時の呼び出しは 1 回の検出にまとめる。Server は起動しない。診断文は Paseo の組み込み Provider と同じ「`ZCode` の後に字下げした `項目: 値`」の形式で、取得元（managed / `PASEO_ZCODE_RUNTIME`）、Server・Agent・Node.js の版、プラットフォームだけを出す。パスは出さない。失敗時は検出処理の固定文言（未導入なら Runtime タブへの案内）を返し、それ以外の例外はログだけに残す。サインインやモデルの問題は、従来どおりセッション作成時の固定文言で知らせる。`command` は宣言しない。

**usage source.** daemon が `registerUsageSource` を持つときだけ、ID `zcode`、ラベル `ZCode`、Provider と同じアイコンで登録する。型は `@getpaseo/plugin/server` からだけ import する。処理は ADR 17 の設定用 Server で、アカウント操作と同じ列に並べて実行する。

- `discover()`: サインイン中の family の、権利のある Individual Coding Plan をアカウントとして返す。キーは family と、バックエンドのユーザー ID の SHA-256 から作る。ラベルは family 名と表示名にする。結果は 5 分再利用し、サインイン・サインアウト・プロバイダー変更の後に破棄する。Server を起動できないときは空を返し、30 秒後に再試行する。セッションの範囲では、ZCode 以外の Provider と、プランに属さないモデルには何も返さない。
- `fetch()`: Desktop と同じく、対象のプランと静的なアカウントアクセスを指定し、`allowEnvApiKey:false`・`requirePreferredProvider:true` で `getEntitlementSnapshot` を呼ぶ。5 時間枠・週次（`TOKENS_LIMIT` と Z.ai Team の `CREDIT_LIMIT`）、月次のツール呼び出し（`TIME_LIMIT`）、ZCode MCP を、Desktop のラベルと単位コードの解釈に合わせて窓にする。`percentage` を使用率として扱い、`nextResetTime` をリセット時刻にする。プラン無し・未接続・サインイン切れは理由付きの unavailable にする。ZCode の例外メッセージは返さない。

Team Plan と Start Plan は対象外とする。Desktop は Team Plan に動的なアカウントアクセス（組織とプロジェクト）を渡し、Start Plan は別の残高表示を使う。

ADR 17 のうち、ブリッジが許すチャンネルに `usage-stats` を加える（読み取りの `getEntitlementSnapshot` だけを呼ぶ）。ADR 8 の診断の秘匿方針は、標準診断欄への診断文にも適用する。

### Consequences

- Good, because 未導入や非対応のランタイムが Settings → Providers に表示され、Runtime タブへの案内が診断シートに出る。
- Good, because Coding Plan の 5 時間枠・週次・ツール呼び出し・MCP の残量とリセット時刻が Paseo の Usage 画面に出る。
- Good, because 0.8〜0.10 では登録されず、最低要件を変えずに済む。
- Bad, because ランタイムの導入・削除が標準表示に反映されるまで最大 30 秒かかる。サインインしていない状態は available のままで、セッション作成時に初めて分かる。
- Bad, because Usage 画面を開いている間、最長 5 分ごとに設定用 Server が起動する。
- Bad, because 0.11.0-beta.5 では ZCode エージェントのポップオーバーに利用量が出ない（Paseo がプラグイン Provider のセッションを探索しない）。Team Plan と Start Plan も表示しない。
- Bad, because Paseo の usage source の契約は 0.11 の beta ごとに変わっており、正式版で変わる可能性がある。

### Confirmation

`server/provider-status.test.ts` で診断文の形式とスキーマ、パスを出さないこと、未導入・非対応・予期しない例外、キャッシュを検証する。`server/usage.test.ts` で、Desktop と同じ要求、窓の対応、Paseo の `UsageReportSchema` への適合、キーに ID やメールを含めないこと、キャッシュと破棄、未サインイン・サインイン切れ・プラン無しで利用枠を問い合わせないこと、例外メッセージを返さないことを検証する。`test:upstream` で、0.11 の実アダプターが `status()` を使うこと、`registerUsageSource` の有無どちらでも登録できること、source の ID とアイコンが Paseo の検証を通ることを確認する。実アカウントでの表示は [検証記録](../verification.md) に記録する。

## More Information

- [Paseo 0.11.0-beta.5 の usage source の型](https://github.com/getpaseo/paseo/blob/15d774d4a17c69bc0f8a62a85842764fab3c038d/packages/plugin/src/server/usage.ts)
- [同版の Provider の `status` と `command`](https://github.com/getpaseo/paseo/blob/15d774d4a17c69bc0f8a62a85842764fab3c038d/packages/plugin/src/server/provider.ts)
- [ZCode の usage-stats の型](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/shared/src/usage-stats.ts) と [Desktop の利用枠の表示](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/CodingPlanUsageRemainingPanel.tsx)

Paseo がプラグイン Provider のセッションを探索するようになったら、ZCode エージェント単位の表示を確認する。usage source の契約が正式版で変わった場合、または Desktop が Team Plan と Start Plan を同じ経路で扱えるようになった場合に、この決定を見直す。
