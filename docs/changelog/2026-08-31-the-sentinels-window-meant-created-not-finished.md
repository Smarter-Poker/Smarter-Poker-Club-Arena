# 2026-08-31 — The invariant sentinel's window meant "created", not "finished"

Found in Phase 5 of the Spins audit, while tracing why a spin's money is
checked after it ends. Second time this exact column has been wrong.

## What was wrong

Sweep #6, the tournament invariant sentinel, walks tournaments "newly observed
as COMPLETED" and checks three things nothing else checks:

1. **payout conservation** — paid `tournament_players.prize` must equal
   `tournaments.prize_pool`; a shortfall means chips were destroyed, an overage
   means chips were minted;
2. **no stranded players** — a COMPLETED event must have nobody left in
   `playing`/`registered`/`active`;
3. **no raked tournament hands** — the pot engine must take zero rake during
   tournament play.

It selected, filtered, ordered and watermarked on `tournaments.updated_at`:

```ts
.eq('status', 'COMPLETED')
.gt('updated_at', sinceIso)
.order('updated_at', { ascending: true })
```

**`tournaments.updated_at` is maintained by nothing** — no trigger, no engine
write. Measured 2026-08-31: **2,286 of 2,286** tournaments created in the last
24 hours had `updated_at = created_at`, and `updated_at < started_at` on every
single one. The row moves REGISTERING → RUNNING → COMPLETING → COMPLETED and
that column never moves at all.

So the watermark was a **creation** time, and every batch advanced it past each
lobby opened before the one it happened to finish on.

## Why that is worse than "late"

A tournament created before the mark and finished after it was **never**
checked. Not delayed — skipped permanently, because the mark only ever moves
forward.

Measured at the live watermark (`14:47:57.519333`, which is itself the
_creation_ timestamp of a spin that had just completed): **63 COMPLETED events
created before it and ended after it, 44 of them Spins**, none of which the
sentinel had looked at. That recurs on every batch, so it is a standing blind
spot for anything that finishes out of creation order — which, for lobbies
opened minutes to hours before they fill, is most of the board.

## Second time

The payout sweep had precisely this defect and it was fixed on 2026-08-29 in
`20260829125035_payout_sweep_window_means_finished_not_created`. Its post-mortem
is still in this same file, three hundred lines below the bug:

> The scan filtered and ordered on `tournaments.updated_at`, which NOTHING
> maintains … Measured across all 39,338 COMPLETED events: `updated_at >=
ended_at` on ZERO of them.

The lesson was written down and the second instance was left in place.

## The fix

`ended_at` — "newly observed as COMPLETED" means finished, not scheduled. It is
safe to order on: set on **100% of the 43,482** events COMPLETED in the last 30
days, so there is no null tail to fall through.

The select list, the filter, the order and the watermark advance all move
together. That matters: selecting `updated_at` while reading `t.ended_at` would
advance the mark to `undefined` and re-scan the same batch forever, which is
why there is a guard for it below.

## The guard

Three assertions in `rakebackWatermark.guard.test.ts`, beside the other
watermark rule, bounded by `sliceMethod` rather than a character count. Verified
in both directions: reverting the source to the old shape turns exactly those
three red and leaves the other four green.

## Verification

`npx tsc --noEmit` clean. 64 server service test files, 705 tests, all passing.
