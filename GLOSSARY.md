# Massage Spa

The day-to-day operation of a single franchise branch: booking guests to therapists, taking payment, paying staff, and tracking stock, expenses and royalty.

## People

**Staff**:
Everyone who works at the shop: Therapists and Receptionists. Most Staff never log in; they only use the Clock-in Screen.
_Avoid_: Employee, worker

**User**:
A login account for the system, held by the Super Admin, a Receptionist, or the shared Reliever Login. A User may also be a Staff member, but the two are separate records.
_Avoid_: Account, staff login

**Reliever Login**:
The one User shared by every Reliever to run the front desk on a Relief Shift.
_Avoid_: Reliever account, guest login

**Super Admin**:
The owner account with unrestricted access; also the only recipient of user-approval requests.
_Avoid_: Admin, owner account

**Receptionist**:
A staff member on a fixed daily rate who runs the front desk: bookings, sales, therapist DTR, Take-out Requests and Receiving, therapist payroll, cash-outs and Cash Handovers. Never buys stock.
_Avoid_: Cashier, front desk

**Therapist**:
A staff member paid by commission on the services they perform. Is either a Regular Therapist or a Licensed Massage Therapist.
_Avoid_: Masseuse, masseur, staff

**Regular Therapist**:
A Therapist who is not DOH-licensed; earns the lower commission rate.
_Avoid_: Normal therapist

**Licensed Massage Therapist (LMT)**:
A Therapist with a DOH Certificate; the only Qualification that earns the higher commission rate. An expired DOH Certificate is flagged, not demoted automatically.
_Avoid_: DOH therapist

**Qualification**:
A Therapist's training level: NC-II holder, DOH-licensed, Nuat Thai trained only, or experience only.

**Certificate**:
A dated credential a Therapist holds (TESDA NC-II or DOH licence), with a number and an expiry date. A Therapist may hold several.
_Avoid_: Cert, licence (alone)

**On-call Therapist**:
A Therapist called in for a single day to handle extra guests, paid their commission at the end of that day rather than through weekly Payroll. The Receptionist can add one directly, always at the Regular rate.
_Avoid_: Extra, reliever

**Reliever**:
The person covering the front desk on a Relief Shift: one of the shop's Therapists, or someone sent by headquarters (an Outside Reliever).
_Avoid_: On-call, substitute, reserve

**Outside Reliever**:
A Reliever who is not on the shop's staff, sent by headquarters; known to the system only by name and PIN, so they can clock in.
_Avoid_: HQ staff, temp

**Relief Shift**:
A Business Day on which a Reliever runs the front desk because the Receptionist is on her Rest Day, absent or on leave. A Therapist on a Relief Shift does no Services that day and is out of the Rotation. Paid at the Minimum Wage Rate with no Government Deductions.
_Avoid_: Cover, relief duty

**Guest**:
A person receiving one or more Services. A returning Guest is known by their Guest Record.
_Avoid_: Customer, client

**Guest Record**:
What the shop keeps about a Guest across visits: name, contact number (optional), and a saved Senior Citizen or PWD ID number, plus their visit history.
_Avoid_: Customer profile, client file

**Visit**:
A Business Day on which a Guest had at least one Booking checked out. Several Services that day are still one Visit; buying a Voucher, a no-show or a cancellation is not a Visit.

**Reject**:
A person the shop did not serve: no Therapist free in time, arrived too late, or refused a Service for safety, e.g. pregnancy or a medical condition. Not a Guest, since no Service happened.
_Avoid_: Turned-away guest, lost customer

**Regular**:
A Guest with at least a set number of Visits in a recent window (by default 3 visits in 90 days), whether Walk-in or Scheduled.
_Avoid_: Suki, loyal customer, VIP

**User Request**:
A sign-up submitted from the login page that the Super Admin must approve (assigning a role) before the person can log in.

## Services and booking

**Service**:
A priced treatment of a fixed duration from the service list, e.g. Swedish Massage (1hr).
_Avoid_: Treatment, package

**Combo**:
A Service made of two treatments sold at a single price (C1–C7), performed and commissioned as one Service by one Therapist.

