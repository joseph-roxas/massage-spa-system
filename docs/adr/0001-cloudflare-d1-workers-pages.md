# Cloudflare D1 + Workers + Pages on the free tier

The system runs entirely on Cloudflare's free tier: the API is a Hono app on Workers, the UI a React/Vite app on Pages, and the database is D1 (SQLite) with Drizzle-managed migrations. We picked D1 over Neon/Supabase Postgres because a single branch's data fits easily within D1's free limits (500 MB per database, 5M row reads and 100k row writes per day) and it binds natively to Workers: one vendor, no connection secrets, no idle-pause, and `wrangler dev` gives an identical local database.

## Consequences

- SQLite dialect: no Postgres-only features. Money is stored as integer centavos; times as ISO strings in Asia/Manila business-day terms.
- The Workers free plan allows ~10 ms CPU per request, so passwords are hashed with WebCrypto PBKDF2 (native) rather than bcrypt/argon2 in JS.
- The UI calls the API through a same-origin Pages Function proxy (service binding to the Worker), so session cookies are first-party; the Worker still deploys independently.
- `UI/`, `API/` and `DB/` deploy independently through separate GitHub Actions workflows; `deploy-all` runs DB → API → UI.
- Production is the only deployed environment (two users don't justify staging); local `wrangler dev` is the test bed, so migrations must be verified locally before merge.
