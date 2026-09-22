---
number: 13
title: 公開ソースの公式stdio ServerとV4会話状態を採用する
status: accepted
date: 2026-09-21
links:
  - target: 3
    kind: supersedes
  - target: 6
    kind: supersedes
  - target: 2
    kind: amends
  - target: 7
    kind: amends
  - target: 9
    kind: amends
  - target: 11
    kind: amends
  - target: 12
    kind: amends
  - target: 14
    kind: amendedby
---

# 公開ソースの公式stdio ServerとV4会話状態を採用する

## Context and Problem Statement

ZCode の公開ソースに Services Host を起動する stdio Server と V4 会話契約がある。従来の Electron 親ポート模倣と圧縮 export 探索を維持する理由がなくなった。CLI 単独運用、公式認証の所有権、Paseo 公開 Provider API の意味を保つ必要がある。

## Decision Drivers

- 認証・モデル・会話保存・ツールの所有権を ZCode に保つ。
- 配布物の導入と更新を利用者に任せる。
- 公開ソースと実配布物の証拠を分離する。
- 旧セッション移行・自動フォールバック・Paseo 本体変更を追加しない。

## Considered Options

- 統合 CLI の公式 stdio Services Server。
- Agent app-server へ直接接続する。
- Desktop Host、HTTP/WebSocket、TUI 解析、Agent engine の同梱。

## Decision Outcome

ユーザー承認に従い公式 stdio Services Server を採用する。Services Host の認証・環境管理を維持できるためである。`PASEO_ZCODE_RUNTIME` と `PASEO_ZCODE_NODE` を必須にし、普通の Node.js 24.14.0+ を Server と Agent の双方に使う。セッションごとにプロセスを所有し、EOF で公式 cleanup を開始し、猶予後のみ終了シグナルを使う。

公式 RPC と必要な V4 契約・差分適用を SHA 固定・出典付きで取り込む。独自 NDJSON bridge と旧 dynamic event を撤去する。V4 の sourceCommandId、row ID、product turn ID で入力・表示・実行を対応付ける。受理 ACK 後に一度だけ成功を返し、不明な受付結果を再送しない。キューからの消失だけで消費を判定しない。Paseo の一実行へ複数 native turn を集約し、foreground 完了と background continuation を区別する。停止は対象 execution ID、autoDrain 無効化、待機入力取消を使用する。履歴は同一 epoch/revision/seq でページングする。

独立 Plan と build/edit/yolo を維持し、復元後に明示された設定だけを適用する。質問の自動終了はプロセス内設定で無効化し、native の選択肢を維持する。Hook 信頼と full access を通常承認へ変換しない。

初回送信前の ID mapping を維持し、handle は v3・保存先は sessions-v3 とする。旧形式を拒否し、移行しない。最低版以上の正式版を許可する方針は維持するが、最低版を Server 3.14.0 / Agent 0.16.9 とする。公開ソースのバージョンを公開済み配布物の証拠とは扱わない。

### Consequences

- Good, because Electron と bundle export 探索への依存がなくなる。
- Bad, because RPC/V4 は外部向け安定 SDK ではなく、契約同期と実配布物の検証を継続する必要がある。
- Bad, because 固定 SHA の cold resume は保存済み実行状態を上書きする upstream 不具合を実行試験で確認した。設計の採用は公開承認ではない。Provider 側の補完保存を追加せず、native 試験成功まで公開を止める。

### Confirmation

公式のソース照合、フレーム/状態/受付/停止/履歴/対話の契約試験、Paseo 実 compiler/adapter、隔離した公式 Server/Agent とローカルモデル、別ジョブの実モデル E2E、実 UI を分ける。環境・配布ハッシュ・成功/失敗・未検証項目は [verification](../verification.md) に記録する。

## More Information

ソース基準は `872ad960de7ec172591f7e1952f7849229f94521`。起動・配置に関する ADR 3/6 を置き換える。ADR 2 の公開 API 直結、ADR 7 の最低版方針、ADR 9 の実行集約、ADR 11 の独立 Plan、ADR 12 の隔離 E2E を維持し、本決定で接続・復元・ビルド前提を変更する。公式安定 SDK が公開された場合、必要な Host 責務を満たすか確認して再評価する。
