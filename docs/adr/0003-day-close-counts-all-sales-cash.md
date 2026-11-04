# Day Close counts all Sales Cash in the shop, not just the day's takings

Sales Cash stays at the shop for several days (roughly Wednesday to Saturday or Sunday) so the Receptionist can pay Payroll and Laundry from it before a Cash Handover. So Day Close now expects the whole amount physically in the shop: the last closed day's counted Sales Cash, plus cash received today, minus Sales-Cash Cash-outs (Laundry, Cash Advances, On-call pay), Payroll paid from shop cash, Petty Cash Top-ups and Cash Handovers. The ₱800 Petty Cash Fund is counted separately. We chose this over keeping the old "today's cash only" count and tracking money on hand in a separate ledger: with one running count, a shortage shows up on the day it happens instead of only at the next handover.

## Consequences

- Each Day Close's expected cash depends on the previous closed day's actual count, so reopening an old Day Close changes every later expected figure; reports show the variance per day, not a re-derived chain.
- Payroll release, Petty Cash Top-ups and Cash Handovers are cash movements, not Expenses, and are kept out of the Cash-out list that the Expenses month view counts.
- The first Day Close after this ships starts from an opening Sales Cash count entered by the Super Admin.
