---
number: 32
title: ZCode 3.18のServerを資格情報ストアが使える状態で起動する
status: accepted
date: 2026-11-20
links:
  - target: 15
    kind: amends
---

# ZCode 3.18のServerを資格情報ストアが使える状態で起動する

## Context and Problem Statement

ZCode 3.18 は、保存する資格情報の暗号化を変えた（変更履歴には載っていない）。既定の鍵は OS の資格情報ストア（macOS の Keychain、Windows の資格情報マネージャー、Linux の Secret Service）に置き、ネイティブモジュール `@napi-rs/keyring` で読む。stdio の Server は、サービスを用意する前に `createServerCredentialCipher` で暗号化の方式を決め、決められなければ終了する（fec9759 の `packages/server/src/stdioServices.ts`、`packages/shared/src/credential-security/`）。決め方は次の順である。

1. 環境変数 `ZCODE_CREDENTIAL_SECRET` か `ZCODE_CREDENTIAL_SECRET_FILE`。
2. 資格情報のディレクトリ（`~/.zcode/v2`）にある、所有者だけが読める `credential-secret`。
3. OS の資格情報ストア。

Server を `--prepare-credentials` 付きで起動すると、ディレクトリがまだ OS のストアに結び付いていなければ（`credential-source` が無く、OS のストアで暗号化したデータも無ければ）、0600 の `credential-secret` を作る。Desktop は、リモートの機械で Server を起動するときにこのフラグを渡す（`packages/server/src/remote/connect.ts`）。Desktop 自身は、OS のストアを使い、ディレクトリを `credential-source`（内容は `os`）で OS に結び付ける。

統合 CLI の配布物（`scripts/build-zcode.mjs`、`scripts/zcode-distribution/assets.mjs`）は、Server の `node_modules` に `@napi-rs/keyring` を入れない。Server のバンドルは、このモジュールを外部のまま残す（`packages/server/buildRemoteValidation.ts`）。Agent の下には JS だけが入り、ネイティブのパッケージは無い。Desktop は、`scripts/stage-credential-keyring.mjs` でプラットフォームごとに入れる。

3.18.2 から作った管理下ランタイムを、隔離したデータで起動すると、Server は hello の直後に `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE` で終了し、プロバイダは `NATIVE_PROTOCOL_ERROR` で失敗した。`--prepare-credentials` を付けると起動し、`credential-secret` ができた。

## Decision Drivers

- 管理下ランタイムが、Desktop の有無にかかわらず起動する。
- Desktop と `~/.zcode` を共有する利用者の資格情報を、Desktop と同じ鍵で読む。鍵を作り直したり、鍵の置き場所を勝手に変えたりしない。
- プラグインは資格情報を持たず、ZCode の資格情報や設定のファイルを直接読み書きしない（ADR 17）。
- ZCode のソースを変えない（ADR 19 のパッチは、使えない能力を隠すことに限る）。

## Considered Options

- 管理下ランタイムに `@napi-rs/keyring` を入れ、3.18 以降の Server を `--prepare-credentials` 付きで起動する。
- `--prepare-credentials` だけを付ける。
- `@napi-rs/keyring` だけを入れる。
- プラグインが鍵を作り、`ZCODE_CREDENTIAL_SECRET_FILE` で Server に渡す。

## Decision Outcome

Chosen option: "管理下ランタイムに `@napi-rs/keyring` を入れ、3.18 以降の Server を `--prepare-credentials` 付きで起動する", because Desktop と共有するデータは Desktop と同じ OS のストアで読み、それ以外は Desktop がリモートの Server に用いるのと同じ公式の手順で起動できる、唯一の選択肢だからである。

