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
- Rotation = clocked-in therapists for the Business Day, ordered by `clock_in`. An LMT goes first until their first finished un-requested Service (§17, 15.2).
- Next un-requested Guest → first therapist in Rotation who is free (not `in_service`) and whose Service would end by 30 minutes before any reservation naming them.
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
4. Add-ons were retired in Phase 15. Top-ups are added to the price (§17, 15.3).
5. Payment after Done; Cash/GCash split allowed; GCash ref required; total paid must equal amount due.

### 5.4 Commission
- `commission = (regular_price − owner's set-aside) × rate`, where rate = staff type's normal or holiday % (holiday if the Business Day is a Holiday with `raises_commission`).
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

## 14. Status and handoff (as of 2026-11-08)

### 14.0 Pick up here

- **Current work is §17 (Phase 15, branch `cr-4`): built and pushed; next is the owner's merge and deploy, before the Front Desk opens on 2026-11-09. Start there.** Phases 12, 13 and 14 are merged to `main`. The notes below are older and kept for history.
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
8. **As built** (migration 0019): `guests` table plus `bookings.guestId` and `voucher_sales.guestId`; the Booking and sale still copy the name and phone. `GuestPicker` (UI) is the shared pick-or-create control: typing a name or phone lists matches; otherwise "Save as a new Guest Record" (ticked by default) sends `saveGuest`, and `resolveGuest` in `API/src/lib/guests.ts` creates the record. `PUT /bookings/:id/guest` links a record to a Booking at any point before it is cancelled, so checkout can link a walk-in ("Link a Guest Record"). At checkout a saved SC/PWD ID picks that Discount and fills in the number; a new or changed ID is offered as "Save this ID to the Guest Record" and saved after the sale. Visits and Regular status come from `visitStats` in `packages/domain/src/guests.ts`; the rule is pay rule `regular_guest_rule` ({"visits":3,"days":90}), set on the Guests page by the Super Admin. The Front Desk shows a Regular badge. Routes: `GET/POST /guests`, `GET/PATCH /guests/:id` (`bookings.manage`), `POST /guests/:id/merge` (`settings.manage`). The full ID is only in `GET /guests/:id`; lists send `statutoryIdMasked`. A new buyer's record is inserted just before the Voucher sale batch, so a failed sale can leave a record with no Visits. API tests: 103.

**13.4 Added Services**

