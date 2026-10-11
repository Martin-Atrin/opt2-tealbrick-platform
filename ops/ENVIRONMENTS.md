# opt2 environments

## Railway project "opt2" (ours; replaces the old dev environment, later becomes prod)
Environment: `production` (the only one; it is the opt2 test run, Stripe TEST + Clerk DEV keys until cutover).

| Service | Exposure | Source | Notes |
|---|---|---|---|
| portal-core | private only (no public domain) | repo opt2-tealbrick-portal-core | JSON API. Reached only through portal-gui's gateway on the private network (`portal-core.railway.internal`). `DATABASE_URL` = reference `${{Postgres.DATABASE_URL}}`. Holds `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY` (restricted test key), `STRIPE_WEBHOOK_SECRET` (belongs to the old dev webhook endpoint; Core registers its own test-mode endpoint and replaces it). |
| portal-gui | public: `portal-gui-production.up.railway.app`; later `dev.tealbrick.com` | repo opt2-tealbrick-portal-gui | Clerk keys are references to portal-core's variables (one source of truth). |
| website | public preview: `website-production-66a1.up.railway.app` only (no custom domain, decision C13) | repo opt2-tealbrick-website | Static Astro build. |
| Postgres | private only (no TCP proxy) | Railway PostgreSQL template | Volume `postgres-volume`; backups DAILY (6 d retention) + WEEKLY (27 d). Decision C7. |

Rules: secrets are copied with `railway variable set <KEY> --stdin` (never on the command line, never printed). Cross-service values use Railway references, not copies. Keep services minimal (spend authorized, but no idle extras).

## Railway project "opt2-test-customer"
The test customer's own Railway project for the test workspace (Portal deploys bridge + apps INTO it through the Railway link). Empty until Portal Core's deploy path runs. Nothing is created by hand there except for diagnosis.

## Deploying a service (C32)
`node ops/railway-deploy.ts --service <name> --repo opt2-tealbrick-<x> --sha <pushed sha> [--dockerfile <path>]` builds the service from its public GitHub repo at exactly that commit. No Railway GitHub app. `railway up` from a clean, pushed tree is the fallback only. Images for customer workspaces are never built this way: they come from the release index (`registry/README.md`).

| Service | Source (current) |
|---|---|
| db-backup | Martin-Atrin/opt2-tealbrick-platform, `ops/db-backup/Dockerfile`, cron `17 19 * * *` |

## Off limits
v1 Railway project `tealbrick-portal` ("Tealbrick Portal"), its production environment, portal.tealbrick.com and tealbrick.com. Its `staging` environment (old dev, serves dev.tealbrick.com) is read only until the Coordinator says to scrap it.
