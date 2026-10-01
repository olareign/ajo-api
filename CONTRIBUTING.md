# Contributing to ajo-api

## Branches and pull requests

- Work is delivered phase by phase: one branch and one pull request per phase, named `phase-N/<slug>`, started from `main` after the previous phase has merged.
- Fill in the pull request template, including the security checklist.
- CI must be green: audit, format, lint, type-check, unit tests, build, OpenAPI check, integration tests, image build, secret scan, CodeQL and dependency review.

## Test-driven development

All code is written test first: write a failing test that states the behaviour in the words of the product spec, make it pass with the simplest code, then refactor with the tests green.

- **Money logic is tested to 100%** (lines, branches, functions). Modules that move money set coverage thresholds in `vitest.config.ts`.
- **Test through HTTP where behaviour is visible to clients**: status codes, error shapes, validation and authorisation (use `configureApp` so tests run with the real hardening).
- **Use real Postgres and Redis for anything involving transactions, locks or Lua scripts** (`*.int-spec.ts`, Testcontainers). Mocks cannot prove concurrency.
- **Every endpoint gets an authorisation test** proving a user cannot reach another user's data.
- **Name tests after behaviour**, e.g. `"never lets concurrent requests slip past the limit"`.

## Rules for code

- Business rules live in this repository only. Modules own their tables; no module writes another's tables.
- Money is an integer in the currency's smallest unit (`bigint` columns), always with a currency code, and is sent in JSON as a string.
- Every money operation takes an idempotency key and posts balanced ledger entries in one database transaction.
- Schema changes are hand-written migrations with a working `down`, safe to run before the new code is live. `synchronize` is never used.
- Use the TypeORM query builder or parameterised queries only; never build SQL from strings.
- Never log credentials or personal data; add new sensitive field names to `src/logging/logger-options.ts`.
- Partners are called only through adapters in their module, never from controllers.
- Secrets come from the environment (validated in `src/config/env.ts`), never from code or images.
