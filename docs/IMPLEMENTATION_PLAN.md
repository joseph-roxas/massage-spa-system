# Implementation Plan — Massage Spa Booking & Management System

Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). Architecture decisions: [ADR 0001](adr/0001-cloudflare-d1-workers-pages.md) (Cloudflare D1/Workers/Pages), [ADR 0002](adr/0002-approval-email-admin-only.md) (user approval), [ADR 0003](adr/0003-day-close-counts-all-sales-cash.md) (Day Close), [ADR 0004](adr/0004-clock-in-on-front-desk-device-without-login.md) (Front-desk Device), [ADR 0005](adr/0005-shared-reliever-login.md) (Reliever Login). Current work: §15 (Phase 13, branch `cr-2`).

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
- `sales` — booking_id, business_day, status (`paid|voided`), regular_price (snapshot), discount_type (`none|senior|pwd|promo|voucher|complimentary`), discount_ref (ID no. / promo_id / voucher_id), discount_bp, discount_amount, service_amount (after discount; what Royalty counts), addons_total, amount_due, foc_kind (`none|prepaid|real`), commission_bp and commission_amount (snapshots, on regular_price), is_holiday, booklet_invoice_no (optional), reason (Complimentary), void_reason. One `paid` sale per Booking.
- `sale_addons` — sale_id, addon_id, price.
- `payments` — sale_id, method (`cash|gcash`), amount, gcash_ref (required for gcash). `voucher_payments` is the same for a voucher_sale_id.
- `vouchers` — serial (unique), service_id, voucher_sale_id (null if imported), is_free (6th of bundle), status (`unused|redeemed|voided`), redeemed_sale_id, imported (bool, go-live).
- `voucher_sales` — buyer_name/phone (optional), service_id, qty_paid, qty_free, unit_price (snapshot), total, business_day, status (`paid|voided`).
- `cash_outs` — business_day, amount, purpose, category, recorded_by. (On-call therapist same-day pay is a Cash-out of category `on_call_commission`.)

**Payroll**
- Pay Weeks are not stored; a Payroll names its week by `week_start` (the Sunday).
- `payrolls` — week_start, staff_id (one per week), kind (`therapist|receptionist`), status (`draft|approved|released`), gross, gov_sss, gov_phic, gov_pagibig, ca_deduction, net, basic (receptionist, for 13th Month), breakdown_json (per-day lines), generated/approved/released by+at.
- `cash_advances` — staff_id, amount, business_day, against_week_start (therapists), cash_out_id (when paid from the drawer), override_by, note.
- `ca_ledger` — staff_id, entry (`opening|advance|repayment`), amount, cash_advance_id, payroll_id. (Balance = opening + advances − repayments.)
- `bonuses` — year, staff_id, kind (`year_end_bonus|thirteenth_month`), basis, bp, amount, paid_at.
- `pay_rules` — key/value settings for receptionist premiums (see §5.6), editable.

**Inventory**
- `vendors` — name, contact.
- `items` — name, unit (`gal|liter|pack50|pack100|500g|1kg|1.5kg|roll|pc|…`), reorder_level, active.
- `purchase_orders` — vendor_id, status (`requested|approved|partially_received|received|cancelled`), requested_by, approved_by.
- `purchase_order_lines` — po_id, item_id, qty, expected_price.
- `stock_ins` — item_id, vendor_id, po_line_id (nullable), qty, unit_price, purchase_date, received_by.
- `stock_outs` — item_id, qty, taken_by_staff_id, recorded_by, date.
- Derived: on-hand = Σin − Σout; last stock-out date = max(stock_outs.date); latest price = last stock_in.
- As built: `items.unit` is free text ("gal", "pack of 50", "500 g"); `stock_ins.kind` is `purchase|opening` (opening = go-live count, no vendor/price); `stock_outs` has an optional note. Quantities are whole units.

**Expenses & royalty**
- `expense_categories` — laundry, petty cash, rice allowance, bookkeeping, electricity, BIR (2551Q, FS), business permit, supplies & tools, phone load, AC cleaning, other.
- `expenses` — category_id, amount, date, description, status (`pending|confirmed`), recurring_expense_id + recurring_month (one draft per month), royalty_month.
- `recurring_expenses` — category_id, amount, day_of_month, description. (Seed: Bookkeeping 1,250.00 monthly.)
- `royalty_statements` — month (YYYY-MM, key), month_start, month_end, service_sales, voucher_sales, gross_sales, bp, amount, status (`draft|confirmed`). Its Expense points back via `expenses.royalty_month`.

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
- Every 5 bought in one sale earn 1 free (10 → 2 free); no separate bundle toggle.
- Serials are `<service code>-<6 chars>` without look-alike characters (0/O, 1/I/L), e.g. `SWE-7K3M9P`; typed back case- and space-insensitively.
- A voucher pays only for the Service; Add-ons on top are still paid. Commission is earned on the Regular Price on the day redeemed.
- Single use is enforced in the database (one paid sale per serial). Voiding that checkout makes the voucher usable again.
- A voucher sale can be cancelled (with a reason) while its day is open and none of its vouchers is used; its vouchers become `voided`.
- Voucher sale payments go into the same drawer and count at Day Close.
- Go-live import (Super Admin only) takes the printed serials of paper vouchers with no sale record, so they are not counted as sales again.

### 5.6 Royalty
- Monthly (calendar month start–end): Σ(payments for Services, after discounts, excluding add-on amounts) + Σ(voucher sales by sale day). Excludes Redemptions and Real FOCs.
- Royalty = 3% → draft statement + pending expense created by monthly cron; Super Admin confirms.
- As built: Σ `sales.service_amount` of paid sales (Redemptions and Real FOCs are 0 there) + Σ paid `voucher_sales.total`, by Business Day. Rate defaults to the last statement's (3% at first) and can be changed per draft. A draft is recomputable until marked paid; its pending Expense follows it.
- A daily Worker cron (01:00 Manila) drafts the month's recurring Expenses and, once a month has ended, its Royalty statement. Both are idempotent; the Expenses screen can also run them on demand.

