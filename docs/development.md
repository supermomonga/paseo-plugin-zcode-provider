# Development

Use Node.js 22.12.0+ and npm for the plugin. ZCode runs separately using the configured ordinary Node.js 24.14.0+ executable.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run format:check
npm run check:zcode-source -- ~/ghq/github.com/zai-org/ZCode
npm run test:upstream -- /absolute/path/to/paseo
```

`test:upstream` uses Paseo's actual plugin compiler, Git preparation and Provider adapter. Use commit `7c1958f5b0a4ae9f2cb12f77b0a754a644cd0081` (0.9.0-beta.1), matching the installed development SDK. It checks clean npm preparation of a Git checkout both with `NODE_ENV` unset and `production`, installation of the `npm pack` tarball with Paseo's npm acquisition options, server/client registration and the provider icon of both, V4 timeline, guidance, attachment queue aggregation, stop, provider replacement, history and Plan configuration on resume. The adapter fixture uses the official V4 schemas and delta application; it does not prove native behavior.

## Source of truth

Inspect `~/ghq/github.com/zai-org/ZCode`, not extracted Electron/deb bundles. The current baseline is `29628c9acdb81b703bbd4080c207a0e7ce5e276e`. Record that SHA and source paths in investigations. Source version, release version and artifact identity are separate facts.

`server/vendor/zcode` contains the needed official RPC modules, V4 contracts, wire assembler and pure delta application with their transitive schema dependencies. It contains no Agent engine, authentication implementation, tools or storage engine. Paseo's compiler requires executable plugin modules to live under `server/`, `client/` or `shared/`, hence this location. `provenance.json` records entrypoints, original/modified hashes and the only import rewrite (a private workspace alias to its relative source). The upstream Apache-2.0 LICENSE and full NOTICE are retained, along with the relevant Visual Studio Code MIT notice extracted from THIRD-PARTY-NOTICES.md. The extraction and full original file hash are recorded. `npm run build` also copies these notices to `dist/licenses/zcode`.

Verify the files with `npm run check:zcode-source`. To deliberately resynchronize the fixed SHA, run `node scripts/sync-zcode-source.mjs /absolute/ZCode --write`; changing the SHA requires reviewing contract changes, the minimum versions and runtime evidence together. The sync script reads `git show <SHA>:<path>`, not possibly modified checkout files. Do not format vendored source. Unexpected vendored files fail verification.

`download:zcodecjs` and deb extraction tests have been removed. Release monitoring still uses the official changelog and its separately recorded last reviewed release (3.14.3), which matches the pinned v3.14.3 source tag. A changelog release without public source (such as 3.14.4) is not a baseline. Associate GitHub tags/releases when available; do not create an Issue for every main commit.

## Managed runtime and its releases

Users install the runtime from the Setup screen (ADR 15). `server/runtime/pins.ts` pins Node.js archives from nodejs.org and the `zcode-runtime-v<version>` release of this repository by URL, SHA-256 and size. The installer downloads to a staging directory under `runtimes/`, checks the size limit and SHA-256, extracts with the system `tar` (Windows uses `%SystemRoot%\System32\tar.exe`, which also reads zip), verifies Node's version and the runtime layout, writes a marker and renames the result into place. A lock directory with the owner PID prevents concurrent setup; a lock from a dead process is reclaimed.

To use it locally without touching your real data directory:

```bash
XDG_DATA_HOME=/tmp/zcode-data npm run setup:managed-runtime
XDG_DATA_HOME=/tmp/zcode-data npm run test:stdio-runtime
```

To pin a new Node.js version, take the five archive checksums from `SHASUMS256.txt`, verify its signature against the [nodejs/release-keys](https://github.com/nodejs/release-keys) active keyring in a temporary `GNUPGHOME`, and record the sizes.

To publish a ZCode runtime, update the source baseline first, then push an annotated `zcode-runtime-v<version>` tag on a commit containing it. `.github/workflows/zcode-runtime-release.yml` builds the official distribution, adds the upstream notices and `BUILD-INFO.json` with `scripts/package-zcode-runtime.mjs`, runs `test:stdio-runtime` on all five managed platforms, attests the archive and creates a non-latest release. Rebuilds are not byte-identical, so pin the published asset's SHA-256 and size, never a local build. Pull requests that touch the packaging run the same build and verification without publishing.

## Build an isolated integrated CLI

For investigation, build the official distribution from an isolated checkout/archive of the pinned source. Do not change the reference clone or a user's installed runtime.

With ordinary Node.js 24.14.0+ and the repository's pnpm version (10.33.2) on PATH, in that isolated ZCode checkout:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b packages/shared
node scripts/build-zcode.mjs --base-url https://example.invalid/zcode/
```

The explicit shared-package TypeScript build supplies `packages/shared/dist`; the packaging script requires it but the baseline does not otherwise generate it. This uses the official tsconfig without patching source. The URL is build metadata for this development artifact, not a download source.

Extract `dist/zcode/releases/3.14.3/zcode-3.14.3.tar.gz` **outside the checkout**, and configure `PASEO_ZCODE_RUNTIME` to the extracted `zcode` directory and `PASEO_ZCODE_NODE` to the explicit Node binary. Record the archive SHA-256, Server/Agent hashes, source SHA, OS/CPU and Node version independently. Do not infer a source SHA from matching version strings.

The baseline's remote terminal service cannot locate the integrated distribution's `node-pty` prebuild. The Agent's Bash tool uses a different path and passes actual execution tests. Do not copy native binaries into guessed paths; see [verification](verification.md).

## Runtime checks

`npm run test:runtime -- /absolute/workspace` initializes the configured official Server and reads its catalog using existing ZCode data. It sends no prompt and creates no conversation, but native startup may perform database migrations.

