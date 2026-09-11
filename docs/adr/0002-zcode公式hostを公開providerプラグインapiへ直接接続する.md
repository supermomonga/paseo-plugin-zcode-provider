---
number: 2
title: ZCode公式hostを公開ProviderプラグインAPIへ直接接続する
status: accepted
date: 2026-09-07
links:
  - target: 3
    kind: amendedby
  - target: 5
    kind: amendedby
  - target: 7
    kind: amendedby
  - target: 8
    kind: amendedby
---

# ZCode公式hostを公開ProviderプラグインAPIへ直接接続する

## Context and Problem Statement

The patcher integrates ZCode by changing internal provider, UI, diagnostics, and usage code. Current main exposes a public ProviderRegistration contract, but its extension points do not cover every patcher feature. We need to remove core patching while preserving native session, permission, and planning semantics wherever the public contract permits it.

## Decision Drivers

- Use the supported provider registration boundary without modifying the daemon or app.
- Preserve native host ownership of credentials, sessions, and interaction responses.
- Report unsupported behavior explicitly; do not invent missing state or silently ignore requested configuration.
- Keep host compatibility tied to inspected artifacts and make upstream gaps reviewable.

## Considered Options

- Implement ProviderRegistration directly against the existing native host bridge.
- Insert an ACP adapter between the host and the provider plugin.
- Keep patching core to reproduce all UI and diagnostic integrations.

## Decision Outcome

Implement ProviderRegistration / ProviderConnection directly. The plugin translates native session state and notifications into public provider events and owns the host processes within each connection. This preserves native permission IDs and plan responses without an additional protocol translation. Only implemented capabilities are advertised.

The inspected host remains ZCode 3.11.2 with CLI 0.16.5 on macOS arm64. The host hashes and RPC exports are checked before use. Unsupported public inputs, including custom system prompts and nonpersistent sessions, fail explicitly. Missing standard UI integrations remain documented TODOs requiring upstream extension points.

Development uses an unchanged, attributed snapshot of the public provider API at the verified main commit because the published 0.7.2 SDK does not export it yet. The snapshot is excluded from runtime bundles; the daemon supplies the actual SDK module. Replace this development snapshot after a release includes the API and its package contract has been verified.

### Consequences

- Good, because the plugin no longer depends on modifying built-in provider registries, fixed schemas, or app bundles.
- Good, because native authentication and persistence retain their existing owner; the plugin does not distribute credentials or proprietary host bundles.
- Bad, because standard quota panels, initial usage replay, provider diagnostics, and draft mode history remain incomplete until core provides the required APIs.
- Bad, because private ZCode host changes still require investigation and a deliberate compatibility update. Old patcher persistence handles are not automatically migrated.

### Confirmation

Validate public events against the pinned SDK schemas, exercise the native bridge and provider lifecycle with tests, and use the actual upstream compiler and adapter in scripts/check-upstream.mjs. Keep live-host checks and unperformed UI checks distinct in docs/verification.md.

## More Information

See [remaining work](../todo.md), [source provenance](../../NOTICE.md), and [verification](../verification.md). Revisit this decision if an official ZCode SDK exposes the required semantics or the public provider contract changes. New upstream capabilities should replace only the corresponding documented limitations, without introducing core patches or timing-based workarounds.
