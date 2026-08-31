# 2026-08-31 — Bankroll telemetry: the ladder says why

Phase 2 of the bankroll re-land. Restores `HorseBankrollTelemetry.ts` from
`6eae5e2b90` (#2118, reverted during the cash-floor incident) and wires it to
the decisions that actually exist in `main` today.

## Why this one goes first

The bankroll layer refuses seats, caps buy-ins and declines reloads, and every
one of those decisions was silent. That silence is what made the 2026-08-31
outage take forty minutes to diagnose: a floor that refuses every seat and a
floor whose seating path is broken look identical from the outside. The
difference is entirely the reason, so the reason is what gets recorded, and it
gets recorded before any further behaviour lands on top of it.

## Wired

| event                                    | site                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| `seat_refused_underrolled`               | `canSit` false in the candidate gate                      |
| `seat_refused_share_below_min`           | `bankrollBuyIn` capped to zero                            |
| `seat_fail_open_roll_unknown`            | the fail-open branch of the bankroll gate                 |
| `buyin_capped`                           | the policy cut the profiled buy-in                        |
| `topup_refused`                          | `topUpAllowance` declined a reload that was otherwise due |
| `session_book_win` / `session_stop_loss` | `sessionVerdict` ended a session                          |
| `ladder_exhausted`                       | gauge: horses that cannot afford the cheapest open game   |

`seat_fail_open_roll_unknown` is the renamed one. The reverted module called it
`seat_refused_no_membership`, which is now a lie: after #2151 an unreadable
bankroll fails OPEN, and the line that made it a refusal is what emptied the
floor. It is counted because a gate that silently abstains for half the fleet
is a gate nobody can trust. 261 of 584 horses are not members of the club that
owns every open cash table, and until this counter existed that number was only
reachable by hand. This closes the P2 "261 horses now fail open, unmeasured".

## Two deliberate departures from the reverted code

**The summary line reports a delta, not a running total.** It prints every 30
seconds against counters that only climb, so a total answers "has this ever
happened", which is permanently yes after the first occurrence. The delta
answers "is this happening now", which is the question a quiet floor poses.
`bankrollCounters()` stays monotonic; only the line changed. Gauges are exempt
and reprint their value each cycle, so a standing strand never falls silent.

**Five event names are deliberately absent.** The reverted module also declared
`seat_refused_aggregate_exposure`, `rebuy_refused_underrolled`,
`rebuy_refused_stop_loss`, `tournament_refused_underrolled` and
`freeroll_entered_broke`. Those decisions do not exist in `main` yet, and a
reason that is permanently zero reads as a decision that never fires, which is
the confusion this module exists to end. Each name lands in the PR that lands
the decision behind it, and a pin fails the build if a name is added without an
emitter.

## Pins

`server/src/services/HorseBankrollTelemetry.test.ts`, 14 assertions. All ten
mutations were applied and observed failing, then reverted:

fail-open turned back into a refusal; the ladder gauge guarded by
`if (stranded > 0)`; the summary line deleted from the seeding cycle;
`buyin_capped` fired unconditionally; the underrolled refusal counted but not
refused; `topup_refused` fired with no reload due; the two session exits
collapsed to one name; a dead event name added to the union; the delta reverted
to a running total; the gauge made to stop reprinting when unchanged.

No behaviour change to seating, reloads or session exits. Counters are
in-memory and diagnostic; chip movement remains recorded in `chip_ledger` and
`chip_transactions` and nothing here substitutes for those.
