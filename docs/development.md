# Development and verification

For installation and usage, see the [README](../README.md#installation).

Node.js **22.12.0 or later** and npm must be available on the development machine and on the Paseo daemon host. CI uses Node.js 22. Git installation uses the Node.js and npm available to the daemon.

If you use mise for development, add the following to the Git-ignored `mise.local.toml`, merging it into an existing `[tools]` section if needed:

```toml
[tools]
node = "22"
```

Review the local configuration, trust it with `mise trust mise.local.toml`, and run `mise install`. Keep this configuration local: Paseo runs Git preparation commands in a fresh checkout on every installation and update, where a tracked `mise.toml` can cause mise's npm shim to reject the untrusted configuration before npm starts. Published plugin sources therefore do not include a mise configuration.

From a local checkout, run `npm ci` to install development dependencies before running the commands below. Development SDKs are pinned to **0.9.0-beta.1**. The minimum supported Paseo runtime remains **0.8.0**; the development SDK version is not the runtime minimum. Client typechecking also installs `react`, `react-native`, and `@types/react` as development dependencies; Paseo supplies their runtime instances. The npm `prepare` hook generates ignored `server/build-info.ts` from `package.json`; `prebuild` regenerates it after version edits. This keeps runtime version metadata inside Paseo's permitted module directories without duplicating the version source.

For Git installation and updates, `paseo-plugin.json` declares `npm ci --include=dev` as its preparation command. Paseo runs this command in the new checkout before compiling the source entry. It installs the locked dependencies, including build-time packages declared in `devDependencies` even under `NODE_ENV=production`, and runs `prepare` to generate the version metadata. No separate `npm run build` is needed for this path: Paseo compiles `index.server.ts` itself.

| Command                                                        | Purpose                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                                            | Check TypeScript types for the server project and the client project separately.                 |
| `npm test`                                                     | Run automated tests for the protocol, mappings, and session handling.                            |
| `npm run build`                                                | Generate `dist/index.server.js` and verify that runtime SDK imports remain external.             |
| `npm run format:check`                                         | Check formatting with Prettier.                                                                  |
| `npm run test:upstream -- /absolute/path/to/upstream-checkout` | Run integration checks using a compatible Paseo checkout's actual compiler and provider adapter. |
| `npm run test:runtime -- /absolute/path/to/workspace`          | Initialize the installed ZCode host and retrieve its model catalog.                              |

`test:upstream` requires a Paseo checkout at `v0.9.0-beta.1` (commit `7c1958f5b0a4ae9f2cb12f77b0a754a644cd0081`). It checks that the checkout matches the installed SDK version and uses the released SDK with the actual upstream manifest reader, preparation runner, compiler, and provider adapter. The harness dependencies resolve from this plugin's `node_modules`. It uses a test implementation of the ZCode host.

The Git preparation checks copy tracked and non-ignored untracked files, using their current working-tree contents, into separate temporary directories outside the harness's dependency tree. They start without `node_modules` or `server/build-info.ts`, execute only the manifest's preparation commands, and verify compilation and provider registration. They run with `NODE_ENV` unset and with `NODE_ENV=production`; each candidate must resolve `es-module-lexer` from its own installed dependencies. These checks require npm registry access and remove their temporary directories on completion or failure.

The check covers registration, model discovery, non-default model selection, switching between models, streaming, usage updates, and provider replacement. The test host returns only the current model in subscription snapshots and session reads/settings responses, while its model selection service contains multiple models. After replacement it waits for the old connection to close, verifies that the old session rejects prompts, and resumes through a new provider instance using the saved persistence handle. It checks native-session reuse, model selection on resume, transcript replay, and a subsequent turn. Persistence records stay in a temporary directory removed when the check finishes. This does not exercise the daemon's automatic recovery or the app UI.

`test:runtime` accesses ZCode's existing user data but does not create conversations or send prompts. Successful model listing or CLI diagnostics alone do not verify that prompts can be sent to a real model.

### Minimum runtime compatibility

To check the updated plugin against the retained minimum, use a disposable Git checkout containing the current plugin sources and lockfile. Keep the development dependencies and lockfile unchanged; replace only the installed SDKs in that disposable checkout:

```bash
npm ci --include=dev
npm install --no-save --package-lock=false @getpaseo/plugin@0.8.0 @getpaseo/client@0.8.0 @getpaseo/protocol@0.8.0
npm run test:upstream -- /absolute/path/to/paseo-v0.8.0
```

The upstream checkout must be at `b8e24677e12b226c7c38c1c3a40649daa9f1152f`. The harness checks its version against the installed SDK and injects that SDK into the compiled server registration and Provider adapter. Clean Git preparation still installs the **0.9.0-beta.1** development dependencies from the unchanged lockfile. This verifies the updated source with the 0.8.0 compiler, adapter, and runtime Provider SDK without weakening the version check. Client registrations use mocked UI modules; this is not a daemon or UI smoke test. Delete the disposable checkout afterward. CI continuously tests 0.9.0-beta.1; this minimum-version check is a separate release check.

### Real model, plan, steering and queue checks

`npm run test:steering-runtime` is opt-in and submits real model requests using your existing ZCode authentication. It creates a temporary workspace and provider mapping store, then checks text guidance, attachment queue execution, a single final completion, stop, native history restoration, cancelled-input absence, and clean shutdown. Temporary local files are removed afterward; ZCode retains the test conversations in its own storage. This checks direct Provider connections, not a Paseo daemon or UI.

`npm run test:model-plan-runtime` is also opt-in and submits real model requests. It checks non-default creation, model changes, every advertised reasoning option on the two selected models, Plan transitions across the three editing modes, approval in each mode, decline, and restoration of model, reasoning level and Plan state through a new connection. It passes the saved editing mode and `settings.plan_mode`, as Paseo does via `featureValues`; native `resumeSession` alone does not retain Plan in 3.12.3. It uses the same temporary-file and retained-conversation policy. Both checks are reused by the isolated E2E runner below.

### Isolated real-model E2E

With an installed ZCode **3.12.3+**, run:

```bash
# GLM_API_KEY must already be set in the environment.
npm run test:e2e
```

This optional command runs both real-model checks in sequence. It is separate from `npm test`, uses a Z.ai Coding Plan API key at `https://api.z.ai/api/coding/paas/v4`, and configures `GLM-5.3-Flash` (default) and `GLM-5.3` (model switching). It submits real requests and consumes Coding Plan quota. Missing credentials or a failed check produce a nonzero exit status; checks are not silently skipped or retried.

The runner supports macOS and Linux. It creates a private temporary ZCode data directory, writes the key to `provider_config.json` with mode `0600`, and uses ZCode's `ZCODE_DATA_BASE_DIR` and `ZCODE_STORAGE_DIR` overrides. Existing login/configuration and conversations are not used. The test subprocess environment excludes `GLM_API_KEY` and unrelated credentials. Computer Use is disabled with the official `ZCODE_CUA_PRODUCT_HELPER=0` setting. Both native conversations and test attachments are removed afterward, including on test failure. Do not upload the temporary directory or native logs as CI artifacts.

These are real-host/provider E2E tests using the **0.9.0-beta.1** Provider SDK. The separate `test:upstream` check exercises Paseo's actual compiler and adapter. The E2E runner does not launch a Paseo daemon or test its UI.

## Pull request CI

The CI workflow runs on every pull request opening, update, and reopening, and on pushes to `main`, without path filters. On Ubuntu with Node.js 22, it installs locked dependencies, checks types, runs unit tests, builds the plugin, and runs `test:upstream`, including both clean Git preparation scenarios. It checks out the exact Paseo commit above alongside the plugin; no installed ZCode app, credentials, or running Paseo daemon is required. The separate **Real ZCode E2E** job downloads the official Linux x64 ZCode 3.12.3 deb, verifies its pinned SHA-256, installs its declared dependencies, and runs `npm run test:e2e` with the repository Actions secret `GLM_API_KEY`. Update the pinned version and checksum together when changing the tested ZCode release.

The workflow also supports manual `workflow_dispatch`. Real-model E2E runs on same-repository PRs and pushes to `main`; fork and Dependabot PRs skip that job because Actions secrets are unavailable. It uses `pull_request`, never `pull_request_target` to execute PR code with credentials. The ordinary tests continue on all PRs. The workflow has read-only repository permissions, a 20-minute test-job timeout, and a 25-minute E2E timeout (8 minutes per real-model check). New runs cancel older runs for the same pull request or branch. When upgrading the Paseo SDK, update the pinned upstream commit in the workflow and these verification instructions together.

## Project structure

- `index.server.ts` — Provider registration and the diagnostics RPC handler.
- `index.client.tsx` — Settings screen registration for the Paseo app.
- `client/` — React Native settings screen.
- `shared/` — Runtime-neutral contracts shared by the daemon and the app.
- `server/provider.ts` — Connection to the public API.
- `server/session.ts` — Public-run and native-turn lifecycle, input correlation, approval, and plan handling.
- `server/models.ts` — Native model selection, per-model reasoning options and effective-selection validation.
- `server/conversation.ts` — V4 command and conversation-state validation, including fragmented frames.
- `server/attachments.ts` — Native persisted attachment uploads.
- `server/status.ts` — Read-only diagnostics handler behind the settings screen.
- `server/discovery/` — Installed ZCode discovery and compatibility checks.
- `server/host/`, `server/protocol/` — Official host startup, communication, and schema validation.
- `test/`, `scripts/` — Test host, build scripts, and upstream API and actual host checks.
- `vendor/paseo/LICENSE` — Upstream license retained for the copied icon.
- `docs/` — Architecture decisions, verification notes, and remaining work.

Server code typechecks with `tsconfig.json`; client code uses `tsconfig.client.json`. The projects are separate because React Native's global `AbortSignal` declaration conflicts with Node's in one program. `scripts/check-upstream.mjs` compiles both entries with Paseo's actual compiler and evaluates their registrations.

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
