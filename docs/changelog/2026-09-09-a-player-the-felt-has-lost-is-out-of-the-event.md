# A player the felt has lost is out of the event

2026-09-09

## What was wrong

106 players across 20 RUNNING tournaments carried `status = 'playing'` with zero
chips. 101 of them held no chair anywhere in their event, some for more than a
day. Between them their events held **10,673.18 of prize money that no door could
pay**, because a tournament with an unranked player never reaches a finish.

`fn_eliminate_tournament_player_atomic` is the only way into `eliminated`, and it
demands a knockout: either a candidate row naming who won the chips, or a
settlement receipt writing the player to zero or less in a hand. Both are proofs
that a HAND took the stack. A player whose stack was lost when their chair moved
was never knocked out by anybody, so neither proof will ever exist, and the
eliminator answers `knockout_evidence_not_found` for ever.

## What was built

Two doors, each carrying its own proof rather than a bypass of that one.

`fn_ca_eliminate_absent_tournament_players` proves **absence**: zero chips on the
roster, no live seat anywhere in the event, no seat row of theirs carrying a
positive stack, and the chair gone for longer than the dwell. `executePlayerMoves`
vacates a seat and writes the destination a second or two later, so ten minutes is
four hundred times the widest honest gap. **94 players recorded out.**

`fn_ca_release_broke_seats` handles the other shape: a live chair reading exactly
0.00, where one look cannot tell a broke player from an unsettled all-in. Nothing
in the database says a hand is in flight, so it proves it by time - the chair is
recorded on the first sighting and released only when a later run, at least the
dwell apart, sees the same chair still at zero. No hand of poker survives two
sweeps a quarter of an hour apart. A sighting is deleted the moment the player
stops qualifying, so nothing carries from one broke moment to an unrelated later
one, and a player with an open rebuy decision is never in the set at all.

Neither stamps a finishing place. `eliminated_at` is the moment the chair was
actually lost, and `position` is left for `fn_normalize_tournament_final_standings`
to derive from chronology at the finish. Stamping a place from a live count is
exactly the fault below.

Both run every quarter hour, both are in `ca_detector_registry`, and
`fn_ca_absent_tournament_players` is a **critical** check in the conservation
sweep, so the board sees the condition if it returns.

## The 6:00 AM freeroll

`$100 Freeroll 6:00 AM` had been RUNNING for 29 hours holding 179.11 of prize
money and 67.90 of fees. Positions there were stamped at bust time from a live
count that still counted players who had left the felt hours before, so the count
moved in both directions: 7f2fcb20 busted at 14:32:35 and was paid place 2, then
89a23158 at 14:37:43 took place 21, 65f99ae2 at 14:41:56 place 26, b1dd1863 at
14:43:45 place 30, and 786eb11f at 14:44:10 place 35. Nobody un-busts. **37 of the
40 paid places disagree with bust order**, and 585.99 had already left the escrow
against them.

`fn_normalize_tournament_final_standings` refuses such an event outright, and it
is right to: every ordering that satisfies chronology moves a place that has
already been paid. It says the event "requires manual review", and until today
nothing existed to answer the review with.

`fn_settle_tournament_places_by_ruling` is that answer. It is unreachable while
the ordinary door works - it calls the normalizer first and refuses if that
succeeds - and it carries the refusal it got into its receipt. Before writing
anything it proves every obligation settled in full, every roster prize matched
by a settled obligation, the place obligations summing to the whole prize pool,
and the escrow and fee closing at zero. Its batch receipt says `mode = 'ruling'`,
never `'structure'`, so an event settled this way is never mistaken for one the
structure computed.

The freeroll: **316bb405 rexlarsen** took place 1 and 126.55, holding all
3,021,200 remaining chips; **ef5a8ddd rford** was paid the 52.56 for place 3 that
had sat stamped on their roster row and unpaid since their 404,093 stack was lost
at a chair move at 14:21:33; **27ebd8e0 BLUFFROCK** took place 313, the only
vacancy, outside a ladder that stops at 40. 126.55 + 52.56 = 179.11, the exact
prize balance - which is the evidence that no third place was owed. Escrow closed
at zero, 0 live seats, status COMPLETED.

## Recorded, not fixed: the certificate layer is switched off

`fn_certify_tournament_finish` answers `completed_without_certificate` for the
freeroll - and for **every completed tournament on this platform**. Seven guards
on `public.tournaments` are DISABLED:

    aa_guard_tournament_completing_claim
    aaa_guard_atomic_satellite_completion
    zzzz_freeze_finalized_tournament_prize_pool
    zzzz_tournament_pool_finalization_window_guard
    zzzz_tournaments_atomic_place_completion_guard
    zzzzz_tournaments_atomic_final_table_deal_completion_guard
    zzzzzz_tournaments_financial_certificate

All 5,658 rows in `tournament_finish_receipts` carry `certified_at` NULL and
`evidence` NULL, while 5,567 completed events do hold a settled place batch. The
migrations of 2026-09-08 installed each guard and disabled it deliberately, to
coexist with an engine still writing the old direct `COMPLETING -> COMPLETED`
path, and named the re-enable "Stage B". Stage B never ran.

This is not enabled here. Each of these is a BEFORE trigger that REFUSES a
completion whose money does not balance; switching all seven on without first
proving that today's events pass `fn_tournament_finish_readiness` would freeze
tournament finishes across the platform. The measurement comes first, and it is
the next piece of work. What the freeroll migration does assert instead is the
proof the certificate would have carried: `fn_tournament_finish_readiness`
returning ok with no failures - the same jsonb the trigger would have written
into `evidence`.

A disabled guard is the purest form of a check nobody sees.
