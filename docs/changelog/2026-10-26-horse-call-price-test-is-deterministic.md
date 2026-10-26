# The horse call-price test no longer depends on the shuffle

## What was wrong

`server/src/engine/HorseDecisionEffectCommit.test.ts`, the case "reconciles the actual call price through the scheduled executor (selected undefined / 2 / 20)", failed intermittently at the `actionHistory` assertion with `expected { seat: 1, ... } to match object { action: 'call', amount: 2 }`. It failed on unrelated PRs in CI shard "Server Engine shard 1/4" (#8162 twice); locally it failed 2 of 40 runs on main.

The cause was not timing. The case builds a real `HandController` and lets it deal, so the horse's hole cards come from `Deck.shuffle()` (crypto `secureShuffle`, `server/src/engine/PokerEngine.ts`), which nothing in the test controlled. The worker mock answers `call`, but at commit the executor reapplies the hold'em premium law (`holdemPremiumAggression`, `server/src/engine/ServerTableEngineTurns.ts` line 4281; rule in `HorseHoldemPremiumAggression.ts`, Dan 2026-10-25): a horse holding QQ+ or AK never flat-calls preflop, so the first-in call becomes a raise to 3 big blinds (6). That is 34 of 1,326 starting hands, about 1 deal in 39. Each test-file run has three cases, so roughly 1 run in 13 failed.

Proven by logging the dealt hand on every run: every failure was AKs (`Ac Kc`, `Ah Kh`) recorded as `raise 6`, and every pass was a non-premium hand recorded as `call 2`. Forcing AKs to the horse made all three cases fail every time.

The engine is right. Raising with a premium is Dan's binding rule, and it applies to every horse at commit.

## What changed

Only the test. That case now rigs `Deck.prototype.shuffle` (the same pattern `HorsePremiumContinuation.test.ts` uses) so the horse is dealt `7c 2d`, which is never premium, and checks that the horse holds exactly those cards before acting. Every assertion is unchanged: call 2 recorded, the witness intended or coerced, no plan commit, the hand anchor, and the committed-hand binding. No engine code changed, and horse timing is the same as a human's.

The other cases in the file that deal with a real controller were checked. "Uses the actual controller record when a wager finishes" and "reconciles the actual %s controller clamp" submit raise or all-in, which the premium law never changes, and the clamp cases run Omaha or fixed limit, which the law does not cover. Neither depends on the deal, so neither was changed.

## Proof

- Before (main): one loop of 30 runs passed every time; a second loop of 40 failed 2 times; a capture loop failed on its 3rd run; a 12-run logging loop failed 2 times. Every failure was `raise 6` on AKs.
- After: 40 of 40 loop runs passed, and the whole file passed 10 of 10 times (203 tests).
- Server TypeScript compiles (`tsc --noEmit -p tsconfig.json`).
