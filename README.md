# ZCode Provider for Paseo

Use ZCode models, tools, and conversation history in [Paseo](https://github.com/getpaseo/paseo). This plugin connects to your installed ZCode app and uses the authentication and models you have configured there.

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

| Component          | Supported configuration                 |
| ------------------ | --------------------------------------- |
| OS / CPU           | macOS / Apple Silicon (`darwin-arm64`)  |
| ZCode              | **3.11.2**, with bundled CLI **0.16.5** |
| ZCode installation | `/Applications/ZCode.app`               |
| Node.js            | **22.12.0 or later**                    |
| Paseo              | **0.8.0-beta.1 or later**.              |

Set up authentication and your models in ZCode first. The plugin checks your ZCode installation at startup and rejects unsupported versions or modified host files.

## Installation

Run these commands on the **machine running the Paseo daemon**.

1. Turn on **Settings → Plugins → Enable plugins** in Paseo for that daemon.
2. Install the plugin from GitHub:

   ```bash
   paseo plugin add supermomonga/paseo-plugin-zcode-provider
   ```

3. Confirm that `zcode-provider` is `running`:

   ```bash
   paseo plugin ls
   ```

Paseo downloads and compiles the plugin automatically; no manual clone, dependency installation, or build is needed. See the [official installation guide](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/v0.8/index.md#install-a-published-plugin) for more options.

> [!NOTE]
> Plugins run with the daemon user's permissions. Make sure you trust the code and its dependencies before installing.

## Usage

Open a workspace on the daemon where you installed the plugin. When creating an agent, select **ZCode** as the provider, then choose a model and mode.

Authentication and available models are managed in the ZCode app. Configure them there before using the provider in Paseo.

## Updates

Update the plugin and check its status:

```bash
paseo plugin update zcode-provider
paseo plugin ls
```

The installation command above tracks this repository's default branch. Check the supported ZCode version in [Requirements](#requirements) when updating.

## Limitations

- Browser control is unsupported. MCP `alwaysLoad` is unsupported, and stdio server commands must use absolute paths.
- **Custom system prompts and `persist: false` are unsupported.** Both produce `INVALID_CONFIGURATION`. This also applies to additional instructions configured in the Paseo daemon or Agent Profiles.
- Integration with the standard account quota, reset time, and provider diagnostics panels is not implemented.
- In the verified Paseo version, initial context usage is not reflected in the standard UI immediately after creating or resuming a session. Subsequent usage updates are delivered.
- The plugin cannot retrieve the mode selected in the creation screen before entering plan mode. API callers can explicitly set `providerOptions.planReturnMode` to `build`, `edit`, or `yolo` when the initial mode is `plan`.
- Steering during generation, conversation rewind, structured output, independent child session management, and automatic conversion of persistence handles from the old patcher are unsupported.

See [remaining work](docs/todo.md) for the evidence and conditions for resolving each limitation.

## Troubleshooting

Check the plugin's status in Paseo's plugin list and inspect **Settings → Plugins → Logs**, or use the CLI:

```bash
paseo plugin ls
paseo plugin logs zcode-provider
```

| Symptom                                          | What to check                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Plugin fails to load                             | Plugins are enabled on the target daemon, the public Provider API is supported, and the installation path is correct. |
| `UNSUPPORTED_PLATFORM`                           | The daemon is running on macOS / arm64.                                                                               |
| `RUNTIME_DISCOVERY_FAILED` / `UNSUPPORTED_ZCODE` | ZCode's installation path, supported versions, and host file integrity.                                               |
| `RUNTIME_SMOKE_FAILED`                           | The bundled CLI works and can access ZCode's user data.                                                               |
| `INVALID_CONFIGURATION`                          | No custom system prompt or nonpersistent session has been requested.                                                  |

Verify the installed versions and files instead of disabling compatibility checks to use an unsupported host.

## Contributing

For build and test commands and the project structure, see the [development guide](docs/development.md). See [NOTICE.md](NOTICE.md) for source and icon attribution.
