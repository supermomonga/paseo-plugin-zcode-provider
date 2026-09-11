---
number: 4
title: 公式変更履歴と対応バージョンを基準にリリース対応Issueを作成する
status: accepted
date: 2026-09-08
links:
  - target: 7
    kind: amendedby
---

# 公式変更履歴と対応バージョンを基準にリリース対応Issueを作成する

## Context and Problem Statement

プラグインはZCodeの特定hostとPaseoの公開SDKに依存しており、両製品の更新時に互換性を確認する必要がある。公式変更履歴から新しいリリースを検知し、変更内容を含む対応Issueを自動作成する。ベータ対応中の正式版公開も独立した確認対象である。

## Decision Drivers

- 対応済みバージョンの定義を既存のmanifestとSDK依存に統一する。
- プレリリースから正式版への更新を取りこぼさない。
- 定期実行の失敗後やIssueのクローズ後に同じ通知を重複させない。
- 通知のための外部ストレージや追加認証情報を導入しない。

## Considered Options

- 公式変更履歴と対応バージョンを比較し、GitHub Issueを通知履歴として使う。
- 別の状態ファイルに前回検知したバージョンを保存する。

## Decision Outcome

Chosen option: "公式変更履歴と対応バージョンを比較し、GitHub Issueを通知履歴として使う", because 対応状態と通知状態を既存の情報から判定でき、再実行時の二重通知を避けられる。

ZCodeはmanifestのappVersion、Paseoは固定したSDK依存バージョンを基準にする。SemVerで厳密に新しいバージョンを対象とし、ベータ・RC・正式版を区別する。Paseo `0.8.0-beta.1` から `0.8.0` への移行も新リリースとして通知する。

製品別の定期・手動ワークフローを使い、製品単位で同時実行を制限する。Issueの完全一致タイトルまたは製品・バージョンの固定マーカーを、オープン・クローズ両状態から探す。取得・解析・API操作が失敗した場合はワークフローを失敗させる。

既存のNode.js環境でCheerioによるHTML解析、Turndownによる変更内容のMarkdown変換、semverによる比較を行う。Bunの導入や独自HTML・バージョン解析器は不要となる。

### Consequences

- Good, because 対応済みバージョンの二重管理や通知状態の専用ストレージが不要になる。
- Good, because ベータ版のIssueが存在していても正式版の確認を別Issueで追跡できる。
- Good, because 標準のGITHUB_TOKENと最小限の権限で運用できる。
- Bad, because 公式サイトのHTML構造変更時には抽出処理の修正が必要になる。
- Bad, because Issueの削除、またはタイトルとマーカーの両方の変更で通知履歴が失われる。

### Confirmation

Vitestで正式版移行、重複判定、ページ巡回、部分失敗からの再実行、解析・取得失敗を検証する。実サイトではdry-runを使い、Issueを作成せず抽出結果を確認する。

## More Information

[zcode-acpの監視実装](https://github.com/supermomonga/zcode-acp/blob/7b3af187d7ee732e9043aed873a863fc855625c2/scripts/check-zcode-releases.ts) を参考とした。公式変更履歴の提供形態が変わった場合や、複数の対応系列を同時に監視する必要が生じた場合に再評価する。実行方法は開発ガイドに記載する。
