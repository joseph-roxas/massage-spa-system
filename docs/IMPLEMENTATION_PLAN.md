# Implementation Plan — Massage Spa Booking & Management System

Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). Architecture decisions: [ADR 0001](adr/0001-cloudflare-d1-workers-pages.md) (Cloudflare D1/Workers/Pages), [ADR 0002](adr/0002-approval-email-admin-only.md) (user approval).

---

## 1. Architecture

```
 Front-desk PC (browser)
        │  https://<app>.pages.dev
        ▼
 ┌──────────────────────────┐    service binding    ┌─────────────────────────┐
 │ UI  — Cloudflare Pages    │ ───────────────────▶ │ API — Cloudflare Worker  │
 │ React + Vite + TS         │   /api/* proxied by   │ Hono + Zod + Drizzle     │
 │ (Pages Function proxy)    │   a Pages Function    │ Cron Triggers            │
 └──────────────────────────┘                        │ send_email binding       │
                                                      └───────────┬─────────────┘
                                                                  ▼
                                                       ┌─────────────────────┐
                                                       │ DB — Cloudflare D1   │
                                                       │ (SQLite)             │
                                                       └─────────────────────┘
```

- **Language:** TypeScript everywhere; npm workspaces monorepo.
- **UI:** React 18, Vite, React Router, TanStack Query, Tailwind + shadcn/ui, desktop-first layout (stationary PC/notebook).
- **API:** Hono on Workers, Zod validation, Drizzle ORM (D1 driver).
- **DB:** D1; schema + SQL migrations + seed in `DB/`.
- **Auth:** email + password (PBKDF2 via WebCrypto), HttpOnly session cookie, sessions stored in D1. Clock-in Screen uses per-person 4-digit PINs (hashed).
- **Time:** all business logic in Asia/Manila; money as integer centavos.
- **Same-origin:** UI calls `/api/*`; a Pages Function forwards to the Worker via service binding, so cookies are first-party.

## 2. Repository layout

```
massage-spa-system/
├── GLOSSARY.md
├── docs/
│   ├── IMPLEMENTATION_PLAN.md
│   └── adr/
├── package.json              # workspaces: UI, API, DB, packages/*; root scripts (dev, test, lint)
├── packages/
│   └── domain/               # PURE business rules, shared by API (and UI for previews)
│       ├── pricing.ts        # discount selection, promo eligibility
│       ├── commission.ts
│       ├── rotation.ts
│       ├── royalty.ts
│       ├── payroll/          # therapist.ts, receptionist.ts, deductions.ts, cash-advance.ts
│       └── business-day.ts
├── DB/
│   ├── schema/               # Drizzle table definitions
│   ├── migrations/           # generated SQL, applied by wrangler
│   ├── seed/                 # services, prices, promo, items, settings, Super Admin
│   └── wrangler.toml         # D1 binding (database_id)
├── API/
│   ├── src/
│   │   ├── index.ts          # Hono app, routes, cron handler
│   │   ├── auth/             # sessions, roles, permission guard
│   │   └── modules/          # users, staff, dtr, bookings, sales, vouchers, dayclose,
│   │                         # payroll, inventory, expenses, royalty, reports, settings
│   ├── test/                 # vitest + @cloudflare/vitest-pool-workers (real local D1)
│   └── wrangler.toml
├── UI/
│   ├── src/ (routes/, components/, api/)
│   ├── functions/api/[[path]].ts   # Pages Function proxy → API service binding
│   └── wrangler.toml
└── .github/workflows/
    ├── ci.yml  deploy-db.yml  deploy-api.yml  deploy-ui.yml  deploy-all.yml
```

`packages/domain` is the heart: every money rule lives there as pure functions with exhaustive unit tests, so the API is thin I/O around it.

## 3. Roles & permissions