1. New `bookings.parentBookingId` (the Booking it follows). "Add Service" on an in-service Booking on the Front Desk: pick Service, Therapist (default the same one; any free clocked-in Therapist allowed), same Room; it starts when the current one ends and becomes `in_service` then automatically.
2. Warn, don't block, when the extra time runs into that Therapist's or Room's next Scheduled Booking, naming the clash.
3. **Rotation**: the Therapist goes to the back once, after the last linked Booking is done; an Added Service costs no extra Rotation place. Update `packages/domain` rotation rules and tests.
4. **Checkout** for the stay: one dialog listing every linked Booking, each with its own Discount (Happy Hours judged by that Booking's own start), SC/PWD ID entered once for all, one payment (Cash / GCash / split). Still one Sale per Booking (`sales_one_per_booking` unchanged); split payments apportioned across the Sales.
5. An Added Service can be cancelled until it starts; once started it is paid or made a Complimentary Service.
6. Day Close blockers (the `d0d4f7a` dialog) handle linked Bookings the same way.
7. **As built** (migration 0020): `bookings.parentBookingId` (no foreign key). `POST /bookings/:id/add-service` (`serviceId`, optional `therapistId`, `confirm`) creates the Added Service as a `waiting` walk-in with its Therapist and Room already set and `scheduledAt` at the expected start, so clash checks and held-therapist logic see it; one per Booking (add the next to the Added Service). A clash returns 409 `clash` until resent with `confirm`, and the reason is kept in the audit log. `POST /bookings/:id/done` starts the waiting Added Service in the same batch and returns `startedNext`; if its Therapist is busy elsewhere it stays waiting and is started from the list as usual. No Rotation change was needed: the same Therapist stays busy and goes to the back at the last Done. An unrequested parent's Therapist keeps the Guest unrequested; a different Therapist takes the Added Service as a normal Rotation turn (costs their place). Checkout is `POST /sales/stay` (items per Service, one payment, split in order over the Sales by `splitPayments`); it refuses while any Service of the stay is not done, or if a Service is left out. `GET /bookings/:id/stay` lists the stay (`stayOf` in the domain). The UI always checks out through `/sales/stay`, also for a single Service; `POST /sales` stays for one Booking. One SC/PWD ID number is entered for the whole stay. API tests: 105.

**13.5 Front-desk Device and Clock-in Screen** (ADR 0004)

1. **Mark this device**: the Super Admin, logged in on the reception PC, marks it in Settings. This stores a long random device token (hashed in a new table `front_desk_devices`: label, tokenHash, createdAt/By, revokedAt) and sets it in a long-lived cookie. Settings lists marked devices with date and lets the Super Admin remove one (re-mark when the PC is replaced).
2. The **login page** on a marked device shows a large **Clock in** button opening `/clock` without a User session. `/clock/staff` and `/clock/punch` accept either a User session (as today) or a valid device token; nothing else under the API does. PIN lockout rules unchanged.
3. Clock-in Screen shows the date and a running clock, and a banner "Regular Holiday: <name>" / "Special day: <name>" or "Regular day".
4. **Birthday**: after a successful clock-in (not clock-out) on the staff member's birthday, a full-screen celebration card ("Happy birthday, <Name>! 🎂", confetti) until the next tap, once per day. The Front Desk shows a highlighted banner all day: "🎂 Today is <Name>'s birthday, greet them!"
5. The Therapist's "Commission so far this Pay Week" after punching stays.
6. **As built** (migration 0021): table `front_desk_devices` (label, `tokenHash` unique, createdBy, `lastUsedAt`, `revokedAt`) in `DB/schema/users.ts`. Cookie `__Host-spa_device` (httpOnly, Secure, SameSite=Lax) lasts 400 days, the most browsers keep, and is renewed on the first use each day. `API/src/auth/device.ts` holds `markThisDevice`, `readDevice` and the `requireSessionOrDevice` guard that now fronts `/clock/*` only. Routes: public `GET /device` ({frontDesk, label}) for the login page; `GET/POST /front-desk-devices` and `DELETE /front-desk-devices/:id` (`settings.manage`), in a new Settings tab **Front-desk device**. The `/clock` page route no longer needs a login; on a 401 it sends the browser to the login page, and its back link reads "Back to log in" when no one is logged in. `GET /clock/staff` adds `today` (Business Day and its Holiday); `POST /clock/punch` adds `birthday` (first clock-in of the Business Day, `isBirthday` in `packages/domain/src/staff.ts`, 29 Feb celebrated on 28 Feb in other years) and `firstName`. `GET /front-desk` adds `birthdays` (display names) for the banner. Holiday and birthday follow the Business Day, so before 6:00am they are still the previous day's. API tests: 107.

**13.6 DTR bulk entry and DTR Review**

1. **Add missing entries** on `DtrPage`: pick one Staff member, add rows (Business Day, clock-in, clock-out), one shared reason with optional per-row reasons. New `POST /dtr/batch`; all rows saved or none, with the overlapping/invalid rows highlighted. Permissions as today: Receptionist for Therapists, Super Admin for anyone.
2. **DTR Review** tab (Super Admin): every entry with `source = 'manual'`, a correction, or no clock-out, regardless of date, newest first, filter by person. New `dtr.reviewedAt`/`reviewedBy`; editing an entry again clears them. Bulk "Mark reviewed".
3. **Needs attention** gets one item, "N DTR entries to review", linking to the DTR Review tab. The rest of Needs attention is unchanged (its title links were already what the owner wanted; no buttons).
4. **As built** (migration 0022): `dtr.reviewedAt`/`reviewedBy`; any correction clears them. `POST /dtr/batch` takes `staffId`, a shared `reason` and up to 14 `rows` (`clockIn`, `clockOut`, optional own `reason`); every row is checked against the person's other entries and against the other rows, and a failure returns 400 `invalid_rows` with `problems` (row index and message) and saves nothing. `GET /dtr/review` (optionally `?all=1` to include reviewed ones) and `POST /dtr/review` with `ids` use `dtr.correct.receptionist`, i.e. the Super Admin. "Missing its clock-out" means an open entry on a Business Day before today, so people currently clocked in are not listed. The Time Records page has **Add several days** beside the single **Add missing entry** (a time out earlier than the time in is read as after midnight), and a **To review** tab (`/dtr?tab=review`, the Needs attention link) for the Super Admin. `ApiError` in the UI now carries the error body. API tests: 109.

**13.7 Relievers** (ADR 0005)

1. **Relief Shift** on DTR: new `dtr.isRelief`. On the Clock-in Screen a Therapist clocking in can tick "Relieving the front desk today"; an Outside Reliever's clock-ins are always relief. Super Admin and Receptionist can set or clear it later on the DTR page (reason required). A Therapist on a relief entry is out of the Rotation; covering part of a day is a relief entry, then they clock out and back in normally to rejoin the Rotation.
2. **Outside Reliever**: `staff.kind` gains `reliever`, needing only name and PIN; `staff.reliefPay` (`on_return` | `weekly`, default `on_return`). No contribution base, no Government Deductions.
3. **Relief pay** (new domain function beside the Receptionist's day calculation): the Receptionist's DTR rules at the Minimum Wage Rate: late, undertime, OT and Holiday premiums apply; **no Rest Day premium**; no Government Deductions.
   - Shop Therapist: a Relief pay line on their Therapist Payroll for that Pay Week; not Commission, so not in the Year-end Bonus; their Government Deductions unchanged.
   - Outside, `on_return`: when the Receptionist next clocks in, the Front Desk shows "Pay <Reliever> ₱X for <dates>"; the button records a `relief_pay` Cash-out from Sales Cash (counted at Day Close, a staff cost on the Income Statement).
   - Outside, `weekly`: their own weekly Payroll (new `payrolls.kind` value `reliever`), same flow as the Receptionist's.
4. **Reliever Login**: one shared User with a new role `reliever`. Login is refused unless someone has an open relief DTR entry; every action under it is credited to that Reliever in the audit log ("Reliever Login (Marites)"). Capabilities: the Receptionist's minus Payroll generate/release (and minus `payroll.view_own`); Cash Handover included.
5. **Reliever Cash Handover**: after each Relief Shift's Day Close, the Front Desk asks the Reliever to record a Cash Handover of all Sales Cash in the shop (Petty Cash stays at ₱800), without the Payroll/Laundry reminder rule. The Super Admin confirms with **Received** as today.
6. **As built** (migration 0023): `dtr.isRelief`/`reliefPaidAt`, `staff.reliefPay`, kinds/roles/payroll kind `reliever`, Cash-out category `relief_pay`, and `audit_log.acting_staff_id` filled by a trigger (ADR 0005). Relief pay is `reliefDay` in the domain; a cover of 5 hours or less takes no meal break (confirmed by the owner on 2026-11-05). `GET/POST /relief-pay` pays short-cover Outside Relievers from Sales Cash; the Front Desk prompt shows whenever one is owed (not only right after the Receptionist clocks in). The Reliever Login session ends when no relief entry is open. Not checked in the browser: logging in with the Reliever Login, the long-cover payroll screen. API tests: 113.

**13.8 Paper Payslips**

1. Printable blank forms beside `PaperSheetPage`, half A4, two per sheet.
2. **Therapist**: name, Pay Week; 7 day rows (date, sales, commission, Holiday rate tick); CAs taken (date, amount); Adjustments; SSS / PhilHealth / Pag-IBIG; total CA; net; signatures.
3. **Receptionist**: name, Pay Week, daily rate; 7 day rows (in, out, late, undertime, OT minutes, day type); the 13.1 earnings and deduction lines; CA balance before, repayment, balance after; net; signatures.
4. **As built** (no migration): `UI/src/pages/PaperPayslips.tsx`, shown as tabs on the **Paper backup** page next to the front desk log, printed A4 portrait with two 138mm slips per sheet and a dashed cut line. The Therapist slip (for anyone with `payroll.therapist.generate`) adds a Relief pay column and prints today's Commission rates for the owner, blanks for the Receptionist (she can't read Settings). The Receptionist slip is the owner's only (`payroll.receptionist.manage`) and prints the premium rates from Settings. Phase 13 is complete; nothing is pushed.

## 16. Phase 14: owner's third batch of change requests (branch `cr-3`)

Grilled with the owner on 2026-11-06 (five rounds). Vocabulary is in `GLOSSARY.md` (new: Go-live, Daily Summary, Reject, Used Before Go-live, Deferred Deductions, Take-home Floor, Not Enrolled, Commission before Go-live). ADRs 0006–0008. Go-live is **Sunday 2026-11-08**. Nothing below blocks going live; 14.1–14.3 are the target for 2026-11-07. 14.5 and 14.6 must ship before the first Therapist Payroll. Next migration is 0024.

**14.1 Front Desk and small fixes**

1. **Today strip** at the top of the Front Desk: large Today's Sales (all money received today, Cash and GCash, including Add-ons and Vouchers sold, same as the sheet's NET SALES) and Today's Guests (checked-out Services, same as the sheet's # of Guest), with Turned away as a small third number.
2. **Turned away**: a Front Desk button records a Reject with a reason (`no_therapist`, `too_late`, `refused_safety`) on today's Business Day. Add to the Daily sales report.
3. **Hand over cash**: on the Front Desk only, the `hand_over` reminder becomes a red banner with the amount, how long it has been due and a large button. Unchanged when not due. After 24 hours it appears as an urgent Needs Attention item for the Super Admin. Day Close is not blocked. Track when the reminder first became due.
4. **Inventory**: the Stock view opens filtered to Consumables for the Receptionist and Reliever Login; All stays selectable. Super Admin still opens on All.
5. **Side menu** is fixed to the browser height: name, role and logout always visible, the menu itself scrolls.
6. **Business name and logo**: Super Admin edits them in Settings. Shown with "Spa System" beneath in the side menu, on the login page, the Clock-in Screen and printed Payslips; the logo is also the tab icon and the name the tab title. The image is shrunk in the browser before upload and kept in D1 (no R2 binding exists). A public read endpoint serves them because the login page has no session.

7. **As built** (migration 0024): `rejects` and `branding` tables, `API/src/modules/rejects.ts` and `branding.ts`. `GET /front-desk` returns `today`. The handover's due time is derived, not stored: `handoverState()` in `lib/sales-cash.ts` takes the later of the last release and the first Laundry of the week, and both `/cash/summary` and `/attention` use it. The logo lives in `branding.logo` as a data URL returned by the public `GET /branding`.

**14.2 Vouchers Used Before Go-live**

1. New Voucher status `used_before_golive` with optional date and note: no Sale, no Commission, no FOC, not in any report total.
2. Super Admin only, from the import form (for cards not yet in the system) and the Vouchers list, by single serial or serial range; then un-mark individual cards with a reason. Audited.
3. Redemption refuses these serials with a clear message.
4. Go-live status counts must stop treating them as unused (today it counts `imported` with no `redeemedSaleId`); show sold / used / still out.

5. **As built**: `POST /vouchers/import` with `state: 'used_before_golive'` inserts new cards and flips paper cards already counted as unused, so a range does both; anything else in the range is refused. Single cards use `POST /vouchers/:id/mark-used` and `/unmark-used`.

**14.3 Time record override**

1. The DTR Review tab gets Edit and Remove on each row. The Super Admin's own correction counts as Reviewed (today `PATCH /dtr/:id` clears `reviewedAt` for everyone); a reason stays required and the audit log keeps the original.
2. Once the Super Admin has reviewed or corrected an entry, the Receptionist can't change it and sees "Corrected by the owner".
3. Changing or removing a DTR entry in a Pay Week whose Payroll is approved or released is refused until that Payroll goes back to draft.

4. **As built**: `reviewStamp()` stamps the Super Admin's entries as Reviewed on add, batch add and correct. `lockedForDesk()` returns 409 `dtr_locked`, `payrollLocked()` 409 `payroll_locked`, the latter for the Super Admin too. It uses today's single Sunday–Saturday `payWeekOf`, so 14.5 must switch it to the person's own Pay Week.

