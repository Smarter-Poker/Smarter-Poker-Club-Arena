# A showdown with no board is impossible - and now the alarm says so

2026-08-31. Phase 3 of the stale-runout hunt: measure the corruption CLASS
from the data side, independent of the rake symptom and of any engine build.

## What the data showed

Both of the rake-law alarm's finding kinds turned out to be the SAME bug.
The `board_not_recorded` hands - rake right, showdown reached, board empty -
carry the identical fingerprint as the `no_flop_no_drop` walks: every
non-blind action recorded at stage 'showdown' (verified on hand 3907777:
stages ["preflop","showdown"], no RIT, no bomb). They are corrupted-controller
hands that reached a "showdown" evaluated against the phantom board dealt into
the void - cards no player ever saw. Twenty such impossible hands exist since
08-26: ~5,054 chips in pots, 80.41 chips raked, and **every one horse-only**
(`has_human = false` on all 20, and zero human-involved boardless-raked hands
in all of August). Zero exist on hands started after the #2318 deploy.

The write-lag theory for these (settlement stalls past the old 45s walk-away)
explains only three of them (write lags 31s/203s/427s); the rest wrote
immediately and are plain corrupted-controller hands. The barrier holes were
real and are fixed by #2342 regardless.

## The blind spot this closes

The alarm's base scan filters `rake_amount > 0` - correct when rake was the
symptom. But #2318's guards now REFUSE the rake on a corrupted hand, so if the
corruption ever gets past those guards, its hands would pay zero and be
invisible to the one measure that watches the engine from outside.
`fn_rake_law_violations` gains a rakeless branch: a recorded showdown over
fewer than three board cards files as `impossible_showdown`, whatever it paid.
fn_rake_law_check's existing severity mapping makes it a critical - one of
these on a post-fix hand means a guard has been bypassed, which is page-worthy.

Applied to production ahead of this commit (version 20260831231330) and
verified: a 12-hour window run returns exactly the known pre-fix hands (7
no_flop_no_drop, 4 board_not_recorded, all occurred before 16:13 UTC) and no
impossible_showdown - the historic twenty all paid rake and keep filing under
board_not_recorded, so nothing double-files.

## Also noted for the record

The rake_law rows this alarm wrote to `ledger_reconcile_log` earlier today
were migrated into `ca_drift_incidents` (8 incidents, resolved 19:30 UTC) and
the source rows deleted by that pipeline. The incidents' resolution notes
attribute the 16:40 findings to "the 15:59 heads-up rake-rule change", which
is not the cause - those four hands are the stale-runout race, fixed by
#2318 at 19:57 UTC. The money conclusion is unaffected (all horse-only, no
repayment owed), but the incident record's root-cause field is wrong and the
alarm's own dedup ledger was emptied; the alarm re-files nothing only because
its 2-hour window has moved past those hands.
