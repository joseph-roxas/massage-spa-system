# One shared Reliever Login, usable only during a Relief Shift

Relievers change case by case (usually one of the shop's Therapists, sometimes someone from headquarters for a day or two), and the owner wants one login for all of them rather than an approved User per person. To keep every sale, Cash-out and Cash Handover traceable to a person anyway, the Reliever Login works only while someone has an open Relief Shift DTR entry, and each action under it is credited in the audit log to the Reliever clocked in at that moment. We chose this over per-person Reliever Users, which trace better but mean a sign-up and approval for every occasional Reliever.

## Consequences

- Attribution is only as good as the clock-in: if two people are on Relief Shifts at once, or the wrong person clocks in, actions are credited to the wrong Reliever.
- The shared password is known to every past Reliever; the Super Admin should change it after an Outside Reliever leaves.
- The Reliever Login has the Receptionist's powers minus Payroll, and cannot see any Payslip.
