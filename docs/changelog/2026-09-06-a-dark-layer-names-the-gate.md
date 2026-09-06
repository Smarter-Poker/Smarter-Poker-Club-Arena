# A dark layer names the gate that closed

2026-09-06. The ledger caught it; nobody could say why.

## The finding

The 2026-09-05 daily audit, critical:

> `v44_second_look` fired **0 times** against **2,121,841** decides (0.000%,
> ledger expects >= 0.100%)

V44 is the two-phase equity read: on a close spot, the fast Monte Carlo
answer is replayed at six times the sample a few hundred milliseconds into
the think time, and the deeper read acts if it disagrees. It shipped, it is
wired, and it has never run once in production.

The hardening worked exactly as designed - a shipped layer that does nothing
was reported rather than assumed healthy. What it could not say was **which
of the five gates was closing**, because `secondLookPlan` returned a bare
`null`.

That matters because the five reasons want opposite fixes:

| gate             | what a high count means                                         | what to do                             |
| ---------------- | --------------------------------------------------------------- | -------------------------------------- |
| `governor`       | `EquityLoadGovernor` is shedding load: event-loop p50 over 40ms | capacity                               |
| `no_think_time`  | horses act in under 1500ms                                      | the tempo model                        |
| `small_pot`      | pots under 20bb                                                 | the ledger's 0.1% expectation is wrong |
| `action_shape`   | the fast answer was a bet or raise                              | ditto                                  |
| `not_facing_bet` | nothing to re-read                                              | ditto                                  |

Guessing between those is how a layer stays dark for a week. The governor is
the strongest suspect and it is also the **only one with no observability at
all**: its scale is exposed in the `GameServer` status payload and persisted
nowhere.

## What changed

`secondLookPlan` returns `{ ok: true, afterMs } | { ok: false, reason }`, and
the call site fires one receipt per declined decision naming the gate.

The gates are checked in order and exactly one receipt fires per decision, so
the five decline counts plus `v44_second_look` **sum to `decide`** - they
partition the decisions rather than double-counting them, and tomorrow's
telemetry answers the question in one query.

The receipts are fired as **literals through a switch**, not looked up in a
map. A map would be tidier and would break `HorseDataLedger.test.ts`, which
greps the source for each registered receipt's firing site. That law is right:
a receipt reachable only through an indirection is one nobody can find from
its name, which is how a key outlives the code that fired it.

No expectation is declared on any decline receipt. **A decline is an
observation, not a promise.**

## Tests

`HorseV44SecondLook.test.ts` gains two: every gate returns its own reason in
gate order (including a spot that fails several, to pin that the first one
wins and the counts stay a partition), and the five reasons fire five
distinct receipts once each, checked through `drainFires` rather than by
reading the source.
