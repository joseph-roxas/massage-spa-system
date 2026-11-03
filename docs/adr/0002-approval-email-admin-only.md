# User approval lives in-app; email is a notification to the Super Admin only

User Requests are approved or rejected from a Pending Users screen that only the Super Admin sees; that screen is the source of truth. Email is just a notification sent to the Super Admin (desiree.ababon@gmail.com) through Cloudflare's free `send_email` Worker binding, which delivers only to verified addresses and requires a domain on Cloudflare with Email Routing enabled. Because the system can't email arbitrary users, a new user sets their password at sign-up and sees "pending approval" on login until approved; forgotten passwords are reset by the Super Admin. We chose this over a third-party mail provider (Resend, etc.) to stay on one vendor at zero cost.

## Consequences

- Until a domain is added to Cloudflare, no approval email is sent; requests still appear on the Pending Users screen, so nothing is blocked.
- Approve/Reject links in the email open the app (login required); they never act on their own, so a forwarded email can't approve anyone.
