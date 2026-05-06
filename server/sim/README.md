# Club Arena — Engine Simulator

Deterministic, in-process harness for reproducing and regression-testing hand-lifecycle
bugs. No Docker, no Hetzner SSH, no Supabase round-trip. Runs in milliseconds.

## Why

Poker is a state machine with 6 streets × N players × M events. Testing on a live
production table surfaces bugs slowly and unreliably. The simulator:

- Instantiates `HandController` + `ServerTableEngine` IN-PROCESS
- Seeds the deck so every run is deterministic
- Records every emitted `HandEvent`
- Pipes every published snapshot through the REAL client mapper (`src/utils/mapEngineSnapshot.ts`)
- Asserts on the exact state the UI would render, at every step

Every bug Dan reports becomes a scenario. Once fixed, that scenario is a regression guard.

## Run

```bash
cd server
npm run sim                           # runs all scenarios
npm run sim -- scenarios/02-turn-bet-clears-river.ts   # single scenario
npm run sim -- --verbose              # dumps every emitted event + snapshot
```

## Writing a scenario

A scenario is a TypeScript file that exports a `Scenario`:

```ts
// scenarios/02-turn-bet-clears-river.ts
import { scenario } from '../framework';

export default scenario('turn bet clears on river', async (sim) => {
  await sim.startHand({ players: 4, stacks: 200, sb: 1, bb: 2, seed: 0xc0ffee });

  // Preflop: all limp
  await sim.act('seat3', 'call', 2);
  await sim.act('seat4', 'call', 2);
  await sim.act('seat1', 'call', 1); // SB completes
  await sim.act('seat2', 'check'); // BB checks

  // Flop
  await sim.deal('flop');
  await sim.act('seat1', 'bet', 10);
  await sim.act('seat2', 'call', 10);
  await sim.act('seat3', 'fold');
  await sim.act('seat4', 'fold');

  // Turn
  await sim.deal('turn');
  await sim.act('seat1', 'bet', 20);
  await sim.act('seat2', 'call', 20);

  // River — assert bets have CLEARED from the felt
  await sim.deal('river');
  sim.assert.lastBetAmountsAllZero(); // no turn bet bleed
  sim.assert.currentPlayerSeatIs(1); // seat1 (OOP) acts first
});
```

## Scenario catalog

- `01-normal-hand.ts` — 4 players, preflop raise, 1 caller, flop check-check, turn bet-fold.
- `02-turn-bet-clears-river.ts` — reproduces BUG 029: turn bet must clear on river.
- `03-winner-banner-no-bleed.ts` — reproduces BUG 030: hand-strength label must clear
  before next pot renders.
- `04-blinds-to-pot.ts` — SB + BB must appear in `pot` in the SAME snapshot that shows
  the blind stacks decremented.
- `05-hero-action-every-street.ts` — hero OOP on every street, must not be skipped.
- `06-auto-fold-preserves-seat.ts` — reproduces BUG 028: engine auto-fold on time-bank
  expire must not remove player from players[] (client must keep seat).
- `07-split-pot.ts` — tie on the river, pot splits evenly.
- `08-side-pot-all-in.ts` — 3 players, short stack all-in, two others contest side pot.
- `09-bomb-pot.ts` — bomb pot triggers every N hands, skips preflop betting.
- `10-hero-fold-card-dim.ts` — hero folds; hole cards must dim but NOT disappear.

## How it works

```
┌────────────────┐   events   ┌────────────────┐  snapshots  ┌────────────────┐
│ HandController │ ─────────> │ SimEventLogger │ ──────────> │ mapEngineSnap  │
│ (server code)  │            │ (records all)  │             │ (client code)  │
└────────────────┘            └────────────────┘             └────────────────┘
                                                                       │
                                                                       v
                                                            ┌────────────────┐
                                                            │ sim.assert.*   │
                                                            │ (asserts on    │
                                                            │  mapped state) │
                                                            └────────────────┘
```

We bypass `ServerTableEngine` (which wraps HandController with DB + WebSocket) and
drive `HandController` directly for speed. Scenarios that test WebSocket protocol
specifics (`07+`) can switch to `ServerTableEngine` mode.
