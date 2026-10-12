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

## Portal Root Keys and the key-set statement (C63 / BSD-08; CREDENTIALS §9.5)
- Statement file: `registry/portal-keyset.jws` (public, signed by a root; Core reads it at start and carries it as `portalKeySet`). Request file: `registry/portal-keyset.request.json` (`{schema, seq, iat, keys: [{jwk, status}]}`; public JWKs only, `iat` fixed so the signature is reproducible).
- The current Portal key set is NOT in `registry/keys.json` (that file is the release-index key). There is no JWKS route (PORTAL-API §bridge_api). The public halves are the `signing_keys.public_jwk` rows of Core. Read them with `railway ssh` into portal-core and a read-only `SELECT kid, status, public_jwk FROM signing_keys` (the query runs inside the container; no variable and no private column is read or printed).
- Tool: `node ops/root-key.ts sign --request registry/portal-keyset.request.json --key <root key file> --out registry/portal-keyset.jws --channel dev` and `node ops/root-key.ts verify --jws registry/portal-keyset.jws --request registry/portal-keyset.request.json --channel dev`. `TB_MANIFEST_MODULE` = built `@opt2-tealbrick/manifest` >= 0.1.6 (install the release tarball in a scratch folder with `--ignore-scripts`; check its sha512 against the lockfile pin). `sign` checks that the key is a pinned root of the channel, signs, re-verifies with `verifyKeySetStatement`, and checks the claim order `iss, aud, seq, iat, keys`. The root key is read only inside this process: never print or copy it, never put it on Railway or CI.
- DEV ceremony (done 2026-10-12, seq 1): root-a (`~/.config/opt2-tealbrick/portal-root-a.key`, mode 0600, no passphrase, dev only) signed seq 1 over the single active Core key. Root-a kid `xr8nlOuIDP8GqJOnDvBe6dIc2jwy2T83j2YqlPz6x7A`.
- Every Core key change needs a new statement first (seq + 1): planned rotation = 3 statements (announce B pending; B active and A retired, at least 24 h later; drop A, at least 12 h 5 min later); "rotate now" = one statement that drops the stolen kid and lists the new key active (publish it BEFORE or with the Core rotation; re-read the key rows after Core rotates).
- PROD: waits for Martin's air-gapped ceremony (CREDENTIALS §9.5: encrypted keys, passphrase prompt in `sign`, kids compared aloud). `PORTAL_ROOT_KEYS.prod` stays empty until then; do not sign a stable statement with a dev key.

## Logs and errors
- GlitchTip projects have server-side PII scrubbing on (keys: authorization, cookie, token, secret, password, key, kek, grant, ticket, enrol, code, session, dsn, jwt, jws, signature, assert, call; emails, cards, private keys) and IP scrubbing. This is a backstop: services must not log tokens, codes, keys or bodies in the first place.
