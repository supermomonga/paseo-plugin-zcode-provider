---
number: 6
title: Windowsの既定インストール先をユーザー別の場所にする
status: accepted
date: 2026-09-09
links:
  - target: 3
    kind: amends
---

# Windowsの既定インストール先をユーザー別の場所にする

## Context and Problem Statement

Windows discovery used C:\Program Files\ZCode, as recorded in ADR 3. A reported installation instead contains resources\glm\zcode.cjs under C:\Users\code\AppData\Local\Programs\ZCode. Without an explicit root, discovery fails before inspecting that installation.

## Decision Drivers

- Resolve the reported per-user installation without hardcoding a username or drive.
- Keep discovery deterministic and use the same environment as the bundled runtime.
- Preserve explicit configuration for other installation locations.

## Considered Options

- Use LOCALAPPDATA\Programs\ZCode as the Windows default.
- Automatically search both the per-user location and Program Files.
- Keep the Program Files default and require configuration for per-user installations.

## Decision Outcome

Use LOCALAPPDATA\Programs\ZCode as the Windows default, as selected by the user. Pass the discovery environment into default-root resolution. Only when the default is needed, reject missing, empty, or non-absolute LOCALAPPDATA with INVALID_CONFIGURATION and a message explaining LOCALAPPDATA and PASEO_ZCODE_INSTALL.

Retain the priority of the explicit installRoot option, PASEO_ZCODE_INSTALL, then the OS default. Do not search Program Files when discovery fails. Program Files and other installations remain selectable explicitly. This amends only the Windows default-root decision in ADR 3; other platform layouts and the shared host contract remain governed by that ADR.

### Consequences

- Good, because per-user installations resolve from the daemon environment without a machine-specific username.
- Good, because explicit roots do not require LOCALAPPDATA and invalid roots still fail without selecting another installation.
- Bad, because installations relying on the old Program Files default now require PASEO_ZCODE_INSTALL.

### Confirmation

Test the reported path, spaces and Japanese characters, missing and invalid LOCALAPPDATA, explicit-root precedence, missing installations, and all existing OS cases. Check resolved runtime files and child-process arguments and environment. Record mocked checks separately from Windows actual-host verification in verification.md.
