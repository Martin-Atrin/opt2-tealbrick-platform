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

## Deploying a service (P1)
From the repo working tree:
```sh
railway link --project opt2 --environment production --service <service>
railway up --detach            # one-off deploy from the working tree
```
Preferred steady state: connect the service to its GitHub repo (`main`) in the Railway UI or `railway add --repo`, so every merge to main deploys. Images for customer workspaces are never built by Railway: they come from the release registry (`registry/README.md`).

## Off limits
v1 Railway project `tealbrick-portal` ("Tealbrick Portal"), its production environment, portal.tealbrick.com and tealbrick.com. Its `staging` environment (old dev, serves dev.tealbrick.com) is read only until the Coordinator says to scrap it.