**14.4 Backfill: Daily Summaries** (ADR 0006)

1. **New records**: `daily_summaries` (date, cash, gcash, oil, voucher, foc, commission, guests, therapists, rejects, laundry, expenses) and weekly Therapist commission for 2026 (week, staff, gross, days worked, deducted). Money received for a day = cash + gcash + oil + voucher − foc. The file's "Gross Sales" column is cash at value before FOC, so it is never used alone as money received.
2. **Upload** (Super Admin): this exact workbook, `2026 Monthly Sales.xlsx`, parsed in the browser by its known layout (`JAN`–`DEC` rows 6–36, `Therapists`, `Summary`), with a preview, fixes in the preview, and re-upload replacing a month. A date with real Sales is refused. Warn when commission is high or low against sales or a day has an odd sales-per-Guest.
3. **Add/edit form** for one Daily Summary (Super Admin), for Nov 1–7 after go-live and for typos.
4. **Known corrections**: Oct 28 Gross 5,750 (file has 570); Jan 26 commission 2,565 (file has 265); Oct Receptionist 18,916.69, VECO 9,265.77, Supplies 12,520, Maintenance 13,998. Apr 2–3 were closed. Nov 1 data is not in the file yet.
5. **Totals**: the monthly rows are official. Daily Laundry and Expenses only draw the daily chart and are never added on top. January's Miscellaneous excludes Maintenance while Feb–Sep include it, so import Maintenance separately and take Miscellaneous as the daily Expenses total, never `Summary` row 18.
6. **Expense mapping**: VECO → Electricity; Laundry → Laundry; Supplies → Supplies and tools; Miscellaneous → Other; Maintenance and Government remittance → new categories; the Bookkeeping row split by its `Summary` rows 49–75 into Bookkeeping, BIR and Business permit. Commission and Receptionist are pay lines, not Expenses. Supplies come in as a monthly total, not Stock-ins.
7. **Commission in the Income Statement** is the sum of daily commission, not the weekly-grouped `Therapists` row, so it matches how live months work. The weekly data feeds Year-end Bonus and opening balances only.
8. **Government remittance**: the Expense is remittance minus what was withheld from staff, because Commission and Receptionist pay are gross. Penalties stay in full. A month where withheld exceeds remitted records 0 and carries the difference forward, so the year total is right. Withholding comes from the weekly figures in the two workbooks (Receptionist ₱317 a week through Feb, ₱368.13 from March).
9. **Royalty**: Jan–May imported as paid, Jun–Sep payable, all at 3% of the daily cash column (Jan 7,326.00, Feb 5,034.30, Mar 4,768.50, Apr 4,845.30, May 6,774.60; Jun 6,078.00, Jul 5,920.80, Aug 5,974.80, Sep 5,577.30). October is payable at the corrected rule, ₱6,436.20. Those statements are fixed amounts that the monthly recompute must not touch. From November the existing rule applies, with Daily Summaries contributing money received less oil. Payable total ₱29,987.10.
10. **2551Q**: import as filed Q4-2025 15,209.40, Q1 17,285.40, Q2 18,198.30, Q3 17,135.70. Their base is NET SALES, which matches the existing rule. Daily Summaries count toward the current quarter.
11. **Reports**: Daily sales, Income Statement, Royalty and Percentage Tax add Daily Summaries; those days are labelled "Summary only". Service, Discount-type and Guest detail say not available before go-live.
12. **Past Payslips** (Receptionist only): a second upload, `Receptionist Time Record.xlsx`, sheets `Summary` (rows 245–288: 44 Pay Weeks, Dec 28, 2025 to Oct 31, 2026) and `Timesheet` (daily times). Stored as they are in their own record, never recomputed with the live rules: coverage, daily rate, days worked, basic, Overtime, holiday and Rest Day pay, late/undertime, SSS, HDMF, PhilHealth, CA repayment, gross, net, date paid, plus each day's times and holiday name. Older years in the file are ignored. Not real DTR or Payrolls, so DTR Review, Payroll, Day Close and the CA ledger are untouched. Skip the junk in the `Savings` column and the `#VALUE!` date paid on row 280. The owner's notes column is not imported.
13. **Shown** read-only in My Pay and to the Super Admin, in the Payslip layout, labelled "Before go-live", after her released Payslips. Printable. The week of Nov 1–7 is added by re-uploading once it is in the file. Her monthly row in the Sales workbook stays the Income Statement figure: it equals these weekly grosses grouped by the month holding most of the week.

14. **As built** (migration 0025): parsing lives in `packages/domain/src/backfill.ts` and runs in the browser on plain rows from `exceljs`, lazy-loaded (`UI/src/lib/backfill.ts`), so it is unit-tested without Excel. The page is `/admin/backfill`. `PUT /backfill/months/:month` replaces one month, and months are saved one at a time. `lib/daily-summaries.ts` adds Daily Summaries to Royalty, Percentage Tax and the Income Statement; `royalty_statements.fixed` keeps imported statements from being recomputed. New Expense categories `maintenance` and `government`.

**14.5 Therapist Pay Week** (ADR 0007)

1. Therapists run Monday–Sunday; the Receptionist and weekly Outside Relievers stay Sunday–Saturday. `payWeekOf` and friends take the staff kind; check Payroll generation, CA cap and repayment, Clock-in Commission so far, `weeklyPart`/`payWeekEndsIn`, Reports, and the Cash Handover rule.
2. Cash Handover reminder: due once the last finished Therapist Payroll is released and Laundry paid. The Receptionist's Payroll no longer gates it unless it was paid from the shop.
3. **First Therapist Payroll, Nov 2–8**: a Commission before Go-live box per Therapist. The Payroll can't be approved until it is filled. Nov 2–7 are exempt from "every day closed". It counts toward the Year-end Bonus.

4. **As built** (migration 0026): `payWeekOf(date, kind)` and `lastCompletedPayWeek(date, kind)` default to Sunday–Saturday; `weekFrom(start)` is used wherever a week is already known, so older Sunday-based Therapist Payrolls still display. A week's start day decides whose it is (`weekKindsOf`): `/payroll/weeks/:start` returns only Therapists for a Monday and everyone else for a Sunday, and the Payroll page switches between them. `weeklyPart` follows the weekday of the week's end. Commission before Go-live is kept in `past_therapist_weeks` for that week, read into `payrolls.commission_before`. `go_live_date` is a pay rule, so days before it never hold a Payroll back.

**14.6 Deferred Deductions, Not Enrolled, exact amounts** (ADR 0008)

