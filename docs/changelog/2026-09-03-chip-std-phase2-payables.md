# Chip standard Phase 2.3 / F8 - the hierarchy's debts are on the balance sheet

2026-09-03, migration `20260903204724_the_hierarchys_debts_are_on_the_balance_sheet`
(applied once, 20:47 UTC), mirrored byte-exact. Lane-2 audit F8 (Medium) and the
F9 remainder found by lane 2.5.

## What it adds

`fn_ca_hierarchy_payables(p_club_id default NULL)` - read-only, SECURITY DEFINER,
revoked from PUBLIC/anon/authenticated, granted to service_role, management gate
for JWT callers (the fn_ca_post_correction gate). One row per club: treasury,
open commission (agent_commissions.settled_at IS NULL, with the amount accrued
since the 2.2 fix at 16:34 UTC), pending rakeback at the row rate AND at the
contract rate (fn_player_rakeback_rate), treasury after payables, covered.

`calculate_cascading_commission` loses its PUBLIC and anon EXECUTE grants
(it is SECURITY INVOKER; authenticated and service_role keep it; the self-check
refuses if a real caller lost its grant).

Nothing moves. No threshold. fn_ca_trial_balance is not changed: an accrual has
no ledger row by design, so a payables row there would alarm hourly for the
wrong reason.

## The numbers (20:47 UTC, from the function as service_role)

| Club                      | Treasury     | Commission payable (rows) | Rakeback at row rate | Rakeback at contract rate | After payables | Covered |
| ------------------------- | ------------ | ------------------------- | -------------------- | ------------------------- | -------------- | ------- |
| SHARK CLUB                | 1,376,610.47 | 640,141.11 (1,514,165)    | 27,946.06            | 50,960.39                 | 685,508.97     | yes     |
| Club JAQK                 | 1,051,788.71 | 129,153.59 (273,545)      | 47,856.68            | 92,517.19                 | 830,117.93     | yes     |
| Deep Stack Society        | 2,020,553.08 | 63,378.80 (249,207)       | 44,743.25            | 44,744.55                 | 1,912,429.73   | yes     |
| Midway Union (house club) | 0.66         | 956.22 (1,667)            | 232,206.26           | 232,205.74                | -233,161.30    | NO      |

Platform-wide pending rakeback: 3,374 rows, 352,752.25 at the row rate vs
420,427.87 at the contract rate; 1,200 rows carry different rates; the gap is
67,675.62. Last rakeback paid 08-20 (JAQK, SHARK), 08-17 (house club), never
(Deep Stack Society).

## For Dan (roadmap decisions 5 and 15)

- Which rate pays pending rakeback: the ladder stamped on the row (352,752.25)
  or the contract rate (420,427.87).
- The house club owes 232,206 of rakeback against a treasury of 0.66: whether
  the union bank stands behind its house club's players.
- Commission accrued since the 2.2 fix: 44,447 in four hours (SHARK 20,297,
  DSS 23,555, JAQK 547) - the previously unbooked chain is now booked; nothing
  is paid until one payer is chosen (2.3, decision 5).