### 5.6a Expenses
- Categories seeded from the owner's list (+ Royalty, Other); the Super Admin can add or hide them. Bookkeeping ₱1,250 is seeded as a monthly expense on the 1st.
- Recurring expenses are drafted as `pending`; the amount can be edited (varying bills) and then confirmed when paid. Only confirmed ones count in the month's total.
- A month's spending = recorded Expenses + drawer Cash-outs (petty cash, supplies, food, transport, other) + inventory purchases (Stock-ins × price). On-call pay and Cash Advances are Payroll, not spending.
- Inventory purchases and deliveries can be marked "paid from the drawer": that makes a `supplies` Cash-out on today's Business Day (so Day Close expects it gone) linked to the Stock-in, and spending counts it once, as the purchase. Such a Cash-out can't be removed on its own.
- Expenses, Royalty and their settings are Super Admin only.

### 5.7 Payroll — Therapists
- Pay Week Sun–Sat; generated after the week ends, released the following Wed–Fri.
- Gross = Σ commission in Pay Week.
- Government Deductions = fixed weekly amounts if the therapist worked ≥1 day that week, else 0.
- CA deduction = Σ CAs taken against this pay week.
- **CA cap** when taking a CA: unreleased net pay of the last completed Pay Week − CAs already taken against it. Blocked above cap unless Super Admin overrides.
- Year-end Bonus (December): Σ commission Jan–Dec × % entered by Super Admin.
- "Worked" = clocked in or served a Guest that week. On-call Therapists have no weekly Payroll.
- A CA counts against last week while that week's Payroll is still a draft (or not generated); once it is approved, against the current week, capped at what has been earned so far this week. A CA taken while a draft exists updates the draft at once.
- Net pay can be negative (e.g. a week with one guest still withholds Government Deductions); the screen flags it.
- CAs default to coming out of the cash drawer: they are recorded as a `cash_advance` Cash-out on today's Business Day and count at Day Close. A CA can be removed (mistakes) while its day is open and its Payroll unapproved.
- Flow: generate (Receptionist or Super Admin, only after the week ends and every day in it is closed) → approve (Super Admin) → mark paid/release (Receptionist or Super Admin). Drafts can be recomputed any time; an approved Payroll can go back to draft with a reason.
- Payslip is a printable page (browser Print → PDF), not a server-made PDF.
- Clock-in Screen shows a Therapist their Commission so far this Pay Week (On-call: today) after punching in or out.

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
- Pay per minute = daily rate ÷ 480. Late, leaving early, and gaps between punches longer than the meal break come off the 480 minutes; the day's premium applies to what is left. Overtime is every minute after 23:00 (past midnight too) at the day's OT rate.
- Unworked Regular Holiday pays 100% only when it is not her Rest Day. Unworked Special Days and ordinary days pay nothing.
- Basic pay (for 13th Month) = daily rate for paid minutes at 100%, excluding premiums, Overtime and unworked holiday pay. Counted by day, so a week across New Year splits correctly. Only approved/released Payrolls count.
- Generating is refused while any of her DTR entries in the week has no clock-out.
- Only the Super Admin sees, prepares and pays the Receptionist's Payroll and CAs. Receptionist CA repayment can't exceed the balance; the screen warns when the balance is more than a week's gross.

### 5.8a Inventory
- Seeded with the owner's list (16 Items, including both pack sizes of tea lights and Epsom salt, and small/medium trash bags); reorder level 1 unit each (tissue: 6 rolls). All editable.
- Low stock = on hand at or below the reorder level (0 = never warns). Before the opening count, everything shows as low.
- Stock-out: refused above on hand; recorded on today's Business Day with an optional "taken by" and note. Removable the same day (Super Admin: any day).
- Purchase Order: Receptionist or Super Admin requests (one line per Item, expected price optional) → Super Admin approves → received in one or more deliveries, each line at the price actually paid; a delivery can't exceed what is still to come. The requester can withdraw a request; the Super Admin can reject, cancel, or stop waiting for the rest of a partial delivery.
- Purchases without an order (e.g. from the market) are recorded directly as a Stock-in with vendor, price and date.
- Opening count (Super Admin): one quantity per Item; entering an Item again replaces its count.
- Purchases are not yet Expenses; that link comes with Phase 9.

### 5.8b Reports
- Every report is one table for a date range (max one year) by Business Day, with a totals row, a short note, and Excel/CSV download of exactly that table. Charts: daily Services-paid bars, commission/spending ranked bars, and a Service × start-hour heatmap.
- FOC report groups: Senior, PWD, Promo, Voucher paid (Prepaid FOC), Voucher free 5+1 (Real FOC), Complimentary (Real FOC), with what the shop covered and the commission still paid.
- "Requested" in Sales per therapist counts Guests who asked for that therapist and were served by them.
- Receptionist: Daily sales and Guests per day, for today only.

### 5.8c Go-live
- `scripts/go-live-setup.sh` walks the owner through Cloudflare + GitHub setup (account, wrangler login, D1 create, token, secrets, Deploy all, production Super Admin).
- The **Go-live** screen (Super Admin) checks readiness from live data: staff and PINs, receptionist rate and login, prices, holidays, stock count; paper vouchers and CA balances are "if needed". It names the next Sunday to start on, so the first Pay Week is whole.
- **Paper backup** (Receptionist and Super Admin) prints an A4 landscape log: guests (start/done, service code, therapist, requested, room, discount/ID/serial, oil, paid, cash/GCash ref, "entered" tick), staff in/out in arrival order, Cash-outs, counted cash, and the price list by code. Paper lines are entered in the system once it is back, before that day's Day Close. Entering a day that was never opened online (a whole day offline) is not supported yet.