| Capability | Super Admin | Receptionist | Clock-in Screen (PIN) |
|---|---|---|---|
| Users, approvals, password resets | ✅ | — | — |
| Services, prices, promos, holidays, settings | ✅ | — | — |
| Bookings, Rotation, Rooms | ✅ | ✅ | — |
| Sales, payments, voucher sale/redemption | ✅ | ✅ | — |
| Complimentary Service | ✅ (reason required) | — | — |
| Cash-outs | ✅ | ✅ (recorded immediately) | — |
| Early Close | ✅ (can reject) | ✅ (reason required) | — |
| Day Close | ✅ (can reopen) | ✅ (must, before logout) | — |
| Therapist DTR | ✅ | ✅ corrections with reason | ✅ clock in/out |
| Receptionist DTR | ✅ corrections | — (cannot edit own) | ✅ clock in/out |
| Therapist Payroll | ✅ approve | ✅ generate, release | view own (read-only) |
| Therapist CA | ✅ (override cap) | ✅ within cap | view own balance |
| Receptionist Payroll & CA | ✅ | — | — |
| Stock-out | ✅ | ✅ (recorded immediately) | — |
| Purchase Orders | ✅ approve | ✅ request, receive (Stock-in) | — |
| Expenses, Royalty | ✅ | — | — |
| Reports | ✅ all | daily operational only (bookings, guests, own-day sales) | own earnings |

Every mutation writes an **audit log** row (who, when, what, before/after, reason).

## 4. Data model (D1 tables)

Money columns are `INTEGER` centavos. Every table has `id`, `created_at`, `created_by`.

**Identity**
- `users` — first_name, last_name, email (unique), password_hash, role (`super_admin|receptionist`), status (`pending|active|rejected|disabled`), approved_by/at.
- `sessions` — user_id, token_hash, expires_at.
- `audit_log` — actor, entity, entity_id, action, before_json, after_json, reason.

**Staff**
- `staff` — name, type (`regular_therapist|lmt|on_call_therapist|receptionist`), pin_hash, daily_rate (receptionist), gov_sss/gov_phic/gov_pagibig (weekly fixed amounts), active.
  - Seed defaults: therapist 100.00 / 62.50 / 40.00; receptionist 212.50 / 105.63 / 50.00, daily rate 692.00, rest day Sunday.
- `commission_rates` — staff_type, normal_pct, holiday_pct, effective_from. (Regular 30/50, LMT 40/60; on-call uses their underlying type.)
- `dtr` — staff_id, business_day, clock_in, clock_out, source (`pin|correction`), corrected_by, reason.

**Calendar**
- `business_days` — date, opened_at, early_close_at, early_close_reason, early_close_status (`recorded|rejected`), closed_at, closed_by, reopened_by/at, expected_cash, counted_cash, expected_gcash, variance.
- `holidays` — date, name, type (`regular|special`), raises_commission (bool).

**Catalogue**
- `services` — code, name, duration_min, is_combo, is_foot_type (allowed in Flex Room recliner mode), voucher_eligible, active.
- `service_prices` — service_id, regular_price, effective_from.
- `rooms` — number (1–8), is_flex.
- `promos` — name, service_id, pct, start_time, end_time, valid_from, valid_to, active. (Seed: Happy Hours, Swedish 1hr, 10%, 14:00–17:59, until 2026-11-30.)
- `addons` — name, price. (Seed: Extra oil, 50.00.)

**Bookings & sales**
- `bookings` — one Guest receiving one Service: business_day, kind (`walk_in|scheduled`), status (`scheduled|waiting|in_service|done|cancelled|no_show`), guest_name/guest_phone (optional, kept on the booking — no separate guest list), service_id, duration_min (snapshot), scheduled_at, requested_therapist_id, therapist_id, room_id, flex_mode, portable_table, override_reason, notes, started_at, done_at, cancel_reason. Partial unique indexes allow only one in-service Booking per Room and per therapist.
- `sales` — booking_id, business_day, regular_price (snapshot), discount_type (`none|senior|pwd|promo|voucher|complimentary`), discount_ref (ID no. / promo_id / voucher_id), discount_amount, amount_due, foc_kind (`none|prepaid|real`), commission_base (= regular_price), commission_pct (snapshot), commission_amount, booklet_invoice_no.
- `sale_addons` — sale_id, addon_id, price.
- `payments` — sale_id or voucher_sale_id, method (`cash|gcash`), amount, gcash_ref (required for gcash).
- `vouchers` — serial (unique), service_id, voucher_sale_id, is_free (6th of bundle), status (`unused|redeemed`), redeemed_sale_id, imported (bool, go-live).
- `voucher_sales` — buyer_name/phone (optional), service_id, qty_paid, qty_free, unit_price (snapshot), total, business_day.
- `cash_outs` — business_day, amount, purpose, category, recorded_by. (On-call therapist same-day pay is a Cash-out of category `on_call_commission`.)

