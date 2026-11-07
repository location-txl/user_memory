# Repository Guidelines

## Project Structure & Module Organization

This local, cross-agent memory service uses Markdown as the source of truth; SQLite stores events, jobs, receipts, and search indexes.

- `src/memory/`: storage, recall, and extraction workers.
- `src/cli.ts`, `src/service.ts`, `src/server.ts`, `src/mcp.ts`: CLI, login service management, HTTP, and MCP entry points.
- `src/adapters/` and `src/integrations/`: agent hooks, setup, and imports; `adapters/hermes/` contains the Python provider.
- `src/web/`: React UI, CSS, and English/Chinese locales.
- `tests/backend/`, `tests/integration/`: regression suites; `scripts/verify-web.mjs` verifies browser flows. `docs/verification.md` documents verification.
- `dist/`: generated CLI, server, and web build output.

## Build, Test, and Development Commands

Use Node.js 24+, pnpm 10.22.0, and Python 3 for Hermes tests.

- `pnpm install --frozen-lockfile`: install locked dependencies.
- `pnpm serve`: start the local backend; `pnpm dev`: start Vite with `/v1` proxied to port 43123.
- `pnpm umem --home /tmp/umem-dev serve --no-worker`: run an isolated development service without extraction.
- `pnpm build`: compile TypeScript and bundle the UI.
- `pnpm typecheck`: check strict TypeScript types.
- `pnpm test`: run all Vitest tests; `pnpm test:watch`: watch mode.
- `pnpm test:backend`: backend and Hermes tests; `pnpm test:integration`: integration tests.
- `pnpm test:web`: build and run Playwright verification; requires an available browser.
- `pnpm format:check`: check formatting with Prettier.

## Coding Style & Naming Conventions

Follow existing two-space indentation, double quotes, semicolons, and ESM imports with `.js` extensions. Use English identifiers and keys, camelCase functions, PascalCase types/components, and descriptive filenames such as `cli-command.ts`. Keep related functionality together. Validate external values at their owning boundary; avoid speculative abstractions and redundant checks. Comment only non-obvious constraints or decisions.

## Testing Guidelines

Name Vitest files `*.test.ts`. Reuse `tests/backend/fixtures.ts` for temporary homes and real Markdown/SQLite storage. Isolate model calls, host configuration, and system commands; never read personal memory or credentials. Cover changed behavior and regressions. No numeric coverage threshold is configured. PR CI runs type checking, Vitest, and Hermes tests.

## Commit & Pull Request Guidelines

History uses Conventional Commits, including `fix(hooks):`, `feat(web):`, `test:`, and `feat(cli)!:` for breaking changes, often with Chinese descriptions. PRs should explain behavior changes, link relevant issues, report validation, and include screenshots for UI changes. Document configuration or compatibility changes. Never commit tokens or personal data. Agents must obtain explicit Git instructions before mutating repository state or history.