### 5.9 Business Day & Day Close
- Business Day starts at first open (14:00) and ends at Day Close, regardless of midnight. Until Day Close exists, activity before 06:00 Manila counts toward the previous day.
- Day Close shows expected Cash (cash payments − Cash-outs) and expected GCash; receptionist enters counted cash; variance stored. Day becomes read-only.
- Logout blocked while a Business Day is open. If the browser closes, the next login sees "Business Day of ___ not closed" and new sales are blocked until it's closed.
- Only Super Admin can reopen.
- A Business Day record opens with the day's first walk-in, service start, sale, Cash-out or Early Close. Scheduling a future Booking opens nothing.
- Day Close is refused until every Booking of the day is finished and checked out; unarrived Bookings must be marked no-show or cancelled.
- On-call Therapists' unpaid Commission for the day is paid at Day Close as automatic `on_call_commission` Cash-outs, already deducted from expected cash.
- A mistaken checkout is voided (with reason, audited), never deleted, and can be redone while the day is open. Cash-outs can be removed while the day is open.
- The Super Admin may log out with a day open; the Receptionist may not.

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
| payroll | `GET /payroll/weeks/:start`, `POST /payroll/weeks/:start/generate {kind}`, `GET /payrolls/:id`, `PUT /payrolls/:id/ca-repayment`, `POST /payrolls/:id/{approve,unapprove,release}`; `GET /cash-advances/balances`, `GET /cash-advances?staffId=`, `POST /cash-advances`, `DELETE /cash-advances/:id`, `PUT /cash-advances/opening` |
| bonuses | `GET /bonuses?year=`, `POST /bonuses/year-end {year, bp}`, `POST /bonuses/thirteenth-month {year}`, `POST /bonuses/:id/paid` |
| inventory | items, vendors, `POST /stock-outs`, purchase orders (request/approve/receive → stock-in), `GET /inventory/on-hand` |
| expenses | CRUD, recurring templates, confirm pending |
| royalty | `GET /royalty?month=`, `POST /royalty/:id/confirm` |
| reports | `GET /reports/{daily-sales|therapist-sales|guests|service-times|foc|addons|payroll|inventory|expenses}?from=&to=` → one table (typed columns, rows, totals). Excel/CSV are made in the browser from that table (keeps the Worker light); Royalty lives on the Expenses screen. |
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

## 14. Status and handoff (as of 2026-11-05)

### 14.0 Pick up here