**Payroll**
- `pay_weeks` — start (Sunday), end (Saturday).
- `payrolls` — pay_week_id, staff_id, status (`draft|approved|released`), gross, gov_sss, gov_phic, gov_pagibig, ca_deduction, net, breakdown_json, approved_by/at, released_at.
- `cash_advances` — staff_id, amount, business_day, against_pay_week_id (therapists), override_by.
- `ca_ledger` — staff_id, entry (`opening|advance|repayment`), amount, payroll_id. (Balance = sum.)
- `bonuses` — year, staff_id, kind (`year_end_bonus|thirteenth_month`), basis, pct, amount.
- `pay_rules` — key/value settings for receptionist premiums (see §5.6), editable.

**Inventory**
- `vendors` — name, contact.
- `items` — name, unit (`gal|liter|pack50|pack100|500g|1kg|1.5kg|roll|pc|…`), reorder_level, active.
- `purchase_orders` — vendor_id, status (`requested|approved|partially_received|received|cancelled`), requested_by, approved_by.
- `purchase_order_lines` — po_id, item_id, qty, expected_price.
- `stock_ins` — item_id, vendor_id, po_line_id (nullable), qty, unit_price, purchase_date, received_by.
- `stock_outs` — item_id, qty, taken_by_staff_id, recorded_by, date.
- Derived: on-hand = Σin − Σout; last stock-out date = max(stock_outs.date); latest price = last stock_in.

**Expenses & royalty**
- `expense_categories` — laundry, petty cash, rice allowance, bookkeeping, electricity, BIR (2551Q, FS), business permit, supplies & tools, phone load, AC cleaning, other.
- `expenses` — category_id, amount, date, description, status (`pending|confirmed`), recurring_template_id.
- `recurring_expenses` — category_id, amount, day_of_month, description. (Seed: Bookkeeping 1,250.00 monthly.)
- `royalty_statements` — month_start, month_end, gross_sales, pct (3%), amount, expense_id.

## 5. Core business rules (all in `packages/domain`, all unit-tested)

### 5.1 Rotation
- Rotation = clocked-in therapists for the Business Day, ordered by `clock_in`.
- Next un-requested Guest → first therapist in Rotation who is free (not `in_service`) and has no scheduled Booking overlapping the service's duration.
- On **Done**, that therapist moves to the back.
- A Requested Therapist serves the Guest out of turn **without** losing their Rotation place.
- Receptionist may override the suggestion; override requires a reason and is audited.

### 5.2 Room assignment
- Capacity = 8 Rooms, one Guest each. Never double-book a Room for overlapping times.
- Room 8 (Flex) is set per Booking: `floor` (any Service) or `recliner` (only `is_foot_type` Services: Foot Massage, Foot Scrub, C6, Back Massage 30 min).
- Combos occupy one Room for the full duration. Portable Table is a flag only.

### 5.3 Pricing & discounts
1. `regular_price` = Service price effective on the Business Day (snapshot on sale).
2. Candidate discounts: Statutory (20%, requires ID number, Senior or PWD) and any active Promo matching service + start time + date.
3. Apply **only the largest** single discount. Voucher Redemption and Complimentary Service set `amount_due = 0` and exclude other discounts.
4. Add-ons added on top; never discounted, never commissioned.
5. Payment after Done; Cash/GCash split allowed; GCash ref required; total paid must equal amount due.

### 5.4 Commission
- `commission = regular_price × rate`, where rate = staff type's normal or holiday % (holiday if the Business Day is a Holiday with `raises_commission`).
- Applies to every Service performed, including Prepaid and Real FOCs; based on the current Regular Price at redemption for Vouchers.
- On-call therapists: same rule, paid at Day Close via Cash-out; no Government Deductions, no CA.

### 5.5 Vouchers & FOC
- Sold singly or as Bundle (5 paid + 1 free, same Service) at the Regular Price on sale day. Serial per voucher, no expiry.
- Redemption only for the exact Service; marks serial `redeemed` (single use). No upgrades.
- FOC classification: Redemption of paid voucher → `prepaid`; free 6th voucher or Complimentary Service → `real`.

