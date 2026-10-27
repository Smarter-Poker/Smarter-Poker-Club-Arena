# A V58 short-stack jam and a maniac call-off are variant_price reference returns

## What was wrong

Two literal reference proposals on the Phase 6 `variant_price` route were refused by the tournament receipt validator (`referenceReturnShape`) as `reference_shape`, so the horse played the isolated-refusal fallback, a fold:

1. **V58 short tournament stack does not flat** (`v58_short_stack_no_flat`). A two-card no-limit tournament stack of at most 12bb facing a non-all-in raise it prices jams. The generic all-in shape admitted a shove only with more than 1.5x the call behind AND another live responder, so every V58 jam heads-up against the raiser (every HU SNG and HU Spin), or with the call near the whole stack, became a fold in exactly the spots V58 exists for. The maniac call-down's own V58 jam inside the reference has the same shape.
2. **Maniac call-down all-in call-off.** `maniacCallDown` runs inside the reference after the route returns and answers an owed call that costs the whole stack with `all_in`. That call-off was refused the same way, in cash and tournaments (maniac_call_down: 1,510 fires on 2026-10-26).

Both were found by the 2026-10-26 horse decision audit (independently by the pipeline and wiring reviews), the same class as the V53 4-bet fixed in #8143.

## What changed

The V58 jam half landed first on main in #8183 (`v58ShortStackJamShape`, any route, preflop, someone else raised, call below stack, stack plus bet at most `SHORT_STACK_NO_FLAT_BB`); this PR adopts that shape unchanged on merge. What this PR adds is the call-off: `referenceReturnShape` admits, on `variant_price` only, an unsized `all_in` whose owed call is at least the positive remaining stack. A zero or negative stack cannot qualify as a call-off. The private maniac read and the equity are not repeated; every other check is unchanged. HorseLogic is not edited.

## Proof

`aV58ShortStackJamIsAReferenceReturn.guard.test.ts`: the HU jam, a three-handed jam with the call near the stack, the exact 12bb ceiling and the call-off (cash and tournament) are admitted; cash, Omaha, short deck, a sized all-in and a heads-up shove with chips behind are refused; source pins require HorseLogic to keep the V58 conditions and the call-down's `allInCall` return. Phase 6 suites, V53 and the bubble short-stack law pass on the merged tree.

Conflict recovery retained the newer protected-main PLO6 priced-call validator and refusal classifier unchanged. A new zero-stack regression failed before the positive-stack guard and passes after it; free and negative-stack call-offs remain refused.
