# A V53 pressure 4-bet is a variant_price reference return

## What was wrong

HorseLogic's `variant_price` preflop route has three literal returns: fold, call, and the V53 pressure 4-bet (`v53_pressure_four_bet`). The 4-bet fires when the horse opened, a pressure target re-raised without going all in, the horse still has chips behind and is clear of the price. The Phase 6 tournament receipt validator (`referenceReturnShape`) knew only fold, call and all-in for that route. Every tournament V53 4-bet was therefore refused as `reference_shape`, and the horse played the isolated-refusal fallback instead: a fold.

Live witness, read with the existing read-only `Inspect Tournament Refill` diagnostic against serving release 9f4f98f2: table `cc37487e`, hand `00b25b52` (heads-up SNG, 20/40, 2026-10-26 04:22 UTC). Seat 1 opened to 88 with 869, seat 2 re-raised to 198, seat 1's decision was refused `reference_shape` and recorded as `horse_fallback` fold. V53 4-bets fired 7 times on 2026-10-25 and 190 times in the first hours of 2026-10-26; isolated refusals rose from 9 to 562 over the same days.

## What changed

`referenceReturnShape` admits a `raise` on `variant_price` only in the V53 public shape: pressure and reads not switched off, exactly two preflop raises, the last raiser not all in, the horse's call smaller than its stack, the horse's own earlier preflop raise, a legal raise with a valid range, and an amount equal to the producer's deterministic target (pot-limit: `maxRaiseTo`; otherwise `min(maxRaiseTo, max(minRaiseTo, 2.3 x currentBet))`, rounded to cents). The private opponent read and equity gap are not repeated. Every other check (route gate, schema, coordinate, graph, transition) is unchanged, as are fold, call and all-in shapes.

HorseLogic is not edited, so no policy or digest changes.

## Proof

`aV53FourBetIsAReferenceReturn.guard.test.ts`: the live witness, min/max clamps and the pot-limit cap are admitted (all three fail on the previous validator); wrong amounts and nine out-of-shape states are refused; fold/call/HU all-in answers are unchanged; and a source pin requires HorseLogic to keep exactly this target and these conditions. The Phase 6 route-refusal, maniac-route, merged attribution-regression, worker client/runtime suites pass (1,222 tests), and server TypeScript compiles.