### 5.6 Royalty
- Monthly (calendar month start–end): Σ(payments for Services, after discounts, excluding add-on amounts) + Σ(voucher sales by sale day). Excludes Redemptions and Real FOCs.
- Royalty = 3% → draft statement + pending expense created by monthly cron; Super Admin confirms.

### 5.7 Payroll — Therapists
- Pay Week Sun–Sat; generated after the week ends, released the following Wed–Fri.
- Gross = Σ commission in Pay Week.
- Government Deductions = fixed weekly amounts if the therapist worked ≥1 day that week, else 0.
- CA deduction = Σ CAs taken against this pay week.
- **CA cap** when taking a CA: unreleased net pay of the last completed Pay Week − CAs already taken against it. Blocked above cap unless Super Admin overrides.
- Year-end Bonus (December): Σ commission Jan–Dec × % entered by Super Admin.

### 5.8 Payroll — Receptionist
- Shift 14:00–23:00, 1 hr unpaid meal break → 8 paid hrs; hourly = daily ÷ 8 (692 → 86.50); per-minute = hourly ÷ 60.
- Late = minutes after 14:00; Undertime = minutes before 23:00 (or before Early Close time if an Early Close is `recorded` and not rejected).
- Overtime = minutes after 23:00, automatically paid at OT premium (no approval).
- Premiums — editable defaults in `pay_rules` (DOLE):

  | Day type | Worked rate | OT rate |
  |---|---|---|
  | Ordinary day | 100% | 125% |
  | Rest Day (Sunday) | 130% | 169% |
  | Special day | 130% | 169% |
  | Special day on Rest Day | 150% | 195% |
  | Regular holiday | 200% | 260% |
  | Regular holiday on Rest Day | 260% | 338% |
  | Regular holiday, not worked | 100% (paid) | — |

- Government Deductions 212.50 / 105.63 / 50.00 weekly.
- CA: running balance (opening balance 4,000.00 at go-live); no cap; repayment amount chosen per Payroll, defaulting to last week's; warning when balance > one week's gross.
- 13th Month Pay (December) = Σ basic pay earned Jan–Dec ÷ 12.

### 5.9 Business Day & Day Close
- Business Day starts at first open (14:00) and ends at Day Close, regardless of midnight. Until Day Close exists, activity before 06:00 Manila counts toward the previous day.
- Day Close shows expected Cash (cash payments − Cash-outs) and expected GCash; receptionist enters counted cash; variance stored. Day becomes read-only.
- Logout blocked while a Business Day is open. If the browser closes, the next login sees "Business Day of ___ not closed" and new sales are blocked until it's closed.
- Only Super Admin can reopen.

## 6. API surface (REST, `/api/v1`)

| Module | Key endpoints |
|---|---|
| auth | `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout` (409 if day open), `GET /auth/me` |
| users | `GET /users?status=pending`, `POST /users/:id/approve {role}`, `POST /users/:id/reject`, `POST /users/:id/reset-password` |
| clock | `POST /clock/identify {pin}`, `POST /clock/in`, `POST /clock/out`, `GET /clock/me/earnings` |
| staff, dtr | CRUD staff, set PIN; `GET /dtr?day=`, `POST /dtr/:id/correct {reason}` |
| rotation | `GET /rotation` (ordered, with status), `GET /rotation/suggest?serviceId=&at=` |
| bookings | CRUD; `POST /bookings/:id/start`, `/done`, `/cancel`, `/no-show`; `GET /rooms/availability?at=&serviceId=` |
| sales | `POST /sales/quote` (returns best discount), `POST /sales` (with payments), `GET /sales?day=` |
| vouchers | `POST /voucher-sales`, `GET /vouchers/:serial`, `POST /vouchers/import` |
| comp | `POST /sales/complimentary {reason}` (super admin) |
| day | `POST /days/open`, `POST /days/early-close {reason}`, `POST /days/close {countedCash}`, `POST /days/:id/reopen`, `POST /days/:id/reject-early-close` |
| cash-outs | CRUD (same day only) |
| payroll | `POST /payroll/generate {payWeekId, scope}`, `POST /payroll/:id/approve`, `/release`, `GET /payroll/:id/payslip.pdf`; `POST /cash-advances`, `GET /cash-advances/cap?staffId=` |
| bonuses | `POST /bonuses/year-end {year, pct}`, `POST /bonuses/thirteenth-month {year}` |
| inventory | items, vendors, `POST /stock-outs`, purchase orders (request/approve/receive → stock-in), `GET /inventory/on-hand` |
| expenses | CRUD, recurring templates, confirm pending |
| royalty | `GET /royalty?month=`, `POST /royalty/:id/confirm` |
| reports | `GET /reports/{daily-sales|therapist-sales|guests|service-time-heatmap|foc|addons|royalty|payroll|inventory|expenses}?from=&to=&format=json|xlsx|csv` |
| settings | services & prices, promos, holidays, commission rates, pay rules, rooms |

