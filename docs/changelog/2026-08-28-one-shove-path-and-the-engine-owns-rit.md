# One shove path, and the engine owns Run It Twice

Dan: "GO AHEAD AND FULLY BUILD ALL OF THESE."

This closes the item I had twice deferred as "a behaviour question". It was —
until I traced it far enough to find that one of the two behaviours was a legacy
duplicate that could not work.

## 1. The client had a second, broken door into the RIT panel

`handleInsuranceDeclineForHand` ended with:

```ts
if (ritOpponent !== 'Opponent') {
  setShowRIT(true);
}
```

`ritOpponent` is the **name displayed on the consent panel**. It was doubling as
a control flag, and the panel it opened had none of the context a RIT panel
needs:

- the countdown reads `ritDeadlineRef.current`, which the hand-boundary reset
  had just set to `0`, so it appeared **already expired**;
- `ritIsChooser`, `ritMaxRuns` and `ritPlayerCount` were **stale from an earlier
  hand**;
- and its Accept / Decline / choose-runs buttons all call
  `respondToRIT(tableId, …)` — **POSTing a response to the engine for an offer
  that does not exist.**

**The engine is the authority and always was.** `handleAllInRunout` broadcasts
`rit_offer` — `server/src/engine/RunItTwice.offerpath.test.ts` pins it: _"THE
OFFER FIRES: a 2-way all-in on a RIT cash table emits rit_offer"_ — and the
`eventType === 'rit_offer'` handler in TablePage sets chooserId, the real
deadline, maxRuns, playerCount and isChooser before opening the panel on a
deliberate 1500ms cadence.

I checked that the engine emits the event **before** deleting the client door.
Removing it otherwise would have removed RIT entirely.

## 2. Two shove paths that had drifted in both directions

The comment sitting directly above `handleAllIn` reads: _"Two copies of a
money-moving path, one of them unreachable, is how they drift."_ It was written
about `handleConfirmRaise`. The same sentence applied, unnoticed, to the function
immediately below it.

|                                    | ALL IN button — `handleActionPanelAction('allin')` | `A` key — `handleAllIn` |
| ---------------------------------- | -------------------------------------------------- | ----------------------- |
| counts VPIP / PFR                  | **yes**                                            | no                      |
| armed the legacy client RIT prompt | no                                                 | **yes**                 |

So a keyboard shove under-counted the player's own HUD stats, and whether a later
insurance decline opened a RIT panel depended on **which control you shoved
with**. Until 2026-08-28 pressing `A` ran _both_ functions and which won depended
on listener registration order.

`handleAllIn` is deleted. `onAllIn` runs `handleActionPanelAction('allin')` —
the button's function. Everything that mattered is already in that path: the
debounce lock, `validateAndExecuteAction('allin')`, the all-in sound,
`setIsAllInMode(true)`, the optimistic update and revert-on-refusal. **The only
behaviour removed is the drift.**

## The test that pinned the old behaviour

`tests/unit/ritArmingDoesNotOutliveTheHand.test.ts` asserted the
`ritOpponent !== 'Opponent'` gate still existed — a sanity check I had added one
commit earlier specifically so the file could not pass vacuously if the gate were
renamed. Deleting the gate made it fail, correctly, and it is **rewritten in this
same commit** rather than deleted:

- there is **no** client-side open gated on the display string;
- the engine's `rit_offer` handler **still exists** — the reason removing the
  client door is safe, and the assertion that fails loudly if RIT ever loses its
  only remaining way in;
- `ritOpponent` is still reset at the hand boundary (it is a display string
  again, but it is still per-hand state);
- `onAllIn` routes through `handleActionPanelAction('allin')`;
- no `const handleAllIn =` exists;
- and the surviving path still validates, sets all-in mode and applies the
  optimistic update — so the delete removed drift, not behaviour.

Both mutations caught:

```
MUTATION: put the client-side RIT open back        -> 1 failed | 5 passed
MUTATION: point A back at a parallel handleAllIn   -> 1 failed | 5 passed
restored                                           -> 6 passed
```

## Results

```
npx tsc --noEmit        TSC=0
npx vitest run tests/   523 files, 8138 tests, 0 failed
```
