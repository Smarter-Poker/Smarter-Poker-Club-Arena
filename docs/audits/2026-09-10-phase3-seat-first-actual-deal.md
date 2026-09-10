# Phase 3: seat-first launch through actual first hand and timer

Date: 2026-09-10. Branch: `agent/codex-phase3-sng-spin-sep10/fix/reveal-recovery`.
Continuation of reveal-delivery commit `77940e27052cbdf58365f498d1017f8ff6192c79`.

## Confirmed defect and correction

The actual `TournamentManager.start()` admitted a Spin engine whose dealing loop was correctly held for the shared wheel, while immediately calling `startBlindTimer`. Ordinary admission spent 16.6 seconds of level one underneath the reveal. Slow table setup correctly extended the engine hold but still started the level clock before that extended deadline. An early reveal-emitter failure had the same clock problem.

`startLifecycle` now retains the effective Spin first-deal deadline and, after launch proof/completion and engine admission, schedules the initial blind timer at that absolute deadline. If a slow completion has already consumed the hold, the timer starts immediately. Non-Spin advertised pre-seat timing follows its existing path. Played recovery never enters the fresh reveal branch. The existing lifecycle timeout prevents a stopped owner from arming the delayed level.

The correction changes no stack, price, rake, multiplier, payout, blind ladder, clock duration, cancellation policy or financial authority. It adds no monitor, repair job or database write.

## Behavioral evidence

`server/src/tournament/SeatFirstActualDeal.test.ts` imports and executes the real manager start operation, launch receipt validation and field proof; the real engine dealing loop, `dealHand`, `HandController.start`, hand-event routing, and `PreciseActionTimer`; and the actual `TableStateHub` retention/reconnect implementation.

External database results, preexisting paid seating/hydration, time-bank extra read and persistence are controlled fixture boundaries. Engine boot hydration is represented by an inert engine initialized from the fixture seats. `startManagedTableEngine` invokes its actual dealing loop. The initial blind-timer invocation is observed at its call boundary; the common blind clock persistence and subsequent levels belong to K01. Post-reveal UI staging and monetary hand settlement are outside this rehearsal. No simulated response is claimed as a PostgreSQL proof.

Fourteen cases establish:

- Ordinary Spin admission, slow setup beyond the original hold, and failed early reveal transport all reach one first hand only after the same hold announced to all three seats.
- Reconnect at one millisecond before that hold receives the same immutable multiplier, reveal anchor and effective deadline. An arrival after dealing receives no stale wheel.
- No controller, hand-start event or action clock exists during the hold. Actual first-hand dealing follows the deadline; the first action timer starts after the engine's real hand-start animation beat and receives its full configured 15 seconds.
- Slow completion beyond the reveal deadline does not restart the full reveal wait or admit a dealer before completion.
- A stopped lifecycle never starts the delayed blind timer.
- Refused draw and refused completion never admit the real dealer or either clock.
- Non-Spin pre-seating keeps the advertised one-minute hold.
- Two concurrent local start calls share one launch claim, one completion and one first hand.
- A one-player Heads-Up field stays REGISTERING without creating a launch receipt.
- NLH and PLO4, at both 300 and 1000 chips, actually deal two players at 10/20 with no ante; the button posts the small blind and acts first preflop, and each seat receives the correct two/four cards. The first actor has the full action clock. Fresh banks contain the 40-second base, with a controlled 20-second funded-extra read giving one seat 60 seconds. Bank uses are 2 and 3 respectively.

Before the fix, the corrected fixture produced exactly **3 failing / 6 passing** cases: all three Spin cases saw a blind-clock start before the hold. Log: `/tmp/codex-sng-actual-deal-baseline.log`.

Focused server command (from `server/`):

```sh
npx vitest run src/tournament/SeatFirstActualDeal.test.ts src/tournament/SpinRevealSettlementBoundary.test.ts src/tournament/SpinStartsInOneSecondAndPlaysInFull.test.ts src/tournament/TheWheelFiresOnTheDraw.test.ts
```

Result: **55 tests in 4 files pass**. Log: `/tmp/codex-sng-actual-deal-verified.log`.

Existing board/spec/wiring acceptance: **63 tests in 5 files pass**, covering `headsUpSpec`, `headsUpCanReachItsOwnFieldSize`, `headsUpSpecIsWired`, `headsUpTurboAndSeatCount` and `headsUpIsAnnounced`. Log: `/tmp/codex-sng-config-verified.log`.