**Top-up**:
More time on a single Service, asked for when booking or while it is under way, in steps of 30 minutes and as many times as the Guest asks. It stays the same Booking, Therapist, Room and sale and costs no extra Rotation place. Foot and Back Massage, at either length, are topped up at the price the owner sets for their 30 minutes; any other 1-hour Service at half its Regular Price; a 1.5-hour Service with a 30-minute head, back or foot massage at that massage's price. A full extra hour of Foot or Back Massage costs its 1-hour price, not two 30-minute prices. Combos cannot be topped up.
_Avoid_: Extension, add-on

**Service Change**:
Replacing the Service on a Booking while it is under way or before it is paid. The sale becomes the new Service at its full price and nothing is charged for the old one.
_Avoid_: Upgrade, downgrade

**Therapist Change**:
Another Therapist taking over a Service already under way at the Guest's wish. The clock keeps running, the new Therapist earns the whole Commission, and the replaced Therapist earns nothing for it and keeps their place in the Rotation.
_Avoid_: Reassignment, swap

**Booking**:
A Guest's reservation of a Service with a Therapist, either a Walk-in starting now or Scheduled for a later time.
_Avoid_: Appointment, reservation

**Room**:
A treatment room holding one Guest at a time; the shop's capacity is its 8 Rooms. Rooms 1–7 have a floor bed.
_Avoid_: Station, bed, cubicle

**Flex Room**:
Room 8, set up per Booking as either a floor bed or a foot-massage recliner; in recliner mode it takes only foot-type Services.

**Portable Table**:
A table bed brought into a Room on a Guest's request; equipment, not extra capacity.

**Walk-in**:
A Booking made on arrival, assigned to a Therapist immediately.

**Added Service**:
A Service a Guest asks for partway through their stay, booked as a follow-on Booking in the same Room that starts when the current one ends; by default the same Therapist performs it. The whole stay is checked out and paid together and costs the Therapist one Rotation place.
_Avoid_: Extension (that is a Top-up), upgrade

**Requested Therapist**:
The specific Therapist a Guest asks for; takes priority over the Rotation and does not cost that Therapist their Rotation place.
_Avoid_: Preferred therapist

**Reserved**:
The mark on a Therapist from 30 minutes before a Scheduled Booking that names them. A Therapist may take another Guest only if that Service is due to end before they become Reserved. Scheduled Bookings naming no Therapist hold nobody.
_Avoid_: On hold, blocked

**Grace Period**:
The 15 minutes after its scheduled time that a Scheduled Booking waits for its Guest before closing by itself as a No-show.

**Rotation**:
The order in which clocked-in Therapists take un-requested Guests, starting by arrival time; a Therapist who finishes a Service goes to the back. An LMT goes ahead of everyone from clock-in until they finish their first un-requested Service.
_Avoid_: Queue, turn list

**DTR (Daily Time Record)**:
A staff member's clock-in and clock-out times for a day; drives Rotation for Therapists and pay for the Receptionist.
_Avoid_: Attendance, timesheet

**Clock-in Screen**:
The screen where Staff tap their name and enter a personal PIN to clock in or out. Reachable on the Front-desk Device without anyone logged in; shows the date and time, whether today is a Holiday, and a birthday greeting on the clock-in.
_Avoid_: Kiosk, time clock

**Front-desk Device**:
The PC at the reception table, marked once by the Super Admin, whose login page offers the Clock-in Screen without logging in; the Receptionist also logs in on it. No other device does.
_Avoid_: Kiosk, terminal

**DTR Review**:
The Super Admin's check of every DTR entry added by hand, corrected, or still missing its clock-out, regardless of date. An entry is Reviewed once they tick it or correct it themselves; after that the Receptionist can no longer change it.
_Avoid_: DTR audit, approval

**Go-live**:
The first Business Day recorded in the system as real Sales, Monday 2026-11-02. Everything before it exists only as Daily Summaries and opening balances.

