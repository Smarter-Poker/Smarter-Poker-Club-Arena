# 2026-08-30 — Satellite audit: late-reg wiring gap, double wins paid nothing

Agent: Claude (Cowork, local). Follow-up to the Sunday $200 Deep Stack outage
audit — full trace of every satellite feeding dfae9288 (16 completed, 1
running) against seats funded (`rake_records.source='fn_award_satellite_seat'`)
and cash paid (`wallet_transactions.category='prize'`).

## Finding 1 — fn_award_satellite_seat contradicted the TS gate (WIRING BUG)

PR #1935 taught `isSatelliteTargetOpen` that a RUNNING target inside late
registration is open — the normal shape of a satellite. But
`fn_award_satellite_seat` still refused every status except
ANNOUNCED/REGISTERING, so the engine's newly-opened gate called a function
that answered `target_closed`, and the winner fell to the cash path anyway.
The #1935 fix only appeared to work on 2026-08-30 because the Sunday $200 was
reset to REGISTERING minutes before satellite e3d3bd1e settled.

Fixed: the function now mirrors satelliteTargetOpen.ts exactly (RUNNING is
open while current_level <= COALESCE(late_reg_levels, rebuy_levels), both
0/NULL meaning no late reg). Migration
`20260830203500_satellite_seats_in_late_reg_and_double_qualification.sql`,
applied to production before the 21:00 UTC restart.

## Finding 2 — a second satellite win was worth exactly nothing

On unique_violation (winner already registered in the target) the function
returned ok=true/awarded=false and the engine logged "Seat awarded". The
player received neither a seat (they had one) nor cash. Four wins in one
week paid zero:

| Satellite | Place | Winner | Why deduped |
|---|---|---|---|
| 1a6f53a4 ($10) | 1 | 4e5a0000 (oxnarddani) | seat from 00a61dc1 |
| acb14548 ($25) | 4 | 660d14dc (chrome) | seat from 1aeeb298 |
| e3d3bd1e ($25) | 1 | 650f193e (goldenarm) | seat from 1a6f53a4 |
| e3d3bd1e ($25) | 5 | …000010 (buttonclicker) | already registered |

All four back-paid 200 (ticket value) in the applied migration, idempotently
under `tourney:{sat}:prize:place:{pos}`. Going forward the function reports
`held_from_this_satellite`, and processSatelliteAwards pays ticket value in
cash for a cross-satellite double win while a recovery re-drive of the same
satellite still pays nothing extra.

## Finding 3 — prize stamps failed silently

The `tournament_players.prize` update after each award discarded its error.
During the 2026-08-30 Supabase degradation every e3d3bd1e winner was recorded
at prize 0 while holding a funded seat. Stamps repaired in the migration; the
write now reports failures (`satellite_prize_stamp_failed`).

## Historical notes (no action, for the record)

- Pre-#1935 cash-outs: 43d74da2, c98e1b8b, 43e00303, 19fb97a1 and parts of
  acb14548/a5516ebf/1941930c paid winners 200 cash instead of seats while the
  target's late reg stood open — the incident #1935 documents (excess over
  pools ~2,0xx chips, all to horse wallets). Conserved going forward; any
  clawback is Dan's call, not an agent's.
- b9803055 settled through the NORMAL payout structure (43.20/27.00/…)
  instead of satellite awards — one-off from 2026-08-28; conserved (paid
  exactly its 108 pool), left as history.
- Early $5 satellites carried `satellite_seats = 5` against a 108 pool
  (overlay 892 per event, house-covered). Later instances are 1-seat. Worth
  a template review if overlay matters.

## Verification

- 36 satellite tests + 60 money-path guard tests green; server typecheck
  clean; new guard file `satelliteDoubleQualification.guard.test.ts` pins all
  three fixes.
- Back-pay assertions ran inside the applied migration (4 ledger rows).
