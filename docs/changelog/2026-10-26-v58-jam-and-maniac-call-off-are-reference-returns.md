# A V58 short-stack jam and a maniac call-off are variant_price reference returns

## What was wrong

Two literal reference proposals on the Phase 6 `variant_price` route were refused by the tournament receipt validator (`referenceReturnShape`) as `reference_shape`, so the horse played the isolated-refusal fallback, a fold:

1. **V58 short tournament stack does not flat** (`v58_short_stack_no_flat`). A two-card no-limit tournament stack of at most 12bb facing a non-all-in raise it prices jams. The generic all-in shape admitted a shove only with more than 1.5x the call behind AND another live responder, so every V58 jam heads-up against the raiser (every HU SNG and HU Spin), or with the call near the whole stack, became a fold in exactly the spots V58 exists for. The maniac call-down's own V58 jam inside the reference has the same shape.
2. **Maniac call-down all-in call-off.** `maniacCallDown` runs inside the reference after the route returns and answers an owed call that costs the whole stack with `all_in`. That call-off was refused the same way, in cash and tournaments (maniac_call_down: 1,510 fires on 2026-10-26).

Both were found by the 2026-10-26 horse decision audit (independently by the pipeline and wiring reviews), the same class as the V53 4-bet fixed in #8143.

## What changed

`referenceReturnShape` admits, on `variant_price` only: an unsized `all_in` in the V58 public shape (tournament mode by the producer's own rule, two-card no-limit not short deck, raiser not all in, call below stack, stack plus bet at most `SHORT_STACK_NO_FLAT_BB`), and an unsized `all_in` whose owed call is at least the whole stack. The private maniac read and the equity are not repeated; every other check is unchanged. HorseLogic is not edited.

## Proof

`aV58ShortStackJamIsAReferenceReturn.guard.test.ts`: the HU jam, a three-handed jam with the call near the stack, the exact 12bb ceiling and the call-off (cash and tournament) are admitted, and all four fail on the previous validator; cash, Omaha, short deck, an all-in raiser, a sized all-in and a heads-up shove with chips behind are refused; source pins require HorseLogic to keep the V58 conditions and the call-down's `allInCall` return. Server tsc passes; Phase 6 route-refusal, V53, maniac-route, merged attribution regressions and worker client/runtime suites pass.