Server TypeScript passed with exit 0; `git diff --check` passed. Independent bounty-lane review found no blocker and reran **29/29 tests** across the actual-deal and reveal-boundary suites; log `/tmp/bounty-independent-spin-timer.log`. Final commit identity review follows the commit.

## S03 supported product disposition

The user ruling recorded in `headsUpSpec.ts` and `TournamentRecurringService.ts` is dated **2026-08-21**: Heads-Up is the only SNG format. The 2026-08-23 clock ruling gives both stack bands the same speed. Parent reconfirmed this explicit scope on 2026-09-10. Generic historical 6/9-max branches are retired/inventory references, not missing products to build.

| Authority         | Approved supported behavior                                | Wiring / proof                                                                                                |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Heads-Up capacity | Exactly 2 players                                          | `HEADS_UP_SEATS`, recurring creation max/min/table size, real one-player stand-down and full two-player start |
| Bands             | 300 and 1000 starting chips                                | Mirrored spec and both actual NLH/PLO4 first hands                                                            |
| Variants          | NLH and PLO4                                               | `HEADS_UP_GAME_TYPES`, recurring board configs and actual dealt card counts                                   |
| Buy-ins           | 1, 2, 5, 10, 20, 25, 50, 100 total chips paid              | `HEADS_UP_BUYINS`, recurring config derivation, existing board-wiring tests                                   |
| Fee               | 5% of total paid; remaining 95% to prize                   | `rakeRateFor` and `buyInColumns` in creation; rates unchanged here                                            |
| First level       | 10/20, no ante                                             | Actual first-hand forced bets and pot                                                                         |
| Level clock       | 3 minutes in both HU bands                                 | `HEADS_UP_BLIND_STRUCTURE`, actual initial clock invocation receives that structure                           |
| Published ladder  | 12 levels, then deterministic 1.4x big blind rounded to 10 | Mirrored `headsUpBlindsForLevel` and existing spec tests                                                      |
| Payout            | Winner takes 100%                                          | Mirrored `HEADS_UP_PAYOUTS` and recurring wiring; final payout writer acceptance belongs to payout lane       |
| Fresh time bank   | 40-second base plus authoritative purchased/VIP extras     | Actual deal initialization and timer assertions                                                               |
| Breaks            | No ordinary synchronized :55 break for this short format   | Existing format eligibility and spec; maintenance remains separately authoritative                            |

There is an existing documented restart limitation at the actual time-bank initialization: the persisted non-null default cannot distinguish an unseeded seat from a spent bank. The old attempted restore was reverted because it consumed paid VIP quota incorrectly. This lane proves fresh initialization and does not claim durable restart fidelity; any schema/authority correction requires a separately reviewed proposal, not a fallback guessed from that column.

## Primary industry comparison

Checked 2026-09-10:

- [PokerStars Spin & Go rules](https://www.pokerstars.com/poker/spin-and-go/) state that the three-player field fills, the prize is drawn and shown to all players, then play begins. This supports auditing reveal-before-play and common displayed result. Its multiplier-dependent stacks and level durations are operator-specific and are not substituted for Dan's approved board rules.
- [PokerStars tournament rules](https://www.pokerstars.com/poker/tournaments/rules/) describe published tournament structures and format-dependent entry/cancellation behavior. The comparison is a control benchmark; it does not override the platform's explicit Heads-Up-only SNG decision.

## Remaining gates; no blanket completion claim

- **S08:** The actual server manager-to-first-hand/action-clock boundary now has behavior-level acceptance. Browser animation/audio, real network delivery, deployed adoption and durable crash/recovery still need their separate evidence.
- **S03:** Approved format inventory, creation wiring, fresh stacks/blinds/cards/action clocks and time-bank initialization are proven at the boundaries described above. Final payout execution and persisted time-bank restart fidelity are not established here.
- **S01/S02/AX08:** Local start coalescing and short-field stand-down are proven. A database concurrency run must still compose actual current `fn_take_seat_and_buy_in` with current launch receipt wrappers and unregister. Entry/refund lane commit `4e8d2e58efa65e2f11e03b8035764684211694fc` already provides 14 ordinary MTT registration/refund groups; those are reused evidence, not HU/Spin launch-race acceptance.
- Read-only live catalog capture of current launch definitions is at `/tmp/codex-sng-launch-catalog.json`; six begin/complete generation and before-generation signatures were captured from project `kuklfnapbkmacvwxktbh`. No production function or data was modified.
- **K01:** This closes the initial fresh Spin scheduling defect only. Subsequent blind-level fanout, persistence, detached anchor writes and resume remain the common clock lane's responsibility.
