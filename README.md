# Subscrify

Subscriptions app for Shopify by MARKA MODERN RETAIL PRIVATE LIMITED.
Merchants sell product subscriptions (subscribe & save, prepaid) and
memberships (recurring fee + perks). Runs on Azure, engineered for hundreds
of merchants.

## The two invariants (never violate)

1. **Never overbill.** Every recurring charge goes through Shopify's
   billing-attempt mutations with an idempotency key from
   `app/lib/billing/idempotency.server.ts`, derived from contract + billing
   cycle. A retried job can never double-charge.
2. **Every read and write is shop-scoped.** Multi-tenant system; no query,
   job, cache key, or webhook handler touches data without an explicit shop
   identifier.

## Stack

- React Router v7 + Vite + TypeScript (Shopify's official app template)
- Prisma + PostgreSQL (from the first migration — never SQLite; the billing
  engine depends on Postgres locking/concurrency)
- Polaris + App Bridge
- Azure: Container Apps, PostgreSQL Flexible Server, Service Bus, Key Vault,
  App Insights — all in `infra/` (Bicep), deployed by GitHub Actions OIDC

## Development (owner's Mac)

```shell
docker compose -f docker-compose.dev.yml up -d   # local Postgres 16
cp .env.example .env                              # then fill values
npm install
npx prisma migrate deploy
shopify app dev                                   # add --use-localhost if the tunnel is flaky
```

Dev store: `subscrify-test.myshopify.com` (log in as Admin Shapify — never
the live Divine Hindu account). Never test against the live store.

## Repo rules

- Lockfiles are intentionally untracked (see `.gitignore`).
- CI runs typecheck, unit tests, migrations against clean Postgres, and the
  production build on every push.
- `infra/` is the only source of truth for cloud resources — nothing is ever
  hand-created in the Azure portal.

## App identity

- Dev Dashboard app: Subscrify (ID 403702841345, handle `subscrify-1`)
- Public distribution; Subscriptions API access granted 2026-07-30
- Config: `shopify.app.toml`