1. On each Therapist Payroll: take this week's Government Deductions only, as far as the Take-home Floor (`pay_rules`, ₱1,000) allows; the rest goes on the balance. The balance is not collected automatically (owner's decision, 2026-11-07): it comes off the last working week, the Year-end Bonus, or sooner if the Therapist asks. No choice for the Receptionist; the Super Admin can override on a single Payroll, and can record that the Therapist agreed to a deduction under the floor. A ledger like `ca_ledger`, shown on the Payslip and Pay Breakdown. Replaces the spec line that net can go negative.
2. A week with no work takes nothing from pay, but its deductions still go on the balance, since the shop remits them anyway (owner's decision, 2026-11-07). Not for someone who has left or not yet started. The Payslip's Last working week button takes everything owed, ignoring the Take-home Floor, up to the pay after Cash Advances.
3. **Opening balances** through Nov 1: 24 weeks at ₱204.50, no-work weeks included and Cabiles's weeks 10–13 left out because March was not declared. Nerosa ₱1,022.50 (7, 14, 16, 29, 30), Navarra ₱1,022.50 (1, 2, 14, 17, 40), Cabiles ₱818.00 (9, 14, 16, 17), Isidro Albert ₱818.00 (3, 11, 20, 21), Gura ₱613.50 (1, 2, 14), Isidro Alma ₱409.00 (11, 38), Ocariza ₱204.50 (8); Ausencillo and Vecin nil. Total ₱4,908.00, set by clicking weeks on or off; the record suggests 28 weeks, ₱5,726.00, until Cabiles's four are clicked off. Week 45 onward is handled by the system.
4. **Not Enrolled** mark on the Staff record (Vecin, Cristina): no deductions, no Employer Contributions, no missing-ID alert, visible on the record.
5. All other Staff are set at their actual bracket (Therapists ₱8,000), so `weeklyPart` splits the monthly share exactly: ₱212.50 in a 4-week month, ₱170 in a 5-week month. Check: the forecast reproduces about ₱20,553 a month.
6. Owner's follow-up, not code: written consent for deductions from the bonus; bookkeeper to confirm coverage for Vecin and the flat bracket.

7. **As built** (migration 0026): `deferDeductions()` in the domain; the room is the smaller of earned − Take-home Floor and earned − Cash Advances. This replaces §5.7's "net pay can be negative" for Government Deductions. `payrolls` gains `gov_deferred`, `gov_collected`, `gov_balance_before`, `gov_override`; `gov_sss/phic/pagibig` stay the week's full shares, since the shop remits them regardless. `deduction_ledger` is written on approve and removed on back-to-draft, so a draft owes nothing. Approve recomputes and refuses (`stale`) if the figures moved; Adjustments and Cash Advances refresh the draft. Payslip shows one signed Deferred Deductions line. Tab: Payroll → Deferred Deductions, which suggests each opening balance from `past_therapist_weeks`.

**14.6a Payroll totals and past Therapist Payrolls** (added 2026-11-07)

1. Payroll → Totals, Super Admin only: `GET /payroll/totals?period=week|month|year&date=`, in `API/src/modules/payrollTotals.ts`. Live Payrolls plus `past_therapist_weeks` and `past_payslips`. A Payroll counts in the period holding its middle day, so a week across two months goes to the one with most of its days. This reproduces the owner's June, August and September lists, except the last Receptionist week of September, which differs by ₱118.49. Draft Payrolls count, with a notice.
2. Print payroll list follows the owner's monthly PDF: business name, contact number, address, then No., Last, First and Middle Name, Civil Status, Gross Salary, Salary Basis, Remarks. Not Enrolled staff are left off unless ticked, as on those PDFs. Contact number (migration 0029 renames `tin`, since production had already run 0028) and address are new Business settings, kept out of the public `/branding`.
3. The Receptionist already sees live Therapist weeks. Added: Pay Breakdown, and weeks before Go-live read only from `past_therapist_weeks`.

**14.8a Guests not served on the Dashboard** (added 2026-11-07): No-shows, cancellations and Rejects for the month, who didn't show with their count to date, and the latest cancellation reasons. An Added Service that was cancelled doesn't count. No migration.

**14.7 December pay**

1. **Year-end Bonus** (Therapists only) covers every Pay Week since last year's cut-off through the last finished one before computing. For 2026 that is Dec 29, 2025 to Dec 13, 2026, weekly sheet data plus live Sales. The next year starts Dec 14. Today it sums Jan 1–Dec 31 Sales.
2. Takes off any remaining Deferred Deductions as a line.
3. **Percentage suggestion**: the Super Admin sets the share of the year's profit to give (default 30%). Suggested % = that share × (profit after the Receptionist's 13th Month Pay) ÷ total Commission, to the nearest 0.5%, shown against the usual 5–7%, with the peso cost and profit left at a few percentages. The owner still chooses. A loss year says there is no room and leaves the choice open. Not applied to the Receptionist.
4. **13th Month Pay**: an opening basic-pay figure, editable, added to live basic pay. From the file's numbers: Jan 4–Oct 31 basic ₱192,463.00 less late/undertime ₱1,393.96, plus Jan 1–3 at ₱605 (₱1,815.00), is ₱192,884.04. Add Nov 1–7 when known. The file's rates stand: ₱605 to Feb 28, ₱650 from Mar 1, ₱692 from mid-October.
5. **Receptionist's opening CA balance** at go-live: ₱5,000 after the Oct 25–31 week, less any Nov 1–7 repayment, editable. Her standing CA Repayment is ₱500.

6. **As built** (migration 0027): `bonusPeriod`, `bonusDeduction` and `suggestBonus` in the domain. `bonuses` gains `deduction`, `period_start`, `period_end`; `amount` stays the whole bonus, so the Income Statement cost is unchanged, and take-home is `amount − deduction`. The cut-off is fixed once any of the year's bonuses is paid. Deferred Deductions move to the ledger (`bonus`) on Mark paid, not on compute; Mark paid refuses (`stale`) if the balance has moved. The suggestion's profit is the Income Statement over the bonus period, with bonuses paid added back, less 13th Month Pay as computed or as the basic pay so far gives. `opening_basic_pay` holds the 13th Month opening figure per year, suggested from Past Payslips (basic less late and undertime). The Receptionist's opening CA uses the existing opening balance, filled in from the last Past Payslip.

**14.8 Dashboard**

1. Super Admin lands on a new **Dashboard** at `/`; Front Desk becomes its own menu item; the Receptionist and Reliever Login still land on Front Desk. Needs Attention and its badge move here. Keep `/?close=1`-style links working. Staff birthdays appear here.
2. Current/previous month switch. Sections: **Top**: Needs Attention, Sales, Expenses, Profit, Cash in vs out. **Daily**: sales vs expenses by day. **Must pay**: government remittance forecast, 2551Q forecast, Royalty paid or not. **Costs**: Electricity trend, Payroll total, Discounts by type. **Guests**: average Guests by weekday, Rejects, top Therapists, top Services. **Stock**: Consumables used.
3. Definitions: forecasts are so far + daily average for the rest of the period. Cashflow is money in vs money actually paid out, no bank balance. Weekday chart uses averages. Top Therapists rank by Regular Price sales, top Services by sales, both from go-live. Consumables is cost per Guest against the 3-month average, flagged above +20%, "building baseline" until a full month exists.
4. Also: unused Voucher liability, month-end profit forecast, average sale per Guest, Day Close cash variance.
5. Insights only; detail stays in Reports. Reuse the hand-rolled SVG in `UI/src/pages/reports/Charts.tsx`; no chart library.
6. **As built**: `GET /dashboard?month=` in `API/src/modules/dashboard.ts`, built on the Reports queries and `statementFor`; forecasts and the Consumables rule are in `packages/domain/src/dashboard.ts`. No migration. `/` shows the Dashboard to whoever holds `reports.all`; everyone else, and any `/?…` link, goes to `/front-desk`. Cash out is the Income Statement's costs with live pay replaced by Payrolls actually released, plus On-call Commission and Cash Advances. Government remittance is both shares for active enrolled staff. Consumables are priced at each Item's average purchase price, and a baseline needs a whole calendar month after Go-live. The charts are in `UI/src/pages/dashboard/Charts.tsx`.


## 17. Phase 15: owner's fourth batch of change requests (branch `cr-4`)

