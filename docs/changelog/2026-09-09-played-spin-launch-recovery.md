# 2026-09-09 — played Spin launch recovery

## Fixed

- A paid 3-max Spin whose table had already dealt could remain `REGISTERING`
  forever after one player busted and vacated. The launch manager saw only the
  two live survivors and stood down before it could adopt the existing table or
  complete the launch receipt.
- PostgreSQL now exposes one service-only, read-only proof for that exact state:
  three original roster/payment/entitlement identities, two playing survivors,
  one zero-stack eliminated player with a vacated seat, a persisted hand, both
  immutable Spin reserve rows and journals, all three exact entitlement source
  charge journals, and conservation of all three bought starting stacks on
  both roster and felt.
- The manager keeps the original three identities for the paid gate, seats only
  the two active survivors, and keeps three seats in both conservation floors.
  Launch completion repeats the same proof after locking the tournament before
  it can lower the active field from three to two.
- Recovery preserves the already-persisted reveal timestamp and lag. It does not
  restamp, rebroadcast, or place a new reveal hold over a Spin that already dealt.
- The proof accepts exactly three starting stacks in both roster and felt
  mirrors. Divergent mirrors and any unreceipted excess chips fail closed rather
  than turning a corrupted snapshot into launch authority.
- The manager retains exact per-player starting stacks for every ordinary Spin
  and Heads-Up launch. Redistributed stacks are accepted only after the narrow
  persisted-hand Spin proof succeeds, and roster/felt stacks must still match
  for each surviving player.

## Verification

- Focused server tests cover strict proof parsing, manager wiring, funding-floor
  behavior, the ordinary launch boundary, historical reveal preservation, and
  immutable Spin settlement.
- `scripts/ci/probes/played-spin-launch-recovery.sql` completes and replays one
  exact disposable launch, then proves missing hand, draw, entitlement, one
  missing source charge, one missing chip, divergent totals, contradictory
  per-player mirrors, unbacked excess chips, a decided one-survivor game, and
  Heads-Up SNG markers all fail closed. Its final PASS exception rolls back
  every fixture row.

## Deliberately unchanged

- Heads-Up remains a separate Sit & Go product. Its economics, settlement, and
  routing are unchanged; only the shared ordinary launch proof was tightened so
  it cannot inherit played-Spin redistribution without the Spin-only evidence.
- No satellite registration, settlement, refund, ticket, or bubble behavior was
  changed.
- No watcher, sweeper, reconciler, or legacy repair path was added.
