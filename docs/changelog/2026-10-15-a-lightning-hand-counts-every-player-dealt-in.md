# A Lightning Hand Counts Every Player Dealt In

Migration `20261015222121_a_lightning_hand_counts_every_player_dealt_in.sql`
(held for the owner to install). Regression
`scripts/ci/test-lightning-hand-counts-every-player-dealt-in.py`, run by
`.github/workflows/lightning-hand-counts-every-player-dealt-in.yml`.

## What Fired

From 20:38 UTC on 2026-10-15: `ledger_reconcile_log:over_spec` (190 open
rows), `ledger_reconcile_log:bbj_over_spec` (146), 25 + 25 `drift_incident`
receipts for them, two `fn_rake_bbj_audit` rows (`I1_drop_under_3_dealt`,
n = 2) and one "0.02 chip drift: reporting_mismatch" owner notification.

## When It Began And What It Names

Every finding names one of two tables of the private Lightning Internal Pilot
club, "Lightning Pilot NLH 9" (0.02/0.04, 77 over_spec, 72 bbj_over_spec) and
"Lightning Pilot NLH 6" (0.01/0.02, 11 and 16). The hands run from 20:11:51 to
20:53:25 UTC, exactly the window the two pilot Clusters dealt Lightning hands:
an operator set `worker_mode = 'form'` at 20:10:42 (Lightning Phase 3 Stage 2
on the private pilot), the first `lightning_hand` formed at 20:10:55 and the
last at 20:52:59, and both Clusters were drained at 21:28. No migration
installed on 2026-10-15 and no engine release (818b10c at 18:02, a2ccc04 at
21:05) falls in the window. No round 5 migration caused it.

## The Money Is Right

Of the 597 raked hands the two tables recorded between 20:00 and 21:00,
priced with the number of players actually dealt in (`hand_history.players`,
`lightning_hand.player_count` and the hand's `lightning_hand_player` rows,
equal on all 597): 0 over spec, 0 under spec, 0 BBJ over, 0 BBJ under. Every
contribution map sums to its pot and no folder who put a chip in is missing
from one. Nobody was over-raked and no BBJ drop was taken over spec, so there
is nothing to refund.

## The Record Is Wrong, And The Line That Wrote It

In 148 of those hands `rake_records.num_players` is smaller than the number
dealt in: four dealt, two fast-folded preflop without posting, `num_players`
2. `fn_lightning_settle_hand` builds the post-commit envelope and set
`'num_players', (SELECT count(*) FROM jsonb_object_keys(v_contrib))`, where
`v_contrib` keeps only participants whose contribution is above zero. The
physical engine's map carries every dealt-in player with a zero for a folder,
which is why no physical hand disagreed (0 of about 80,000 raked cash hands
outside the Lightning window in the 30 hours to 22:00 UTC). Both rake monitors
read `num_players` as the dealt count, so with 2 they applied the heads-up
percentage and the BBJ minimum-dealt rule: a correct 0.03 rake read as "took
0.03 where the spec says 0.01".

## The Fix

`num_players` is now `v_n`, the count of the hand's `lightning_hand_player`
rows, which step 3 of the same function has already proved names every
participant exactly once. `v_contrib` is unchanged, so weighted attribution
and promo playthrough still read only payers. The 148 historical rows stay as
recorded (CLAUDE.md 10.9). The monitors are left as they are: they read the
record correctly, and the record was the defect.

## Proof

The regression rebuilds production's exact function text from the Phase 6
definition plus the Phase 6 remediation and Phase 8 substitutions (md5
`fcd616a9...`, equal to production on 2026-10-15), settles a four-handed hand
with two fast folders who never posted, and captures the envelope the
physical door receives: 2 before, 4 after, contributions unchanged and summing
to the pot, rake and BBJ unchanged, derived postimage md5 `0432654c...`
reproduced, and a second run of the migration refused. 17 checks pass on
native PostgreSQL 16.
