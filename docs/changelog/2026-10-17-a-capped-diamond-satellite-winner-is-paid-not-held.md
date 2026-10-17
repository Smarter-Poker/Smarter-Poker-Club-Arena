# A capped Diamond satellite winner is paid, not held (2026-10-17)

## What the owner saw

"Tables Have Stopped Dealing - 1 MTT(s) have stopped producing hands. 4 more
of this kind since the last alert." - pushed to Dan's phone at 21:22 Chicago
time on 2026-10-16, after `MttPlayStopped` had been firing since the
afternoon.

## What actually happened, read from rows

**Sunday Deep Stack Satellite 10** (`a4445447-9baf-4700-8648-34987af2a81f`, a
Diamond satellite into "Sunday 200 Deep Stack") decided at 01:32:04Z: 24
entrants, positions 2 through 24 recorded in order, one survivor (SDLena,
`82c24bec`, a horse) holding all 240,000 chips. Ten seconds later the
single-winner settlement authority refused the finish:

```
diamond_satellite_winner_at_the_table_cap: satellite a4445447-... award 1 user 82c24bec-...
```

and refused every bounded engine retry for the next two hours, across the
02:56Z engine restart and adoption. The event sat `RUNNING` with one player
and nothing to deal; `MttPlayStopped` paged hourly;
`fn_ca_tournament_finished_but_not_completed` filed the unpaid winner. Earlier
the same day **Sunday Deep Stack Satellite 25** (`9dc3fae9`) hit the identical
wall on the cohort authority at 17:33Z (`satellite_qualifiers_refused_repeatedly`)
and finished 56 minutes late only because its winners' other games happened to
end.

## Two causes, one clause, both settlement authorities

The clause lives identically in `fn_settle_satellite_tournament_pre_money_path_gate`
(single winner) and `fn_ca_settle_satellite_cohort` (multi-qualifier), installed
by Phase 9 migration `20260929161500_a_diamond_satellite_seat_is_a_whole_ticket`.

1. **The dying satellite counted against its own winner.** The four-game cap
   read `fn_concurrent_game_load(winner, NULL, NULL, target)`, whose clause (1)
   counts every live seat at a non-closed table of a non-terminal tournament.
   The satellite being settled is still `RUNNING` when its settlement runs -
   the settlement is what completes it - so the winner's seat at the
   satellite's own final table counted as a game. This is the exact miscount
   the 2026-09-10 note inside `fn_concurrent_game_load` was written about,
   reachable again because that fix keyed on `COMPLETING`/`COMPLETED` status
   the satellite does not yet have at settlement time. SDLena's load read 5:
   four real tournaments plus the satellite she had just won. It also silently
   downgraded **chip** winners from a real target seat to a noncash ticket one
   game too early.

2. **The Diamond refusal had no exit.** For a Diamond satellite the clause
   raised by name, documented as "nothing moves and the engine retries". The
   engine does retry, on its bounded backoff (`FINISH_REFUSAL_BACKOFF_CAP_MS`,
   15 minutes) - but a horse seated at four long tournaments stays at the cap
   for hours, so the refusal is not transient and the event is held hostage:
   no hands, no finish, no payout, a page every hour. An unbounded hold with
   no exit is a deadlock, not a rule.

## The fix, at the root (migration `20261017033733`)

Both authorities, asserted substitution against pinned live md5s
(`384887d62082eec9a0d61a9d49d955a2` single, `e8986b5b177c88acbde1ac80fe7e029f`
cohort), reverse substitution proved:

1. **The dying satellite is not a game.** The winner's live seats at the
   satellite being settled are subtracted from the cap load, with the same
   predicates clause (1) counts by, because this very transaction releases
   them. A winner's own dying event can never again be the game that caps
   them. This repairs the chip path's early ticket downgrade too.

2. **A capped Diamond winner takes the ticket's value as whole Diamonds.**
   The duplicate-qualification rule already pays a Diamond ticket's value as
   money through `fn_credit_and_log` -> `fn_poker_diamond_tournament_pay`
   (delivery_kind `'cash'`, payout_source `'satellite_ticket'`, obligation
   opened and closed in the same transaction) - the Phase 9 header names that
   door itself. The capped winner now takes exactly that path. Nothing
   divides (the ticket is the target's whole buy-in plus whole fee, asserted
   whole before any Diamond moves) and a cash exit closes the prize bank
   exactly as a seat does. The **chip** rule is unchanged: a capped chip
   winner still receives the noncash tournament-entry ticket.

The event therefore **always finishes and always pays in the transaction that
records the finish**. No repair job, no backfill: the engine's existing
bounded finish retry healed the live stuck event through its own finish path
within one backoff interval of the apply.

## Self-healing, stated plainly

The engine side already behaves correctly and needed no change: a proven
refusal re-arms the finish on its own schedule (base delay, doubling to a
15-minute cap for rule refusals), adoption after a restart re-detects the
decided field, and `fn_ca_tournament_finished_but_not_completed` stays as the
net that is now expected to find nothing. The deadlock was entirely the
database rule; with it gone, a decided satellite cannot stay `RUNNING` longer
than one retry interval for this cause.

## The damage already done

Satellite 10's winner was paid in full by the live path once the rule stopped
refusing - no compensating write was needed, nobody was paid twice, nothing
was clawed back. Satellite 25 had already settled correctly on its own once
its winners dropped below the cap; its payouts stand.

## Pinned

`tests/a-capped-diamond-satellite-winner-is-paid-not-held.law.test.ts` pins
the migration's substitution: the own-satellite seat subtraction, the Diamond
cap routing to `'cash'`, the unchanged chip `'ticket'` rule, and the absence
of the no-exit refusal from the post-image.
