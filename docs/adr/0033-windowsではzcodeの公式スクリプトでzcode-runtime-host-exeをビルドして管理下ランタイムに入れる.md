---
number: 33
title: WindowsではZCodeの公式スクリプトでzcode-runtime-host.exeをビルドして管理下ランタイムに入れる
status: accepted
date: 2026-11-21
links:
  - target: 15
    kind: amends
---

# WindowsではZCodeの公式スクリプトでzcode-runtime-host.exeをビルドして管理下ランタイムに入れる

## Context and Problem Statement

ZCode 3.18 は、Windows で Agent の CLI を起動するとき、ネイティブの補助 `zcode-runtime-host.exe` に起動を任せる（fec9759 の `packages/services/src/windows-runtime-host/`、`zcodeAgentProcessManager.ts`）。補助は CLI を Job オブジェクトに入れ、終了時にプロセスの木を確実に回収する。補助が見つからなければ、Agent を起動しない（`Windows runtime host is missing. Prepare the runtime assets before starting CLI.`）。Server は、`ZCODE_RUNTIME_HOST_PATH`、Electron の `resourcesPath`、`ZCODE_SERVER_RUNTIME_ROOT` の下などで補助を探す。Windows 以外では使わない。

補助は、ZCode のリポジトリにある C++ のソース（`scripts/windows-runtime-host/`）から、公式の `scripts/build-windows-runtime-host.mjs` が CMake でビルドする。Desktop と、Windows 向けの独立した Server の配布物（`packages/zcode-server-cli`）は、これを `tools/runtime-host/` に入れる。統合 CLI の配布物（`scripts/build-zcode.mjs`）には入らない。

PR #111 の CI で、3.18.2 から作った管理下ランタイムは、Linux と macOS では全項目を通り、Windows の x64 と arm64 ではカタログの取得で失敗した。ZCode の `initialize` が `available: false` を返し、プロバイダは `NATIVE_PROTOCOL_ERROR` で失敗した。3.17.2 の管理下ランタイムは、同じ Windows のランナーで通る。

ユーザーは、補助をビルドして管理下ランタイムに入れる案を選んだ。

## Decision Drivers

- 管理下ランタイムが、管理対象の 5 プラットフォームすべてで同じ版で動く。
- ZCode のソースを変えず、ZCode 自身のビルドの手順と、公式の設定の手段だけを使う（ADR 19 の制限）。
- 固定の仕組みとリリースの手順を、プラットフォームごとに分けない。

## Considered Options

- 補助をリリースのワークフローでビルドして書庫に入れ、Windows で `ZCODE_RUNTIME_HOST_PATH` を渡す。
- 管理下ランタイムを 3.17.2 のままにし、3.18.2 は別の PR で扱う。
- Windows だけ 3.17.2 を固定し続ける。

## Decision Outcome

Chosen option: "補助をリリースのワークフローでビルドして書庫に入れ、Windows で `ZCODE_RUNTIME_HOST_PATH` を渡す", because Desktop と同じ補助を、Desktop と同じ手順で作り、固定の仕組みを変えずに 5 プラットフォームを 3.18.2 にできるからである。

- `.github/workflows/zcode-runtime-release.yml` の `windows-host` ジョブは、Windows のランナー（`windows-2025`）で、固定したソースから公式の `scripts/build-windows-runtime-host.mjs` で x64 と arm64 の補助をビルドする。Desktop と同じく Visual Studio を使う。
- `scripts/package-zcode-runtime.mjs` は、ZCode 自身の `isRuntimeHostReady`（この構成の PE であること、`build.json` にこのソースの要約と実行ファイルのハッシュがあること）で確かめてから、`tools/runtime-host/win32-<arch>/zcode-runtime-host.exe` に入れ、`BUILD-INFO.json` の `addedFiles` に SHA-256 を記録する。公開する書庫は、補助が無ければ作らない。公式の配布物が既に `tools/runtime-host` を持てば、梱包を止める。
- プロバイダは、Windows で 3.18 以降の Server を起動するとき、ランタイムにある daemon のアーキテクチャの補助を `ZCODE_RUNTIME_HOST_PATH` で渡す（`server/host/bridge.ts` の `windowsRuntimeHostEnvironment`）。daemon の環境に `ZCODE_RUNTIME_HOST_PATH` があれば、それを使う。どちらも無ければ、Agent が失敗する前に、新しいコード `WINDOWS_RUNTIME_HOST_MISSING` で失敗する。

### Consequences

- Good, because 管理下ランタイムが 5 プラットフォームで同じ 3.18.2 になる。
- Good, because 補助は ZCode のソースと公式のスクリプトから作り、ZCode 自身の検査で確かめるので、Desktop が入れるものと同じ作り方である。
- Bad, because リリースのワークフローに Windows のジョブが二つ増え、書庫に二つの実行ファイルが加わる。
- Bad, because 署名の無い実行ファイルを配る。Desktop の補助は、Desktop の署名の下にある。
- Neutral, because `PASEO_ZCODE_RUNTIME` で指定する公式の配布物を Windows で使うには、利用者が `ZCODE_RUNTIME_HOST_PATH` を設定する必要がある。

### Confirmation

- `server/host-bridge.test.ts` で、Windows の 3.18 以降でだけ補助を渡すこと、daemon の設定を優先すること、補助が無ければ `WINDOWS_RUNTIME_HOST_MISSING` になることを確かめる。
- リリースのワークフローの検証のジョブは、Windows の x64 と arm64 で、補助を入れた書庫に `test:stdio-runtime` を実行する。

## Pros and Cons of the Options

### 補助をビルドして書庫に入れる

- Good, because 管理下ランタイムが一つの版に揃う。
- Bad, because 梱包の手順が増える。

### 3.17.2 のままにし、別の PR で扱う

- Good, because この PR の範囲が小さくなる。
- Bad, because 3.18.2 の管理下ランタイムが遅れ、同じ作業が別の PR に移るだけである。

### Windows だけ 3.17.2 を固定する

- Good, because 補助をビルドしなくて済む。
- Bad, because 固定とリリースがプラットフォームごとに分かれ、Windows の利用者だけ古い ZCode の挙動が残る。

## More Information

- ZCode の統合 CLI の配布物が補助を入れるようになったら、梱包はそれを検出して止まる。そのときに、このビルドと梱包の手順を外し、補助の場所の解決を見直す。
- ADR 32（資格情報ストア）と同じく、ソースを変えずに公式の部品を加える判断である。