Grilled with the owner on 2026-11-08 (three rounds), then adjusted while the owner tested. Vocabulary is in `GLOSSARY.md` (new: Owner's Set-aside, Top-up, Service Change, Therapist Change, Reserved, Grace Period, Catch-up Day; Add-on is gone; Go-live now means 2026-11-02). ADR 0009 covers the Nov 2–8 entry. Migrations 0030–0032. **Next migration is 0033.**

**Status (2026-11-08):** all of this is pushed to `cr-4` at `a6c5da6`, on top of the contact number fix `5d43917`. Not merged, not deployed. 447 tests pass (240 domain, 207 API); typecheck, lint and build pass. Merging or Deploy all runs migrations 0029–0032 on production.

**Pick up here, in order:**

1. Owner opens the PR from `cr-4` to `main`, checks CI, merges. Must be live before the Front Desk opens at 2pm on 2026-11-09. Then `/api/v1/health` should report `0032_catch_up_week`.
2. Check production for test sales dated Nov 2–8 and void them: they would show in the Nov 2–8 entry and count in its totals, with no Remove link.
3. On 2026-11-09, **before the first Guest**: Cash → Count sales cash in the shop. Counted earlier, it lands on Nov 8 and that day's entered cash is added on top.
4. Payroll → Cash Advances: the Receptionist's opening balance, with this week's payroll taking the repayment.
5. Go-live → Nov 2–8 entry, each day from the paper records.
6. From 2026-11-09, generate Payroll: Therapists week of Nov 2, Receptionist week of Nov 1 (Sunday–Saturday, so Nov 8 falls in their next week). Compare with the manual computation.
7. Finish testing the data migration locally, then upload the workbooks to production. The local database was reset on 2026-11-08 to a fresh install with only the Super Admin login.

**15.1 Commission and Oil** (migration 0030)

1. **Owner's Set-aside**: ₱50 from 2026-11-02 on ARO, HOIL and HSTN, not C3–C5. Commission = (Regular Price − Set-aside) × rate, on Holidays, FOCs and discounted sales too. ARO pays 195 Regular / 260 LMT, or 325 / 390 on a raised Holiday.
2. Bookkeeping only: it stays in Sales, Royalty Gross Sales and Sales Cash. The workbook shows ₱40 through September and ₱50 from October, which is why it is dated like prices.
3. **Oil** is no longer added to money received. Jan–Oct falls by ₱4,340; Royalty is unchanged, since it never counted Oil. Daily sales shows an Owner's Set-aside column for information.
4. **Add-ons retired**: Extra oil off, gone from checkout, reports, Settings and the Price List. `addons` and `sale_addons` tables stay.
5. **As built**: `service_set_asides` table (dated), `sales.set_aside` snapshot, `commissionFor(price, rate, holiday, setAside)`. Settings → Services has a Set-aside button.

**15.2 Rotation, reservations, No-show** (no migration)

1. Any LMT goes ahead of everyone from clock-in, at any hour, until they finish their first un-requested Service; several LMTs go in clock-in order. After that turn a later clock-in joins at the back. The shop's 3pm LMT start has no system effect.
2. Only a Scheduled Booking naming a Therapist holds anyone. From 30 minutes before, the board tags them Reserved and they stop being Next.
3. **The rule**: a Service with a held Therapist must be due to end by 30 minutes before the reservation. A 1-hour walk-in an hour before is denied; a 30-minute one is allowed. It applies to Rotation (skipped, place kept), named walk-ins, Top-ups, Service Changes, Added Services and Therapist Changes. Hard denial, no override. Clock seconds are ignored.
4. Moving, cancelling or changing the Therapist on a named reservation needs a reason and "The guest asked for this"; the Super Admin needs only the reason. New Move button on the Front Desk.
5. **No-show**: a Scheduled Booking not marked Arrived closes itself 15 minutes after its time. Rotation place unchanged. Manual No-show is hidden on named reservations.
6. **As built**: `computeRotation` takes `isLmt`. `closeMissedBookings()` and `holdSpan()` in `lib/front-desk.ts`, run lazily from `frontDeskState`. `reservedClash()` in `modules/bookings.ts`.

**15.3 Changes during a Service** (migration 0031)

1. **Top-up**: singles only, 30-minute steps, repeatable, same Booking and sale, no extra Rotation cost, no second Set-aside.
2. **Price**: Foot and Back at either length use the 30-minute price in Settings (₱250), and each full extra hour costs the 1-hour price (₱450), however it was added: 2 hours of Foot is ₱900. Other 1-hour Services are half their Regular Price. 1.5-hour Services take a chosen 30-minute head, back or foot massage at its price. Head Massage is an inactive Service (`head-30`, ₱250) so its price is editable.
3. **Discounts**: Senior/PWD on the whole bill; Voucher on the original Service only; Happy Hours on the original Service, later also one more full hour of Top-ups (§20); Complimentary covers all. Commission on full prices less the Set-aside.
4. **Service Change**: during service or before payment, reason required, full price of the new Service only, counted from the original start, clears Top-ups. A warning if the new Service is shorter than the time used.
5. **Therapist Change**: during service, reason required, new Therapist must be free. Clock runs on, whole Commission to the new one. The replaced Therapist keeps their old place, passed only by named Guests. The new one loses a place when done unless the Guest named them.
6. **As built**: `booking_top_ups`, `therapist_changes`, `sales.top_ups_total`; `sales.regular_price` includes Top-ups. `modules/service-changes.ts`, `lib/top-ups.ts`, `packages/domain/src/topups.ts`.

**15.4 Booking and the room card** (added while testing, no migration)

1. **How long** on the booking form: the menu time by default, or up to 3 hours longer in 30-minute steps, charged as Top-ups. Not on Combos, and never shorter than the menu.
2. **Room card**: Add time, Service, Therapist, Done · name, with the Therapist's name as the largest line. Done asks for confirmation. Service asks one question: change to a different service, or add another after this. With a service already following, it goes straight to change.
3. **Added Services** can be any Service. A non-foot Service after the Room 8 recliner resets that Room as a floor bed, with a note to the desk.
4. **Starts by itself**: at time up, if the same Therapist does the next one, the first closes and the next starts from the moment the first ended. `startFollowingServices()` runs lazily from `frontDeskState`, so up to about 15 seconds late on screen. A different Therapist still waits for the desk.

**15.5 Reports and menu** (no migration)

1. Receptionist: From/To dates defaulting to today. Reliever stays on today only, without the new reports, because the login may be used by a Therapist.
2. **Therapist Sales** (`therapist-detail`): one line per Service, pick one or All, subtotals per Therapist. **Therapist Changes** (`therapist-changes`): when, Service, replaced, new, minutes served, reason.
3. Price List and Paper backup hidden for Receptionist and Reliever; the Super Admin keeps them.

**15.6 Nov 2–8 entry** (migration 0032, ADR 0009)

1. Super Admin page at `/admin/catch-up`, one tab per day: time records with a Relief Shift tick, sales lines (time, Service, Therapist, Discount, Payment), Expenses, Cash Advances. Sales are priced by the same code as checkout. No Top-up field; a change that week is entered as the final Service and Therapist.
2. `go_live_date` is now 2026-11-02, so Commission before Go-live no longer applies to any week; its code and box remain, unused. Nov 2 is a special Holiday that raises Commission (50/60) and pays the Receptionist the special-day premium.
3. Days close with no cash count. On-call Commission counts as already paid. Cash Advances don't touch Sales Cash. `sales.catch_up` marks these Sales; only those can be removed on the page.

**15.7 Small additions** (no migration)

1. A rejected save names the fields ("Please check: Hire date, Email."). The Staff form also turns them red. Date boxes refuse five-digit years.
2. First names and surnames are saved with each word capitalized, on the Staff form and for on-call staff. Middle name and Shown as stay as typed.
3. The Receptionist can add an On-call Therapist from the Front Desk (+ On-call): name and PIN, always at the Regular rate. Not the Reliever login.

**Checked by automated tests only, not yet by hand:** the Reliever's menu, submitting a Therapist Change or Service Change, the Combo room card, the automatic start of an Added Service, Therapist Sales with subtotals, Expenses and Cash Advances on the Nov 2–8 page, and generating Payroll from that page.

**Known small things:** pressing Esc on Add time or Change service during checkout also closes checkout. A Guest who runs over shows the next service already counting down.

**Worth confirming with the owner:** a Guest asking for longer upfront pays the same as one who extends. An extra hour of foot or back on a 1.5-hour Service costs ₱450, not ₱500.


## 18. Phase 16: owner's fifth batch of change requests (branch `cr-5`)

Grilled with the owner on 2026-11-10 (two rounds). Vocabulary is in `GLOSSARY.md` (new: Auto Clock-out, Late Entry, Opening Count; Day Close, DTR Review and Shop Stock updated). Migrations 0033 (`dtr.auto_clock_out`) and 0034 (`bookings.entered_late`, `late_checked_at`). **Next migration is 0035.**

**Newer status: see §26 (2026-11-12).**

**Status (2026-11-11):** CR-5 is merged to `main` (`3bfab98`) and deployed: migrations 0033-0034 are on production, and 16.1-16.8 are live. The only CI failure on the PR was the Top-up test during Happy Hours; its checkout now passes no Promo. One follow-up is on branch `cr-6` (16.9), pushed at `8149942`, **not merged or deployed**; it has no migration. 463 tests pass (249 domain, 214 API). Typecheck, lint and build pass. Not tried by hand: the 6:00am cron, a Late Entry that is still in service, and saving an uploaded Opening Count (covered by an API test).

**Pick up here, in order:**

1. Owner opens the PR from `cr-6` to `main` (title: "Happy Hours includes its end time: a 6:00pm start gets the discount"), checks CI, merges. No migration, so health still reports `0034_late_entry`.
2. **Finish Nov 9** once 16.9 is live, on Correct sales, day 2026-11-09. Production now reads expected cash ₱4,650, counted ₱5,150 (the duplicate sale in 16.8.7 is already voided).
   - Re-save the start time 6:00 PM on the 6:00 PM Swedish services that really paid the Happy Hours price. With both, expected drops to ₱4,550; with one, ₱4,600. The owner is checking with the Receptionist which.
   - Correct count to ₱4,600, what the owner received.
   - Record the ₱4,600 Cash Handover for Nov 9 and confirm receipt.
3. If the Receptionist still lacks "Log out anyway", her tab is stale: reload with Ctrl+F5. The live bundle has it.
4. Correct the Receptionist's Nov 9 clock-in if not done yet (the overlap that refused it is gone).
5. Re-enter Nov 2-8 from paper on the Nov 2-8 entry page, then generate Payroll for the weeks of Nov 1 (Receptionist) and Nov 2 (Therapists).
6. Upload the Opening Counts for the Shop and Storage.
7. After the test week, collect the Receptionist's feedback as the next batch.

**Offered, not yet asked for:** an "Order" button on Shop requests, to turn a take-out request straight into a Purchase Order; and a "new version, reload" prompt (or auto-reload) for tabs left open across a deploy.

**As built, worth knowing:**
- Late Entry is a checkbox on the New walk-in form ("Already served before I could record it"), which then asks Therapist, Room, Started at and Finished at. The 30-minute Reserved rule is not applied to Late Entries, since the Service already happened. The Super Admin ticks them on the Dashboard card "Guests entered late".
- Auto Clock-out also runs from a new 06:00 Manila cron (`0 22 * * *`) and lazily whenever the Clock-in Screen or Front Desk loads.
- Logout with an open day returns `day_open` unless the body has `force: true`; the sidebar offers Go to Day Close or Log out anyway.

**Context:** the week from 2026-11-09 is the Receptionist's test week on the live system. Its records are real (Payroll, Royalty, Sales Cash); there is no test mode. Her feedback comes back as the next batch.

**16.1 Clear sample records up to Nov 8** (one-off script, not a migration)

1. Delete everything with a Business Day on or before 2026-11-08: DTR, Sales with their Bookings and related rows, Voucher Sales (their cards go back to unsold), Expenses, Cash-outs and Cash Advances, Day Closes, Cash Handovers, Rejects, Payroll for the weeks of Nov 1 and Nov 2, and Guest Records that exist only because of those Sales.
2. Keep: Daily Summaries, Past Payslips, opening balances (including the Receptionist's opening Cash Advance and the Sales Cash count, even if dated Nov 8 or earlier), staff, settings, the Item catalog. The dry run lists any kept opening rows separately.
3. Nothing real was entered for Nov 2-8 yet; the owner re-enters those days from paper on the Nov 2-8 page afterwards.
4. **The owner runs it**, not the agent: a dry-run SQL that only counts per table, a Time Travel restore point first, then the delete. The script stays local (git-excluded); it touches no names.
5. **Done 2026-11-10.** The owner ran it on production; every DELETE count afterwards was 0. `node scripts/one-off/purge.mjs` also has `list` (what is left from Nov 9 on), `cash` (where the Front Desk's Sales Cash comes from) and `fix-nov9`, all read-only except `fix-nov9`.
6. **Two D1 limits found on the way:** `wrangler d1 execute --remote --file` uses the import API, which refused the owner's OAuth login (code 10000), so SQL goes through `--command` instead. D1 also refuses a long `UNION ALL` ("too many terms in compound SELECT"), so the dry run returns one row of counts, printed one per line.
7. **Nov 9's Day Close was corrected.** It had expected and counted the cash including the sample records from before Nov 9, and Sales Cash is anchored on the latest Day Close count, so the Front Desk kept showing that figure after the delete. `fix-nov9` set Nov 9's expected and counted cash to that day's own cash only (its services less GCash, no cash-outs), with an audit log entry `day.close_corrected`. Lesson: after deleting past cash records, check the Day Close counts that follow them.

**16.2 DTR overlap message** (no migration)

1. The overlap error names the clashing entry, its times and the Business Day it is filed under, and tells the user to open that day. Cause of the owner's Nov 9 case (likely, unverified): a sample entry from Nov 8 or earlier left open, which the Receptionist's first tap on Nov 9 clocked out at about 2pm. 16.1 removes it.

**16.3 Logout and Day Close** (no migration)

1. Logging out no longer requires Day Close for the Receptionist or Reliever, so a Reliever can finish a day the Receptionist started. With a day open, logout asks once: Log out anyway, or Go to Day Close.
2. "Close the day" on the Front Desk is solid red whenever a Business Day is open, older unclosed days included.
3. Closing always asks for confirmation before it locks the day, naming the day and who will be clocked out.
4. Dropped: ending the login when the browser closes.

**16.4 Auto Clock-out** (migration: a marker on DTR)

1. Day Close clocks out everyone still clocked in, the closer included, at the close time.
2. At 6:00am (a new daily cron, `0 22 * * *` UTC, and lazily when the Clock-in Screen or Front Desk loads), anyone still in is clocked out at that Business Day's Day Close time, or 11:00pm if it was never closed.
3. Each is marked "Auto clock-out" and goes on DTR Review. A Receptionist's Overtime therefore never runs past the close.

**16.5 Late Entry** (migration: entered-late marker on bookings). As agreed 2026-11-10:

1. The Walk-in form gets "Started at" (default now) and optional "Finished at"; a past start also asks Therapist and Room.
2. Today's Business Day only, never before the Therapist's clock-in; if they did not clock in, the desk adds the time record first (goes to DTR Review).
3. Rotation follows the real times.
4. Marked "Entered late" with when it was entered, shown in the Finished list and Therapist Sales, and counted in the Super Admin's Needs Attention, since a past time can earn Happy Hours.
5. A Therapist or Room recorded as busy at that time is refused.
6. Paper backup stays hidden from the Receptionist.

**16.6 Voucher list filters** (no migration)

1. New Service filter. Status choices: Unsold (in shop), Sold (all), Sold and unused, Used (redeemed or Used Before Go-live), Voided. Super Admin and Receptionist both.

**16.7 Opening Count upload** (no migration expected)

1. Inventory -> Catalog -> Upload opening count: pick Shop or Storage, one .xlsx each, columns Item, Quantity, Unit, Kind; Unit and Kind needed only for new Items. Template to download.
2. Preview before saving: names matched ignoring case, matches and new Items shown apart; new Items created on save.
3. Saved as an Opening Count dated the upload day, through the existing `/inventory/opening` logic: no Turnover, Receiving or Expense. Uploading again replaces that place's count for the Items in the file.

**16.8 After the first push** (no migration; asked by the owner the same day)

1. **Sales per therapist** charts and ranks Therapists by sales at Regular Price, not Commission, which would always put LMTs first for the same work.
2. **Therapist Sales** has a Guest column (Walk-in guest when no name was taken).
3. **Correct sales** (Super Admin, `/admin/correct-sales`): pick a Business Day, see its finished Services and Day Close.
   - *Correct start time*: moves a finished Service to when it really started, same length, same Business Day. A Sale with no Discount or a Promo is priced again by the checkout rules, so a Happy Hours missed because the time was wrong now applies; the difference comes off its cash payment (else the first). On a closed day, its expected cash and variance follow; what was counted stays. Commission doesn't change. Audit log `booking.correct_start`. API `POST /sales/correct-start`, `GET /sales/day-detail`.
   - *Correct count*: the cash really counted at a past Day Close; the variance follows and Sales Cash runs on from it. Audit log `day.counted_corrected`. API `POST /days/:date/counted`.
   - Why not reopen the day instead: an earlier open day blocks new walk-ins until it is closed again, so correcting a past day during opening hours would stop the desk.
4. **Cash Handover counts, not assumes.** The amount box starts empty, so the Receptionist types what she actually counted out. Handing over less than the Sales Cash that should be in the shop needs a reason, on screen and in the API (`note_required`), so a gap like Nov 9's is explained when it happens. The owner still confirms what they received separately.
5. **Nov 9**: superseded by the Pick-up list above, which has the figures as they stand.
6. **Where supply orders go** (explained, no change): paying for supplies is a Purchase Order, received into Storage, which records the Expense; a plain Expense is for things that aren't stock. Shop requests are answered from Inventory -> Requests (move from Storage); when Storage is short, the Super Admin raises a Purchase Order separately.
7. **A duplicate Sale was voided on production** (Nov 9: one Guest recorded under two Therapists). Local one-off script `scripts/one-off/void-sale.mjs <guest> <therapist> [--apply]` (git-excluded): lists the Guest's paid Sales, voids exactly one, cancels its Booking, frees a redeemed Voucher, lowers a closed day's expected cash/GCash, and logs `sale.void`. `SPA_LOCAL=<folder>` runs it against a local copy. Also `node scripts/one-off/purge.mjs promo-check` shows Nov 9's Sales, Promos and start-time corrections (read-only).
8. **Correct start time didn't give Happy Hours at exactly 6:00pm**, because the Promo's end was exclusive. That is 16.9.

**16.9 Happy Hours includes its end time** (branch `cr-6`, no migration)

1. A Service starting exactly at a Promo's end time gets it: Happy Hours to 6:00pm covers a 6:00pm start, 6:01pm doesn't. One comparison in `promoProblem` (`packages/domain/src/catalogue.ts`), so checkout and Correct sales both follow.
2. Settings -> Promos says the end is inclusive; the Price List says "starts from X to Y". `GLOSSARY.md` Happy Hours updated.
3. Why: two Nov 9 Guests who started at 6:00pm paid the discounted price; correcting their start time to 6:00pm still priced them in full.

## 19. Phase 17: owner's sixth batch of change requests (branch `cr-6`)

Grilled with the owner on 2026-11-11 (two rounds). Built on `cr-6` on top of 16.9, which ships with it. Vocabulary in `GLOSSARY.md`: Cash Handover and Petty Cash Top-up updated; new Laundry and Laundry Breakdown; Catch-up Day and Guest Record extended. Migration 0035 (`cash_outs.breakdown_json`, and an `app_meta` marker for the Guest name tidy). **Next migration is 0036.**

**Status (2026-11-11):** built, not committed. 480 tests pass (259 domain, 221 API). Typecheck, lint and build pass. Tried in a browser on a scratch copy of the local database: Nov 2-8 Edit and "Add service for this guest", Correct service, the Payments report and its filters, Sales per therapist opened straight after Daily sales, the Wednesday banner and the Laundry form.

**17.1 Happy Hours at 6:00pm** is 16.9, unchanged; it ships in this batch.

**17.2 Guest names are capitalized** (`properName`): every word capitalized, a possessive kept lower ("Rosa's Husband"), a suffix like III in capitals. Applied to Guest Records, the name on Bookings and Voucher buyers when saved. Names saved before are tidied once: migration 0035 sets `app_meta.guest_names = 'to_tidy'`, and the API's first request afterwards capitalizes them, logs `guest.names_capitalized` and sets it to `done`.

**17.3 Nov 2-8 entry**
1. Each sale line takes an optional Guest name from the paper record (no Guest Record is made).
2. "Add service for this guest" starts the form at the time that Service ended, with the same Guest, Therapist and Payment Method; Senior/PWD carries over. Each Service is its own line and price.
3. "Edit" changes any of time, Guest, Service, Therapist, Discount and Payment Method; GCash needs no reference ("Not recorded"). The line is entered again by the same rules (`PUT /catch-up/:date/sales/:id`), so price and Commission follow; if that is refused, the old line is put back. Audit `catch_up.sale_edit`.
4. Adding, editing or removing a line is refused once that Therapist's Payroll for the week is approved or released.

**17.4 12-hour time everywhere.** A shared hour / minute / AM-PM picker (`UI/src/components/TimeInput.tsx`) replaces every time and date-time box, so entry looks the same on every device. Times shown on the Nov 2-8 page are 12-hour like the rest.

**17.5 Sales per therapist chart.** On first open it kept the previous report's rows (Daily sales) while loading; those rows have no name, so React reused one bar and left it behind with a day's sales on it. The report query now keeps only the same report's figures while loading, and bars are keyed by position.

**17.6 Payments report** (`payments`): one line per payment, Services and Vouchers, with date and time, Guest (Walk-in guest if none), what it paid for, Cash or GCash, amount, and the GCash reference. A split bill is two lines. Nov 2-8 lines show when the Service ended. Filters: From/To, Guest (contains), Payment. Totals for Cash, GCash and both. Super Admin and Receptionist any dates; Reliever today only.

**17.7 Correct service** on Correct sales (`POST /sales/correct-service`, Super Admin): same start, the new Service's length and price; Senior/PWD and Complimentary kept, a Promo checked again; Commission follows the new Service. The difference moves the cash payment and a closed day's expected cash, like Correct start time. Refused for a Voucher sale, a sale with Top-ups, or once that week's Payroll is approved. Audit `sale.correct_service`.

**17.8 Hand over banner by weekday** (`handoverReminder`). Thursday and Friday hold. Saturday turns red once last week's Therapist Payroll is released, Laundry is paid that week and petty cash is back at ₱800. Sunday to Wednesday are red whenever there is Sales Cash, with no Payroll check, so a handover can happen several times a week. A Reliever is unchanged. The Petty Cash Top-up moves from Sunday/Monday to Saturday.

**17.9 Laundry Breakdown.** The Receptionist's Laundry Cash-out is rows of date and amount due; the total is added up, never typed (the API refuses a typed amount). Dates within the 14 days up to today, each once; a day already in an earlier Laundry payment is a warning only. Still one Cash-out from Sales Cash dated the day paid. The breakdown shows on the Cash-out list, the Expenses page and the Expenses report's "Days paid for" column. Older Laundry, Nov 2-8 Expenses and the Super Admin's Expenses keep a single amount.

**Also fixed on the way:** the Correct sales page's boxes lost their styling when given a width; they are wrapped instead.

## 20. Happy Hours covers up to 2 hours of Swedish (on `main`)

Asked by the owner on 2026-11-11, after `cr-6` was merged; committed straight to `main` at the owner's request. No migration.

1. A Promo covers its Service and one more full hour of Top-ups (the first two 30-minute steps). The start of the Service decides it for the whole: a 2-hour Swedish started at 5:30pm gets 10% off both hours, though the second runs past 6:00pm.
2. A half hour, or time past 2 hours, pays full price. Swedish at ₱500 with Happy Hours: 1 hour ₱450, 1.5 hours ₱700, 2 hours ₱900, 2.5 hours ₱1,150, 3 hours ₱1,400.
3. Time added while the Service is under way counts the same as time booked upfront.
4. Senior/PWD still take 20% off the whole bill instead; Commission is still on the full price.
5. `quoteSale` takes each Top-up step's price (`topUpSteps`); `promoCoveredTopUps` in `packages/domain/src/pricing.ts`. Correct start time re-prices by the same rule.

## 21. The desk picks the Room (branch `cr-8`)

Asked by the owner on 2026-11-11: a Guest may prefer a certain Room, and the shop wants a record of the Room in case an item is lost. No migration: every Booking already keeps its `room_id`.

1. **New walk-in, Start now:** a required Room box listing only free Rooms (occupied ones are not shown); the Flex Room asks floor bed or, for foot services, recliner. The Service starts there with the next therapist. If no therapist is free, the Start dialog opens with that Room kept.
2. **Start dialog:** the therapist is still suggested; the Room is no longer filled in, the desk picks it from the free ones.
3. **Scheduled bookings** have no Room option and nothing is held; the Room is picked when the Service starts.
4. **Where the Room shows:** the Front Desk's Finished list, the Guest's visit history (now with the time too), a Room column in the Therapist Sales report, and the Correct sales page.
5. **Correct room** (Correct sales, Super Admin, `POST /sales/correct-room`): records the Room a finished Service was really in, with a reason; refused if another Guest was in that Room at the time. Nothing is re-priced. Audit `booking.correct_room`.

## 22. Pag-IBIG on the maximum and the Government Deduction Refund (branch `cr-8`)

Agreed with the owner on 2026-11-12 after a grilling on weekly Government Deductions. Vocabulary: Government Deductions, Government Deduction Refund (`GLOSSARY.md`). Decision: ADR 0010. Migration `0036_deduction_refunds`; next is 0037.

1. **Monthly split stays.** Each month's employee share is split evenly over the Pay Weeks ending in that month (Sundays for Therapists, Saturdays for the Receptionist), so a month withholds exactly what is remitted. A five-week month therefore takes less per week than a four-week month.
2. **Pag-IBIG on the maximum, shop-wide.** New rate setting `pagibig.atMaximum` (Settings → Pay, a checkbox under the SSS, PhilHealth and Pag-IBIG rates), on by default: the employee and employer Pag-IBIG shares use the maximum fund salary for everyone, whatever their salary basis. Rates saved before the setting existed get the default through `withDefaultRates`, so no data change is needed. The employer contributions draft follows.
3. **Government Deduction Refund**, one time, for January to November 2026 (2025 is closed). Per person: what was charged (taken or deferred) less the true employee share for the months the shop remitted, entered by agency (signed; an agency taken short is negative). Never below zero.
   - Table `deduction_refunds` (one per staff member: Pay Week, SSS, PhilHealth, Pag-IBIG, applied, cash, Adjustment id). `deduction_ledger` gains the entry `refund`, which lowers the balance and clears the oldest weeks first, like any payment.
   - `refundSplit` (domain): the refund first comes off the Deferred Deductions balance; the rest is cash, added to the chosen Payroll as an Adjustment labelled "Government Deduction Refund" (reason holds the agency figures). The Receptionist has no balance, so hers is all cash.
   - Routes (Super Admin only): `GET /deduction-refunds`, `POST /deduction-refunds`, `DELETE /deduction-refunds/:staffId`. Refused for an approved or released Payroll's week; the refund's Adjustment can't be removed from the Payslip, only with the refund. Audit `deduction_refund.set` / `deduction_refund.remove`.
   - UI: a "Government Deduction Refund" card under Payroll → Deferred Deductions, with a live preview of what comes off the balance, the cash and what is still owed; the Payslip shows the refund by agency, what came off Deferred Deductions and what is paid.
4. **Owner steps before the December Payroll:** on Deferred Deductions, click off any opening week the shop did not remit, then enter each person's refund on the first December Payroll, before the Year-end Bonus takes Deferred Deductions. The per-person figures are kept outside the repo.

## 23. Therapist Commission report (branch `cr-8`)

Asked by the owner on 2026-11-12: the **Therapist Sales** report (`therapist-detail`) is now called **Therapist Commission**, and it always opens on today, also for the Super Admin and when picked from the report list. Other reports keep their defaults.

## 24. Refund reminder and to-do list (branch `cr-8`)

Asked by the owner on 2026-11-12: a reminder two weeks before the Government Deduction Refund is paid, with a detailed to-do list, kept up until the Payroll carrying the refund is released. No migration.

1. **Payout date** on the refund card (Payroll → Deferred Deductions), default Sat 2026-12-12: the release of the Therapists' first December Payroll (week of Nov 30 – Dec 6). Stored in `pay_rules` as `deduction_refund_plan` (`payoutDate`, ticked steps); `PUT /deduction-refunds/plan`, Super Admin only.
2. **To-do list** (`REFUND_STEPS`, `refundChecklist` in `packages/domain/src/refund.ts`): approve the last November Payrolls (ticks itself), remove opening weeks not remitted, check the Receptionist's January–February remittances, recompute each refund by agency, enter every refund (shows "n of m entered"; ticks itself when everyone has one), approve the payout week's Payrolls and release them (both tick themselves). Manual steps have a Done box.
3. **Reminder** in the Super Admin's Needs Attention (`deduction-refund`, link `/payroll?tab=deferred`) from 14 days before the payout date until every Payroll carrying a refund is released, even past the date; urgent from 3 days before. It shows steps done, days to payout and the next step. The Payroll page now opens on a tab named in `?tab=`.

## 25. "To receive" banner on the Front Desk (branch `cr-8`)

Asked by the owner on 2026-11-12: the desk had no sign that something was sent for Receiving. `GET /front-desk` now returns `toReceive` (Turnovers and Voucher card ranges not yet received), and the Front Desk shows a banner under the cash reminder, e.g. "2 deliveries to receive · 1 voucher range to receive", naming up to three items, with **Receive items** (Inventory, Stock tab) and **Receive vouchers** (Vouchers page) buttons. It shows to whoever can receive each kind and goes once everything is received; the board refreshes every 15 seconds. No migration.

## 26. Current status and cr-9 (branch `cr-9`)

**Status (2026-11-12): start here.** `cr-8` (§21–§25) is merged to `main` (`f9fa078`) and deployed: production health reports `0036_deduction_refunds`; the next migration is 0038 (0037 is on `cr-9`). `cr-9` was branched from that `main`.

**Built on `cr-9` so far:**

1. **Dashboard month and year picker** (asked 2026-11-12, after the 2026 workbooks were uploaded and the Dashboard only offered October and November). The two-button switch is replaced by a Month and a Year box: any month from January 2026 (`FIRST_YEAR` in `UI/src/pages/DashboardPage.tsx`) up to this month; future months are greyed out, and picking a year that would land in the future falls back to this month. It opens on the current month and year, and a "This month" link appears when another month is shown. No API change: `GET /dashboard?month=` already took any month. Months before Go-live show their Daily Summaries in the daily chart and their monthly records in the totals. No migration.
2. **Draft payrolls reminder** (asked 2026-11-13). Needs Attention item `draft-payrolls`: every Payroll still in draft for a Pay Week that has ended, e.g. "Approve 4 payrolls still in draft · Therapists · 2 weeks, oldest the week of Nov 2", linking to the oldest week. Urgent once the oldest has been waiting more than 7 days past its week's end. Weeks that ended before Go-live are left out (paid outside the system). Goes once every one is approved. No migration.
3. **Releasing pay in parts** (asked 2026-11-14): the Receptionist hands Therapists their pay as Sales Cash allows, some today and the rest tomorrow. Migration `0037_payroll_releases` (table `payroll_releases`: Payroll, amount, Business Day, the Sales Cash transfer when paid from the shop). `POST /payrolls/:id/releases {amount, fromShopCash}` hands over a part (refused above what is left); `POST /payrolls/:id/release` is now "Paid in full" and hands over whatever is left; the part that reaches net pay releases the Payroll and repays its CA deduction. Each part from the shop's cash leaves Sales Cash that day, so Day Close counts stay right. A Payroll with money handed over can't go back to draft. Weekly payroll table: a Released column, "Part released" / "Fully released" badges, "Hand over part" and "Paid in full" on each approved row, and "N of M fully released · ₱X still to be released"; the Payslip page lists each part. Glossary: Release.

**Pick up here, in order:**

1. Continue `cr-9` with the owner's next requests (a new session). Commit each slice on `cr-9`; the owner opens the PR and merges.
2. **Government Deduction Refund** (§22, §24), before the first December Payroll. The reminder shows in Needs Attention from Sat 2026-11-28; payout date defaults to Sat 2026-12-12.
   - After the last November Payrolls (Therapists' week of Nov 23, Receptionist's week of Nov 22) are approved, recompute each person's refund by agency from the updated workbooks. The per-person figures and how they were worked out are in the local `docs/HANDOFF.md`, never in the repo.
   - Owner removes the unremitted opening weeks on Deferred Deductions, then enters each refund on the payout week.
3. **Offered, not yet asked for:** showing the Receptionist's Past Payslips on the Payroll page's pre-Go-live weeks (owner declined for now on 2026-11-12; they stay on the Backfill page and in her My Pay).
