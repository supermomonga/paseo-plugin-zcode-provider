# ZCode Provider for Paseo

Use ZCode models, tools and conversations through Paseo's public Provider API. The plugin launches the **official stdio Services Server from the integrated ZCode CLI distribution**, which it can set up for you. Authentication, models, tools and conversation storage remain owned by ZCode. ZCode Desktop is not required.

> Mode/Plan restoration is guaranteed when Paseo supplies both saved settings on resume. Without them, the pinned ZCode source can restore an older editing mode and drop Plan. That upstream defect remains unresolved and is outside the supported restoration contract. See [verification and remaining checks](docs/verification.md).

This is an unofficial plugin. It is not endorsed or maintained by ZCode or Z.ai. The official RPC/V4 implementation is public source, but it is not a stable third-party SDK.

## Requirements

| Setting        | Requirement                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Paseo          | 0.8.0 or later; development SDK 0.9.0-beta.1                                                                 |
| Plugin Node.js | 22.12.0 or later (the Paseo daemon's runtime)                                                                |
| Managed setup  | darwin-arm64, linux-x64, linux-arm64, win-x64, win-arm64                                                     |
| ZCode          | Managed: 3.14.3 with Node.js 24.21.0. Overrides: stable Server 3.14.0+ / Agent 0.16.9+ with Node.js 24.14.0+ |

## Installation

Enable **Settings → Plugins → Enable plugins** for the target daemon, then install and inspect:

```bash
paseo plugin add supermomonga/paseo-plugin-zcode-provider
paseo plugin ls
```

Paseo prepares the Git checkout and compiles the plugin. Update with `paseo plugin update zcode-provider`. Plugins execute with the daemon user's permissions.

## Setup

Open **Settings → Plugins → zcode-provider → Setup** and choose **Download and install**. The screen lists every download, its SHA-256, size and license before you start. Setup runs on the machine hosting the daemon:

- Node.js 24.21.0 from nodejs.org.
- The ZCode runtime 3.14.3 from this repository's [releases](https://github.com/supermomonga/paseo-plugin-zcode-provider/releases/tag/zcode-runtime-v3.14.3). ZCode does not publish its integrated CLI, so this is an **unofficial build** of the unmodified public source, made and verified by CI. It is not endorsed or maintained by ZCode or Z.ai.

Both archives are verified against SHA-256 values pinned in the plugin and extracted to `$XDG_DATA_HOME/paseo-plugin-zcode-provider/runtimes`, or `~/.local/share/paseo-plugin-zcode-provider/runtimes`. `PATH` and other installations are not changed. The plugin never installs anything until you start setup.

After setup, the screen shows a login command. Run it in a terminal on the daemon machine to sign in through ZCode's browser authorization (`--no-browser` prints the URL). Then choose **ZCode** when creating an agent. The plugin neither decrypts nor copies credentials.

**Remove** on the same screen deletes the managed runtime; `paseo plugin remove` does not. ZCode settings, logins and conversations are kept.

### Using your own runtime

Set both variables in the daemon's environment and restart the daemon to bypass the managed runtime:

```bash
export PASEO_ZCODE_RUNTIME=/absolute/path/to/zcode   # extracted integrated CLI distribution
export PASEO_ZCODE_NODE=/absolute/path/to/node       # ordinary Node.js 24.14.0 or later
```

`PASEO_ZCODE_RUNTIME` must contain `server/remote/zcode-server.cjs`, `agent/zcode.cjs`, its provider configuration, and `package.json`. Setting only one variable is an error. Newer stable versions are allowed, including major versions; passing the minimum check does not certify compatibility. A terminal export does not change an already running Desktop application. Electron, `process.execPath` and Desktop discovery are never used.

Session environment variables are forwarded, subject to ZCode's own proxy, certificate and runtime environment handling.

The source baseline is `29628c9acdb81b703bbd4080c207a0e7ce5e276e` (ZCode `v3.14.3`). The managed runtime passed the stdio runtime contract on all five managed platforms in CI. See the [verification record](docs/verification.md) for exact coverage.

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

New conversations support listing, resume and paged V4 history. Mode/Plan restoration requires both `mode` and `settings.plan_mode` saved by Paseo. The plugin applies them after native restore and confirms the resulting state before reporting the session ready. Omitted settings retain whatever ZCode returns, which can be stale on the pinned source; restoration of those values is not guaranteed. There is no private Plan restoration store. [ADR 14](docs/adr/0014-paseoの保存設定を再適用する復元を保証範囲とする.md) limits the guarantee to this supported path; settings-free restoration is checked separately with `npm run test:native-restore`. Existing ZCode databases may be migrated by ZCode itself on startup; the native tests isolate the home, configuration and database.

## Diagnostics

**Settings → Plugins → zcode-provider → Diagnostics** shows whether the managed runtime or the environment override is in use, the runtime and Node.js paths and versions, Server/Agent versions and hashes, minimum-version assessment and mapping location. The screen is read-only. Its optional version check does not prove that authentication or a model call succeeds.

```bash
paseo plugin logs zcode-provider
```

For failures, report the operation, error code, structured diagnostic and versions/hashes. Native stderr, raw errors, credentials and conversation bodies are excluded from diagnostics. Review any additional material before sharing. Reports are not sent automatically.

## Development and license

See [development](docs/development.md), [verification](docs/verification.md), [remaining work](docs/todo.md), [ADR 13](docs/adr/0013-公開ソースの公式stdio-serverとv4会話状態を採用する.md) and [ADR 15](docs/adr/0015-プラグイン管理のzcodeランタイムとnode-jsを設定画面から導入する.md).

Original code is [MIT](LICENSE). Vendored ZCode RPC/contracts retain their upstream license and provenance. The ZCode runtime releases are Apache-2.0 builds of unmodified upstream source and include ZCode's LICENSE, NOTICE.md and THIRD-PARTY-NOTICES.md; third-party components keep their own terms. Node.js is downloaded from nodejs.org, not redistributed. The icon retains Apache-2.0 attribution; the historical screenshot includes third-party UI and branding. See [NOTICE](NOTICE.md).