- **Phase 12 is done and waiting to be merged.** It is on branch `cr-1` (pushed), in [PR #1](https://github.com/joseph-roxas/massage-spa-system/pull/1) to `main`.
  - The PR has 9 commits: docs `607562c`, slices 12.1–12.7 ending `c9788df`, then the Day Close fix `d0d4f7a` (§14.2, "Fix after 12.7").
  - The PR description is written; it still says 95 API tests, but there are now 96, and it doesn't mention the Day Close fix yet.
  - CI "verify" was running on `d0d4f7a` when the session ended (2026-11-05). This session can't link the PR, so check the PR's Checks tab. One voucher API test failed once on a busy machine and passed on every rerun; if that is the only failure, rerun the check first.
- **Next steps, in order:**
  1. CI green on PR #1, then merge `cr-1` into `main`.
  2. Finish go-live (§14.1): `scripts/go-live-setup.sh` from stage 5. Deploying runs migrations 0012–0017 in order; they rewrite data (see the PR's Merge Danger).
  3. Owner's to-dos once Phase 12 is live (Needs attention lists most): mark 2026-Q3 2551Q filed on `/finance` if done; enter the opening Sales Cash count on `/cash`; do the voucher card count and storage counts; set staff salary bases and government ID numbers.
  4. In the deployed app, the Business Day of Wed 2026-11-04 was left open with a guest not checked out. After the fix is deployed, open "Close it now", check the guest out from the dialog, then close the day.
- **Local data:** the local database (`.wrangler-state`) has Business Day 2026-11-03 still open, with every guest checked out; it can be closed whenever.

### 14.1 Where things stand

- **Phases 0–11 are built, tested and pushed to `main`.** The last commit is `96cb501`, a fix to the setup wizard.
  - Phase commits: 6 `9f7a17a..b653fe2`, 7 `53bc912`, 8 `192d733`, 9 `3bd9cdc`, 10 `a010a7f`, 11 `6d2c886`.
- **Production go-live is in progress, run by the owner.** The owner is working through `scripts/go-live-setup.sh` (9 stages) and was last at stage 5, creating the Cloudflare API token.
  - The token is the "Edit Cloudflare Workers" template plus `Account · D1 · Edit`. Its Zone Resources are `Include · All zones from an account`.
  - After stage 5 come the GitHub secrets, the "Deploy all" workflow, the Super Admin login, and then the in-app Go-live checklist (`/admin/go-live`).
  - On Windows, run the wizard with Git Bash: `& "C:\Program Files\Git\bin\bash.exe" scripts/go-live-setup.sh`. Plain `bash` in PowerShell is WSL, which has no Node.
  - `.deploy.env` (gitignored) holds the account id and the D1 database id.
- **Local test login:** `claude-test@spa.localhost`. Its password is in `.wrangler-state/test-login.txt` (gitignored, local only).
- **Conventions:**
  - Money is integer centavos; percentages are basis points.
  - Capabilities live in `packages/domain/src/permissions.ts`.
  - `auditInsert` goes inside `db.batch`, and a batch must not start with a spread.
  - D1 allows at most 100 bound parameters per query.
  - Every migration ends by updating `app_meta.schema_version`. The next migration is `0018_*` (0012–0017 are on `cr-1`).

### 14.2 Phase 12: owner's change requests after testing (built on `cr-1`, in PR #1, not merged)

All seven slices are built on branch `cr-1`, one commit each (12.1–12.7), with migrations 0012–0017; each slice ends with an **As built** note where it differs from the plan. Every decision here was confirmed with the owner on 2026-11-04 (three grilling rounds); the vocabulary is in `GLOSSARY.md` and the Day Close change in ADR 0003. Build on branch `cr-1`, one commit per slice, in this order.

**12.1 Cash-out categories and the checkout Discount dropdown**

1. **Cash-out form** offers only **Petty cash** (paid from the Petty Cash Fund) and **Laundry** (paid from Sales Cash). Cash Advance and On-call pay stay as they are.
   - Keep `supplies`, `food`, `transport`, `other` in `CASH_OUT_CATEGORIES` for history and reports; just drop them from the form.
   - Add `source` (`sales` | `petty`) to `cash_outs`. Migration: `petty_cash` rows → `petty`, the rest → `sales`. (Built in `0012_cash_out_source`; Day Close still subtracts every Cash-out until 12.3 starts using `source`.)
   - Petty cash and Laundry Cash-outs feed the Expenses month view as today.
   - Files: `DB/schema/days.ts`, `newCashOut` in `API/src/modules/days.ts`, `UI/src/lib/sales.ts`, `UI/src/pages/front-desk/DayDialogs.tsx`, `CASH_OUT_LABELS` in `API/src/modules/reports.ts`.
2. **One Discount dropdown** in `CheckoutDialog.tsx` replaces the radio buttons: No discount · each active Promo ("Happy Hours (10%)") · Senior Citizen (20%) · PWD (20%) · Voucher · Complimentary (Real FOC, Super Admin only).
   - Default pick: the best Promo that applies, so a running Promo is visible.
   - Promos that don't apply are listed disabled with the reason (wrong Service, outside 2–6pm start, past end date). Add `promoProblem()` beside `promoApplies()` in `packages/domain/src/catalogue.ts`.
   - `POST /sales/quote` takes an explicit `promoId` or `none` and returns the active Promos with applies/why-not.
   - Why the owner couldn't see Happy Hours: it applies only to Swedish (1hr) starting 2–6pm, and the old "Promo if any" option applied it silently.

**12.2 Vouchers: serials, endorsements, sales history, last-used free rule**

1. **Voucher Serial format** is `NTL-SM-0271`: branch code, Service voucher code, 4-digit counter.
   - Built as one per-Service field `voucherPrefix` holding branch + Service code (`NTL-AM`, `NTL-SM`, `NTL-VM`, `NTL-TB`, seeded by migration 0013), separate from `services.code`; no separate branch setting.
   - `normalizeSerial()` accepts `NTLSM0271`, `ntl-sm 0271`, etc., and checkout searches serials as you type.
   - Retire `newSerial()` random generation; nobody generates serials in the app.
2. **Voucher Endorsement**: the Super Admin records Service + counter range (e.g. SM 0271–0320, date). It appears on the Receptionist's For Receiving list (shared with Turnovers, 12.4); receiving creates the serials as `in_shop`.
   - Voucher statuses are `in_shop` → `unused` (sold) → `redeemed`, plus `voided` (damaged/lost card, Super Admin only). Cancelling a voucher sale puts its cards back `in_shop`.
   - Until 12.4 builds the shared For Receiving list, pending Endorsements show at the top of `VouchersPage`.
3. **Sell dialog** (`SellVouchersDialog.tsx`): the Receptionist picks **each** serial from a dropdown of received, unsold serials for that Service; no auto-fill, no generate. Buyer name required, phone optional. API checks every serial is `in_shop` and for the right Service.
4. **Voucher sales history** on `VouchersPage`: filter by date range, buyer or serial. Each Bundle row shows date sold, buyer, phone, each serial, how many used and when each was used. Also an "In shop" count per Service.
5. **Free = last redeemed.** At redemption, count the Bundle's already-redeemed Vouchers; it is a Real FOC when that count ≥ `qtyPaid` (in 10+2, the 11th and 12th). Migration: `UPDATE vouchers SET is_free = 0 WHERE voucher_sale_id IS NOT NULL`. Imported paper vouchers keep `isFree`. Update `price()` in `API/src/modules/sales.ts`, the "Free" badges and domain tests.
6. **Checkout with a serial** shows its Bundle: buyer, date bought, "3 of 6 used" with each use date, and whether this Redemption will be the Real FOC.
7. **Go-live** (replaces the "paper vouchers" step): per Service code, the owner enters the serials currently in the shop unsold, and the sold-but-unused ones with buyer/date if known, marking which imported ones are free. The owner's Feb 18 counts are stale and have gaps (AM "0092–0142 (50pcs)" is 51 numbers; VM and TB have no range), so this is a fresh count.

**12.3 Petty Cash Fund, Sales Cash and Cash Handover** (ADR 0003)

1. **Petty Cash Fund** ₱800. Balance = 800 + Top-ups − petty Cash-outs; refuse a petty Cash-out above the balance.
2. **Petty Cash Top-up**: recorded by the Receptionist, moves Sales Cash into the fund; not an Expense. On Sunday/Monday the Front Desk suggests 800 − balance.
3. **New table `cash_transfers`**: `kind` (`handover`, `petty_topup`, `payroll`), `amount`, `businessDay`, `payrollId`, `note`, `createdBy`; for handovers also `receivedAmount`, `receivedAt`, `receivedBy` (User), `receivedByName` (free text when someone received it for the owner), `confirmedBy`.
   - Payroll release (`POST /payrolls/:id/release`) gets "Paid from shop cash", default on, recording a `payroll` transfer.
   - A transfer recorded after today's Day Close belongs to the next Business Day.
   - Transfers are not Expenses and stay out of `cash_outs`.
4. **Day Close counts all Sales Cash in the shop**: expected = last closed day's counted Sales Cash + cash received today − Sales-Cash Cash-outs − payroll/top-up/handover transfers. Petty Cash counted separately. Needs a one-time opening Sales Cash count. Change `packages/domain/src/day-close.ts`.
5. **Front Desk reminder**: always "Sales Cash in shop ₱X since <last handover>". Once every payroll of the last completed Pay Week is released **and** this week's Laundry is recorded, it becomes "All paid: hand over ₱X (keep petty cash at ₱800)".
6. **Cash Handover**: the Receptionist records the amount; status "Waiting for owner". Only the Super Admin clicks **Received**, entering the amount counted and "Me" or the name of who received it. Expected / handed over / received differences are kept and shown; confirm with a note is allowed.
7. **Owner view**: Sales Cash in shop, handovers waiting, history of handovers, top-ups and payroll paid.
8. **As built** (migration 0014): the `Cash` page (`/cash`) is the owner view, also visible to the Receptionist without the Received and count buttons. The one-time opening count is a `cash_transfers` row of kind `opening` ("Count sales cash in the shop", Super Admin), and any later count restarts the running total the same way. Payroll release takes `fromShopCash` (default true). The "hand over" reminder fires once last Pay Week's Payroll is all released and a Laundry Cash-out exists this Pay Week, until a handover is recorded this Pay Week. Owner-only actions use the new capability `cash.receive`.

**12.4 Inventory: Storage, Shop Stock, Turnover, Receiving, Take-out Request, Item Kinds**

1. **Item Kind** on `items`: `consumable` | `reusable` | `equipment`. Inventory list filterable by kind. Migration: existing Items → `consumable`; the owner reclassifies in one list.
2. **Two locations.** Every Stock-in (Super Admin only) lands in **Storage**. **Shop Stock** = Received Turnovers − Uses − Discards. Lists show Storage, Shop and total.
3. **Receptionist loses** `inventory.po.request` and `inventory.receive` (and Record a Purchase). Hide those buttons in `StockTab.tsx` / `OrdersTab.tsx`.
4. **Take-out Request** (new table): Item (or free text for something new), qty needed, `low` | `out`, note, createdBy, resolvedAt/By. The Super Admin sees whether Storage has it and fulfils with a Turnover (buying first if needed) or dismisses. Resolved when its Turnover is Received.
5. **Turnover** (new table): Item, qty, date, optional Take-out Request, createdBy; `receivedQty`, `receivedAt`, `receivedBy`, note. Can be sent without a request. Appears on the Receptionist's **For Receiving** list with Voucher Endorsements. A shortfall stays counted in Storage and is flagged to the Super Admin to resolve. New capability `inventory.receive_turnover`.
6. **Use** (rename of Stock-out, Consumables only) and **Discard** (Reusable Supply/Equipment, reason `broken` | `worn_out` | `lost`), both from Shop Stock. Super Admin sees Discards as a replacement signal.
7. **Go-live**: today's on-hand counts become Shop Stock; a new step asks the Storage count per Item.
8. Purchases are expensed in the month bought (no depreciation, Equipment included).
9. **As built** (migration 0015): `stock_ins.location` and `stock_outs.location` (`storage` | `shop`), `stock_outs.kind` (`use` | `discard`) with `reason`, and new tables `turnovers` and `takeout_requests`. Existing stock rows were moved to `shop`. No new capability was added: the Receptionist's Use, Discard, Take-out Requests and Receiving all run under `inventory.stock_out`, and the Super Admin's actions (Stock-ins, Purchase Orders, Turnovers, resolving shortfalls, closing requests, Storage discards) under `inventory.po.approve`. The Receptionist no longer has `inventory.po.request` or `inventory.receive`, and the Purchase Orders tab is Super Admin only. For Receiving shows at the top of Inventory → Stock; Voucher Endorsements stay on the Vouchers page. A shortfall is resolved as "Still in my storage" or "Lost" (a Storage discard).

**12.5 Staff records and Certificates**

1. New `staff` fields: surname (existing `lastName`), first name, middle name, gender, birthdate, birthplace, civil status, religion, address, email, SSS no., PhilHealth no., TIN, Pag-IBIG no., hire date. Required: surname, first name, gender, birthdate, hire date. ID numbers get a length warning (SSS 10, PhilHealth 12, Pag-IBIG 12, TIN 9 or 12 digits) that never blocks saving.
2. Personal and government-ID fields are visible and editable by the Super Admin only.
3. **Qualification** per Therapist: NC-II holder, DOH-licensed, Nuat Thai trained only, experience only. Only DOH-licensed Therapists can be LMT class.
4. **Certificates** (new table): staffId, type (`nc2` | `doh`), number, issued, expires. Needs attention alert 60 days before expiry; an LMT whose DOH Certificate expired shows "licence expired" but isn't demoted automatically.
5. **As built** (migration 0016): the whole Staff settings API and screen were already Super Admin only (`settings.manage`), so no extra field-level hiding was needed. The API requires gender, birthdate and hire date only when a staff member is created; older records show "Personal record incomplete" and the edit form asks for them. Existing LMTs were set to `qualification = 'doh'`. Expiry badges show on the Staff list now; the Needs attention alert comes in 12.7.

**12.6 Employer Contributions, 2551Q and the Income Statement**

1. **Contribution brackets.** Per staff member, the owner sets the monthly salary base; the system computes monthly employee and employer shares from rate tables kept in Settings. Rates to re-verify against SSS/PhilHealth/Pag-IBIG official pages before building:
   - SSS 15% of MSC (EE 5%, ER 10%) + EC ₱10 (MSC < 15,000) or ₱30; MSC ₱5,000–35,000.
   - PhilHealth 5% split equally; base floor ₱10,000, ceiling ₱100,000.
   - Pag-IBIG EE 2% (1% if ≤ ₱1,500), ER 2%; fund salary cap ₱10,000.
   - Owner's current figures (EE monthly) check out: Therapists SSS ₱400 / PHIC ₱250 / HDMF ₱160 → ER ₱810 / ₱250 / ₱160 = **₱1,220**; Receptionist ₱850 / ₱422.50 / ₱200 → ER ₱1,730 / ₱422.50 / ₱200 = **₱2,352.50**.
2. **Weekly deduction** = monthly EE share ÷ number of Pay Weeks ending in that month (4 or 5), so each month adds up exactly. Replaces the fixed weekly `govSss`/`govPhic`/`govPagibig` amounts.
3. Each agency applies only once that staff member's ID number is entered (one Therapist has none yet); missing IDs show in Needs attention. On-call Therapists: none.
4. Monthly Employer Contributions draft as a Recurring Expense for the owner to confirm.
5. **Percentage Tax (2551Q)**: 3% of quarterly gross sales (Service payments after Discounts + Add-ons + Voucher sales on the day sold); expenses don't reduce it. Due the 25th day after quarter end (Apr 25, Jul 25, Oct 25, Jan 25), moved to the next working day if that is a weekend/Holiday. Home shows amount and countdown from quarter end, red in the last 7 days; **Filed** (date + amount paid) records the Expense and clears it.
6. **Income Statement** (Reports), month/quarter/year with the same period last year: Revenue (Services, Add-ons, Voucher sales; Discounts shown) less Commissions (by Service date), Receptionist pay (by DTR date), Employer Contributions, Royalty, Percentage Tax, Laundry, Petty cash, purchases (date bought) and other Expenses → Net profit.
7. **As built** (migration 0017): rates verified on sss.gov.ph (Circular 2024-006: 15%, EC ₱10 up to ₱14,500 MSC / ₱30 from ₱15,000) and philhealth.gov.ph (Advisory 2025-0002: 5%, ₱10,000–₱100,000), stored as pay rule `contribution_rates` and editable under Settings → Commission & Pay. Each staff member gets `contributionBase` (monthly salary basis); without one, Payroll keeps using the older fixed weekly amounts. Weekly deductions are still withheld only in weeks the person worked (the existing rule), so a missed week means that month is under-withheld. The Employer Contributions draft (category `employer-contributions`, one per month via `expenses.contributions_month`) is recomputed by the daily job for the current month and by a button on the new **Finance** page (`/finance`, `reports.all`), which also holds the 2551Q card and the Income Statement. 2551Q filings are `percentage_tax_filings`; marking one filed records a confirmed `bir` Expense. The Home reminder shows from quarter end until filed, red from 7 days before. Pending drafts (Royalty, contributions, recurring) are listed under the statement, not counted.

**12.7 Needs attention**

One list on the Super Admin's Home, with a nav badge: open Take-out Requests, Turnover shortfalls, Cash Handovers waiting, Certificates expiring, missing government IDs, 2551Q due. Each links to where it is acted on. (Approval email is still not set up.)

**As built:** `GET /attention` (Super Admin, `settings.manage`) also lists incomplete staff records and Expense drafts to confirm, and replaces the separate 2551Q bar on Home. Urgent items (2551Q in its last 7 days or late, out-of-stock requests, expired Certificates) come first with a red dot; the Front Desk nav item shows the count, red when anything is urgent. It refreshes every minute and after any action that can clear an item.

**Fix after 12.7: finishing guests on a day left open** (`d0d4f7a`, found by the owner on 2026-11-05)

A day left open with a guest not checked out could never be closed: the Front Desk board only shows today's guests, and the Day Close dialog listed the unfinished ones with no way to act on them. The API already allowed it (checkout records against the booking's own Business Day).
- `closingState` in `API/src/modules/days.ts` now sends each blocker's `status`, `guestName`, `serviceId` and `therapistName`.
- `DayCloseDialog` (`UI/src/pages/front-desk/DayDialogs.tsx`) offers per guest: **Check out** (done), **Done → check out** (in service), **No-show** (booked), **Cancel** (booked or waiting). Checkout opens the normal `CheckoutDialog` (its prop is now `CheckoutBooking`, a `Pick` of `Booking`) and returns to the dialog; once nothing blocks, the cash count shows.
- Test: "finishes and checks out guests left on an earlier day, then closes it" in `API/test/sales.test.ts`. API tests: 96.

### 14.3 Still open from earlier phases

- Night shift differential (see §13).
- Review of holidays and Happy Hours settings before go-live.
- Approval email domain (see §12.3).
- Whole-day offline entry: the paper sheet exists, but there is no bulk-entry screen.

## 15. Phase 13: owner's second batch of change requests (branch `cr-2`)

Every decision here was confirmed with the owner on 2026-11-05 (four grilling rounds, Q1–Q45). Vocabulary is in `GLOSSARY.md` (new: Reliever, Outside Reliever, Relief Shift, Reliever Login, Guest Record, Visit, Regular, Added Service, Front-desk Device, DTR Review, Payslip, Pay Breakdown, Adjustment, CA Repayment, Minimum Wage Rate, Paper Payslip). Security trade-offs are in ADR 0004 (Front-desk Device) and ADR 0005 (Reliever Login). Build on `cr-2`, one commit per slice, in this order; the next migration is `0018_*`. Nothing is built yet.

**13.1 Pay Breakdown, Adjustments, CA Repayment, Minimum Wage Rate**

1. **Payroll lines.** Split what `breakdownJson` already computes into named lines, stored on the Payroll so Payslip, Pay Breakdown and Paper Payslip all read the same thing:
   - Therapist earnings: Commission at normal rates; Holiday extra (Commission at Holiday rate minus what normal rate would have paid); Adjustments; Relief pay (13.7).
   - Receptionist earnings: basic pay; Overtime; Rest Day premium; Holiday pay worked (premium part) and Holiday pay not worked, shown apart; Adjustments.
   - Deductions: SSS, PhilHealth, Pag-IBIG, late, undertime, CA.
   - Late and undertime are today folded into paid minutes; show them as deductions at the day's rate so basic pay reads as days present × daily rate.
2. **Pay Breakdown** tab on `PayrollPage` (Super Admin only): one table per Pay Week, one row per person, a column per line above, totals row. Print-friendly.
3. **Adjustments** (new table `payroll_adjustments`: payrollId, label, amount signed centavos, reason, createdBy/At). Added and removed on draft Payrolls only, by the Super Admin, on both kinds. They change net and gross but not `basic` (13th Month). Staff see the label only; the reason is for the Super Admin and the audit log.
4. **CA Repayment**: new `staff.caRepayment` (centavos, default ₱500) for the Receptionist, set from her Staff record or the CA screen with quick picks ₱500 / ₱750 / ₱1,000 / custom. Generating a Payroll uses it, capped at the balance; `PUT /payrolls/:id/ca-repayment` still overrides one Payroll. Replaces "default to last week's amount". Therapist CAs unchanged.
5. **Minimum Wage Rate**: new `pay_rules` key `minimum_wage_daily`, ₱582 (Cebu), editable in Settings → Commission & Pay. The Receptionist's own ₱692 stays `staff.dailyRate` on her Staff record.
6. **As built** (migration 0018): lines are not stored. `payLines()` in `packages/domain/src/payroll.ts` derives them on read from `breakdownJson`, the Payroll's totals and its Adjustments; `GET /payroll/weeks/:start` and `GET /payrolls/:id` return `lines` and `adjustments` on every Payroll. New days in `breakdownJson` carry `holidayExtra` (Therapist) and `dailyRate`, `fullBasic`, `premium`, `lateDeduction`, `undertimeDeduction` (Receptionist); Payrolls generated before 13.1 show their day pay as basic pay with no late/undertime lines. Late and undertime are valued at the day's premium and are what the day lost, so they can be a centavo off a per-minute figure but always add up exactly. A Rest Day premium is its own line; every Holiday kind (Special Day and Regular Holiday, on a Rest Day or not) goes under Holiday premium. `payroll_adjustments` is keyed by week and person, so recomputing drafts keeps them; they change `gross` and `net`, not `basic`. Adjustments are added and removed with `POST /payrolls/:id/adjustments` and `DELETE /payrolls/:id/adjustments/:adjustmentId` (Super Admin, draft only); the reason is only returned to the Super Admin. `staff.caRepayment` defaults to ₱500 for everyone and is set from Payroll → Cash Advances ("Repays ₱X a week") through `PATCH /settings/staff/:id`. The Income Statement still counts Receptionist pay from day totals, so Adjustments are not in it yet. API tests: 98.

**13.2 My Pay for the Receptionist**

1. New page **My Pay** in the Receptionist's nav, read-only, her own records only (new capability `payroll.view_own`; the Reliever Login does not get it).
2. Lists her **released** Payslips (no drafts or approved-unreleased). Each shows coverage (Sun–Sat dates), daily rate, days present, the per-day lines (in, out, late, undertime, OT, day type), every 13.1 line, net, and a Print button (reuse `PayslipPage`).
3. **CA history**: each CA (date, amount), each repayment (Payroll week, amount), total CAs, total repaid, balance.
4. API: `GET /me/payslips`, `GET /me/payslips/:id`, `GET /me/cash-advances`, all scoped to the logged-in User's linked Staff record.
5. **As built** (no migration): nothing set `staff.userId` before, so the Receptionist's Staff record gets a **Login account** picker (active Receptionist logins only, one staff record per login), saved through `PATCH /settings/staff/:id` with `userId`. Until it is linked, My Pay says to ask the owner. The API is two endpoints: `GET /me/pay` (staff summary, released Payslips, and the CA ledger oldest first with totals taken, repaid and owed) and `GET /me/payslips/:id` (released and her own only, otherwise 404; Adjustment reasons left out). `payroll.view_own` is granted to the Receptionist role; the Super Admin holds it too but the nav item is hidden for her (`hideFor`). The printable payslip is now `PayslipSheet`, shared by the owner's Payslip page and My Pay. API tests: 99.

**13.3 Guest Records, Visits, Regulars**

1. New table `guests`: name, phone (optional), statutoryType (`senior` | `pwd` | null), statutoryIdNo, mergedInto, createdAt/By. `bookings.guestId` and `voucher_sales.guestId` (nullable); `guestName`/`guestPhone` kept for history and for Bookings without a record.
2. **Pick or create** in `NewBookingDialog` (Walk-in and Scheduled) and `SellVouchersDialog`: typing searches name and phone, pick one or create new. Leaving it as a typed name with no record still works.
3. **Checkout** pre-fills Senior/PWD and the ID number from the Guest Record; entering a new ID at checkout offers to save it to the record.
4. **Guests page** (Receptionist and Super Admin): list with search, Regular badge, Visits, last Visit; Guest page with visit history (date, Services, Therapist), average days between Visits, Vouchers bought. SC/PWD ID masked (`••••4821`) except at checkout and in the edit form.
5. **Visit** = a Business Day with at least one checked-out Booking for that Guest. **Regular** = at least 3 Visits in the last 90 days; both numbers are `pay_rules`-style settings (`regular_guest_rule`) editable by the Super Admin.
6. **Merge duplicates** (Super Admin only): moves Bookings and Voucher sales to the kept record, sets `mergedInto` on the other.
7. No backfill: Bookings and Voucher sales before this slice stay unlinked.

**13.4 Added Services**

1. New `bookings.parentBookingId` (the Booking it follows). "Add Service" on an in-service Booking on the Front Desk: pick Service, Therapist (default the same one; any free clocked-in Therapist allowed), same Room; it starts when the current one ends and becomes `in_service` then automatically.
2. Warn, don't block, when the extra time runs into that Therapist's or Room's next Scheduled Booking, naming the clash.
3. **Rotation**: the Therapist goes to the back once, after the last linked Booking is done; an Added Service costs no extra Rotation place. Update `packages/domain` rotation rules and tests.
4. **Checkout** for the stay: one dialog listing every linked Booking, each with its own Discount (Happy Hours judged by that Booking's own start), SC/PWD ID entered once for all, one payment (Cash / GCash / split). Still one Sale per Booking (`sales_one_per_booking` unchanged); split payments apportioned across the Sales.
5. An Added Service can be cancelled until it starts; once started it is paid or made a Complimentary Service.
6. Day Close blockers (the `d0d4f7a` dialog) handle linked Bookings the same way.

**13.5 Front-desk Device and Clock-in Screen** (ADR 0004)

1. **Mark this device**: the Super Admin, logged in on the reception PC, marks it in Settings. This stores a long random device token (hashed in a new table `front_desk_devices`: label, tokenHash, createdAt/By, revokedAt) and sets it in a long-lived cookie. Settings lists marked devices with date and lets the Super Admin remove one (re-mark when the PC is replaced).
2. The **login page** on a marked device shows a large **Clock in** button opening `/clock` without a User session. `/clock/staff` and `/clock/punch` accept either a User session (as today) or a valid device token; nothing else under the API does. PIN lockout rules unchanged.
3. Clock-in Screen shows the date and a running clock, and a banner "Regular Holiday: <name>" / "Special day: <name>" or "Regular day".
4. **Birthday**: after a successful clock-in (not clock-out) on the staff member's birthday, a full-screen celebration card ("Happy birthday, <Name>! 🎂", confetti) until the next tap, once per day. The Front Desk shows a highlighted banner all day: "🎂 Today is <Name>'s birthday, greet them!"
5. The Therapist's "Commission so far this Pay Week" after punching stays.

**13.6 DTR bulk entry and DTR Review**

1. **Add missing entries** on `DtrPage`: pick one Staff member, add rows (Business Day, clock-in, clock-out), one shared reason with optional per-row reasons. New `POST /dtr/batch`; all rows saved or none, with the overlapping/invalid rows highlighted. Permissions as today: Receptionist for Therapists, Super Admin for anyone.
2. **DTR Review** tab (Super Admin): every entry with `source = 'manual'`, a correction, or no clock-out, regardless of date, newest first, filter by person. New `dtr.reviewedAt`/`reviewedBy`; editing an entry again clears them. Bulk "Mark reviewed".
3. **Needs attention** gets one item, "N DTR entries to review", linking to the DTR Review tab. The rest of Needs attention is unchanged (its title links were already what the owner wanted; no buttons).

**13.7 Relievers** (ADR 0005)

1. **Relief Shift** on DTR: new `dtr.isRelief`. On the Clock-in Screen a Therapist clocking in can tick "Relieving the front desk today"; an Outside Reliever's clock-ins are always relief. Super Admin and Receptionist can set or clear it later on the DTR page (reason required). A Therapist on a relief entry is out of the Rotation; covering part of a day is a relief entry, then they clock out and back in normally to rejoin the Rotation.
2. **Outside Reliever**: `staff.kind` gains `reliever`, needing only name and PIN; `staff.reliefPay` (`on_return` | `weekly`, default `on_return`). No contribution base, no Government Deductions.
3. **Relief pay** (new domain function beside the Receptionist's day calculation): the Receptionist's DTR rules at the Minimum Wage Rate: late, undertime, OT and Holiday premiums apply; **no Rest Day premium**; no Government Deductions.
   - Shop Therapist: a Relief pay line on their Therapist Payroll for that Pay Week; not Commission, so not in the Year-end Bonus; their Government Deductions unchanged.
   - Outside, `on_return`: when the Receptionist next clocks in, the Front Desk shows "Pay <Reliever> ₱X for <dates>"; the button records a `relief_pay` Cash-out from Sales Cash (counted at Day Close, a staff cost on the Income Statement).
   - Outside, `weekly`: their own weekly Payroll (new `payrolls.kind` value `reliever`), same flow as the Receptionist's.
4. **Reliever Login**: one shared User with a new role `reliever`. Login is refused unless someone has an open relief DTR entry; every action under it is credited to that Reliever in the audit log ("Reliever Login (Marites)"). Capabilities: the Receptionist's minus Payroll generate/release (and minus `payroll.view_own`); Cash Handover included.
5. **Reliever Cash Handover**: after each Relief Shift's Day Close, the Front Desk asks the Reliever to record a Cash Handover of all Sales Cash in the shop (Petty Cash stays at ₱800), without the Payroll/Laundry reminder rule. The Super Admin confirms with **Received** as today.

**13.8 Paper Payslips**

1. Printable blank forms beside `PaperSheetPage`, half A4, two per sheet.
2. **Therapist**: name, Pay Week; 7 day rows (date, sales, commission, Holiday rate tick); CAs taken (date, amount); Adjustments; SSS / PhilHealth / Pag-IBIG; total CA; net; signatures.
3. **Receptionist**: name, Pay Week, daily rate; 7 day rows (in, out, late, undertime, OT minutes, day type); the 13.1 earnings and deduction lines; CA balance before, repayment, balance after; net; signatures.
