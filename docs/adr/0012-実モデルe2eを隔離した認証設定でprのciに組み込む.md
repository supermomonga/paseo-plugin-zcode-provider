---
number: 12
title: 実モデルE2Eを隔離した認証設定でPRのCIに組み込む
status: accepted
date: 2026-09-18
---

# 実モデルE2Eを隔離した認証設定でPRのCIに組み込む

## Context and Problem Statement

Issue #16 のモデル選択・独立 Plan 状態への移行では、偽ホストだけでなく公式ホストと実モデルによる検証が必要になった。ユーザーはモデル変更、Plan 承認・却下、追加指示、添付、停止・復元を任意実行の E2E にし、PR の CI でも実行すること、および `GLM_API_KEY` の Actions secret 登録を明示的に承認した。

既存の実機スクリプトは利用者の ZCode 認証と保存済みデータを利用する。公開リポジトリの PR CI へそのまま持ち込むと、ローカル状態への依存と認証情報の扱いが不明確になる。

## Decision Drivers

- 通常の単体テストは認証情報やモデル課金に依存させない。
- 公開 Provider API から公式ホストを通る実際の処理を検証する。
- 認証設定と会話データを通常の ZCode 利用環境から分離する。
- PR のコードへ渡すシークレットの範囲を明確にする。

## Considered Options

- 既存の実機スクリプトを、隔離する E2E ランナーから再利用する。
- ローカルの認証状態や会話データを CI へ複製する。
- 偽ホストのテストだけを PR CI で実行する。

## Decision Outcome

Chosen option: "既存の実機スクリプトを、隔離する E2E ランナーから再利用する"。検証シナリオを重複させず、明示的に承認された API キーだけで実行可能にする。

`npm run test:e2e` は `npm test` と分離し、Z.ai Coding Plan の明示されたエンドポイントを使用する。ランナーは一時ディレクトリにモード `0600` の personal provider 設定を作り、公式の `ZCODE_DATA_BASE_DIR` と `ZCODE_STORAGE_DIR` で保存先を分離する。Unix ソケットのパス長制限を満たす短い一時パスを使う。対象外の Computer Use helper は公式環境設定で無効にする。子プロセスへ渡す環境変数を限定し、API キーは環境変数から除く。通常終了・失敗時は一時設定とデータを削除し、キャンセル時は Provider 接続を閉じてから片付ける。シークレットを含む設定やネイティブログを CI artifact にしない。

PR CI は `pull_request` を使い、同一リポジトリの PR と `main` push で独立した実モデルジョブを実行する。手動起動も用意する。fork・Dependabot PR には Actions secret が渡されないため実モデルジョブを除外する。`pull_request_target` で PR コードを実行する方法は採用しない。通常のテストは全 PR で継続する。

CI は公式 Linux x64 deb のバージョンと SHA-256 を固定し、宣言された依存パッケージとともにインストールする。失敗を再試行や skip で成功扱いにせず、実行時間に上限を設ける。

### Consequences

- Good, because 通常の ZCode ログインや会話に依存せず、同じシナリオをローカルと CI で実行できる。
- Good, because 単体テスト・Paseo 実アダプター検証・実モデル E2E の責務と未検証範囲が区別できる。
- Bad, because 実モデルの応答、ネットワーク、Coding Plan の利用枠によって CI が失敗しうる。
- Bad, because fork・Dependabot PR は実モデル E2E の対象外になり、必要に応じて保守者が管理するブランチで検証する必要がある。
- Bad, because 強制終了やマシン障害では finally による削除が保証されない。CI は使い捨ての GitHub-hosted runner を利用する。

### Confirmation

認証情報未設定時の失敗、子プロセス環境の制限、設定ファイルの権限、成功・失敗時の削除を自動テストで確認する。実モデル E2E でモデル・推論レベル・Plan 応答・追加指示・添付・停止・再開を検証する。Paseo のコンパイラーと実アダプターは別の `test:upstream` で確認する。実行記録と未検証範囲は [verification.md](../verification.md) に保存する。

## More Information

- [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub Actions events and fork PR restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [開発・実行手順](../development.md)

API の契約、公式 provider 設定形式、対象モデル、GitHub の secret 仕様が変わった場合はこの判断とランナーを再評価する。Paseo daemon や UI の検証はこの E2E の対象に含めない。
