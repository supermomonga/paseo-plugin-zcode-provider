# Repository Guidelines

## Project Structure

This plugin connects Paseo's public Provider API to the official stdio Services Server included in the integrated ZCode CLI distribution.

- `index.server.ts` / `index.client.tsx`: Server and settings UI registration.
- `server/`: Provider, sessions, and persistence. `discovery/` locates installations; `host/` and `protocol/` handle startup, communication, and validation.
- `client/`: React Native diagnostics UI. `shared/` contains types and contracts shared by the server and client.
- `test/`: Integration tests and `fake-host.ts`. Unit tests also live in `server/`.
- `scripts/`: Build, upstream integration, and runtime verification scripts. `docs/` contains development procedures, verification records, and ADRs. Images live in `images/` and `icon.svg`.

## Development and Verification Commands

Use Node.js **22.12.0 or later** and npm.

- `npm ci`: Install dependencies from the lockfile and generate `server/build-info.ts`.
- `npm run typecheck`: Type-check the server and client separately.
- `npm test`: Run all Vitest tests.
- `npm run build`: Generate `dist/index.server.js` and verify that the runtime SDK is not included in the bundle.
- `npm run format:check` / `npm run format`: Check or apply Prettier formatting.
- `npm run test:upstream -- /absolute/path/to/paseo`: Verify integration using the actual compiler and Provider adapter from a supported Paseo checkout. See `docs/development.md` for the target commit.
- `npm run test:runtime -- /absolute/path/to/workspace`: Initialize the installed host and retrieve the model list. No prompts are sent.
- `npm run test:e2e`: Opt-in real-model checks on macOS/Linux using `GLM_API_KEY` (Z.ai Coding Plan), isolated ZCode data, and the installed host. Also runs in eligible PR CI jobs; separate from `npm test`. See `docs/development.md` for coverage and secret requirements.

There is no standalone development server. The plugin runs on the Paseo daemon; see `README.md` for installation instructions.

## Coding Conventions

Keep TypeScript strict mode and ESM enabled. Match the existing code: use 2-space indentation, double-quoted strings, and semicolons, and format with Prettier. Follow the existing `.js` extension convention when importing local TypeScript modules.

Use kebab-case for filenames, such as `host-contract.ts`, PascalCase for types and classes, and camelCase for functions and variables. Place shared contracts in `shared/`, and keep Node.js and React Native type-checking separate.

## Testing Guidelines

Place tests in `server/**/*.test.ts`, `test/**/*.test.ts`, and `test/**/*.test.mjs`. To run a specific test file, use `npm test -- server/mapping.test.ts`. No minimum coverage threshold is configured. Add tests that reproduce the bugs being fixed, and verify failure behavior and session restoration as appropriate for the scope of the change.

`test:steering-runtime` is an explicitly invoked runtime verification. It sends requests to a real model using existing authentication and leaves test conversations in ZCode. Keep it separate from regular tests.

## Commits and Pull Requests

Write commit messages in English. Follow the commit history by using `feat: ...`, `fix: ...`, and `chore: ...`. A scoped example is `fix(discovery): ...`. Group changes by purpose.

PRs should describe the problem, the resulting behavior, related issues, verification results, and any unverified areas. Include screenshots for UI changes. CI runs type checks, tests, builds, and upstream integration verification. When updating the SDK, update the dependency version, the Paseo commit used in CI, and the development procedures together.

## Design and Configuration Guidelines

Identify the root cause and do not add ad hoc workarounds. Add backward compatibility logic only when explicitly instructed. Consult the existing `docs/adr/` for design decisions. Do not commit credentials, conversation content, generated artifacts, or the local `mise.local.toml`. Use `gh` for GitHub operations and investigations.

- If `ghq` is installed on the local machine and the Paseo source repository has been cloned at `$(ghq root)/getpaseo/paseo`, it is recommended to consult that checkout when investigating Paseo's implementation.
- Limit feature implementations to what is possible within a Paseo plugin. Do not propose implementation plans that require changes to Paseo itself.

- Use `~/ghq/github.com/zai-org/ZCode` as the implementation reference. Record commit SHA and source paths; do not extract Electron/deb bundles for source investigation.
- Current source baseline: `872ad960de7ec172591f7e1952f7849229f94521`. Verify vendored RPC/V4 source with `npm run check:zcode-source`. Keep `server/vendor/zcode` unformatted and retain its license/provenance.
- Require `PASEO_ZCODE_RUNTIME` and ordinary Node.js 24.14.0+ via `PASEO_ZCODE_NODE`. CLI installation and updates belong to the user. Never fall back to Desktop/Electron.
- `npm run test:stdio-runtime` uses the real runtime with isolated data and a local model fixture. Keep source SHA, distribution hashes, runtime versions and actual OS coverage separate. Native contract failures block release.
- Persistence handles use version 3. Do not migrate old Paseo handles or introduce Plan restoration storage.
