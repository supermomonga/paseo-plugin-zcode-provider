# ![ZCode](icon.svg) ZCode Provider for Paseo

A provider plugin for using ZCode models, tools, and conversation history in [Paseo](https://github.com/getpaseo/paseo). It connects directly to the official host from your installed ZCode app through the public Provider API. No Paseo core patches or ACP adapter are required.

> [!NOTE]
> This plugin is under development. It requires Paseo **0.8.0-beta.1 or later**. Initialization and model listing have been verified against the actual ZCode host, but sending prompts, running tools, and restoring conversations after a restart through the Paseo UI remain unverified. See the [verification notes](docs/verification.md) for details.

> [!IMPORTANT]
> This project is an unofficial tool and is not officially released, endorsed, or maintained by ZCode or Z.ai.

> [!WARNING]
> This plugin uses ZCode's undocumented headless mode. It does not modify the ZCode application itself or include any implementation that bypasses its communications. However, there is no guarantee that it will not be interpreted as violating the [Terms of Service](https://zcode.z.ai/en/terms). Therefore, please use it at your own risk.

## Features

- **Model and mode selection** — Model discovery, thinking settings, and `build` / `edit` / `plan` / `yolo` modes.
- **Conversations and tools** — Text and image prompts, slash commands, streaming responses, and tool execution status.
- **Approvals and questions** — Tool permissions, structured questions, plan approval and rejection, and generation interruption.
- **Persistence and restoration** — Conversation lists per workspace, importing existing ZCode conversations, and history restoration.
- **Session configuration** — MCP server configuration and notifications for token, cost, and context usage.

The ZCode host manages credentials, model settings, and conversation storage. This repository does not bundle ZCode or credentials.

## Requirements

These requirements apply to the **machine running the Paseo daemon**.

| Component          | Supported configuration                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| OS / CPU           | macOS / Apple Silicon (`darwin-arm64`)                                      |
| ZCode              | **3.11.2**, with bundled CLI **0.16.5**                                     |
| ZCode installation | `/Applications/ZCode.app`                                                   |
| Node.js            | **22.12.0 or later**                                                        |
| Paseo              | **0.8.0-beta.1 or later**. Development SDKs are pinned to **0.8.0-beta.1**. |

Set up authentication and your models in ZCode first. At startup, the plugin checks app and CLI versions, host file hashes and RPC exports, and bundled CLI operation. Unsupported versions or hosts cannot be used. Compatibility information is pinned in the [manifest](server/discovery/manifest.ts).

## Getting started

1. Place the repository on the daemon machine, then install dependencies and run the checks from its root directory.

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   ```

2. Turn on **Settings → Plugins → Enable plugins** in Paseo.
3. Follow [Install and try it in the official guide](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/v0.8/index.md#install-and-try-it) to install a local plugin using the repository's absolute path.
4. Confirm that `zcode-provider` is `running`, then select **ZCode** when creating an agent on that daemon. The provider ID is `zcode`.

> [!NOTE]
> Plugins run with the daemon user's permissions. Make sure you trust the code and its dependencies before installing.

Paseo compiles `index.server.ts`. Install from the repository root, not `dist/`. To apply changes, run `npm run typecheck` successfully, then follow the official [reload instructions](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/v0.8/index.md#edit-and-reload).

## Limitations

- Browser control is unsupported. MCP `alwaysLoad` is unsupported, and stdio server commands must use absolute paths.
- **Custom system prompts and `persist: false` are unsupported.** Both produce `INVALID_CONFIGURATION`. This also applies to additional instructions configured in the Paseo daemon or Agent Profiles.
- Integration with the standard account quota, reset time, and provider diagnostics panels is not implemented.
- In the verified Paseo version, initial context usage is not reflected in the standard UI immediately after creating or resuming a session. Subsequent usage updates are delivered.
- The plugin cannot retrieve the mode selected in the creation screen before entering plan mode. API callers can explicitly set `providerOptions.planReturnMode` to `build`, `edit`, or `yolo` when the initial mode is `plan`.
- Steering during generation, conversation rewind, structured output, independent child session management, and automatic conversion of persistence handles from the old patcher are unsupported.

See [remaining work](docs/todo.md) for the evidence and conditions for resolving each limitation.

## Development and verification

| Command                                                        | Purpose                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                            | Check TypeScript types.                                                                          |
| `npm test`                                                     | Run automated tests for the protocol, mappings, and session handling.                            |
| `npm run build`                                                | Generate `dist/index.server.js` and verify that runtime SDK imports remain external.             |
| `npm run format:check`                                         | Check formatting with Prettier.                                                                  |
| `npm run test:upstream -- /absolute/path/to/upstream-checkout` | Run integration checks using a compatible Paseo checkout's actual compiler and provider adapter. |
| `npm run test:runtime -- /absolute/path/to/workspace`          | Initialize the installed ZCode host and retrieve its model catalog.                              |

`test:upstream` requires a Paseo checkout at `v0.8.0-beta.1`. It checks that the checkout matches the installed SDK version and uses the released SDK with the actual upstream compiler and provider adapter. Dependencies resolve from this plugin's `node_modules`. It uses a test implementation of the ZCode host.

`test:runtime` accesses ZCode's existing user data but does not create conversations or send prompts. Successful model listing or CLI diagnostics alone do not verify that prompts can be sent to a real model.

### Project structure

- `index.server.ts` — Provider registration.
- `server/provider.ts` — Connection to the public API.
- `server/session.ts` — Conversation, approval, and plan handling.
- `server/discovery/` — Installed ZCode discovery and compatibility checks.
- `server/host/`, `server/protocol/` — Official host startup, communication, and schema validation.
- `test/`, `scripts/` — Test host, build scripts, and upstream API and actual host checks.
- `vendor/paseo/LICENSE` — Upstream license retained for the copied icon.
- `docs/` — Architecture decisions, verification notes, and remaining work.

Development and tests use the published `@getpaseo/plugin/server/provider` module. Paseo supplies this SDK module at runtime; it remains external to the build. See the [ADRs](docs/adr/README.md) for design rationale and [NOTICE.md](NOTICE.md) for source and icon attribution.

## Troubleshooting

Check the plugin's status in Paseo's plugin list and inspect **Settings → Plugins → Logs**.

| Symptom                                          | What to check                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Plugin fails to load                             | Plugins are enabled on the target daemon, the public Provider API is supported, and the installation path is correct. |
| `UNSUPPORTED_PLATFORM`                           | The daemon is running on macOS / arm64.                                                                               |
| `RUNTIME_DISCOVERY_FAILED` / `UNSUPPORTED_ZCODE` | ZCode's installation path, supported versions, and host file integrity.                                               |
| `RUNTIME_SMOKE_FAILED`                           | The bundled CLI works and can access ZCode's user data.                                                               |
| `INVALID_CONFIGURATION`                          | No custom system prompt or nonpersistent session has been requested.                                                  |

Verify the installed versions and files instead of disabling compatibility checks to use an unsupported host.