**Cron Trigger** — one daily `0 22 * * *` (06:00 Manila, after even late closings):
- Flag any Business Day still open.
- If today (Manila) is the 1st: create this month's recurring expenses and the previous month's royalty draft.

## 7. UI screens

Desktop-first, large touch-friendly buttons; one sidebar nav filtered by role.

1. **Login / Create New User** (first name, last name, email, password → "pending approval").
2. **Front Desk board** (receptionist home): Rotation column, 8 Room tiles (free / in service with countdown), today's queue + scheduled bookings, big "New Walk-in" and "New Booking".
3. **New Booking**: guest (optional name/phone), service, requested therapist (optional), time; system suggests therapist + room; Flex Room mode toggle; portable table checkbox.
4. **Checkout**: price breakdown, discount picker (Senior/PWD + ID, auto-promo, voucher serial lookup), add-ons, split Cash/GCash with ref, booklet invoice no.
5. **Sell Vouchers**: service, qty, bundle toggle → prints serials.
6. **Cash-outs**, **Early Close**, **Day Close** (blocking modal on logout attempt).
7. **Clock-in Screen** (full-screen on the logged-in front-desk PC): tap your name → 4-digit PIN → clock in/out; 5 wrong PINs lock that PIN for 5 minutes. Therapists' own earnings view arrives with Payroll (Phase 7).
8. **DTR** (corrections with reason).
9. **Payroll**: pick Pay Week → generate → review → approve (admin) → release → payslips; CA entry with live cap.
10. **Inventory**: on-hand list with low-stock badges, Stock-out, Purchase Order request/receive, item history (vendor, price, dates, last stock-out).
11. **Admin**: Pending Users, Users, Services & Prices, Promos, Holidays, Commission rates, Pay rules, Rooms, Staff (PINs, deductions), Expenses, Recurring expenses, Royalty, Complimentary Service.
12. **Reports**: date-range picker, tables + simple charts, Excel/CSV export.

## 8. CI/CD (GitHub Actions)

Secrets: `CLOUDFLARE_API_TOKEN` (Workers, Pages, D1 edit), `CLOUDFLARE_ACCOUNT_ID`. All deploys use `cloudflare/wrangler-action@v3`.

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | PR + push to `main` | install → typecheck → lint → unit tests (`packages/domain`) → API tests (local D1, migrations applied) → UI build |
| `deploy-db.yml` | push to `main` touching `DB/migrations/**`; `workflow_dispatch` | `wrangler d1 migrations apply <db> --remote` (D1 Time Travel gives 30-day point-in-time restore on free tier) |
| `deploy-api.yml` | push to `main` touching `API/**` or `packages/**`; `workflow_dispatch` | test → `wrangler deploy` |
| `deploy-ui.yml` | push to `main` touching `UI/**` or `packages/**`; `workflow_dispatch` | build → `wrangler pages deploy UI/dist --project-name=<app>` |
| `deploy-all.yml` | `workflow_dispatch` | calls the three above in order DB → API → UI (`workflow_call`) |

Rules: migrations are additive/backwards-compatible so DB can deploy before API; deploys only run after `ci.yml` passes; a `concurrency` group prevents overlapping deploys.

## 9. Local development

```bash
npm install
npm run db:migrate:local   # wrangler d1 migrations apply --local
npm run db:seed:local      # services, prices, promo, rooms, items, settings, Super Admin
npm run dev                # API (wrangler dev :8787) + UI (vite :5173, /api proxied)
```

