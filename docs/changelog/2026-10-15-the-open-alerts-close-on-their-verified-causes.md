# The Open Alerts Close On Their Verified Causes (2026-10-15)

Phase 7 of the tournament hardening: triage of the open financial alerts. Migration `20261015124934_the_open_alerts_close_on_their_verified_causes_again.sql` (replacing `20261015101531`, which the database refused whole because the settler lag incident it resolved carried no written root cause) closes each group only after re-asserting, in the same transaction, the state it is closed on. It moves no money, writes no ledger row and deletes nothing.

## Closed

| Group                | Alerts                                                     | Verified cause                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Freeroll a38b88a9 | 8 table_admission_failing, 1 tournament_dark_after_rebuild | Completed 05:22 UTC, 27 places paid to the 100.00 pool, Diamond book conserved. Root fix 20261015011723.                                                                                         |
| B. leave_pending     | 85, none moved chips                                       | 83 from a trigger that read `NEW.metadata` for 37 minutes on 2026-10-13 (replaced, never recurred, no such trigger today). 2 Cloudflare 502 pages, now retried inside the boundary (`seats.ts`). |
| C. Money check board | 7 critical + 7 drift incidents                             | Raised by one diagnostic call to `fn_money_check_health`, which no job schedules. Every check it lists runs on its own job (asserted).                                                           |
| D. Free Buy board    | 1 (2026-10-13)                                             | Midway skipped eight slots, Midday 2026-10-13 to Afternoon 2026-10-14. The board resumed at Prime Time 2026-10-15 01:00 UTC and every slot since is published.                                   |

## Left Open, Because Each Is True

- **The original week has not closed.** `union_accounting_scheduler` ×3 and `fn_union_treasury_selftest` ×2 stay open with their incidents.
- **Two clubs have unpaid square-up statements.** `fn_union_age_invoices` and `fn_union_enforce_stop_loss` stay open with their incidents. Club JAQK owes 126,153.66 and SHARK CLUB owes 124,015.29 on their 2026-09-28 to 10-05 square-up statements (ECO win tax), now 7 days past due. That is a debt between a club and its union, not a platform defect. The suspension flag has no reader in the engine or the client.
- **The spin fairness reading.** `fn_spin_fairness_check` (critical 04:44, warning 22:44) stays open:
  - The 7-day window reads chi-square about 26.9 on 7 df, driven by 18 draws of 50x (8.7 expected) and 90 of 25x (65.4 expected).
  - Every receipt in the window drew from the published ladder with no locked tier, and the draw rolls 48 random bits over it.
  - Over 42 days (267,415 draws) the same test reads 13.27 (p about 0.07).
  - The reading looks like chance, but a fairness alarm is not closed by an agent's reading of it.
- **The money conservation warnings.** `fn_tournament_money_conservation` ×56 close on the scan's own next pass once 20261015100003 is installed.
- **The settler lag incident.** Incident c748f59f (2026-10-13) stays open with its mirror alert. The rakeback settler stalled (its last save was 27.8 hours old at 16:15 that day, with 1,545 rake records waiting) and has since caught up. The cause of the stall is not yet established, and an incident is not closed without one.
- **Another change's refused transaction.** `drift_incident:ledger_invariant.refused` stays open: that transaction rolled back whole, and its change owns the alert.

Pinned by `tests/the-open-alerts-close-on-their-verified-causes.law.test.ts`.
