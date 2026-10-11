# opt2 backups and restore test

## Portal DB (Railway Postgres in project "opt2")
1. Layer 1, volume snapshots (on): Railway volume backups DAILY (6 d) + WEEKLY (27 d) for `postgres-volume`. Use for full disaster recovery. A Railway restore overwrites the volume in place: never use it as a test.
2. Layer 2, logical dumps (P1, when Core has a schema): a small private `db-backup` cron service in opt2 runs `pg_dump -Fc "$DATABASE_URL"` nightly into its own volume, keeps 14 dumps, and reports success/failure to GlitchTip (cron monitor).

## Restore test (monthly, and before cutover)
1. Create a temporary service `pg-restore-test` (Railway PostgreSQL template) in project "opt2" (private only).
2. From the `db-backup` service: `pg_restore --clean --if-exists --no-owner -d "$RESTORE_URL" <latest dump>` (`RESTORE_URL` = reference to `pg-restore-test`'s `DATABASE_URL`).
3. Verify: schema migration version equals production; row counts per registry table match the dump's source within the dump time; Core's own read-only health query passes against the restored DB.
4. Record date, dump name, duration, result in `ops/RESTORE-LOG.md` (no data, no URLs with credentials).
5. Delete `pg-restore-test`.
Pass criteria: restore completes, checks match, total time under 30 minutes.

## App volumes (customer workspaces)
Baked into the Miniapp SDK (each app's backup volume in its Railway template) — owned by Lead · Specs & SDK; Platform adds the restore test for the test customer workspace at P2.
