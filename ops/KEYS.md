# opt2 key handling (Platform guidance)

## TB_KEK via Railway `secret()` (CORE I3, C17) — verified 2026-10-11
- Railway resolves `${{secret(<length>, "<alphabet>")}}` when the variable is WRITTEN, through the CLI and through GraphQL `variableCollectionUpsert` (probe on project opt2: 43 chars, base64url alphabet; the unrendered value is already the generated secret, not the template).
- Core's deploy adapter writes exactly: `TB_KEK = ${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")}}` (256 bits). Core sends only the template; it never receives the value.
- Rule for Core: the Railway adapter must NEVER call the `variables` query (or `railway variables`) on customer services. Anyone with workspace access can read variables; "Portal never sees TB_KEK" holds because Core never reads it. Add a boundary test: no `variables(` query string in the adapter.
- Rotation: set `TB_KEK_PREVIOUS = ${{<service>.TB_KEK}}`-style copy is NOT possible after resolution; rotation = the service re-seals on boot with `TB_KEK_PREVIOUS` written by the customer/bridge admin, not by Core. (Out of opt2 scope; recorded.)

## Portal Core secrets (project opt2)
- In Railway variables only, set with `railway variable set <KEY> --stdin` (never argv, never printed). Cross-service values by reference (`${{Postgres.DATABASE_URL}}`, `${{portal-core.CLERK_PUBLISHABLE_KEY}}`).
- Core's own sealing key (Portal signing keys, Railway refresh tokens; AES-256-GCM, CREDENTIALS §9.1): `TB_KEK` on portal-core, generated the same way (`secret(43, ...)`), set once by Platform. Back it up to Vaultwarden (Martin) before cutover: losing it = re-link every Railway account and rotate Portal keys.
- Release signing key: see `registry/README.md`.

## Logs and errors
- GlitchTip projects have server-side PII scrubbing on (keys: authorization, cookie, token, secret, password, key, kek, grant, ticket, enrol, code, session, dsn, jwt, jws, signature, assert, call; emails, cards, private keys) and IP scrubbing. This is a backstop: services must not log tokens, codes, keys or bodies in the first place.