- `scripts/package-zcode-runtime.mjs` は、公式の `scripts/stage-credential-keyring.mjs` で、管理下の 5 プラットフォーム（darwin-arm64、linux-x64、linux-arm64、win32-x64、win32-arm64）の `@napi-rs/keyring` とネイティブのパッケージを、ランタイムの `node_modules` に入れる。入れるのは、固定したロックファイルで pnpm が入れたパッケージである（ZCode の `pnpm-workspace.yaml` の `supportedArchitectures` が、これらのプラットフォームを入れる）。入れたパッケージと版は `BUILD-INFO.json` に記録する。公式の配布物が既に入れているときは、梱包を止める。
- 管理下ランタイムの導入時の検査（`MANAGED_ZCODE_FILES`）に、`node_modules/@napi-rs/keyring/package.json` を加える。
- ZCode 3.18 以降の Server は、`--prepare-credentials` 付きで起動する（`server/host/bridge.ts` の `serverArguments`）。3.18 より前の Server には付けない。
- Server が資格情報ストアを開けずに終了したら、標準エラーに出る固定のコード `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE` だけを照らし合わせ、新しいコード `CREDENTIAL_STORE_UNAVAILABLE` と、OS のストアを使えるようにすることを促すプラグインの文言で伝える。Server の出力は、これまでどおり記録しない。
- 利用者が daemon の環境で `ZCODE_CREDENTIAL_SECRET` か `ZCODE_CREDENTIAL_SECRET_FILE` を与えれば、Server はそれを優先する。プラグインは、この変数を作りも消しもしない。

### Consequences

- Good, because Desktop の無い機械でも、headless の Linux でも、CI の隔離したデータでも、管理下ランタイムが起動する。
- Good, because Desktop と共有するデータは、Desktop が結び付けた OS のストアの鍵で読む。
- Good, because ZCode のソースを変えず、ZCode が配る同じ版のパッケージを、ZCode 自身の梱包の手順で加えるだけである。
- Bad, because Desktop の無い機械で最初に起動すると、`~/.zcode/v2` に所有者だけが読める鍵のファイルができる。後で Desktop を入れた場合に、Desktop がこの鍵を読むことは、ソースからの推定で、確かめていない。
- Bad, because Desktop が OS のストアに結び付けたデータを、OS のストアを使えない環境（Secret Service の無い headless の Linux など）の daemon からは読めない。この場合は `CREDENTIAL_STORE_UNAVAILABLE` で失敗する。
- Bad, because macOS では、Desktop が作った Keychain の項目を Node.js から読むときに、OS が許可を求める可能性がある。確かめていない。
- Bad, because ランタイムの書庫が約 2 MB 大きくなる。
- Neutral, because `PASEO_ZCODE_RUNTIME` で指定する公式の配布物には `@napi-rs/keyring` が無いので、OS のストアに結び付いていないデータでだけ起動する。

### Confirmation

- `npm run test:stdio-runtime` は、3.18 以降のランタイムで、隔離したデータに `credential-secret` ができ、Server が全項目を通ることを確かめる。リリースのワークフローは、これを 5 プラットフォームで実行する。
- 3.18.2 の公式の配布物そのものは、隔離したデータで `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE` で終了し、`--prepare-credentials` 付きなら起動することを、手で確かめた（[verification.md](../verification.md)）。

## Pros and Cons of the Options

### `@napi-rs/keyring` を入れ、`--prepare-credentials` 付きで起動する

- Good, because Desktop と共有するデータと、そうでないデータの両方で起動する。
- Bad, because ランタイムの梱包に手順が一つ増える。

### `--prepare-credentials` だけを付ける

- Good, because ランタイムの中身を変えない。
- Bad, because Desktop が OS のストアに結び付けたデータでは、モジュールが無いので起動しない。

### `@napi-rs/keyring` だけを入れる

- Good, because 公式の独立した Server と同じ規則で動く。
- Bad, because OS のストアが無い環境（CI の Linux、headless の Linux）で起動しない。macOS と Windows でも、Desktop が無ければ、最初の起動で OS のストアに新しい項目を作る。

### プラグインが鍵を作り、`ZCODE_CREDENTIAL_SECRET_FILE` で渡す

- Good, because どの環境でも同じに動く。
- Bad, because プラグインが資格情報を持つことになる（ADR 17 に反する）。明示した鍵は OS のストアより優先されるので、Desktop が OS のストアで暗号化したデータを読めなくなる。

## More Information

- ZCode の統合 CLI の配布物が `@napi-rs/keyring` を Server から読める場所に入れるようになったら、梱包はそれを検出して止まる。そのときに、この梱包の手順を外す。
- ADR 15 の管理下ランタイムの中身と、ADR 19 の「パッチは使えない能力を隠すことに限る」は変えない。この判断はソースを変えず、公式のパッケージを加えるだけである。
