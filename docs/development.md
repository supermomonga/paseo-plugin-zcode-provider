# Development and verification

For installation and usage, see the [README](../README.md#installation).

From a local checkout, run `npm ci` to install development dependencies before running the commands below. Development SDKs are pinned to **0.8.0-beta.1**.

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

## Project structure

- `index.server.ts` — Provider registration.
- `server/provider.ts` — Connection to the public API.
- `server/session.ts` — Conversation, approval, and plan handling.
- `server/discovery/` — Installed ZCode discovery and compatibility checks.
- `server/host/`, `server/protocol/` — Official host startup, communication, and schema validation.
- `test/`, `scripts/` — Test host, build scripts, and upstream API and actual host checks.
- `vendor/paseo/LICENSE` — Upstream license retained for the copied icon.
- `docs/` — Architecture decisions, verification notes, and remaining work.

Development and tests use the published `@getpaseo/plugin/server/provider` module. Paseo supplies this SDK module at runtime; it remains external to the build. See the [ADRs](adr/README.md) for design rationale and [NOTICE.md](../NOTICE.md) for source and icon attribution.
