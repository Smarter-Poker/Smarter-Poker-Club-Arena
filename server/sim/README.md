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
import { scenario } from '../framework.js';

export default scenario('turn bet clears on river', async (sim) => {
  // dealerSeat=1 -> SB=2, BB=3, UTG=4 (first to act preflop).
  await sim.startHand({ players: 4, stacks: 200, sb: 1, bb: 2 });

  // Preflop: everyone limps. Order: UTG -> BTN -> SB -> BB.
  await sim.act(4, 'call', 2);
  await sim.act(1, 'call', 2);
  await sim.act(2, 'call', 1); // SB completes
  await sim.act(3, 'check'); // BB checks

  // The engine deals the next street itself once the round closes — there is
  // no sim.deal(). Assert where you landed instead.
  sim.assert.stageIs('flop');
  await sim.act(2, 'bet', 10);
  await sim.act(3, 'call', 10);
  await sim.act(4, 'call', 10);
  await sim.act(1, 'fold');

  sim.assert.stageIs('turn');
  await sim.act(2, 'bet', 20);
  await sim.act(3, 'call', 20);
  await sim.act(4, 'fold');

  // River — assert bets have CLEARED from the felt.
  sim.assert.stageIs('river');
  sim.assert.currentPlayerSeatIs(2); // SB acts first on every postflop street
});
```

NOTE: `SimStartOptions.seed` is accepted but ignored — the deck is shuffled with
`secureShuffle` and is deliberately not seedable, so a scenario must not depend
on specific cards. Assert on structure (stage, turn order, bet display, pot),
not on holdings.

## Scenario catalog

CORRECTION 2026-08-20: this section used to list ten scenarios (`01-normal-hand`
through `10-hero-fold-card-dim`). Nine of them have never existed on disk. The
`sim.deal('flop')` call in the example above is not real either — `HandController`
advances the street itself once the betting round closes, so a scenario just
keeps calling `sim.act(...)`. Both were written as a plan and then read back as
a status. What actually exists:

- `02-turn-bet-clears-river.ts` — reproduces BUG 029: a turn bet must clear from
  the felt on the river.

Writing the other nine is open work. Until then, do not cite this directory as
covering split pots, side pots, bomb pots or auto-fold: it does not.

## Chip conservation

The property-based half of the simulator lives next to the engine rather than
here, because it has to run inside `npm test` (the Hetzner deploy gates on that
suite before it ships anything):

- `src/engine/HandFuzzer.ts` — drives `HandController` through complete
  randomized hands (all 7 variants, 2-9 non-contiguous seats, sitting-out seats,
  micro to deep stacks, antes, Big Blind Antes, straddles, bomb pots, dead
  blinds, post-BB entries, every rake shape, BBJ on and off) picking a uniformly
  random LEGAL action each turn, and asserting the chip-integrity invariants
  after every single mutation. All three all-in runout shapes are exercised:
  the instant `continueRunout()`, the paced per-street `dealNextStreet()`, and
  the run-it-twice shape where the caller distributes and
  `finalizeRunout(skipDistribution=true)` only reports.

  The invariants: chips are conserved against the table total (INV-1) and
  per player (INV-2); the side pots sum to the pot (INV-3) AND match an
  independent partition built from the rules rather than from the code under
  test (INV-10); settlement pays out exactly the pot less the rake and jackpot
  fee it reports taking (INV-4); every value is a whole cent and nothing is
  negative (INV-5); nobody invests more than they sat down with (INV-6); nobody
  is paid out of a pot they were not eligible for (INV-7); the rake gate agrees
  with the dealt board (INV-9); and the engine never offers an action and then
  refuses it (INV-LEGALITY) — which is what a player sees when a button they
  were given does nothing.

- `src/engine/ChipConservation.property.test.ts` — the vitest leg. ~11,000 hands
  per run: a fixed corpus that keeps a green build green, plus 1,000 hands from
  a fresh random seed so every CI run walks new ground.
- `sim/soak-conservation.ts` — the long soak. `npm run soak -- 2000000`.

A failure prints the invariant, the seed, and a full replay (config, hole cards,
board, every action), so it is reproducible from the message alone.

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
