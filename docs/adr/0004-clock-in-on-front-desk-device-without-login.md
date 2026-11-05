# Clock-in without a login, only on a marked Front-desk Device

Therapists often arrive before the Receptionist, who is sometimes late, and could not clock in until someone logged in. So the Clock-in Screen now opens from the login page with no User session, but only on the reception PC that the Super Admin has marked as the Front-desk Device: marking stores a long random token in a cookie, and the clock endpoints accept that token in place of a session. We chose this over a public clock page protected by PINs alone, because the app is on the public internet and 4-digit PINs would be the only barrier between anyone and every staff member's DTR (which drives Rotation and pay).

## Consequences

- The token grants only the clock endpoints (staff list, punch); every other API path still needs a User session.
- Clearing the PC's cookies or replacing the PC means marking it again; the Super Admin can remove a marked device in Settings.
- PIN lockout stays the guard against guessing on the device itself.
