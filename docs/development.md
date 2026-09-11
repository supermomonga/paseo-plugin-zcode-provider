# Development and verification

For installation and usage, see the [README](../README.md#installation).

Node.js **22.12.0 or later** and npm must be available on the development machine and on the Paseo daemon host. CI uses Node.js 22. Git installation uses the Node.js and npm available to the daemon.

If you use mise for development, add the following to the Git-ignored `mise.local.toml`, merging it into an existing `[tools]` section if needed:

```toml
[tools]
node = "22"
```

Review the local configuration, trust it with `mise trust mise.local.toml`, and run `mise install`. Keep this configuration local: Paseo runs Git preparation commands in a fresh checkout on every installation and update, where a tracked `mise.toml` can cause mise's npm shim to reject the untrusted configuration before npm starts. Published plugin sources therefore do not include a mise configuration.

From a local checkout, run `npm ci` to install development dependencies before running the commands below. Development SDKs are pinned to **0.8.0**. The npm `prepare` hook generates ignored `server/build-info.ts` from `package.json`; `prebuild` regenerates it after version edits. This keeps runtime version metadata inside Paseo's permitted module directories without duplicating the version source.

For Git installation and updates, `paseo-plugin.json` declares `npm ci --include=dev` as its preparation command. Paseo runs this command in the new checkout before compiling the source entry. It installs the locked dependencies, including build-time packages declared in `devDependencies` even under `NODE_ENV=production`, and runs `prepare` to generate the version metadata. No separate `npm run build` is needed for this path: Paseo compiles `index.server.ts` itself.

| Command                                                        | Purpose                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                            | Check TypeScript types.                                                                          |
| `npm test`                                                     | Run automated tests for the protocol, mappings, and session handling.                            |
| `npm run build`                                                | Generate `dist/index.server.js` and verify that runtime SDK imports remain external.             |
| `npm run format:check`                                         | Check formatting with Prettier.                                                                  |
| `npm run test:upstream -- /absolute/path/to/upstream-checkout` | Run integration checks using a compatible Paseo checkout's actual compiler and provider adapter. |
| `npm run test:runtime -- /absolute/path/to/workspace`          | Initialize the installed ZCode host and retrieve its model catalog.                              |

`test:upstream` requires a Paseo checkout at `v0.8.0` (commit `b8e24677e12b226c7c38c1c3a40649daa9f1152f`). It checks that the checkout matches the installed SDK version and uses the released SDK with the actual upstream manifest reader, preparation runner, compiler, and provider adapter. The harness dependencies resolve from this plugin's `node_modules`. It uses a test implementation of the ZCode host.

The Git preparation checks copy only Git-tracked files, using their current working-tree contents, into separate temporary directories outside the harness's dependency tree. They start without `node_modules` or `server/build-info.ts`, execute only the manifest's preparation commands, and verify compilation and provider registration. They run with `NODE_ENV` unset and with `NODE_ENV=production`; each candidate must resolve `es-module-lexer` from its own installed dependencies. These checks require npm registry access and remove their temporary directories on completion or failure.

The check covers registration, model discovery, streaming, usage updates, and provider replacement. After replacement it waits for the old connection to close, verifies that the old session rejects prompts, and resumes through a new provider instance using the saved persistence handle. It checks native-session reuse, transcript replay, and a subsequent turn. Persistence records stay in a temporary directory removed when the check finishes. This does not exercise the daemon's automatic recovery or the app UI.

`test:runtime` accesses ZCode's existing user data but does not create conversations or send prompts. Successful model listing or CLI diagnostics alone do not verify that prompts can be sent to a real model.

## Pull request CI

The CI workflow runs on every pull request opening, update, and reopening, and on pushes to `main`, without path filters. On Ubuntu with Node.js 22, it installs locked dependencies, checks types, runs unit tests, builds the plugin, and runs `test:upstream`, including both clean Git preparation scenarios. It checks out the exact Paseo commit above alongside the plugin; no installed ZCode app, credentials, or running Paseo daemon is required. CI does not run `test:runtime`.

The workflow has read-only repository permissions and a 20-minute timeout. New runs cancel older runs for the same pull request or branch. When upgrading the Paseo SDK, update the pinned upstream commit in the workflow and these verification instructions together.

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

The ZCode verification baseline comes from `VERIFIED_ZCODE_ARTIFACT.appVersion` in the compatibility manifest. The Paseo baseline comes from the exact `@getpaseo/plugin` development dependency. Update verification evidence through normal compatibility work. `MINIMUM_ZCODE_VERSION` separately controls which stable releases may start; verifying a newer release does not automatically raise the minimum. The checks do not change either value automatically.

All newer versions are candidates, including Paseo betas and release candidates. SemVer ordering treats `0.8.0-beta.1 < 0.8.0-beta.2 < 0.8.0-rc.1 < 0.8.0`: a stable release gets its own issue even if a beta issue already exists. Versions older than or equal to the baseline are not reported.

Preview candidates locally without GitHub credentials or issue creation:

```bash
npm run check:zcode-releases -- --dry-run
npm run check:paseo-releases -- --dry-run
```

Dry runs print candidate titles and bodies without checking existing GitHub issues. Normal execution requires `GH_TOKEN` and `GITHUB_REPOSITORY=owner/name`; Actions supplies its standard token with `contents: read` and `issues: write`. No personal access token is required.

Each candidate issue includes its release notes and a product/version marker. The checks use `gh` to read all open and closed issues, exclude pull requests, and skip exact matching titles or markers. Keep the marker when renaming an issue. Closing an issue does not cause it to be recreated. Product-specific concurrency prevents overlapping workflow executions, and rerunning a failed check skips issues already created.

HTTP, parsing, missing notes, and GitHub API errors fail the workflow. Inspect the failed run's logs and fix the source structure or access problem before rerunning. An error is never treated as “no newer release.” The checks create tracking issues only; they do not implement compatibility changes or reopen existing issues.
