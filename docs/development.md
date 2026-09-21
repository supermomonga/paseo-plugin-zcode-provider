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

`test:upstream` uses Paseo's actual plugin compiler, Git preparation and Provider adapter. Use commit `7c1958f5b0a4ae9f2cb12f77b0a754a644cd0081` (0.9.0-beta.1), matching the installed development SDK. It checks clean npm preparation both with `NODE_ENV` unset and `production`, server/client registration, V4 timeline, guidance, attachment queue aggregation, stop, provider replacement, history and Plan configuration on resume. The adapter fixture uses the official V4 schemas and delta application; it does not prove native behavior.

## Source of truth

Inspect `~/ghq/github.com/zai-org/ZCode`, not extracted Electron/deb bundles. The current baseline is `872ad960de7ec172591f7e1952f7849229f94521`. Record that SHA and source paths in investigations. Source version, release version and artifact identity are separate facts.

`server/vendor/zcode` contains the needed official RPC modules, V4 contracts, wire assembler and pure delta application with their transitive schema dependencies. It contains no Agent engine, authentication implementation, tools or storage engine. Paseo's compiler requires executable plugin modules to live under `server/`, `client/` or `shared/`, hence this location. `provenance.json` records entrypoints, original/modified hashes and the only import rewrite (a private workspace alias to its relative source). The upstream Apache-2.0 LICENSE and full NOTICE are retained, along with the relevant Visual Studio Code MIT notice extracted from THIRD-PARTY-NOTICES.md. The extraction and full original file hash are recorded. `npm run build` also copies these notices to `dist/licenses/zcode`.

Verify the files with `npm run check:zcode-source`. To deliberately resynchronize the fixed SHA, run `node scripts/sync-zcode-source.mjs /absolute/ZCode --write`; changing the SHA requires reviewing contract changes, the minimum versions and runtime evidence together. The sync script reads `git show <SHA>:<path>`, not possibly modified checkout files. Do not format vendored source. Unexpected vendored files fail verification.

`download:zcodecjs` and deb extraction tests have been removed. Release monitoring still uses the official changelog and its separately recorded last reviewed release (3.12.3), not the source-only 3.14.0 baseline. Associate GitHub tags/releases when available; do not create an Issue for every main commit.

## Build an isolated integrated CLI

CLI installation is a user responsibility. For development/CI, build the official distribution from an isolated checkout/archive of the pinned source. Do not change the reference clone or a user's installed runtime.

With ordinary Node.js 24.14.0+ and the repository's pnpm version (10.33.2) on PATH, in that isolated ZCode checkout:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b packages/shared
node scripts/build-zcode.mjs --base-url https://example.invalid/zcode/
```

The explicit shared-package TypeScript build supplies `packages/shared/dist`; the packaging script requires it but the baseline does not otherwise generate it. This uses the official tsconfig without patching source. The URL is build metadata for this development artifact, not a download source.

Extract `dist/zcode/releases/3.14.0/zcode-3.14.0.tar.gz` **outside the checkout**, and configure `PASEO_ZCODE_RUNTIME` to the extracted `zcode` directory and `PASEO_ZCODE_NODE` to the explicit Node binary. Record the archive SHA-256, Server/Agent hashes, source SHA, OS/CPU and Node version independently. Do not infer a source SHA from matching version strings.

The baseline's remote terminal service cannot locate the integrated distribution's `node-pty` prebuild. The Agent's Bash tool uses a different path and passes actual execution tests. Do not copy native binaries into guessed paths; see [verification](verification.md).

## Runtime checks

`npm run test:runtime -- /absolute/workspace` initializes the configured official Server and reads its catalog using existing ZCode data. It sends no prompt and creates no conversation, but native startup may perform database migrations.

`npm run test:stdio-runtime` exercises the real extracted Server and Agent against a deterministic **local HTTP model fixture**, without billable API calls. It isolates HOME, ZCode settings, the SQLite database, temp sockets, workspace and plugin mappings. It checks catalog, draft, Bash, acknowledgements, completion, paged replay, mode/Plan restore, questions, tool approval, targeted stop and restart, session listing and owned Agent exit after Server SIGKILL. It deletes test data after cleanup. Its nonzero exit on the upstream Plan restore defect is deliberate; do not weaken the assertion to publish this baseline. Loopback and Unix sockets require execution outside a restrictive network sandbox.

`npm run test:steering-runtime` and `npm run test:model-plan-runtime` send **real model requests** using existing authentication and leave native conversations when invoked directly. They are not part of ordinary tests. Use the isolated runner below for routine validation.

## Isolated real-model E2E

```bash
# Existing GLM_API_KEY: Z.ai Coding Plan key. Never print it.
npm run test:e2e
```

Set both runtime variables first. The runner writes a private, temporary official provider configuration using the existing key, isolates HOME/configuration/SQLite/temp sockets, and passes no unrelated credentials to child processes. It runs model/reasoning, independent Plan transitions and approval/decline, followed by real guidance, attachment queue, stop and resume checks. The explicit Paseo settings supplied in that resume test are distinct from native-only Plan restore in `test:stdio-runtime`. Test data is removed even after failures.

CI runs ordinary non-billable tests, actual Paseo integration and vendored-source verification on Node 22. A separate Node 24 job builds the pinned official distribution and executes the non-billable real-runtime contract check. Eligible non-fork PRs and pushes additionally run isolated real-model E2E with `GLM_API_KEY`; no Desktop/deb installation is used. A failing native contract check blocks release. Actual OS coverage is recorded only after execution, not inferred from workflow configuration.

## Architecture

`discovery/` validates the explicitly configured runtime. `host/bridge.ts` owns hello/ack, official binary framing, RPC, process preferences and process shutdown. `conversation.ts` owns one V4 state, wire assembly, sequencing, resync and coherent history paging. `session.ts` coordinates admissions, public execution IDs, stop and native configuration. `presentation.ts` translates rows and interactions to Paseo. `persistence.ts` stores only the pre-send logical/native identity mapping. Authentication remains in Services Host.

Model admission is never retried after an unknown outcome. Only a stale conditional control command, which confirms no mutation occurred, may be retried with the returned revision. Recovery must not mix history epochs/revisions or publish a partial recovery window as complete history. Foreground execution and background continuation are distinct. Product turn IDs, row IDs and source command IDs have different meanings.
