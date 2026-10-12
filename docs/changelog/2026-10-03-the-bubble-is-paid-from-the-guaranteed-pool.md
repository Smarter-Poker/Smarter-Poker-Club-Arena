# The bubble is paid from the guaranteed pool (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003141003_the_bubble_is_paid_from_the_guaranteed_pool`, live as schema_migrations `20261003141028`.

## What was wrong

Alert `cc1fb3cc` (`Tournament.guarantee_not_met`) said Sunday $200 Deep Stack `f84852af` (2026-09-27) paid 19,820.00 against a 20,000.00 guarantee.

Read from production, the event paid out its whole guarantee:

| Paid to | Amount | Source |
| --- | --- | --- |
| Place 1 | 12,589.66 | structure |
| Place 2 | 7,230.34 | structure |
| Stone bubble | 180.00 | bubble_protection |
| **Total** | **20,000.00** | escrow closed at 0.00 |

Bubble protection is reserved from the prize pool before the ladder is priced, and the event page shows it as "From Prize Pool". `fn_tournament_guarantee_check` summed only ladder sources, so every bubble-protected event whose pool sat exactly on its guarantee read 180.00 short. The same alert fired for `690bfcb0` on 2026-09-14 and was closed then as nothing owed.

The 2026-09-09 decision to fund bubble protection from the house (`20260909060341`) was not carried into the settlement authority. From 2026-09-10 the platform priced the ladder after the bubble on the server, in the database and on the event page, and every Sunday Deep Stack since has paid exactly what its page showed. Nobody is owed anything.

## What changed

The check now counts the bubble refund and any overlay backpay as money the guarantee paid out. A bounty is still never counted. The alert closes in `20261003141247_the_money_alerts_phase_six_proved_are_closed`.

Pinned by `tests/the-bubble-is-paid-from-the-guaranteed-pool.law.test.ts`.
