---
number: 17
title: 設定画面のサインインとモデルプロバイダー管理をZCode公式サービスで行う
status: accepted
date: 2026-10-06
links:
  - target: 15
    kind: amends
  - target: 18
    kind: amendedby
---

# 設定画面のサインインとモデルプロバイダー管理をZCode公式サービスで行う

## Context and Problem Statement

ADR 15 は導入後に公式 TUI のログインコマンドを表示するだけとし、「プラグインは認証情報を扱わない」と決めた。利用者はコマンドを daemon のマシンのターミナルで実行する必要があり、モバイルや別マシンの Paseo から設定できない。また ZCode は GLM Coding Plan 以外に、Start Plan や API キーで接続するカスタムプロバイダー（DeepSeek、OpenRouter、任意の互換エンドポイントなど）を使える。Desktop の Model settings と同様に、設定画面でそれらを管理したいという要望があった。

2026-10-06 時点の公開ソース（`29628c9`）と、管理下ランタイム 3.14.3 を隔離データで起動した実測で次を確認した。

- stdio Server は `oauth`、`setting`、`provider-settings` チャンネルを公開する。Desktop の Model settings も同じサービスを呼ぶ（`packages/services/src/oauth/oauthService.ts`、`packages/services/src/model-provider/providerFacadeServices.ts`）。
- `oauth.startOAuthWithPolling` は ZCode のサーバーにフローを作り、認可 URL（`chat.z.ai` または BigModel）を返す。完了は Server が `pollPendingOAuth` で受け取る。ブラウザ側のコールバックは不要で、認可ページは daemon 以外の端末でも開ける。保留中のフローは Server プロセスのメモリに最大 5 分保持される。
- サインイン後、Server は `setting.json` の `providerFamilyDomain` が一致しないとアカウントのプランを使わない（`accountProviderConnectionResolver.ts`）。Desktop は完了時にこれと接続プランを書き、`provider-settings.refresh` を呼ぶ。統合 CLI の `zcode.mjs login` はこの値を書かないため、Desktop を使っていない環境では ADR 15 の手順でログインしてもアカウントのモデルが使えない可能性が高い。
- 同時にサインインできる Z.ai / BigModel アカウントは 1 つで、ログイン時にもう一方は消える。一方、API キーのカスタムプロバイダーは数の制限なく追加でき、`provider_config.json` に保存される（API キーは平文、ファイル権限は所有者のみ）。追加したモデルは `model-selection` にも現れる。
- `provider-settings` の作成・保存・モデル追加・有効化・削除は実ランタイムで期待どおりに動き、ZCode が URL の形式などを検証する。
- Paseo のプラグイン API に秘密情報の保管庫はない。プラグイン RPC は `daemon.manage` 権限を持つクライアントだけが呼べる。Paseo はプロバイダーのモデル一覧をキャッシュし、0.9 のクライアント API `providers.refresh` で再取得する。

## Decision Drivers

- daemon 以外の端末を含め、Paseo の画面だけでサインインとプロバイダー設定を完結できる。
- ZCode・Paseo 本体を改変せず、公開された公式の API だけを使う。
- ZCode の Desktop・CLI と同じ保存先と検証を使い、二重管理を作らない。
- API キーを daemon の外へ返さず、プラグイン自身は認証情報を保存しない。
- 画面が長くなっても目的の設定を探しやすい。

## Considered Options

- プラグイン RPC から、プラグインが起動した ZCode Server の公式サービスを呼ぶ。
- ログインコマンドの表示を維持する。
- daemon で `zcode.mjs login --no-browser --json` を実行し、出力された URL を画面に表示する。
- `provider_config.json`・`setting.json`・`credentials.json` をプラグインが直接読み書きする。
- アカウントや API キーを Paseo の設定文書（`defineSettings`）に保存し、セッション起動時に注入する。

## Decision Outcome

「プラグイン RPC から、プラグインが起動した ZCode Server の公式サービスを呼ぶ」を採用する。Desktop と同じ経路で ZCode が検証と保存を行い、サインインの結果を daemon が受け取れる唯一の選択肢だからである。

**画面.** 設定画面の名前を Setup から Settings に変え、上部のタブで Runtime（ADR 15 の導入・削除）と Account に分ける。プラグインの設定画面にはホストのタブ部品がないため、ホストのセグメントコントロールに似せた部品を `Pressable` で作る。Diagnostics 画面は別のまま残す。

**Server.** 設定用の RPC は、セッションとは別に ZCode Server を 1 つ起動して使う。要求をすべて直列に処理し、最後の要求から 60 秒後に終了する。サインインの保留中は終了しない。ブリッジは `oauth`・`setting`・`provider-settings` の 3 チャンネルに限り、位置引数での呼び出しを許す。

**サインイン.** Region（Z.ai / BigModel）を選んで `startOAuthWithPolling` を呼び、認可 URL をクライアントの端末で開く。開けない場合のために URL を表示し、コピーできるようにする。完了の確認は daemon 側で 1 秒ごとに行い、画面を閉じても進む。完了時は Desktop と同様に `providerFamilyDomain` を設定する。その family に接続プランがまだなければ Individual Coding Plan を選ぶ。既にあれば維持し、`provider-settings.refresh` を呼ぶ。サインアウトも Desktop と同じく `oauth.logout`、family の解除、refresh の順に行う。プランは状態の表示だけとし、Team プランの選択は Desktop に任せる。

