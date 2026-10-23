# River Nuts Always Bet Full, and an Alarm That Proves It

Owner request, October 23, 2026, following #7780.

## What Changed

- **The nuts never check.** With the exact river nuts, an opponent who can still act, and a legal bet, a horse bets. Live measurement before this change: 76 nut checks in 30 minutes of PLO5.
- **The nuts are never under-sized.** A nut bet or raise goes to the controller's maximum in pot limit and fixed limit (production hand 45000112 raised to 92 of a legal 113). In no limit it is at least the full pot, and a larger policy size is kept.
- **Both decision boundaries enforce it.** `riverNutsRaise` runs as the final strategy rule and again at commit time against the fresh, cap-adjusted controller menu.
- **Horse river value alarm.** `HorseRiverValueAudit` audits every committed hand from the settled snapshot (captured legal menus, public boards, dealt hole cards), never from the decision state. It flags nut calls with a legal raise, nut checks with a legal bet, under-sized nut wagers and 90 to 99 percent pot wagers that could legally be the full pot, across every variant, board count and the table commitment cap. One durable `HorseRiverValueLeak` engine alert fires on the first finding and resolves after a clean day. It runs after settlement commits, does no database reads and never throws.
- **Delivery.** The pre-push hook now runs source-contract laws (the Horse data ledger) for any changed server file that fires horse telemetry, which `vitest related` cannot find. The autopilot re-evaluates a same-repository PR when its required CI run passes, because GitHub withdrew #7780's auto-merge 17 seconds after it was armed and nothing re-armed it.
