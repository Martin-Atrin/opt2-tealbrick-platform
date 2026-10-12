# opt2 incident runbook

Scope: our side of Teal Brick (Railway project "opt2": portal-core, portal-gui, website, Postgres, db-backup, status) plus the release index. Customer workspaces (bridge + apps in the customer's Railway) keep working while Portal is down until their grants expire (CORE §3); their incidents follow §6.
Rules that always apply: never print secrets; copy values with `railway variable set <KEY> --stdin`; deploy only pushed commits (`ops/railway-deploy.ts`); never touch v1 (project "tealbrick-portal" production, portal.tealbrick.com, tealbrick.com).

## 1. Detect
| Signal | Where | Means |
|---|---|---|
| Status page red | https://status-production-62da.up.railway.app (JSON: `/api/status`) | a probe failed: Portal, API→Core, Core health (private), website, release index |
| GlitchTip uptime alert | the GlitchTip host (URL in the operator notes), org tealbrick: "opt2 portal-gui", "opt2 dev.tealbrick.com", "opt2 website", "opt2 status page" | public endpoint down |
| GlitchTip heartbeat missed | "opt2 db-backup nightly" | last night's dump or restore test failed or did not run |
| GlitchTip issues spike | projects opt2-portal-core, opt2-portal-gui | errors in Core or GUI (PII scrubbed server-side) |
| Railway deploy failed / crash loop | Railway project opt2 → service → Deployments | health check (`/internal/health` Core, `/healthz` status) failing |
| Woodpecker red | the Woodpecker UI (private network only; URL in `~/.config/opt2-tealbrick/hosts.env` as `WOODPECKER_URL`, not in this repo) | CI; `template-audit` red = a repo below `ci/MIN_TEMPLATE`; the platform `registry-sync` GitHub Actions run red = a release candidate was rejected |

## 2. Triage (first 10 minutes)
1. Which probes are red on the status page? Core health red + API red → Core or Postgres. Only API red → gateway (portal-gui) config. Portal red → GUI deploy or DNS.
2. Railway → opt2 → the red service → latest deployment: status, build/deploy logs (`railway logs -s <service> -e production`). Note the deployed commit SHA.
3. Was there a deploy in the last hour? If yes, roll back first (§3), investigate after.
4. Postgres: Railway → Postgres → Metrics (disk, connections). Disk full → grow the volume in Railway; do not delete data.
5. DNS/TLS: `dig CNAME dev.tealbrick.com` must be `1spe7wwp.up.railway.app`; Railway → portal-gui → Settings → Domains must show the certificate VALID.
6. Write a one-line incident note (time, symptom, suspected cause) in `ops/INCIDENTS.md` before changing anything else.

## 3. Roll back (pinned SHA)
Every opt2 service is built from a pushed commit; the previous good SHA is in the Railway deployment list (and in the deploying lead's STATUS note).
```sh
cd <workspace>/opt2-tealbrick-platform
node ops/railway-deploy.ts --service <portal-core|portal-gui|website|status|db-backup> --repo opt2-tealbrick-<repo> --sha <previous good sha> [--dockerfile <path>]
```
Faster for a bad deploy: Railway → service → Deployments → previous SUCCESS deployment → "Redeploy" (same image, no rebuild).
Database: rollbacks never run down-migrations by hand. If a migration broke data, restore (§5) into a new database and switch `DATABASE_URL` only after checking it.
Customer workspaces: a bad app/bridge release is never edited in the index; publish a fixed newer version (`registry-add-source` / CI tag) — Core deploys the newest on the channel; owners can roll back an instance with `instances.rollback`.

## 4. Key rotation
| Key | Where | Procedure |
|---|---|---|
| Core `TB_KEK` | portal-core variable | `ops/KEYS.md` "Portal Core KEK rotation" (C47): previous → new → deploy re-seals → drop previous |
| Clerk DEV / Stripe TEST keys, webhook secret | portal-core variables | new key in the provider dashboard → save to a 0600 file → `railway variable set <KEY> --stdin` → deploy → revoke the old key |
| Railway OAuth client secret | portal-core `RAILWAY_OAUTH_CLIENT_SECRET` | regenerate in Railway developer settings → `--stdin` → deploy |
| Release signing key | platform repo GitHub Actions environment `registry` secret `RELEASE_SIGNING_KEY` + owner key store (`gh secret set RELEASE_SIGNING_KEY --env registry < key.pem`) | `registry/README.md` "Key handling": add new public key to `registry/keys.json`, re-sign, update the secret, remove the old key later |
| GitHub publishing | none: built-in `GITHUB_TOKEN` per workflow run (C72) | nothing to rotate |
| Woodpecker repo hook token (leaked) | Woodpecker DB repo hash | new random repo hash on the CI host, then `POST /api/repos/<id>/repair`; check a test push triggers a pipeline (done for portal-core and website, 2026-10-12) |
| GlitchTip DSN | portal-core/portal-gui `SENTRY_DSN` | new project key in GlitchTip → `--stdin` → deploy → disable the old key |
After any rotation: record date + key id (never the value) in `ops/ROTATION-LOG.md`.

## 5. Restore
- Portal DB, logical: `ops/BACKUPS.md` — latest dump on the db-backup volume; restore into a new Postgres service, verify, then point `DATABASE_URL` at it.
- Portal DB, full volume: Railway → Postgres → Backups → restore (overwrites in place; only for disaster recovery, after a dump-based restore was ruled out).
- Bridge / app volumes (customer workspace): Railway volume backups (daily, 7 days) → restore on the same service; `TB_KEK` is provider-held and unchanged, so sealed state opens again (test record in `ops/BACKUPS.md`).
- Release index: the history is in git (`registry/index.json`, `index.jws` on platform main); re-publish with `node ci/tb-ci.ts registry-sign`.

## 6. Customer workspace incidents (bridge / apps in the customer's Railway)
Portal never connects in; the owner's bridge pulls config. Symptoms: agents get refusals, canvas shows the bridge offline.
1. Portal side healthy? (status page). If Portal is down, workspaces keep working until grants expire (≤ 12 h worst case offline); fix Portal first.
2. Bridge health: the owner's Railway → bridge service → `/healthz` (live) and `/readyz` (enrolled + config fresh).
3. Re-enrol only if the bridge key is lost: Portal → workspace → bridge → new enrolment code (Core refuses the old key at once).
4. App broken after an update: `instances.rollback` to the previous release.

## 7. Close
Status page green for 15 minutes, GlitchTip quiet, root cause written in `ops/INCIDENTS.md` (what, why, fix, follow-up), follow-up tasks filed with the owning lead.
