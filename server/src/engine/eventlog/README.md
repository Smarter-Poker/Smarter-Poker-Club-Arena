# Event-Sourced Hand Engine (Keystone Upgrade #1 — FOUNDATION)

Deterministic, replayable, event-sourced model for a single Club Arena hand.

**Status: built + unit-tested, but NOT yet wired into the live engine (by design).**
These are new, self-contained modules. No existing engine file was touched.
Wiring `ServerTableEngine` is a sequenced, mechanical follow-up (owned by another
agent). Everything here is proven in isolation by `*.test.ts`.

## Modules

| File                          | Purpose                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.ts`                   | Typed, versioned event union for a hand's full lifecycle (`HandStarted`, `BlindsPosted`, `HoleCardsDealt`, `PlayerActed`, `StreetAdvanced`, `ShowdownRevealed`, `PotAwarded`, `HandEnded`). Every event carries `seq` (monotonic), `ts` (passed in, never generated in pure code) and `v` (schema version). |
| `HandReducer.ts`              | Pure, deterministic `apply(state, event) -> state` and `replay(events) -> finalState`. No I/O, no `Date.now`, no `Math.random`. The only "randomness" is deriving the deck from the event's `seed` via an injectable shuffle fn (`deriveDeck` / `defaultShuffle`, a seeded Fisher–Yates).                   |
| `ChipConservationVerifier.ts` | Asserts on **every** event that `Σstacks + Σbets + pot + rake == initial buy-in total` — the invariant `StateVerifier` lacks (it only checks Σstacks between hands and excludes bets). Returns violations with the exact offending event.                                                                   |
| `EventLog.ts`                 | Append-only in-memory log + `EventSink` durability interface, an `InMemoryEventSink`, and a stub `SupabaseEventSink` that batches inserts into `hand_events`.                                                                                                                                               |
| `ShadowRecorder.ts`           | The SAFE integration path — record events alongside the live engine with **zero behavior change**, then at hand end replay + verify + report any divergence from the engine's actual final state.                                                                                                           |
| `testFixtures.ts`             | Shared example-hand builders for the tests (not production code).                                                                                                                                                                                                                                           |

## Chip model (important)

This foundation uses the classic poker chip model, which differs from the legacy
`HandController`:

- `bet` = live wager on the felt for the **current street**.
- `pot` = chips already **swept** from prior streets.
- Bets are swept into the pot on `StreetAdvanced` / `PotAwarded`.

This makes the target invariant hold literally:
`Σstacks + Σbets + pot + rake == initial buy-in total` at all times.
(Legacy `HandController` increments `pot` immediately on each action, so `bet` is
a subset of `pot` there — which is exactly why `StateVerifier` had to exclude
bets. When wiring, map the engine's milestones into these events; do not copy its
pot accounting.)

## ShadowRecorder wiring plan (the ~8 `record()` calls)

Wire in `server/src/engine/ServerTableEngine.ts` (line numbers from the
2026-07-24 revision, indicative). Create one `ShadowRecorder` per hand, seeded
with the same deck seed `HandController` uses.

| #   | Location in `ServerTableEngine.ts`                                                     | Call                                                                                           |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `startHand()` right after `new HandController(...)` (~L2478)                           | `recordHandStarted({ seed, handNumber, buttonSeat, players, stakes })`                         |
| 2   | `handleHandEvent()` case `'BLINDS_POSTED'` (~L2616)                                    | `recordBlindsPosted(postings)`                                                                 |
| 3   | `handleHandEvent()` case `'CARDS_DEALT'` (~L2636)                                      | `recordHoleCardsDealt(cardsPerPlayer, hands)` (aggregate per-seat deals, or one call per seat) |
| 4   | `handleHandEvent()` case `'PLAYER_ACTION'` (~L2726)                                    | `recordPlayerActed(seat, action, amount)`                                                      |
| 5   | `handleHandEvent()` case `'COMMUNITY_CARDS'` (~L2770)                                  | `recordStreetAdvanced(street, board)`                                                          |
| 6   | `handleHandEvent()` case `'SHOWDOWN'` (~L2826)                                         | `recordShowdownRevealed(reveals)`                                                              |
| 7   | `handleHandEvent()` case `'WINNERS'` (~L2860)                                          | `recordPotAwarded(payouts, rake)`                                                              |
| 8   | `onEvent` closure, case `'HAND_COMPLETE'` before `this.handController = null` (~L2547) | `recordHandEnded(handNumber)` then `finalize(actualFinalState)`                                |

The engine already emits all eight milestones through its `HandEvent` union, so
each is a one-liner inside an existing `switch` case. The recorder swallows all
errors and never mutates engine state, so the shadow path cannot change gameplay.

## Follow-up steps (not in this foundation)

1. Wire the 8 calls above (mechanical).
2. Apply `supabase/migrations/011_hand_events.sql` and pass a real Supabase
   client into `SupabaseEventSink`.
3. Run in shadow mode; alert on `DivergenceReport.ok === false`.
4. Once divergence is consistently zero in production, flip to driving state
   FROM the events (source of truth), retiring the parallel path.

## Tests

```
cd server && npx vitest run src/engine/eventlog
```

Covers: full example hand replays to the correct stacks; conservation holds after
every prefix; overpaid/underpaid `PotAwarded` corruption is caught with the
offending event; determinism (same events -> identical state twice, incl.
seed-derived decks); reducer purity; ShadowRecorder divergence detection; and the
`SupabaseEventSink` batching.
