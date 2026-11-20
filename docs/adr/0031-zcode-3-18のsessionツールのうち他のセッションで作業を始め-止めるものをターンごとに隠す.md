---
number: 31
title: ZCode 3.18のSessionツールのうち他のセッションで作業を始め・止めるものをターンごとに隠す
status: accepted
date: 2026-11-20
links:
  - target: 19
    kind: amends
---

# ZCode 3.18のSessionツールのうち他のセッションで作業を始め・止めるものをターンごとに隠す

## Context and Problem Statement

ZCode 3.18 で、モデルがほかの ZCode のセッションを扱う Session のツールが加わった（変更履歴の「Session management Tool」、`apps/zcode-cli/packages/core/src/tool/session-control/index.ts`、fec9759）。CLI 単体には ListSessions・ReadSession・CreateSession・ForkSession・SendToSession・WaitSessions・InterruptSession・RenameSession があり、App の変種には ListProjects・OpenSession・SetSessionArchived・SetSessionPinned が加わる。どれも ToolSearch の後ろにあり、読み取り以外は承認を求める（権限 `session_control.<method>`）。

ツールは、Host が `session/requestRuntimePreferences` に `appControlEnabled: true` と答えたときに登録される。stdio の Server は、`createLocalServices` で常に `appControlService` を作り（`packages/services/src/node.ts`）、エージェントのサービスはそれがあれば `appControlEnabled` を真にする（`zcodeAgentService.ts`）。つまり、このプロバイダが起動する Server のセッションでも、App の変種が有効になる。Desktop の画面は要らず、OpenSession だけが使えない。

CreateSession・ForkSession が作るセッションと、SendToSession が始めるターンは、プロバイダの Server の中で動くが、Paseo のエージェントを持たない。Paseo には見えず、アイドル時の解放（ADR 25）の判断にも入らない。Paseo のセッションが解放されて Server が止まると、その作業も止まる。InterruptSession は、Paseo が管理するセッションのターンも止められる。一方、Paseo 自身が、エージェントを作り、メッセージを送るツールを持っている。

ユーザーは、作業を始める・止める書き込み系のツールだけを隠し、読み取り系を残す案を選んだ。

## Decision Drivers

- Paseo から見えない場所で、ZCode の作業を始めたり止めたりしない。
- アイドル時の解放（ADR 25）で、見えない作業を失わない。
- 公式の手段だけを使い、ZCode の挙動を変えるパッチを足さない（ADR 19 の制限）。
- 害の無いツールまで取り上げない。

## Considered Options

- 作業を始める・止めるツール（CreateSession・ForkSession・SendToSession・InterruptSession）を、ターンごとの `toolDisallowlist` で隠す。
- すべての Session のツールを隠す。
- 隠さず、承認に任せる。

## Decision Outcome

Chosen option: "作業を始める・止めるツールを、ターンごとの `toolDisallowlist` で隠す", because Paseo の管理の外で作業が動く原因だけを、公式の手段で取り除けるからである。

- プロバイダが送るすべての `sendText` の `toolDisallowlist` に、ADR 19 の `mcp__node_repl__js` に加えて CreateSession・ForkSession・SendToSession・InterruptSession を入れる（`server/unsupported-capabilities.ts` の `TURN_TOOL_DISALLOWLIST`）。ZCode は、ターンのツールをこの名前で除き（`turn-tool-visibility.ts` の `getTurnTools`）、ToolSearch の候補もそのツールから作る。
- ListSessions・ReadSession・WaitSessions・ListProjects は残す。RenameSession・SetSessionArchived・SetSessionPinned も残す。ZCode のセッションの一覧の表示を変えるだけで、作業を始めも止めもせず、実行の前に承認を求める。
- ほかの ZCode のクライアント（Desktop など）のセッションから、Paseo のセッションへ送られた入力は、送り手を書いた通知として出す（ユーザーの発言としては出さない）。

### Consequences

- Good, because Paseo の管理の外で ZCode の作業が始まらず、アイドル時の解放で失われる作業が増えない。
- Good, because ZCode のパッチや設定ファイルを変えず、管理下ランタイムでも `PASEO_ZCODE_RUNTIME` のランタイムでも同じに効く。
- Bad, because `sendGoalCommand` は `toolDisallowlist` を受け取らないので、ゴールのターンでは隠せない（ADR 27 と同じ制約）。そのときも、書き込み系のツールは実行の前に承認を求める。
- Bad, because ZCode の Session のツールでほかのセッションを作るワークフローは、Paseo からは使えない。Paseo のエージェントを作るツールで代える。
- Neutral, because 隠すツールの名前は ZCode のソースに依存する。名前が変わったら、`test:stdio-runtime` の確認で分かる。

### Confirmation

- `test/provider.test.ts` で、すべての `sendText` の `toolDisallowlist` に四つのツールが入ることを確かめる。
- `npm run test:stdio-runtime` で、3.18 以降の実ランタイムのモデルへの要求に、ListSessions が出て、四つのツールがツールにも ToolSearch の告知にも出ないことを確かめる。

## Pros and Cons of the Options

### 作業を始める・止めるツールを、ターンごとの `toolDisallowlist` で隠す

- Good, because 問題の原因だけを取り除き、読み取りと表示の整理は使える。
- Good, because 公式の `toolDisallowlist` だけで済む。
- Bad, because ゴールのターンには効かない。

### すべての Session のツールを隠す

- Good, because 考えることが少ない。
- Bad, because 害の無い読み取りのツールまで使えなくなる。

### 隠さず、承認に任せる

- Good, because ZCode と同じ道具が使える。
- Bad, because 承認の後の作業が Paseo から見えず、`yolo` のモードでは承認も無い。アイドル時の解放で止まる作業が生じる。

## More Information

- ADR 19 は、このプロバイダで動かない能力を隠す判断である。この ADR は、動くが Paseo の管理の外で作業を生むツールを隠す判断で、ターンごとの指定の仕組みを共有する。
- 検証の記録は [verification.md](../verification.md) にある。
