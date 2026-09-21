# ZCode Provider for Paseo

Use ZCode models, tools and conversations through Paseo's public Provider API. The plugin launches the **official stdio Services Server from the integrated ZCode CLI distribution**. Authentication, models, tools and conversation storage remain owned by ZCode. ZCode Desktop is not required.

> This migration is not ready for release. The pinned upstream source restores an older editing mode and drops Plan during cold resume, even though the correct execution state is present in its database. The native regression test intentionally fails. See [verification and release blockers](docs/verification.md).

This is an unofficial plugin. It is not endorsed or maintained by ZCode or Z.ai. The official RPC/V4 implementation is public source, but it is not a stable third-party SDK.

## Requirements and configuration

Configure the machine running the Paseo daemon:

| Setting               | Requirement                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paseo                 | 0.8.0 or later; development SDK 0.9.0-beta.1                                                                                                                                  |
| Plugin Node.js        | 22.12.0 or later                                                                                                                                                              |
| `PASEO_ZCODE_RUNTIME` | Absolute path to an extracted **integrated CLI distribution**, containing `server/remote/zcode-server.cjs`, `agent/zcode.cjs`, its provider configuration, and `package.json` |
| `PASEO_ZCODE_NODE`    | Absolute path to **ordinary Node.js 24.14.0 or later**, used for both Server and Agent                                                                                        |
| ZCode                 | Stable Server 3.14.0+ / Agent 0.16.9+; necessary files and runtime contracts are checked                                                                                      |

```bash
export PASEO_ZCODE_RUNTIME=/absolute/path/to/zcode
export PASEO_ZCODE_NODE=/absolute/path/to/node
```

Set these in the daemon's environment, then restart the daemon. A terminal export does not change an already running Desktop application. Electron, `process.execPath`, Desktop discovery and `PASEO_ZCODE_INSTALL` are not alternative launch paths. Missing or invalid settings fail explicitly.

You install and update the CLI and its Node.js runtime. Set up authentication and models using the official CLI/TUI. The plugin neither decrypts nor copies credentials. Session environment variables are forwarded, subject to ZCode's own proxy, certificate and runtime environment handling.

The source baseline is `872ad960de7ec172591f7e1952f7849229f94521`. Its version strings do not prove that a public CLI artifact has been released or verified. [Build and validation instructions](docs/development.md) distinguish source, distribution hashes and actual runtime results. Newer stable versions are allowed, including major versions; passing the minimum check does not certify compatibility. Only macOS arm64 has been exercised locally for this migration. Other OS/CPU combinations remain unverified.

## Installation

Enable **Settings → Plugins → Enable plugins** for the target daemon, then install and inspect:

```bash
paseo plugin add supermomonga/paseo-plugin-zcode-provider
paseo plugin ls
```

Paseo prepares the Git checkout and compiles the plugin. Choose **ZCode** when creating an agent. Update with `paseo plugin update zcode-provider`. Plugins execute with the daemon user's permissions.

## Behavior

- Models and reasoning options come from ZCode. Editing modes are `build`, `edit`, and `yolo`; `settings.plan_mode` is independent.
- Text, thoughts, tools, subagent progress, usage and history use V4 snapshots and deltas. Tool output is marked when ZCode truncates it. Usage is cumulative; repeated snapshots do not add it again.
- Text submitted during generation uses native guidance. Attachments use the native queue. Paseo reports one run across these native turns and completes it only after all accepted input has been consumed and foreground work has ended.
- Acceptance is reported once, after the native acknowledgement. Unknown delivery results are never automatically resent. Stop identifies the current native execution, disables automatic queue execution and removes pending input. A new explicit run enables the queue again.
- Native permission IDs, option values, questions and Plan approval retain their meanings. Question auto-resolution is disabled for each owned Server. Workspace hook trust is reviewed through the official CLI; it is not represented as “allow once.”
- Each session owns its Server process and environment. Metadata requests use temporary Servers. Closing stdin gives ZCode time to clean up before process termination.

The plugin uses ZCode's own skills, MCP configuration and tools. Browser/Computer Use, generic rewind, independent Paseo child agents, hook-review UI and Goal/Workflow controls are outside this migration. `prompt.output_schema`, custom system prompts and `persist:false` are unsupported. MCP `alwaysLoad` is unsupported; stdio MCP commands must be absolute paths. Standard Paseo quota and initial usage UI limitations are not filled with substitute displays.

## Persistence

New handles use **version 3**. Versions 1 and 2 are rejected without migration or replacement. Old Paseo sessions are outside this migration.

Unsent conversations are deferred drafts. Before the first prompt, the plugin atomically saves the logical-to-native ID mapping under `$XDG_STATE_HOME/paseo-plugin-zcode-provider/sessions-v3`, or `~/.local/state/paseo-plugin-zcode-provider/sessions-v3`. It stores identifiers and workspace paths, not message bodies. Preserve this directory for backup. A mapping write failure prevents sending. Corrupt mappings and missing native conversations fail explicitly; no replacement conversation is created.

New conversations support listing, resume and paged V4 history. Explicit settings supplied by Paseo on resume are applied after native restore. There is no private Plan restoration store. **The pinned upstream cold-resume defect remains a release blocker.** Existing ZCode databases may be migrated by ZCode itself on startup; the native tests isolate the home, configuration and database.

## Diagnostics

**Settings → Plugins → zcode-provider → Diagnostics** shows the configured runtime, explicit Node.js executable/version, Server/Agent versions and hashes, minimum-version assessment and mapping location. The screen is read-only. Its optional version check does not prove that authentication or a model call succeeds.

```bash
paseo plugin logs zcode-provider
```

For failures, report the operation, error code, structured diagnostic and versions/hashes. Native stderr, raw errors, credentials and conversation bodies are excluded from diagnostics. Review any additional material before sharing. Reports are not sent automatically.

## Development and license

See [development](docs/development.md), [verification](docs/verification.md), [remaining work](docs/todo.md) and [ADR 13](docs/adr/0013-公開ソースの公式stdio-serverとv4会話状態を採用する.md).

Original code is [MIT](LICENSE). Vendored ZCode RPC/contracts retain their upstream license and provenance. The icon retains Apache-2.0 attribution; the historical screenshot includes third-party UI and branding. See [NOTICE](NOTICE.md).
