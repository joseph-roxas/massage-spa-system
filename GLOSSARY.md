# Massage Spa

The day-to-day operation of a single franchise branch: booking guests to therapists, taking payment, paying staff, and tracking stock, expenses and royalty.

## People

**Staff**:
Everyone who works at the shop: Therapists and Receptionists. Most Staff never log in; they only use the Clock-in Screen.
_Avoid_: Employee, worker

**User**:
A login account for the system, held by the Super Admin or a Receptionist. A User may also be a Staff member, but the two are separate records.
_Avoid_: Account, staff login

**Super Admin**:
The owner account with unrestricted access; also the only recipient of user-approval requests.
_Avoid_: Admin, owner account

**Receptionist**:
A staff member on a fixed daily rate who runs the front desk: bookings, sales, therapist DTR, stock-out and order requests, therapist payroll and cash-outs.
_Avoid_: Cashier, front desk

**Therapist**:
A staff member paid by commission on the services they perform. Is either a Regular Therapist or a Licensed Massage Therapist.
_Avoid_: Masseuse, masseur, staff

**Regular Therapist**:
A Therapist without a massage licence; earns the lower commission rate.
_Avoid_: Normal therapist

**Licensed Massage Therapist (LMT)**:
A Therapist holding a massage licence; earns the higher commission rate.

**On-call Therapist**:
A Therapist called in for a single day to handle extra guests, paid their commission at the end of that day rather than through weekly Payroll.
_Avoid_: Extra, reliever

**Guest**:
A person receiving one or more Services.
_Avoid_: Customer, client

**User Request**:
A sign-up submitted from the login page that the Super Admin must approve (assigning a role) before the person can log in.

## Services and booking

**Service**:
A priced treatment of a fixed duration from the service list, e.g. Swedish Massage (1hr).
_Avoid_: Treatment, package

**Combo**:
A Service made of two treatments sold at a single price (C1–C7), performed and commissioned as one Service by one Therapist.

**Add-on**:
An optional extra charged on top of a Service (currently extra oil, ₱50) that belongs wholly to the shop: no Commission, not in Royalty Gross Sales.

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

**Requested Therapist**:
The specific Therapist a Guest asks for; takes priority over the Rotation and does not cost that Therapist their Rotation place.
_Avoid_: Preferred therapist

**Rotation**:
The order in which clocked-in Therapists take un-requested Guests, starting by arrival time; a Therapist who finishes a Service goes to the back.
_Avoid_: Queue, turn list

**DTR (Daily Time Record)**:
A staff member's clock-in and clock-out times for a day; drives Rotation for Therapists and pay for the Receptionist.
_Avoid_: Attendance, timesheet

**Clock-in Screen**:
The screen on the logged-in front-desk device where Staff tap their name and enter a personal PIN to clock in or out.
_Avoid_: Kiosk, time clock

**Business Day**:
The span from opening (2:00pm) until that day's Day Close, even past midnight; all sales and DTR belong to it. Activity before 6:00am counts toward the previous day.
_Avoid_: Calendar day

**Early Close**:
Closing the shop before 11:00pm, recorded with a reason; time lost to an Early Close is not Undertime.

**Day Close**:
The end-of-day count reconciling expected against actual Cash and GCash, after which that day's sales are locked; only the Super Admin can reopen it.
_Avoid_: End of day, Z-reading

## Money in

**Regular Price**:
A Service's list price before any Discount; the basis for every Commission.

**Discount**:
A reduction in what the Guest pays, always absorbed by the shop. At most one per Service; the Guest gets whichever eligible one is largest.

**Statutory Discount**:
The 20% Senior Citizen or PWD Discount, which requires the Guest's ID number.
_Avoid_: SC/PWD promo

**Promo**:
A time-boxed Discount defined by Service, time-of-day window and validity dates. Happy Hours is the current one.

**Happy Hours**:
The Promo giving 10% off Swedish Massage (1hr) when the Service starts 2:00–6:00pm, valid until 2026-11-30.

**Voucher**:
A serial-numbered, non-expiring prepaid entitlement to one specific Service, redeemable once by whoever presents the serial, only at this branch. Sold at that Service's Regular Price.
_Avoid_: Gift certificate, GC

**Redemption**:
Using a Voucher for its exact Service, which marks its serial used; no upgrades or paying a difference.

**Voucher Bundle**:
Five Vouchers bought together for the same Service, plus a sixth free Voucher (5+1).

**FOC (Free of Charge)**:
A Service the Guest pays nothing for at the time of service. Is either a Prepaid FOC or a Real FOC.

**Prepaid FOC**:
An FOC paid for earlier, i.e. redemption of a purchased Voucher.

**Real FOC**:
An FOC nobody paid for: the free sixth Voucher of a Voucher Bundle, or a Complimentary Service.

**Complimentary Service**:
A Real FOC granted only by the Super Admin, with a reason.
_Avoid_: Comp, freebie

**Payment Method**:
How money is received: Cash or GCash.

**Royalty Gross Sales**:
For a calendar month: money received for Services after Discounts plus Voucher sales on the day sold. Excludes Add-ons, Voucher redemptions and Real FOCs.

**Royalty**:
The monthly fee owed to the franchisor, 3% of Royalty Gross Sales.

## Money out

**Commission**:
A Therapist's share of the Regular Price of each Service they perform (including FOCs): Regular 30% / LMT 40%, or 50% / 60% on a Holiday.

**Holiday**:
A date the Super Admin flags as raising Therapist Commission rates (and triggering Receptionist holiday premium).

**Pay Week**:
Sunday through Saturday. Its Payroll is released the following week.

**Payroll**:
The weekly computation of each staff member's pay for one Pay Week, net of Government Deductions and Cash Advance repayment.

**Government Deductions**:
The employee share of SSS, PhilHealth (PHIC) and Pag-IBIG withheld each Pay Week, as a fixed amount per person.

**Cash Advance (CA)**:
Money given to a staff member ahead of Payroll and deducted from a later Payroll. A Therapist's CAs are capped at their unreleased net pay; the Receptionist repays a chosen amount per Payroll against a running balance.
_Avoid_: Vale, loan

**Overtime**:
Receptionist time worked after 11:00pm, paid at a premium without needing approval.

**Undertime**:
Receptionist time missing from the 2:00–11:00pm shift (late arrival or early leave), deducted per minute; excludes Early Close.

**Rest Day**:
The Receptionist's weekly day off (Sunday); working it earns a Rest Day premium.

**Year-end Bonus**:
A Therapist's discretionary December payment: their total Commission for the year times a percentage chosen by the Super Admin.
_Avoid_: Therapist 13th month

**13th Month Pay**:
The Receptionist's statutory December payment.

**Cash-out**:
Cash taken from the drawer during the day for a recorded purpose.
_Avoid_: Petty cash withdrawal

**Expense**:
Money the shop spends, under a category (laundry, utilities, BIR, bookkeeping, supplies, etc.).

## Inventory

**Item**:
A stocked consumable with a unit of measure, e.g. massage oil (gal).

**Stock-in**:
Receiving quantity of an Item from a Vendor at a purchase price and date.

**Stock-out**:
Taking quantity of an Item out of storage for use.
_Avoid_: Withdrawal, issue

**Purchase Order**:
A request to buy Items from a Vendor, received later as one or more Stock-ins.

**Vendor**:
A supplier Items are bought from.