**Catch-up Day**:
A Business Day from 2026-11-02 to 2026-11-08, run on paper and entered afterwards by the Super Admin from those records as real Sales, DTR and Expenses, with no Guest Records. The Front Desk went live the day after, 2026-11-09.
_Avoid_: Backfill (that is Daily Summaries)

**Business Day**:
The span from opening (2:00pm) until that day's Day Close, even past midnight; all sales and DTR belong to it. Activity before 6:00am counts toward the previous day.
_Avoid_: Calendar day

**Daily Summary**:
One day's totals from before Go-live, kept as a record of its own rather than as Sales. It has no Guests, Bookings or Service detail, and a day with real Sales cannot have one.
_Avoid_: Historical sale, imported sale, legacy data

**Early Close**:
Closing the shop before 11:00pm, recorded with a reason; time lost to an Early Close is not Undertime.

**Day Close**:
The end-of-day count reconciling expected against actual Cash and GCash, after which that day's sales are locked; only the Super Admin can reopen it.
_Avoid_: End of day, Z-reading

## Money in

**Regular Price**:
A Service's list price before any Discount.

**Owner's Set-aside**:
A fixed amount of the Regular Price of Aromatherapy, Hot Oil and Hot Stone Massage (₱50 at present) that is the owner's before Commission is worked out. It is bookkeeping only: it stays in Sales, Royalty Gross Sales and Sales Cash. Combos have none.
_Avoid_: Oil, oil fee, add-on

**Discount**:
A reduction in what the Guest pays, always absorbed by the shop. At most one per Service, chosen at checkout; the best applicable Promo is offered first.

**Statutory Discount**:
The 20% Senior Citizen or PWD Discount, which requires the Guest's ID number.
_Avoid_: SC/PWD promo

**Promo**:
A time-boxed Discount defined by Service, time-of-day window and validity dates. Happy Hours is the current one.

**Happy Hours**:
The Promo giving 10% off Swedish Massage (1hr) when the Service starts 2:00–6:00pm, valid until 2026-11-30.

**Voucher**:
A serial-numbered, non-expiring prepaid entitlement to one specific Service, redeemable once by whoever presents the serial, only at this branch. Sold at that Service's Regular Price to a buyer, who is a Guest with a Guest Record. The Receptionist only sells serials she has Received through a Voucher Endorsement, picking each one herself.
_Avoid_: Gift certificate, GC

**Voucher Serial**:
The number printed on a Voucher card: branch code, Service code and a 4-digit counter, e.g. NTL-SM-0271 (Nuat Thai Lawaan, Swedish Massage, card 271). The Service code fixes which Service the card is for.
_Avoid_: Voucher number, code

**Voucher Endorsement**:
The Super Admin handing a printed range of Voucher cards for one Service to the shop, e.g. NTL-SM-0271 to 0320. Received by the Receptionist like a Turnover.
_Avoid_: Voucher turnover, issuance

**Redemption**:
Using a Voucher for its exact Service, which marks its serial used; no upgrades or paying a difference.

**Used Before Go-live**:
A Voucher sold and used before Go-live, marked so by the Super Admin. It has no sale, no Commission and no FOC behind it, and it can no longer be redeemed.
_Avoid_: Old redemption

**Voucher Bundle**:
Vouchers bought together for the same Service, where every five paid earn one free (5+1). The free ones are whichever of the Bundle's Vouchers are redeemed last, not a particular serial.

**FOC (Free of Charge)**:
A Service the Guest pays nothing for at the time of service. Is either a Prepaid FOC or a Real FOC.

**Prepaid FOC**:
An FOC paid for earlier, i.e. redemption of a purchased Voucher.

**Real FOC**:
An FOC nobody paid for: the last Redemption(s) of a Voucher Bundle, or a Complimentary Service.

**Complimentary Service**:
A Real FOC granted only by the Super Admin, with a reason.
_Avoid_: Comp, freebie

**Payment Method**:
How money is received: Cash or GCash.

**Royalty Gross Sales**:
For a calendar month: money received for Services after Discounts plus Voucher sales on the day sold. Excludes Voucher redemptions and Real FOCs.

