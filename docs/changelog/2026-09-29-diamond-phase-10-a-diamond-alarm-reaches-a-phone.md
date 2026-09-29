# Diamond Phase 10, Line 5: A Diamond Alarm Reaches A Phone, And Only A Person Moves The Switches

September 29, 2026. Phase 10 of the Diamond Arena build programme, line 5: "Integrate financial push alerts and reconciliation without arena-wide automatic lockout." This builds items 2 and 9 of the ordered build list in `docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md`. The reconciliation readers named in that line were already built and scheduled. Both arena switches stay closed. Nothing is priced.

## The Database

Migration `a_diamond_alarm_reaches_a_phone`, applied as `20260929210000`. The recorded text is byte-identical to the repo file.

- **A critical Diamond row pages.** A new trigger on `ca_diamond_incidents` (`ca_diamond_incident_critical_pages`, which calls `fn_ca_diamond_incident_pages`) fires only for critical rows. Each one raises a drift incident through `fn_ca_raise_drift_incident`. The incident has source `ca_diamond_incidents`, is recorded in diamonds, takes the row's amount as its discrepancy, and names no club, so it is a platform finding. Its key is `diamond-rule:<rule>:<episode>`. While the rule's incident is open, every new critical row of the rule folds into it, so a condition re-filed every hour pages once. The episode number counts the rule's incidents that were already closed. After a person closes the incident, or after the rule has filed nothing for 24 hours, the next critical row pages again. The source is registered to "diamond programme" with a 24-hour aging window, which is the registry's floor. Warnings and info rows do not fire the trigger. A paging failure is recorded in `ca_incident_file_failures` and never costs the Diamond row.
- **The pipe learns a currency.** `fn_ca_raise_drift_incident` records `currency = 'diamonds'` for a finding whose metadata says `asset = diamonds`. The engine's DiamondCustody alerts already carry that tag. Its alert text and headline say Diamonds: for example "Diamond rule DR0:health_critical is critical", or "fn_ca_diamond_snapshot: 6000 Diamonds in doubt". Every chip finding is filed and worded exactly as before. The signature is unchanged, so no caller changed.
- **The page says Diamonds.** `fn_ca_incident_notify` prints Diamonds for a Diamond incident, in whole numbers. It lets a critical from a Diamond rule through even when the row has no amount (a `DR0:health_critical` row names an area, not a sum), for the same reason a liveness finding is let through. Dan's other rules of September 6 still hold: a fix is not a page, and anything below critical is not a page.
- **The supply alert is a Diamond alert.** `fn_ca_diamond_snapshot` tags its unexplained-supply incident as Diamonds. Its eight past incidents on the board are now recorded in diamonds.
- **The board keeps Diamond incidents to staff.** `fn_ca_incident_dashboard` shows a Diamond incident only to platform staff (`fn_is_platform_admin`) and to recipients at platform, financial-ops or technical scope. It never shows one to a club or union owner. Chip incidents are shown as before.
- Every chip function was changed in place: live md5 pinned, each changed clause present exactly once, and the reverse substitution proved. The watched guards (`fn_ca_raise_drift_incident`, `fn_ca_incident_notify`, `fn_ca_diamond_snapshot`) were declared. New md5s: raise `e6dac566804430737ee80da0a1801b40`, notify `12db60ac332870e31d1c713c3fe4c099`, snapshot `d4b4d63f74f302ab55e426f2ffb4556c`, dashboard `f99151acc42a8d6f788779a1ae285a2c`, trigger function `b56a5a9ddeced4145b788efc49b9a540`.
- The migration's final block proves the live side of item 9: no function in any schema writes `ca_arena_settings`, and both switches are false.

## The Engine

`server/src/services/DiamondCustody.ts`: both custody alerts now carry `amount`, the Diamonds in doubt. For a reservation that is the requested amount. For a release, `releaseDiamondEntry` takes the amount as a new third argument; it is not sent to the database. Without it, an unverified custody call became an incident of 0 that was withheld as "nothing is unaccounted for". Nothing in production calls these two functions yet.

## The Rehearsal

The migration and its fixture ran as one rolled-back transaction on production before the apply. The result was REHEARSAL OK on the first run.

- **What the rows open right now would page.** Every open Diamond row was replayed through the trigger, in filing order: 20 critical rows in one rule (`DR0:health_critical`, the horse-reward claims waiting on Dan), 7,060 warnings and 15,979 info rows. The result was 1 incident, with 20 occurrences, and **exactly 1 notification** to the one active recipient. The page read "Diamond rule DR0:health_critical is critical | CRITICAL | Diamond rule DR0:health_critical (fn_ca_diamond_health_watch): horse claims: … horse reward(s) are owed past the sweep interval …".
- **Through the real filer:**
  - A critical with 1,500 in doubt paged once, reading "1500 Diamonds in doubt". Its repeat folded and did not page.
  - A warning and an info row paged nothing.
  - After a person closed the incident, the rule's next critical row opened episode 2 and paged once.
- **The other two Diamond paths:**
  - A supply-snapshot finding read "6000 Diamonds (ledger layer)".
  - A custody alert without an amount was filed and withheld. With 250 in doubt, it paged "250 Diamonds in doubt".
  - A chip finding was worded exactly as before.
- **The board:** a club-scoped recipient saw 0 of the 5 open Diamond incidents (and 59 chip ones). A platform admin and the registry recipient saw all 5.
- The switches stayed closed, and the Diamond identity did not move.

## The Laws

- `tests/a-diamond-alarm-reaches-a-phone.law.test.ts`
- `tests/only-a-person-moves-the-arena-switches.law.test.ts` (item 9). It fails if a migration defines a function that writes `cash_games_enabled` or `tournaments_enabled`, or if `server/src` writes `ca_arena_settings`. It covers function bodies, bodies built by substitution in strings, and cron bodies. A migration's own statement counts as a person's act and is allowed.

## What Is Still Not Here

- **The supply alert will not page again as things stand.** Its finding paged on September 2. The notify ledger remembers every finding it has paged and never learns that one was closed, because Dan's "a fix is not a page" rule returns before the ledger is written. So a recurrence is marked "already reported". This affects every stable chip finding too. Diamond rule incidents avoid it by counting episodes.
- **Escalation does not push again.** Since September 1, one push per drift is the rule. The escalation tick only ages the board.
- **Owner routing.** For the owner account, `financial_incident` notifications go to the operational-notification route that the Production Alerts fleet reads, not to a device push. This is unchanged and shared with every chip incident.
- **The Midway burn-in gate.** `fn_ca_midway_burnin_gate` counts every open critical and every open "unknown" incident, so an open Diamond incident counts against the chip estate's burn-in. The gate has not passed in 14 days for chip reasons, so today's verdict does not change.

Laws: a-diamond-alarm-reaches-a-phone, only-a-person-moves-the-arena-switches.