`npm run test:stdio-runtime` exercises the real extracted Server and Agent against a deterministic **local HTTP model fixture**, without billable API calls. It isolates HOME, ZCode settings, the SQLite database, temp sockets, workspace and plugin mappings. It checks catalog, draft, Bash, acknowledgements, completion, paged replay, mode/Plan restore **with both saved Paseo settings**, questions, tool approval, targeted stop and restart, session listing and owned Agent exit after Server SIGKILL. The test captures the settings before shutdown, closes the Server, opens a separate connection and requires the restored settings to be reported before `session.ready`. Any failed assertion exits nonzero. It deletes test data after cleanup. Loopback and Unix sockets require execution outside a restrictive network sandbox.

`npm run test:native-restore` adds a strict check of cold resume **without explicit settings** to the same isolated runner. It fails on the pinned source because ZCode replaces saved execution state with an old message mode and Plan OFF. This path is outside the supported restoration contract, so this command is separate from required CI and release conditions; there is no `continue-on-error` or blanket error suppression. Run it when evaluating official runtime updates and record the outcome. A successful upstream check is evidence for reconsidering the guarantee, not an automatic expansion of it. See [ADR 14](adr/0014-paseoの保存設定を再適用する復元を保証範囲とする.md).

`npm run test:steering-runtime` and `npm run test:model-plan-runtime` send **real model requests** using existing authentication and leave native conversations when invoked directly. They are not part of ordinary tests. Use the isolated runner below for routine validation.

## Isolated real-model E2E

```bash
# Existing GLM_API_KEY: Z.ai Coding Plan key. Never print it.
npm run test:e2e
```

Set both runtime variables, or `XDG_DATA_HOME` containing a managed runtime, first. The runner writes a private, temporary official provider configuration using the existing key, isolates HOME/configuration/SQLite/temp sockets, and passes no unrelated credentials to child processes. It runs model/reasoning, independent Plan transitions and approval/decline, followed by real guidance, attachment queue, stop and resume checks. Its mode/Plan restoration supplies both saved Paseo settings, matching `test:stdio-runtime`. Test data is removed even after failures.

CI runs ordinary non-billable tests, actual Paseo integration and vendored-source verification on Node 22. A matrix job installs the pinned managed runtime with the plugin's installer on darwin-arm64, linux-x64, linux-arm64, win-x64 and win-arm64 runners (plugin on Node 22, ZCode on the managed Node.js) and executes the non-billable Provider contract check. Eligible non-fork PRs and pushes additionally run isolated real-model E2E with `GLM_API_KEY` on the managed runtime; no Desktop/deb installation is used. Failures of the supported contract or E2E block release. Actual OS coverage is recorded only after execution, not inferred from workflow configuration.

## Plugin releases

The plugin is published to npm as `paseo-plugin-zcode-provider` (ADR 16). Run the **Version Bump** workflow from `main` with patch, minor or major, or an explicit `MAJOR.MINOR.PATCH` version. It bumps `package.json` and `package-lock.json` with `npm version`, opens a `release/v<version>` pull request and dispatches CI on it. Merging the pull request makes the **Release** workflow tag `v<version>`, run `npm publish` with npm trusted publishing (provenance included, no token) and create a GitHub release with generated notes. A failed publish after tagging needs a manual `npm publish` from the tag or a new patch release; the workflow acts only when the version changes.

`npm pack` and `npm publish` ship the files listed in `package.json` without tests, and `prepack` removes the Git-only `build` commands from the packed `paseo-plugin.json`: Paseo runs them for npm installations too, where `npm ci` fails without a lockfile. `postpack` restores the manifest; after an interrupted pack, restore `paseo-plugin.json.git` as the message says. Runtime libraries other than Paseo's host modules (`@getpaseo/plugin/*`, `zod`) belong in `dependencies`, because npm installation omits development dependencies.

The first version is published by hand from `main`, because a trusted publisher can only be configured for an existing package: `npm publish`, then tag `v<version>` and create its GitHub release. Then register the trusted publisher with `npm trust github paseo-plugin-zcode-provider --file release.yml --repo supermomonga/paseo-plugin-zcode-provider --allow-publish` (or in the package settings on npmjs.com, allowing `npm publish`). Publishing access can then require two-factor authentication and disallow tokens. The repository setting that allows GitHub Actions to create pull requests must stay enabled for the Version Bump workflow.

## Architecture

Paseo and ZCode themselves must remain unmodified. Changes belong to this Provider plugin; a fork, source patch or patched upstream runtime is not an implementation option. Official configuration and protocol operations remain available. For mode/Plan resume, the plugin reapplies both settings when Paseo supplies them and waits for native confirmation before accepting prompts. This is the supported restoration contract. Omitted values use the state returned by ZCode and are not guaranteed to match the state before shutdown. Keep that upstream defect documented and reproducible with `test:native-restore` until an unmodified official version resolves it.

`discovery/` validates the environment override or, without one, the installed managed runtime. `runtime/` holds the pins and the installer behind the Setup screen. `host/bridge.ts` owns hello/ack, official binary framing, RPC, process preferences and process shutdown. `conversation.ts` owns one V4 state, wire assembly, sequencing, resync and coherent history paging. `session.ts` coordinates admissions, public execution IDs, stop and native configuration. `presentation.ts` translates rows and interactions to Paseo. `persistence.ts` stores only the pre-send logical/native identity mapping. Authentication remains in Services Host.

Model admission is never retried after an unknown outcome. Only a stale conditional control command, which confirms no mutation occurred, may be retried with the returned revision. Recovery must not mix history epochs/revisions or publish a partial recovery window as complete history. Foreground execution and background continuation are distinct. Product turn IDs, row IDs and source command IDs have different meanings.
