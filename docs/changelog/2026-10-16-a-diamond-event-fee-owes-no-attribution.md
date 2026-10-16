# A Diamond Event Fee Owes No Attribution (2026-10-16)

Migration `20261016104032_a_diamond_event_fee_owes_no_attribution.sql` (held draft, owner installs).

## What Fired

`RakeAttributionBacklog` (`poker_rake_attribution_gaps > 100` for 30 minutes) fired and resolved seven times between 02:03 and 06:28 UTC as the count crept from 101 to 106. At 10:38 it was 107.

## Cause, Read From Rows

All 107 rows of `v_tournament_rake_attribution_gaps` are verdict `credited_nobody`, destination `diamond_house`, club Diamond Arena: 89 from `engine.fn_complete_tournament_terminal` (64,618 Diamonds) and 18 from `engine.fn_settle_satellite_tournament` (646 Diamonds), settled 2026-10-07 13:03 to 2026-10-16 10:19. The Diamond Phase 8 branch of `fn_settle_tournament_rake` sends a Diamond event's fee to the house and records `attributed_users = 0` on purpose: VIP points, rakeback basis and commission are chip accounting. The view counted a fee that owes nobody as one that credited nobody, so the alarm rose with every Diamond event.

Not caused by an r5 install; the rows accumulated from 2026-10-07.

## The Money

Nobody is owed anything. The fees reached the Diamond house as Phase 8 specifies. Chip attribution is untouched.

## The Fix

The view excludes `destination = 'diamond_house'`. Columns, `security_invoker` and grants are unchanged; its only reader is `fn_spin_metrics`. Measured read-only on production: 107 rows before, 0 after.

Regression: `scripts/ci/test-a-diamond-event-fee-owes-no-attribution.py`, run by `.github/workflows/a-diamond-event-fee-owes-no-attribution.yml` (8 checks, native PostgreSQL).
