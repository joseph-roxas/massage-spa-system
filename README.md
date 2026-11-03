# Massage Spa System

Booking, sales, payroll, inventory and reporting for a single massage spa branch.

- Domain vocabulary: [GLOSSARY.md](GLOSSARY.md)
- Plan and phases: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- Architecture decisions: [docs/adr/](docs/adr/)

| Folder | What | Runs on |
|---|---|---|
| `UI/` | React + Vite front desk app | Cloudflare Pages |
| `API/` | Hono REST API | Cloudflare Workers |
| `DB/` | Drizzle schema, D1 migrations, seed | Cloudflare D1 |
| `packages/domain` | Pure business rules (pricing, commission, payroll…) | shared |

## Run locally

Requires Node 22+.

```bash
npm install
npm run dev
```

This applies migrations to a local D1 database (`.wrangler-state/`), then starts the API on http://localhost:8787 and the UI on http://localhost:5173.

Create a Super Admin login for the local database (asks for name, email and password):

```bash
npm run admin:create -w API
```

Locally, "new user request" notifications are printed in the API's console instead of emailed.

Other commands:

```bash
npm test            # domain unit tests + API tests against a local D1
npm run lint
npm run typecheck
npm run build
npm run db:generate # after editing DB/schema, generate a new migration
```

## Deploy (GitHub Actions → Cloudflare)

| Workflow | Runs when |
|---|---|
| `CI` | every PR and push to `main` |
| `Deploy DB` | push to `main` changing `DB/migrations/**`, or manually |
| `Deploy API` | push to `main` changing `API/**`, `packages/**` or `DB/schema/**`, or manually |
| `Deploy UI` | push to `main` changing `UI/**` or `packages/**`, or manually |
| `Deploy all` | manually; runs DB → API → UI in order |

Migrations must stay backwards-compatible with the running API, since DB and API can deploy independently.

### One-time Cloudflare setup

1. Create a free Cloudflare account.
2. Create the database and note its id:
   ```bash
   npx wrangler login
   npx wrangler d1 create massage-spa-db
   ```
3. Create an API token (My Profile → API Tokens → Create Token → *Edit Cloudflare Workers* template, plus **D1: Edit** and **Cloudflare Pages: Edit**).
4. In the GitHub repo → Settings → Secrets and variables → Actions:
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Variable: `D1_DATABASE_ID` (the id from step 2)
5. Run the **Deploy all** workflow. The app is then at `https://massage-spa-ui.pages.dev`.
6. Create the production Super Admin login:
   ```bash
   D1_DATABASE_ID=<id from step 2> npm run admin:create -w API -- --remote
   ```
   Run it again any time to reset the Super Admin password.

### Approval emails (optional)

New user requests always appear under **Users → Pending requests**. To also email them to the Super Admin, add a domain to Cloudflare, enable Email Routing, verify desiree.ababon@gmail.com as a destination, then in `API/wrangler.toml` set `EMAIL_FROM` and uncomment the `[[send_email]]` block. See [ADR 0002](docs/adr/0002-approval-email-admin-only.md).