**Royalty**:
The monthly fee owed to the franchisor, 3% of Royalty Gross Sales.

## Money out

**Commission**:
A Therapist's share of the Regular Price, less any Owner's Set-aside, of each Service they perform (including FOCs and whatever the Guest was discounted): Regular 30% / LMT 40%, or 50% / 60% on a Holiday.

**Holiday**:
A date the Super Admin flags as raising Therapist Commission rates (and triggering Receptionist holiday premium).

**Pay Week**:
Monday through Sunday for Therapists, Sunday through Saturday for the Receptionist. Its Payroll is released the following week.

**Payroll**:
The weekly computation of each staff member's pay for one Pay Week, net of Government Deductions and Cash Advance repayment.

**Payslip**:
One staff member's Payroll as they see it: coverage (their Pay Week), what was earned and what was deducted, line by line. The Receptionist sees hers once released, with her Cash Advance history.

**Past Payslip**:
A Receptionist's Payslip from before Go-live, kept exactly as it was paid and never recomputed. It is a record to read, not a Payroll.
_Avoid_: Old payslip, imported payroll

**Pay Breakdown**:
The Super Admin's table of everyone's Payroll for one Pay Week, every earning and deduction in its own column, with the same lines as the Payslips.
_Avoid_: Payroll summary, register

**Adjustment**:
A labelled amount, added or taken off, that the Super Admin puts on a Payroll with a reason, e.g. a correction for an earlier week. Not part of basic pay for 13th Month Pay.
_Avoid_: Bonus

**Paper Payslip**:
A blank printed form for writing a Therapist's or the Receptionist's Payslip by hand when the system can't be used; each has its own layout.

**Minimum Wage Rate**:
The current daily minimum wage in Cebu, set by the Super Admin; what a Reliever earns for a Relief Shift. Separate from the Receptionist's own daily rate, which is usually higher.

**Government Deductions**:
The employee share of SSS, PhilHealth (PHIC) and Pag-IBIG withheld each Pay Week. The shop remits the full amount every month whether or not it was withheld.

**Not Enrolled**:
A Therapist marked as having no government contributions: no Government Deductions, no Employer Contributions, and no missing-ID alert. The mark stays visible on their Staff record.
_Avoid_: Exempt

**Deferred Deductions**:
Government Deductions a Therapist still owes the shop, week by week: what would have left less than the Take-home Floor, and every week away with no work. They come off the last working week's pay or the Year-end Bonus, whichever comes first, or sooner if the Therapist asks. Every Payslip shows the weeks and the total.
_Avoid_: Carry-over, double deduction, missing deductions

**Take-home Floor**:
The least a Therapist should take home from a Payroll; Government Deductions stop there and the rest becomes Deferred Deductions. Set by the Super Admin, who alone can override it on a single Payroll, for example when the Therapist agrees to have the week taken anyway.

**Cash Advance (CA)**:
Money given to a staff member ahead of Payroll and deducted from a later Payroll. A Therapist's CAs are capped at their unreleased net pay; the Receptionist repays her CA Repayment each Payroll against a running balance.
_Avoid_: Vale, loan

**CA Repayment**:
The amount taken from each of the Receptionist's Payrolls toward her Cash Advance balance: a standing amount the Super Admin sets (usually ₱500, sometimes ₱750 or ₱1,000), changeable for any single Payroll, never more than the balance left.
_Avoid_: Amortization, installment

**Overtime**:
Receptionist time worked after 11:00pm, paid at a premium without needing approval.

**Undertime**:
Receptionist time missing from the 2:00–11:00pm shift (late arrival or early leave), deducted per minute; excludes Early Close.

**Rest Day**:
The Receptionist's weekly day off (Sunday); working it earns a Rest Day premium.

**Year-end Bonus**:
A Therapist's discretionary December payment: their total Commission since last year's cut-off times a percentage chosen by the Super Admin, less any Deferred Deductions. The Receptionist gets 13th Month Pay instead.
_Avoid_: Therapist 13th month

**13th Month Pay**:
The Receptionist's statutory December payment.

