# A stale runout cannot reach the next hand

2026-08-31. Root cause and fix for the rake-law alarm's `no_flop_no_drop`
criticals (#2267 stopped the money; this stops the corruption).

## The race, step by step

1. Hand N parks in an all-in runout. The insurance / run-it-twice / paced
   cascade that resumes it is built of sleeps, 20-second offer windows,
   `.catch` handlers and safety timers.
2. Hand N dies (watchdog, void, abnormal end). `dealHand` for hand N+1
   assigns `this.handController = new HandController(...)` and then AWAITS
   `fetchTimeBankExtras` — a database read — before it subscribes the event
   listener or calls `start()`.
3. A stale continuation from hand N fires in that window.
   `safeContinueRunout` read `this.handController` bare — no identity check —
   and so did `dealNextInsuranceStreet` and `runInsurancePerStreetFlow` after
   every sleep. The continuation ran the FRESH, UNSTARTED, LISTENER-LESS
   controller out: five phantom board cards dealt into the void (no listener,
   so `hand_history.community_cards` stayed empty), `sawFlop` set true,
   `transitionStage('showdown')`, and a pot-0 completion emitted to nobody.
4. `start()` then posted blinds into the corpse — it never reset the stage —
   and the hand PLAYED there. `performAction` does not gate on stage;
   `advanceStage`'s switch has no `'showdown'` case, so no street could ever
   deal and the turn pointer simply kept rotating, which is why big blinds
   are on record folding uncontested pots and why every recorded action
   carries `stage: "showdown"` where the same table's clean hands say
   `"preflop"`. The only way such a hand ends is everyone folding to one
   player, and that settlement priced rake on `sawFlop = true`: 10% of a pot
   that never saw a card, 5% heads-up. 32 live hands, 12.51 chips, every one
   preceded on its table by a big all-in runout pot.

## The fix, both halves

**Engine (ServerTableEngineRunout):** every continuation now names its hand.
`safeContinueRunout(reason, controller)` drops and reports a continuation
whose controller is no longer live (`stale_runout_dropped`);
`runInsurancePerStreetFlow` and `dealNextInsuranceStreet` carry the
controller as a parameter and re-check IDENTITY — not null-ness — after every
sleep; `handleAllInRunout` anchors `controllerAtPark` for the cascade it
spawns; the RIT/insurance wait helpers pass their existing `controllerAtOffer`
anchors into the catch paths that previously re-read the field.

**HandController (the authoritative backstop):** the runout entry points —
`continueRunout`, `dealNextStreet`, `finalizeRunout`, `markFlopSeen`,
`settleUncalledBet` — exist for exactly one situation: the hand has started
and betting is over because at most one live player can still bet. Any other
caller is refused and reported (`stale_runout_refused`). Whatever engine path
goes stale next, now or in a future refactor, it lands here as a loud no-op
instead of a corrupted hand. And `start()` refuses to start dirty: a
controller found at the wrong stage / with `sawFlop` set / holding board
cards before start is reset to a blank preflop hand and reported
(`dirty_start`).

Defense in depth, bottom to top: the anchors stop the stale call, the runout
guard stops any unanchored caller, `dirty_start` cleans up anything that
slips past both, and #2267's board-corroboration in `priceDeductions` (with
its `financial_alerts` critical from #2295) still refuses the money if all
three somehow fail. The rake-law alarm remains the independent check that
measures the engine from outside.

## Pins

`HandController.staleRunout.law.test.ts` — seven pins: the exact production
race (continueRunout pre-start) is a no-op that deals nothing, sets nothing
and completes nothing; the hand dealt afterwards plays clean and pays no rake
on a walk; `finalizeRunout` and `dealNextStreet` mid-betting are refused;
`markFlopSeen`/`settleUncalledBet` pre-start are refused; a REAL all-in
runout still runs out and still rakes; a corrupted pre-start controller is
reset by `start()`.

Two existing files drove `dealNextStreet`/`markFlopSeen` directly on hands
with live betting — legal before this change, exactly the stale shape after
it. `PineappleThreeCardShowdown.test.ts` and the `markFlopSeen` pin in
`HandController.noFlopNoDrop.law.test.ts` now establish the all-in state
those paths actually run in; their assertions are unchanged.

Server suite: 3282 passed, 291 files. `tsc --noEmit` clean.
