# Rotation log

Date and key id or subject only. Never a value, token, hash or webhook URL.

| Date | What | Reason |
|---|---|---|
| 2026-10-12 | portal-core Woodpecker hook token | leaked |
| 2026-10-12 | website Woodpecker hook token | leaked |
| 2026-10-12 | samples Woodpecker hook token (repo id 29) | transcript exposure |

## How: Woodpecker hook token (RUNBOOK section 4)

- Host names, ssh aliases and paths are private. They live in `~/.config/opt2-tealbrick/hosts.env` on the operator machine (`WOODPECKER_URL`, `WOODPECKER_SSH`, `WOODPECKER_DATA_DIR`, `WOODPECKER_API_LOOPBACK`), never in this repo.
- CI host: `ssh $WOODPECKER_SSH`. Woodpecker runs rootless under a dedicated CI user; use `sudo -n -u <ci user>` (run from `/tmp`).
- DB: SQLite at `$WOODPECKER_DATA_DIR/woodpecker.sqlite`, table `repos`, column `hash` (base32 of 32 random bytes, 56 chars).
- Set a new hash for one repo id only. Generate it on the host and do not print it.
- API host: `$WOODPECKER_API_LOOPBACK` on the CI host (server container port 8000, loopback only). Call `POST /api/repos/<id>/repair` there; expect 204.
- API token: `~/.config/opt2-tealbrick/woodpecker-token` on the operator Mac. Pass it to `curl -K -` over ssh stdin so it never shows in output or process lists.
- Verify: push an empty commit to the repo, then check the new pipeline reaches success.
