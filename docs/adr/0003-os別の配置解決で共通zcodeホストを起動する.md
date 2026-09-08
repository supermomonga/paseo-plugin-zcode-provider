---
number: 3
title: OS別の配置解決で共通ZCodeホストを起動する
status: accepted
date: 2026-09-08
links:
  - target: 2
    kind: amends
---

# OS別の配置解決で共通ZCodeホストを起動する

## Context and Problem Statement

The provider inherited macOS-only discovery from the old patcher although zcode-acp supports macOS, Linux, and Windows layouts. Supporting those installations must preserve the official bundled runtime and the inspected host contract without introducing separate OS-specific protocol implementations.

## Decision Drivers

- Support macOS arm64/x64, Linux arm64/x64, and Windows x64.
- Keep executable, metadata, CLI, and host within the validated installation.
- Distinguish implemented platform support from actual-host verification.

## Considered Options

- Resolve OS-specific layouts and retain one shared host contract.
- Maintain separate host compatibility manifests for each OS.
- Retain the macOS-only restriction.

## Decision Outcome

Resolve the official layout for each OS, following zcode-acp discovery and ADRs 0003 and 0005. Compare bundle metadata with the current process OS and architecture exactly. Use the bundled Electron executable with ELECTRON_RUN_AS_NODE=1 on every OS. Keep one version and host hash/export contract; do not add system Node fallback or ACP translation.

Use /Applications/ZCode.app, /opt/ZCode, and C:\Program Files\ZCode as default roots. Resolve an internal explicit root before PASEO_ZCODE_INSTALL before the OS default. Reject an invalid explicit path without searching other locations. Read the app version from plist on macOS and from app.asar/package.json through bundled Electron on Linux and Windows; failure does not switch sources.

This extends ADR 2's platform coverage while retaining its direct public Provider API integration and ownership boundaries. The inspected macOS artifact is the shared compatibility reference, not evidence that every OS has been exercised.

### Consequences

- Good, because platform differences are isolated to discovery while host compatibility remains strict and shared.
- Good, because nonstandard installations can be selected explicitly without ambiguous searches.
- Bad, because other OS installations still need native runtime verification; mocked discovery tests cannot prove actual Electron behavior or process cleanup.

### Confirmation

Test all five OS/CPU identities, all three layouts, Windows path semantics, explicit-root precedence, missing files, invalid metadata, version and host mismatches, cancellation, and timeout handling. Verify discovered executable and environment propagation into the bridge. Record actual-host checks separately from automated tests in verification.md.

## More Information

See [source provenance](../../NOTICE.md) for the exact zcode-acp revision and [verification](../verification.md) for execution evidence.
