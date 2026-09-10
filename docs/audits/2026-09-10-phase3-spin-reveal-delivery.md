# Phase 3 Spin Reveal Delivery

## Observed Defects

The real `TournamentManagerBase.startLifecycle` launch fragments and the real `TableStateHub` reproduced three failures on September 10, 2026:

1. An early funded reveal was retained until the original first-deal hold. The admission pass subsequently extended the engine hold when table setup ran late, but skipped every early table. A participant reconnecting after the original hold received no reveal even though dealing was still held.
2. The manager recorded only that the early pass had run, before its per-table emit. If that emit threw, the later admission pass still skipped the table and never delivered its funded result.
3. `TableStateHub.replayRetained` recorded successful delivery before attempting the send. If a replay send threw, a resync on the same subscriber permanently suppressed the reveal.

These are demonstrated implementation defects, not inferred production incident counts. The baseline manager test had two failures with empty event lists. The baseline hub test had one failure with an empty event list after a failed send and subsequent resync.

## Live Path Corrections

The manager records the tables whose early emit completed without an exception. Its admission pass skips a table only when that emit succeeded and the actual deal hold is unchanged. A longer hold refreshes the event through the existing hub using the same reveal instant, multiplier, prize and locked tiers. No new draw is requested. The ordinary fast-start path still sends one reveal.

The hub records delivery only after `safeSend` succeeds. A failed replay remains available to the existing resync path until its original retention deadline. This changes the event producer and consumer directly; no scheduled recovery, financial correction, new monitor, or polling loop is added.

Exact callers are `TournamentManagerBase.startLifecycle` for both manager blocks, and `TableStateHub.subscribe` / `TableStateHub.resync` for retained delivery. The existing `TablePage` `SPIN_REVEAL` handler guards a second wheel using `spinRevealPlayedRef` and `spinRevealAlreadyPlayed`; the refreshed event retains the original anchor rather than scheduling another wheel.

## Executed Acceptance

The expanded `SpinRevealSettlementBoundary.test.ts` executes both production launch fragments, a controlled immutable funded receipt, and the real hub. It proves:

- All three connected participant fixtures receive the same stored 10x result and reveal instant.
- A late admission extends the engine hold, and a reconnect during that extension receives the same result with the actual extended hold.
- Repeated resync after a successful replay adds no duplicate event.
- At the actual hold deadline, the event is no longer retained.
- A quick admission does not repeat an unchanged early reveal.
- An early emitter failure is delivered by the normal admission pass.

`TableStateHub.replay.test.ts` additionally throws the initial replay send and verifies that the next resync delivers it once, with the replay counter increasing only after success. Existing backpressure, bounded retention, expiry and normal delivery tests remain green.

Verification on the isolated worktree:

- Root TypeScript check: passed, exit 0.
- Server TypeScript check: passed, exit 0.
- Eight server test files: 115 tests passed.
- Baseline failure logs: `/tmp/codex-sng-spin-reveal-baseline.log` and `/tmp/codex-sng-spin-replay-send-baseline.log`.
- Corrected run: `/tmp/codex-sng-spin-verified.log`.

```sh
cd server
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run \
  src/tournament/SpinRevealSettlementBoundary.test.ts \
  src/tournament/TheWheelFiresOnTheDraw.test.ts \
  src/tournament/SpinDrawIntegrity.guard.test.ts \
  src/tournament/SpinDrawReceipt.test.ts \
  src/tournament/SpinDrawReadback.test.ts \
  src/tournament/SpinStartsInOneSecondAndPlaysInFull.test.ts \
  src/transport/TableStateHub.replay.test.ts \
  src/transport/TableStateHub.test.ts
```

## Industry Comparison And Product Authority

The official [PokerStars Spin & Go product rules](https://www.pokerstars.com/poker/spin-and-go/), retrieved September 10, 2026, describe a three-player field, a prize draw after registration fills, and display of that prize to all players before play. The relevant engineering interpretation is one funded result shared before dealing. This comparison does not claim access to PokerStars' implementation or establish a universal technical standard.

PokerStars currently varies stacks and blind-level lengths by multiplier. Club Arena deliberately follows Dan's September 1 board rule: Turbo 300 chips, Deep Stack 1000 chips, with three-minute levels at every multiplier. That authorized difference remains intact. The previously completed [S09 every-tier acceptance](2026-09-10-phase3-spin-tier-acceptance.md) is not reopened or replaced.

The official [PokerStars tournament rules](https://www.pokerstars.com/poker/tournaments/rules/), retrieved September 10, 2026, describe disclosed structures and distinct cancellation policies. Their economic terms are a comparison source, not authorization to change Club Arena prices, rake, payout structures, or cancellation awards.

## Control Status And Limits

S08 now has reproduced failures and verified source corrections for reveal retention, emitter failure and failed replay delivery. It remains partial pending integrated first-deal/action-timer and browser acceptance plus production adoption. There is no assertion that every participant physically received a network frame merely because a socket accepted it.

S06 / AX09 retain the existing immutable draw and played-state proof evidence. This test uses controlled receipt and clock inputs, so it does not certify a real registration-to-draw transaction or an engine process crash before reveal. The PR #4096 played-hand-count parser correction (`02b267443`) was reviewed separately and is preserved by parent-branch integration; this patch does not touch it.

S01 / S02 / AX08 still need real final-seat admission, unregister and startup composition. S03 needs all supported SNG rules together. S04 / S05 / S07 still require their complete financial writer composition. S10 needs approved peak-exposure acceptance. S11 / AX10 cancellation and S12 finishing/action-order composition retain their separate acceptance gates.

No migration, production financial query, financial mutation, historical repair, deploy, push or merge was performed in this lane. Runtime production adoption is required before claiming the correction is shipped. The shared Phase 3 progress register is intentionally owned by the coordinating lane.
