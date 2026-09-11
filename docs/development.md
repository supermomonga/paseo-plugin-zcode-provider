# Development and verification

For installation and usage, see the [README](../README.md#installation).

From a local checkout, run `npm ci` to install development dependencies before running the commands below. Development SDKs are pinned to **0.8.0**.

| Command                                                        | Purpose                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                            | Check TypeScript types.                                                                          |
| `npm test`                                                     | Run automated tests for the protocol, mappings, and session handling.                            |
| `npm run build`                                                | Generate `dist/index.server.js` and verify that runtime SDK imports remain external.             |
| `npm run format:check`                                         | Check formatting with Prettier.                                                                  |
| `npm run test:upstream -- /absolute/path/to/upstream-checkout` | Run integration checks using a compatible Paseo checkout's actual compiler and provider adapter. |
| `npm run test:runtime -- /absolute/path/to/workspace`          | Initialize the installed ZCode host and retrieve its model catalog.                              |

`test:upstream` requires a Paseo checkout at `v0.8.0` (commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f`). It checks that the checkout matches the installed SDK version and uses the released SDK with the actual upstream compiler and provider adapter. Dependencies resolve from this plugin's `node_modules`. It uses a test implementation of the ZCode host.

The check covers registration, model discovery, streaming, usage updates, and provider replacement. After replacement it waits for the old connection to close, verifies that the old session rejects prompts, and resumes through a new provider instance using the saved persistence handle. It checks native-session reuse, transcript replay, and a subsequent turn. Persistence records stay in a temporary directory removed when the check finishes. This does not exercise the daemon's automatic recovery or the app UI.

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

## Release monitoring

GitHub Actions checks the official [ZCode changelog](https://zcode.z.ai/en/changelog) daily at 09:17 JST and the [Paseo changelog](https://paseo.sh/changelog) at 09:27 JST. Both workflows also support `workflow_dispatch`. Scheduled execution starts after the workflow is on `main`; GitHub may delay scheduled runs.

The ZCode baseline comes from `CURRENT_ZCODE_ARTIFACT.appVersion` in the compatibility manifest. The Paseo baseline comes from the exact `@getpaseo/plugin` development dependency. Update these through normal compatibility work; the checks do not change supported versions automatically.

All newer versions are candidates, including Paseo betas and release candidates. SemVer ordering treats `0.8.0-beta.1 < 0.8.0-beta.2 < 0.8.0-rc.1 < 0.8.0`: a stable release gets its own issue even if a beta issue already exists. Versions older than or equal to the baseline are not reported.

Preview candidates locally without GitHub credentials or issue creation:

```bash
npm run check:zcode-releases -- --dry-run
npm run check:paseo-releases -- --dry-run
```

Dry runs print candidate titles and bodies without checking existing GitHub issues. Normal execution requires `GH_TOKEN` and `GITHUB_REPOSITORY=owner/name`; Actions supplies its standard token with `contents: read` and `issues: write`. No personal access token is required.

Each candidate issue includes its release notes and a product/version marker. The checks use `gh` to read all open and closed issues, exclude pull requests, and skip exact matching titles or markers. Keep the marker when renaming an issue. Closing an issue does not cause it to be recreated. Product-specific concurrency prevents overlapping workflow executions, and rerunning a failed check skips issues already created.

HTTP, parsing, missing notes, and GitHub API errors fail the workflow. Inspect the failed run's logs and fix the source structure or access problem before rerunning. An error is never treated as “no newer release.” The checks create tracking issues only; they do not implement compatibility changes or reopen existing issues.
