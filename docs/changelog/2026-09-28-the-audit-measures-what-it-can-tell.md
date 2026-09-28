# 2026-09-28 - The audit measures what it can tell

Two findings in the 2026-09-27 horse audit answered confidently about things
they could not see (CLAUDE.md 10.86).

## bust_sweep_lag read a tournament's age as its wait

`oldest_decided_minutes` was `now() - started_at`, so the panel said "oldest
decided-but-unpaid for 7 days". That tournament (Sunday Funday Six-Card
Closer) started on 2026-09-21 and dealt its last hand at 01:10 UTC on
2026-09-28.

The lag is real, but it is measured in minutes, not days. At about 15:10 UTC
on 2026-09-28 there were 342 decided tournaments: 245 decided 10-60 minutes
earlier and one more than an hour earlier. The age is now measured from each
decided tournament's last hand.

The recommendation now names what the engine was logging that day: the
seat-first finish sweep refused 262 times in 20 minutes with
`F06_DRAINED_CUSTODY_EVENT_CHANGED`, while decided events took about 40
minutes to complete. The old text blamed a starved event loop measured on
2026-09-02.

## data_stale paged critical for a pipeline that was never started

`horse_solver_agreement_v31_decisions` had a two-day freshness window in the
ledger. It has never held a row: rows exist only while a V31 dataset is
active, and none ever has been. So `data_stale` filed a critical every night
for the same fact `certified_v31_missing` already reports. The window is
removed, with a note to restore it in the commit that commissions V31.

## Not changed: phase7 data_unread

`phase7_tournament_utility` reads about 96% of complete contexts against a 99%
floor. Every day from 2026-09-21 to 09-28, utility plus
`phase7_utility_unavailable` accounts for exactly 100.00%, with every refusal
carrying a named reason (mostly `recovery_option`). Nothing is unread. The
receipt cannot express "read or declined with a reason", and lowering the
floor would hide a real loss, so it stays and is documented here as a known
over-reading.