**プロバイダー.** カスタムプロバイダー（`standard-personal`）だけを作成・編集・削除できる。テンプレートは ZCode のテンプレート一覧から選ぶ。保存時は Desktop と同じく、変更された項目だけを個人設定に適用し、隠れたヘッダーやテンプレートの継承値を保つ。アカウントのプランは編集できない。API キーはクライアントから受け取って ZCode に渡すだけで、表示用の応答には設定済みかどうかしか含めない。ZCode の検証メッセージは入力値を含みうるため、利用者には固定の文言を返す。変更後はクライアントが Paseo の ZCode カタログの再取得を要求する。

**互換性.** `openExternalUrl`・`copyText`・`getPaseoClient` は Paseo 0.9 で追加されたため、無い場合は React Native の `Linking`、コピーボタンの非表示、手動の再取得で代替する。最低要件 `>=0.8.0` は変えない。

ADR 15 のうち、ログインコマンドの表示と「プラグインは認証情報を扱わない」を本 ADR で改める。認証情報の保存先は引き続き ZCode であり、プラグインは保存しない。ランタイムの RPC がクライアントから URL・パス・版を受け取らない方針は維持する。プロバイダーの Base URL は ZCode の設定値で、ランタイムの取得には使わない。

### Consequences

- Good, because 利用者はターミナルを使わずに、daemon 以外の端末からもサインインとプロバイダー設定ができる。
- Good, because Desktop と同じ公式サービスと保存先を使うため、Desktop・CLI と設定が一致し、ZCode の検証がそのまま働く。
- Good, because Coding Plan 以外の Start Plan と、API キーの任意のプロバイダーを Paseo から使える。
- Bad, because daemon を管理できるクライアントは、daemon の ZCode アカウントの切り替えや、任意の Base URL への API キー送信を設定できる。これはエージェントの実行権限より広くはないが、操作の影響範囲は ZCode Desktop・CLI にも及ぶ。
- Bad, because 設定画面を開くと ZCode Server が 1 つ追加で起動する。
- Bad, because 複数の Z.ai / BigModel アカウントの同時利用は ZCode の制約で提供できない。
- Bad, because ZCode のサービス API は公開の安定契約ではないため、ランタイム更新時に実ランタイムでの確認が要る。

### Confirmation

`server/account.test.ts` で、表示から API キーが除かれること、family によるプランの絞り込み、サインインの完了・重複・期限切れ・失敗・Server 停止、Desktop と同じ設定の書き込み、編集項目だけの保存、アカウントプランの編集拒否、作成失敗時の削除を検証する。`server/host-bridge.test.ts` で位置引数の転送を確認する。実ランタイム 3.14.3 と隔離データで、作成・編集・無効化・モデル操作・削除とサインイン開始・取り消しを確認した。隔離した Paseo 0.9.0-beta.2 の daemon とヘッドレス Chrome でタブ、サインイン開始、テンプレートからの作成、モデルの切り替えと Paseo カタログの更新、削除を確認した。画面で作成した Z.ai Coding Plan のプロバイダーで実モデルの応答を得た。実環境で Z.ai アカウントのサインインが完了し、`providerFamilyDomain` の設定とプランのモデルの表示を確認した。daemon 以外の端末から認可したときに完了まで進むかは未確認であり、確認した結果を [verification](../verification.md) に記録する。

## Pros and Cons of the Options

### プラグイン RPC から、プラグインが起動した ZCode Server の公式サービスを呼ぶ

- Good, because 公式 API だけで Desktop と同じ処理になる。
- Good, because サインインの結果を daemon が受け取るため、認可する端末を選ばない。
- Bad, because 公開の安定契約ではないサービス API に依存する。

### ログインコマンドの表示を維持する

- Good, because プラグインが認証の操作に関わらない。
- Bad, because daemon のマシンのターミナルが必要で、`providerFamilyDomain` が書かれずアカウントのモデルが使えない場合がある。

### daemon で `zcode.mjs login --no-browser --json` を実行し、出力された URL を画面に表示する

- Good, because CLI の認可 URL は書き換えられておらず、Desktop の deep link を経由しない。
- Bad, because CLI は `providerFamilyDomain` を書かないため、結局 Server の `setting` を呼ぶ必要がある。認証情報を書く処理が 2 つのプロセスに分かれ、実行中の Server が変更を検知しない。

### `provider_config.json`・`setting.json`・`credentials.json` をプラグインが直接読み書きする

- Good, because Server を起動せずに済む。
- Bad, because ZCode の保存形式・暗号化・ロック・検証を再実装することになり、上流の変更で壊れやすい。

### アカウントや API キーを Paseo の設定文書（`defineSettings`）に保存し、セッション起動時に注入する

- Good, because Paseo の設定として一元管理できる。
- Bad, because 設定文書は秘密情報の保管庫ではなく、ホストのクライアントが読める平文になる。ZCode の Desktop・CLI と設定が二重になる。

## More Information

- 参照したソース：`packages/services/src/oauth/oauthService.ts`、`packages/services/src/model-provider/accountProviderConnectionResolver.ts`、`packages/ui/src/lib/providerFamilyDomainSettings.ts`、`packages/ui/src/root/useRootWorkspaceActions.ts`、`packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts`（ZCode `29628c9`）。
- Paseo のプラグイン API：`openExternalUrl`、`@getpaseo/plugin/client/react-native` の `copyText`、`getPaseoClient(...).providers.refresh`（0.9.0-beta.1）。
- ZCode が統合 CLI か Server の認証 API を安定契約として公開した場合、または Paseo が秘密情報の保管 API やプロバイダーのカタログ変更通知を公開した場合に再評価する。