- Approval emails print to the console locally.
- `npm test` runs domain + API tests against a real local D1.

## 10. Build phases

Each phase ends deployed to production and usable.

| # | Phase | Delivers | Done when |
|---|---|---|---|
| 0 | **Foundation** | Monorepo, `UI/` `API/` `DB/`, Drizzle, CI + 4 deploy workflows, `npm run dev`, Cloudflare projects created | Hello-world UI calls API, which reads D1, deployed by GitHub Actions |
| 1 | **Auth & users** | Sign-up, pending approval, login, sessions, roles, permission guard, admin password reset, audit log, approval email notifier | Receptionist signs up, Super Admin approves from the Pending Users screen, the receptionist logs in with limited menus |
| 2 | **Catalogue & settings** | Services/prices (effective dates), promos, holidays, rooms, staff (+PINs, deductions), commission rates, pay rules; seed data | Full price list and Happy Hours visible and editable |
| 3 | **Clock-in & Rotation** | Clock-in Screen, DTR, corrections, Rotation engine | Arrival order drives rotation; requested and Done rules pass tests |
| 4 | **Bookings & Rooms** | Walk-in/scheduled, therapist + room suggestion, Flex Room, Start/Done | A full shift's bookings run on the Front Desk board without double-booking |
| 5 | **Sales & Day Close** | Checkout, discounts, add-ons, split payments, Complimentary, Cash-outs, Early Close, Day Close, logout guard, on-call same-day pay | A Business Day can be run end-to-end and closed with variance |
| 6 | **Vouchers** | Sell single/bundle, serials, redemption, FOC classification, go-live import | 5+1 bundle produces 6 serials; the 6th redeems as a Real FOC |
| 7 | **Payroll** | Therapist + receptionist payroll, CA (cap + ledger), approve/release, payslip PDF, Year-end Bonus, 13th Month | A sample week matches a hand-computed spreadsheet to the centavo |
| 8 | **Inventory** | Items, vendors, POs, Stock-in/out, on-hand, low-stock, opening count import | Receptionist requests PO → admin approves → receive → on-hand updates |
| 9 | **Expenses & Royalty** | Expenses, categories, recurring templates, monthly cron, royalty statement | Month-end produces royalty draft matching the defined gross |
| 10 | **Reports** | All reports + Excel/CSV export | Owner can answer: sales per therapist, guests/day, service × time-of-day, FOC breakdown |
| 11 | **Go-live** | Import unused vouchers, CA balances, inventory count; start on a Sunday; paper-fallback sheet | First full Pay Week is run in the system |

Suggested order is linear; phases 8–9 can run in parallel with 6–7.

## 11. Testing strategy

- **Domain (most important):** table-driven unit tests for discount selection, promo window edges (13:59 / 14:00 / 17:59 / 18:00, 2026-11-30 vs 12-01), commission on holidays/FOCs, rotation sequences, royalty inclusion/exclusion, every receptionist premium row, CA cap, 13th month.
- **API:** vitest in the Workers pool against local D1 — permission matrix (receptionist gets 403 on admin routes), Day Close lock, logout guard, voucher single-use.
- **Golden payroll test:** one real past week re-computed and compared with the manual payroll.
- **UI:** smoke tests with Playwright for the walk-in → checkout → Day Close path.

## 12. One-time setup (owner steps)

1. Create Cloudflare account (free); create D1 database, Worker, Pages project.
2. Create API token; add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to the GitHub repo secrets.
3. (Optional, ~₱600/yr) add a domain to Cloudflare and enable Email Routing; verify desiree.ababon@gmail.com as a destination → approval emails start working.
4. Set the Super Admin password on first deploy (seed creates the account with a one-time setup link printed in the deploy log).

## 13. Open items (flagged, not decided)

- **Night shift differential:** DOLE requires +10% for work between 10:00pm and 6:00am. The receptionist's 10–11pm hour (and any OT) would qualify. Not yet in the rules — confirm whether to add it as a `pay_rules` entry.
- **Domain for approval email** (see §12.3): without it, approvals work in-app only.
- **Happy Hours after 2026-11-30:** the promo simply stops applying; a replacement promo is a settings change, not code.
