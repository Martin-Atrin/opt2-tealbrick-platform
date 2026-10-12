# opt2 key handling (Platform guidance)

## TB_KEK via Railway `secret()` (CORE I3, C17) — verified 2026-10-11
- Railway resolves `${{secret(<length>, "<alphabet>")}}` when the variable is WRITTEN, through the CLI and through GraphQL `variableCollectionUpsert` (probe on project opt2: 43 chars, base64url alphabet; the unrendered value is already the generated secret, not the template).
- Core's deploy adapter writes exactly: `TB_KEK = ${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")}}` (256 bits). Core sends only the template; it never receives the value.
- Rule for Core: the Railway adapter must NEVER call the `variables` query (or `railway variables`) on customer services. Anyone with workspace access can read variables; "Portal never sees TB_KEK" holds because Core never reads it. Add a boundary test: no `variables(` query string in the adapter.
- Rotation of a customer service's `TB_KEK` (bridge, apps) is not done by Core (Core never reads those values). It uses the same re-seal-on-boot mechanism as below, performed by the workspace owner/bridge admin. Out of opt2 scope; recorded.

## Portal Core secrets (project opt2)
- In Railway variables only, set with `railway variable set <KEY> --stdin` (never argv, never printed). Cross-service values by reference (`${{Postgres.DATABASE_URL}}`, `${{portal-core.CLERK_PUBLISHABLE_KEY}}`).
- Core's own sealing key (Portal signing keys, Railway refresh tokens; AES-256-GCM, CREDENTIALS §9.1): `TB_KEK` on portal-core, generated the same way (`secret(43, ...)`), set once by Platform. Back it up to Vaultwarden (Martin) before cutover: losing it = re-link every Railway account and rotate Portal keys.
- Release signing key: see `registry/README.md`.

## Portal Core KEK rotation (C47; proven live by Core 36dfe0b)
Values are never printed: every copy goes through `railway variable set <KEY> --stdin`. Project "opt2", service portal-core, environment production.
1. Set `TB_KEK_PREVIOUS` = the current `TB_KEK` (`--stdin`, `--skip-deploys`).
2. Set `TB_KEK` = a new 32-byte random value, base64url (43 chars) or hex (64 chars) (`--stdin`, `--skip-deploys`). Railway can generate it: `TB_KEK=${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")}}`.
3. Deploy. On boot Core re-seals every sealed value in ONE transaction and logs `kek rotation resealed=<n> kekId=<new id>`. If any value opens with neither key, boot fails and nothing changes (the previous deployment keeps serving): fix the variables and redeploy.
4. Check that the Portal signing key id is unchanged (configs and tickets still verify; `kid` in the published JWKS is the same).
5. Delete `TB_KEK_PREVIOUS` and redeploy. Boot must succeed without it.
6. Update the Vaultwarden copy of `TB_KEK` (Martin) and note the date and new `kekId` (never the value) in ops/ROTATION-LOG.md.

## Portal signing key compromise — "rotate now" (C60 / SEC-15; Core 4778e23)
Use when a Portal signing key may have leaked. Values never printed; project "opt2", service portal-core.
1. Set `TB_PORTAL_KEY_ROTATE_NOW` = a new random id (≥ 16 chars, e.g. `${{secret(24)}}` or a fresh ULID) with `railway variable set --stdin`, then deploy. Boot logs `portal key rotated now newKid=… compromisedKid=…`. The same id never rotates twice (re-deploys are safe).
2. Online bridges receive a transition config within ≤ 60 s (signed with the old key, listing only the new key); after their ack everything is signed with the new key. Bridges offline > 12 h must be re-enrolled (`bridge.enrolment_code` in Portal).
3. Revoke every pairing connection created since the suspected leak (`connections.revoke`).
4. If `TB_KEK` may have leaked too: rotate the KEK (procedure above), re-link Railway, roll the Stripe and Clerk webhook secrets (RUNBOOK §4).
5. Remove `TB_PORTAL_KEY_ROTATE_NOW` afterwards, record the incident in ops/INCIDENTS.md and the new kid (never a value) in ops/ROTATION-LOG.md.

## Logs and errors
- GlitchTip projects have server-side PII scrubbing on (keys: authorization, cookie, token, secret, password, key, kek, grant, ticket, enrol, code, session, dsn, jwt, jws, signature, assert, call; emails, cards, private keys) and IP scrubbing. This is a backstop: services must not log tokens, codes, keys or bodies in the first place.
