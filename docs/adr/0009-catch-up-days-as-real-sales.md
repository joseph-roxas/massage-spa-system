# The first week run on paper is entered as real Sales, not Daily Summaries

The shop ran on paper from 2026-11-02 to 2026-11-08 while the system was being corrected, and the first Payroll must cover that week. ADR 0006 keeps pre-Go-live history as Daily Summaries because real Sales would need invented detail. These days are different: the paper records name the time, Service, Discount and Therapist of each sale, so nothing is invented, and Payroll can work from them directly. They are entered as real Sales marked as catch-up, Go-live moves to 2026-11-02, and the Front Desk starts on 2026-11-09. We rejected Daily Summaries with Commission typed in by hand because the owner wants this week's Commission computed and checked by the system.

## Consequences

- Catch-up Sales have no Guest Records, so they add nothing to Visits or Regulars.
- Catch-up Days close without a cash count. The actual Sales Cash is entered as an opening balance on 2026-11-09, so these Sales do not inflate it.
- Go-live on 2026-11-02 matches the opening Deferred Deductions, which run through 2026-11-01, and the Therapist Pay Week of 2026-11-02 becomes an ordinary week.
