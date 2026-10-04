# ajo-api

The backend for Àjọ: a NestJS API and background worker that own every business rule, the ledger, payments, KYC, the èsúsú engine and all partner integrations. The web app ([olareign/Ajo](https://github.com/olareign/Ajo)) and the future mobile app are clients of this API.

Project docs (spec, architecture, plan, threat model) live in [olareign/Ajo/docs](https://github.com/olareign/Ajo/tree/main/docs).

## Stack

| Concern      | Choice                                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| Framework    | NestJS 12 (ESM) on Express                                                             |
| Database     | PostgreSQL 17 (PostGIS image) through TypeORM; schema changes only by migrations       |
| Jobs         | BullMQ on Redis, run by a separate worker process from the same image                  |
| API contract | OpenAPI generated from the code (`openapi.json`), checked in CI                        |
| Tests        | Vitest and supertest; integration tests on real Postgres and Redis with Testcontainers |
| Hosting      | Render (Blueprint in `render.yaml`): API, worker, Postgres, Key Value                  |

## Run it locally

```sh
corepack enable
pnpm install
cp .env.example .env
docker compose up -d            # Postgres, Redis, Mailpit on 127.0.0.1 only
pnpm build && pnpm migration:run
pnpm start:dev                  # http://localhost:3000/api/v1/health/ready
```

API docs are served at `/api/docs` when `API_DOCS_ENABLED=true` (refused in production).

## Commands

| Command                                                   | What it does                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:watch`                           | Unit and HTTP tests                                                                                                                                              |
| `pnpm test:integration`                                   | Integration tests against real Postgres and Redis (needs Docker)                                                                                                 |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check`      | Static checks                                                                                                                                                    |
| `pnpm build`                                              | Compile to `dist/`                                                                                                                                               |
| `pnpm migration:create src/database/migrations/<name>`    | New empty migration; write the SQL by hand, then add it to `migrations/index.ts`                                                                                 |
| `pnpm migration:run`                                      | Apply pending migrations (Render runs this before each deploy)                                                                                                   |
| `scripts/sql/bring-database-up-to-date.sql`               | The schema as one re-runnable script for a SQL editor; keep in step with `migrations/`                                                                           |
| `pnpm mail:check you@example.com`                         | Send one real email with the configured provider (`MAIL_PROVIDER=smtp` or `resend`) to prove it works                                                            |
| `pnpm kyc:override <email> approve\|deny\|clear` / `list` | Approve or hold one person without the identity checks while they are pended; every change is logged (`KYC_AUTO_APPROVE=true` approves everyone, test keys only) |
| `pnpm retention:run`                                      | Delete expired sessions and tokens once (the worker also does this every six hours)                                                                              |
| `pnpm openapi:generate` / `pnpm openapi:check`            | Write or verify `openapi.json`                                                                                                                                   |

## Security baseline

- Configuration is validated at startup; errors name variables, never values. API docs cannot be enabled in production.
- Helmet headers (`default-src 'none'`, HSTS with preload, frame denial), `Cache-Control: no-store`, no `x-powered-by`.
- No CORS: browsers reach the API only through the web app's server-side BFF.
- Global validation rejects unknown fields; JSON bodies capped at 100 KB.
- One error shape; unexpected errors return a generic message and a request id, never internals.
- Rate limiting on every route, stored in Redis with an atomic script so limits hold across instances.
- Structured logs with request ids; credentials and personal data redacted.
- Non-root container; graceful shutdown on SIGTERM; health checks that never reveal hostnames.
- CI: dependency audit, Gitleaks, CodeQL, dependency review, Actions pinned to commit SHAs.

See [SECURITY.md](SECURITY.md) to report a vulnerability.
