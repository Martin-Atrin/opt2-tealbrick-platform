# opt2 backups and restore test

## Portal DB (Railway Postgres 18 in project "opt2") — decision C7
1. Layer 1, volume snapshots (on): Railway volume backups DAILY (6 d) + WEEKLY (27 d) for `postgres-volume`. Use for full disaster recovery. A Railway restore overwrites the volume in place: never use it as a test.
2. Layer 2, logical dump + restore test (live): service `db-backup` (Railway cron `17 19 * * *` UTC = 02:17 Bangkok, restart policy NEVER), source `ops/db-backup/` (Dockerfile: Postgres 18 client + Node 24, job `backup.ts`). Volume `db-backup-volume` at `/backups`. Env: `DATABASE_URL` = reference `${{Postgres.DATABASE_URL}}`, `BACKUP_DIR=/backups`, `KEEP=14`, `HEARTBEAT_URL` (GlitchTip heartbeat monitor "opt2 db-backup nightly", set unprinted).
   Each run: canary row in `tb_ops.restore_canary` → `pg_dump -Fc` → restore into scratch database `tb_restore_test` on the same server → verify (every source table exists in the restore, canary row present) → drop scratch database → keep 14 dumps → append to `/backups/RESTORE-LOG.jsonl` → heartbeat on success only (a missed heartbeat alerts in GlitchTip).
   Credentials reach pg tools only through PG* env vars (never argv, never logs).
   Portal Core: schema `tb_ops` belongs to Platform; Core migrations must not touch it. Database name `tb_restore_test` is reserved.

## Restore test evidence
- 2026-10-11 11:05 UTC: first real run `portal-2026-10-11T110532Z.dump`, restore **pass** (`tables=1 rows=3 canary=ok`, 497 ms), heartbeat 200. (DB holds only the canary until Core ships its schema; the check covers every table automatically.)

## Full-server restore drill (before cutover)
1. Create a temporary Postgres 18 service `pg-restore-drill` (private).
2. `pg_restore --no-owner --exit-on-error` the latest dump from `/backups` into it (from a one-off run of `db-backup` with `DATABASE_URL` pointed at the drill service).
3. Point a temporary Core deployment at it; Core health + read-only registry queries pass.
4. Record in this file; delete the drill service.

## Bridge + app volumes (customer workspaces) — C16 S7
Bridge: Railway volume backup DAILY, kept 7 days, set by the bridge template (BRIDGE.md). `TB_KEK` is provider-held and not in the volume. Restore test at P2 in project opt2-test-customer: restore the latest bridge volume backup into a fresh bridge service with the same `TB_KEK` reference, check it unseals its state and serves its last good config.
Apps: baked into the Miniapp SDK (each app's backup volume in its Railway template) — owned by Lead · Specs & SDK; Platform adds the restore test for the test customer workspace at P2.
