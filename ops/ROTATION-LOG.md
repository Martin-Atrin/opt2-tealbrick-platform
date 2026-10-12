# Rotation log

Date and key id or subject only. Never a value, token, hash or webhook URL.

| Date | What | Reason |
|---|---|---|
| 2026-10-12 | portal-core Woodpecker hook token | leaked |
| 2026-10-12 | website Woodpecker hook token | leaked |
| 2026-10-12 | samples Woodpecker hook token (repo id 29) | transcript exposure |

## How: Woodpecker hook token (RUNBOOK section 4)

- CI host: `ssh neuu`. Woodpecker runs rootless under user `ci`; use `sudo -n -u ci` (run from `/tmp`).
- DB: SQLite at `/home/ci/woodpecker/data/woodpecker.sqlite`, table `repos`, column `hash` (base32 of 32 random bytes, 56 chars).
- Set a new hash for one repo id only. Generate it on the host and do not print it.
- API host: `http://127.0.0.1:18080` on neuu (server container port 8000, loopback only). Call `POST /api/repos/<id>/repair` there; expect 204.
- API token: `~/.config/opt2-tealbrick/woodpecker-token` on the operator Mac. Pass it to `curl -K -` over ssh stdin so it never shows in output or process lists.
- Verify: push an empty commit to the repo, then check the new pipeline reaches success.
