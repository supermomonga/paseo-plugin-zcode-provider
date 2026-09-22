---
number: 14
title: Paseoの保存設定を再適用する復元を保証範囲とする
status: accepted
date: 2026-09-21
links:
  - target: 13
    kind: amends
---

# Paseoの保存設定を再適用する復元を保証範囲とする

## Context and Problem Statement

ADR 13 は ZCode 単独の mode / Plan 復元の成功も公開条件としていた。固定ソースでは過去のメッセージから導出した mode が保存済み実行状態より優先されるため、この条件で必須 CI が失敗し、後続の実モデル E2E も実行されない。

Paseo は保存した `modeId` と `featureValues` を Provider の `mode` と `settings` に渡す。Provider が公式 API で両方を再適用する経路は、実ランタイムと実 UI で確認済みである。Paseo・ZCode 本体は改変不可という条件の下、ユーザーはこの経路に復元の保証範囲を限定することを承認した。

## Decision Drivers

- Paseo が保持する設定を明示的に適用し、Plan と編集 mode を独立に扱う。
- 必須 CI は Provider が保証する動作を検証する。
- 上流の設定省略時の不具合を再現可能なまま記録する。
- 本体のパッチ、補完保存、旧接続方式への切替を追加しない。

## Considered Options

- Paseo が保存した両設定を再適用する復元を保証する。
- 設定省略時の復元も必須とし、公式の修正を待つ。

## Decision Outcome

ユーザーの選択に従い、mode / Plan の復元保証は、Paseo が保存した `mode` と `settings.plan_mode` の両方を渡す場合に限定する。Provider は ZCode の再開後に公式 API で設定を適用し、V4 の状態が一致してから再開完了を通知する。既存の実装を維持し、設定値を推測したり別に保存したりしない。

`test:stdio-runtime` は閉じる前に通知された実際の設定を保存し、Server を終了して別接続から再開するときに渡す。反映済みの設定が `session.ready` より先に通知され、履歴が復元されることを必須 CI で確認する。設定適用の失敗、他の runtime 契約の失敗、実モデル E2E の失敗は引き続き CI を失敗させる。

設定省略時の復元は保証対象外とする。Provider は省略された値を補完せず、ZCode が返した状態を公開するため、固定ソースでは古い mode / Plan OFF になる場合がある。別コマンド `test:native-restore` でこの経路の厳密な検証を残し、失敗時は非ゼロ終了する。この検証は必須 CI・公開条件から外し、ランタイム更新時に実施する。上流不具合を修正済みとは扱わない。

### Consequences

- Good, because 本体改変なしで提供できる復元と必須 CI の条件が一致し、実モデル E2E も実行できる。
- Good, because 上流の復元挙動は別の厳密な検証で継続確認できる。
- Bad, because 設定を持たない呼び出し元では mode / Plan の復元を保証できない。

### Confirmation

契約試験で build / edit / yolo と Plan true / false の 6 通りを検証する。無改変の公式 Server / Agent とローカル模擬モデルでは、保存設定ありの再開を通常チェック、設定省略を追加の上流チェックとして個別に実行する。実 compiler / adapter、実モデル E2E、実 UI の証拠とは分けて [verification](../verification.md) に記録する。

## More Information

ADR 13 の接続方式、V4、保存形式、責務分担は維持し、復元の保証範囲と公開条件を変更する。公式の無改変ランタイムで `test:native-restore` が成功するようになった際に、設定省略時の保証を改めて判断する。単にバージョン番号が上がったことだけで保証範囲を広げない。
