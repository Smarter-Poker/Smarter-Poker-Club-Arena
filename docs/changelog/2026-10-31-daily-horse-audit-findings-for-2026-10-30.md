# Daily horse audit, 2026-10-30: three false alarms removed, one real leak measured

The 2026-10-30 daily horse audit analysis raised ten flaws. Read against
production on 2026-10-31, four were the audit misreading its own data, and
this change fixes those at the source.

## The leak spike judged the win side as a leak

`fn_run_horse_daily_audit` iterated every tag, including the `_won` win
mirrors that `HorseHandReview.flag()` records for the same situation, although
its own comment says the count is the loss side only. `plo_set_stackoff_won`
(268 tags, every sampled hand a win) was therefore raised as a critical
`leak_tag_spike`, beside the real finding `plo_set_stackoff`. Migration
`20261031200256` excludes `_won` mirrors from the spike loop; the loss side and
the mirrored-EV pairing are unchanged.

## The overlay audit ignored the overlay's return

`fn_audit_overlays` reported gross funding. The Nightly 10K (NLH) e48479cd
was funded 4,172.50 at 00:04 UTC and the live path returned all of it at
01:32 when late registration, rebuys and add-ons took the pool to 19,362.00
against a 10,000.00 guarantee. The analysis escalated it to Dan as a money
decision; there was nothing to decide. Migration `20261031200545` nets the
recorded return (`reversal`, "Guarantee overlay excess returned to its
source"). The estimate also uses the prize pool, so the diamonds Nightly 10K
(102,480 pool, 100,000 guarantee) no longer reports a 45,820 "gap". On
production data: 10-28 gross 8,901.60, net 0.00; 10-29 gross 29,270.50, net
1,262.00; 10-30 gross 4,172.50, net 0.00.

## Retired opponent-memory counters were read as dead layers

`horse_mind_mirror_learned`, `horse_mind_mirror_nothing_to_learn` and
`horse_opponent_memory_snapshot_applied` stopped on 2026-10-26, when live
decisions moved to independent observer memory and accepted public profiles.
No code fires them now. They are registered as retired receipts, so
`fn_audit_layer_drift` reads their silence as retirement.

## The volume collapse was a tournament start hold

On 2026-10-30, 93 of 95 MTTs and all 12 satellites were cancelled and no
SNG or Spin started from 01:00 to 24:00 UTC, under the owner-instructed
`ca_tournament_start_hold` during the MTT outage recovery. That alone explains
tournament decides falling about 91% and most of the 94 layer collapse and
silence warnings (icm*\*, v37_sat*\*, phase8 bounty and authority counters).
It is not a horse wiring regression.

## PLO top pair with no redraw: measured, not changed here

`plo_toppair_no_redraw_stackoff` covered 162 hands from 10-24 to 10-30,
averaging -157 bb. By pot type: 72 were 3-bet pots (flop pot about 45-60 bb),
78 were 4-bet-plus pots and 12 single-raised. In 64 hands the horse itself
raised or jammed the top pair; in 66 it led the flop and was raised.

A default-off V70 arm was written and measured on the legacy HorseLogic
path. It covered the committed-branch flat and the value-raise gate, using the
detector's own redraw definition. It changed nothing: 2 qualifying decisions
in 600 PLO5 pairs, 0 divergent pairs, and the legacy path already CALLS every
real-hand fixture tried. These decisions carry `origin: horse_policy` and are
made by the Phase 10/11/13 PLO policy packs (`phase13_plo5_execution_intended`
and siblings, millions of fires a week), not by the legacy branch. An inert
arm would have added one more `league_matchup_inert` finding, so it was not
shipped. The fix belongs in those packs, under their locked held-out
qualification contract.