**Cash-out**:
Cash taken out during the day for a recorded purpose: Petty cash (from the Petty Cash Fund), Laundry (from Sales Cash), a Cash Advance, On-call pay or an Outside Reliever's Relief pay. Petty cash and Laundry are also Expenses.
_Avoid_: Petty cash withdrawal

**Petty Cash Fund**:
A fixed ₱800 kept at the shop, apart from Sales Cash, for small buys (rice, ballpens, paper, tape, phone load).

**Petty Cash Top-up**:
Moving Sales Cash into the Petty Cash Fund to bring it back to ₱800, done weekly on Sunday or Monday.
_Avoid_: Replenishment

**Sales Cash**:
Cash from sales held at the shop, often for several days, from which the Receptionist pays Payroll, Laundry and Petty Cash Top-ups.
_Avoid_: Cash on hand, drawer

**Cash Handover**:
The Receptionist giving the Super Admin all Sales Cash once that week's Payroll and Laundry are paid, or a Reliever doing so at the end of every Relief Shift. It is complete only when the Super Admin confirms receipt, naming who received it if not them.
_Avoid_: Turnover (that is for Items), remittance

**Employer Contributions**:
The shop's own share of SSS, PhilHealth and Pag-IBIG, derived from each staff member's contribution bracket; an Expense. On-call Therapists have none.

**Percentage Tax**:
The 3% quarterly tax on gross sales the shop owes as a non-VAT business, filed on BIR Form 2551Q. Expenses do not reduce it.
_Avoid_: 2551Q (that is the form), VAT

**Income Statement**:
Revenue less every cost for a month, quarter or year, showing whether the shop made a profit.
_Avoid_: Financial statement, P&L

**Expense**:
Money the shop spends, under a category (laundry, utilities, BIR, bookkeeping, supplies, etc.).

## Inventory

**Item**:
Something the shop stocks, with a unit of measure and an Item Kind, e.g. massage oil (gal), bath towel (pc).

**Item Kind**:
Whether an Item is a Consumable, a Reusable Supply or Equipment.

**Consumable**:
An Item used up in service or daily running: oil, alcohol, tissue, rice.
_Avoid_: Disposable

**Reusable Supply**:
An Item used again and again until it breaks or wears out: baskets, sprayers, oil containers, drinking glasses, spa shorts, towels, bed sheets, herbal balls, hot stones, ventosa glasses.
_Avoid_: Disposable, asset

**Equipment**:
A large, durable Item such as an aircon, bed or recliner, tracked by count only.
_Avoid_: Fixed asset

**Storage**:
The Super Admin's own stock, where every purchase lands first; the Shop is sent only what it needs.

**Shop Stock**:
The quantity of an Item physically at the shop, counting only Turnovers that have been Received.

**Stock-in**:
The Super Admin recording a purchase of an Item into Storage from a Vendor, at a price and date. Counted as an Expense when bought.

**Use**:
The Receptionist taking a quantity of a Consumable out of Shop Stock for service or daily running.
_Avoid_: Stock-out, withdrawal, issue

**Discard**:
Removing a Reusable Supply or Equipment from Shop Stock because it broke, wore out or was lost, with that reason.
_Avoid_: Write-off, disposal

**Turnover**:
The Super Admin sending a quantity of an Item from Storage to the Shop, with or without a Take-out Request. It sits on the Receptionist's For Receiving list until Received; any shortfall stays counted in Storage and is flagged for the Super Admin.
_Avoid_: Handover (that is for cash), delivery

**Receiving**:
The Receptionist confirming a Turnover arrived, with the date and any shortfall; only then does Shop Stock go up.
_Avoid_: Accepting

**Take-out Request**:
The Receptionist asking the Super Admin for an Item the shop needs, flagged running low or out of stock. Fulfilled by a Turnover from Storage, buying first if Storage has none.
_Avoid_: Restock request, purchase request, stock alert

**Purchase Order**:
The Super Admin's plan to buy Items from a Vendor, received later into Storage as one or more Stock-ins.

**Vendor**:
A supplier Items are bought from.
