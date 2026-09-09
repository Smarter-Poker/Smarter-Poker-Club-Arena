# 2026-09-08 — The pre-action executes without prompting, the BOMB POT! title clears the board, the add-on says how it adjusted, and the pot reads to the penny

Dan, 2026-09-04, four items with two screenshots (a 0.10/0.25 double-board bomb
hand, and hand #6206699's detail):

> "1. WHEN YOU CLICK THE FOLD BUTTON WHEN USING THE PRE ACTION BAR, TO CLICK
> FOLD, CHECK CALL WHAT EVER, IT STILL 'PROMPTS YOU' AND STARTS THE CLOCK FOR
> A SPLIT SECOND INSTEAD OF JUST EXECUTING THE PRE TURN ACTION YOU'VE
> SELECTED. THIS IS A GLITCH THAT NEEDS TO BE FIXED. 2. THE 'BOMB POT' THAT EXPLODES AND APPEARS ON THE TABLE, NEEDS TO BE
> HIGHER, IT COVERS THE BOARD WHILE DISPLAYING. 3. IF YOU ADD ON DURING A HAND, LIKE I JUST DID, AND YOU WIN THE POT, THE
> ADD ON NEEDS TO BE AUTO ADJUSTED. I ADDED ON FOR $49.95 BUT THEN WON THE
> VERY SMALL POT, MY ADD ON NEEDS TO ADJUST TO ONLY ALLOW FOR $49.95 -
> REMAINING CHIPS. THIS NEEDS TO BE A REAL TIME ADJUSTMENT. 4. FOR ALL SMALL STAKES GAMES .50/1 AND LESS THE POT SHOULD SHOW TRUE
> AMOUNTS... NOT ROUNDED UP. POT SHOULD SHOW 3.50 OR 6.80 OR WHAT EVER THE
> TRUE NUMBER IS IN THE SMALLER GAMES. IF THERE IS AN ANTE, THAT NEEDS TO BE
> 'TAKEN FROM THE PLAYER AND ADDED TO THE POT PRE FLOP'."

## 1. The pre-action prompt and clock flash

The engine executes an armed pre-action itself, after a deliberate visible
beat (`preActionVisibleMs`, 250ms since 2026-09-07) so it does not read as
instant to the table. But it
stamps a full turn deadline and broadcasts "hero is on the clock" BEFORE that
beat (`ServerTableEngineHandEvents` TURN_CHANGE, then
`ServerTableEngineTurns.handleTurnChange`). The 2026-08-29 fix
(`suppressPanelForPreAction`) hid exactly one of the surfaces that react to
that broadcast, the ActionPanel. The other seven kept announcing the turn for
the beat plus a round trip: the bell and the haptic (discrete TURN_CHANGE
event), the countdown ring on the hero's seat, the control strip's time-bank
button and ticking numeral, the time-bank tile in the HUD corner, the
`table-page--hero-turn` pulse and the bottom-bar reserve (`heroActionState`),
and the ActionClockWarning. That is the prompt-and-clock Dan sees for a split
second before the fold lands.

There is now ONE boolean, `heroPromptedToAct = isHeroTurnContext &&
!suppressPanelForPreAction`, and every surface reads it:

- `hudSlotControl` (time-bank tile), the page pulse class and the control
  strip read `heroPromptedToAct`; `isHeroOnTheClock` (ActionClockWarning)
  carries `!suppressPanelForPreAction`.
- `heroActionState`'s `'active'` arm carries `!suppressPanelForPreAction`,
  restoring its claim to be "character-for-character the ActionPanel
  branch's test".
- The hero's OWN seat withholds `isActive` and the deadline while
  suppressed. Every other player's screen still shows the seat on the clock
  for the beat, which is what keeps a pre-action from being a tell.
- The bell and the buzz: the TURN_CHANGE handler reads a ref mirror of the
  armed pre-action (`preActionArmedRef`; the discrete event runs outside
  render, so render state is stale there). With an arm it DEFERS through
  STATE (`turnAlertDeferred`; the snapshot lands before the discrete event,
  so a ref write would not re-run the effect) to an effect on
  `heroPromptedToAct`, which rings only if the hero ends up genuinely
  prompted - the engine refused the arm, or missed the grace window. A turn
  the engine takes for the player is never announced to the player.

The suppression is still bounded by the same grace window
(`PRE_ACTION_EXEC_GRACE_MS`) and the same honorability rule, so a refused or
lost pre-action still prompts the player before the clock costs them
anything.

Pins moved with the mechanism in `tests/unit/preActionPanelGate.test.ts`
(new: every surface pinned to `heroPromptedToAct` by name) and
`tests/all-in-cannot-leave-and-the-hud-slot.test.ts`.

## 2. The BOMB POT! title covered the board

`.bpo-title-block` was pinned at `top: 42%` of the VIEWPORT. The community
area sits at 42.5% of the FELT and the bomb's flop deals the moment the
explosion finishes, which is when the title arrives and holds for 3.2s. So
the largest text on the screen sat on the cards for as long as it was up, on
every bomb hand.

No viewport percentage fixes it: the felt is edge-to-edge on a phone and a
324px island on a laptop. `BombPotOverlay` now measures the felt the instant
the title phase renders (`useLayoutEffect`, so no fallback frame is ever
painted): the ceiling is the highest of the pot pill, its chip pile and the
board; the floor is the lowest top seat above that ceiling; the block stands
with its bottom edge `TITLE_GAP_PX` above the ceiling, and scales down from
its bottom edge (never below `TITLE_MIN_SCALE`) when the band is shorter
than the block, rather than climbing onto the seat plates. The lookup is
scoped to the overlay's own `.table-page`, so a hidden multi-table sibling
(zero-size rects) is never the anchor. The fallback for an unpainted table
is `top: 22%` - above the board, not on it.

Measured in the felt harness with the real stylesheets: 390x844, block
172-269 against a pot top of 279 (scale 1); 1280x800, block 185-257 against a
pot top of 267 (scale 0.74, the laptop band is 46px). Unit-tested in
`tests/unit/bombPotTitleAboveTheBoard.test.ts`, source-pinned in
`tests/unit/bombPotGuards.test.ts`.

## 3. The add-on that "did not adjust"

It did. Read from the ledger (`table_pending_addons` row `cd60239c`, kingfish,
2026-09-04 23:15 UTC): 49.95 requested mid-hand, resolved ten seconds later
as **applied 48.88, refunded 1.07** - exactly 50.00 less the 1.12 stack the
pot left him with. `resolve_pending_addon` caps every landing at the max
buy-in less the stack AS IT STANDS AFTER THE POT and returns the rest to the
wallet, and it has since 2026-08-26. What was missing was everything around
it:

- **Nobody told the player.** The refund reached a `console.log` on the
  engine box. The client had debited its displayed balance and its session
  buy-in total by the full 49.95 at request time, so P&L read low by the
  refund for the rest of the session and the wallet figure was wrong until
  the next real read. New private frame `add_on_adjusted` (via
  `hub.sendToUser`, the same channel as hole cards and the engine's
  pre-action copy) carries `requested`, `applied`, `refunded`, sent whenever
  `refunded > 0` on either resolve path (the lease-receipt path and the
  legacy sweep). The client corrects the balance, the session buy-in total
  and `sessionStatsService`, and toasts "Add-On Adjusted: 48.88 Added, 1.07
  Returned To Your Wallet. Your Stack Is At The Table Maximum." (or
  "Add-On Returned ..." when nothing landed).
- **The queued toast now names the amount and the rule** - "49.95 Lands When
  This Hand Ends. If The Pot Puts You Over The Table Maximum, The Difference
  Returns To Your Wallet." - so the later adjustment resolves something the
  player was told to expect.
- **`addChips` counted queued chips against the cap only while
  `handController` was set.** Settlement nulls the controller BEFORE step 8e
  resolves the ledger, so a request in that window (the auto top-up fires
  there; its gate is the early `hand_complete` broadcast) was sized as if the
  queued add-on did not exist, applied straight to the seat, and the sweep
  then refunded the add-on that was queued FIRST. The cap now counts
  `pendingAddOns` in both branches.
- **The auto top-up toast printed the REQUESTED amount and "Added"** even
  when the engine had capped or queued it ("Auto Top Up: Added 0.85" beside
  "Your Chips Land When This Hand Ends" for one request). It reads the
  actual result now.

`server/src/engine/AddOnAdjustsItself.test.ts` proves the cap in both
branches and the frame's contents.

## 4. The pot pill rounded, and the ante had no presentation

`PotDisplay`'s local `formatAmount` was `Math.round(amount)` for anything
from 1 up: 5.10 of bomb antes read "POT 5", 1.50 of blinds and antes read
"POT 2", while the chip pile under the pill (exact, from
`chipDenominations.ts`) disagreed with the digits on every micro-stakes
hand. At a big blind of 1 or under (`SMALL_STAKES_BB_MAX`) the pot reads to
the penny with two places, always - 3.50, not 3.5, so the pill does not
jitter through the count-up. Above that, `formatTableChips`' contract:
integers clean, a real fraction kept, never a rounded magnitude. Pinned in
`tests/chips-on-the-felt.test.tsx`.

The ante was already IN the pot preflop: `HandController.postBlinds` adds a
regular ante straight to `state.pot`, not to the player's street bet, so the
pill (`pot - streetBets`) counted it from the first snapshot. What the table
never showed was the chips going: `BLINDS_POSTED` carries only the SB and BB
by design, and a bomb ante flies at the blast, but a plain ante just made
every stack smaller and the pot bigger with nothing in between. The engine
now emits `antes_posted` (from the `FORCED_BETS_POSTED` handler, `kind ===
'ante'` rows only) and the client flies each ante to the pot with the same
`createChipToPotEvent` the bomb ante uses, the moment they post. Presentation
only; the money was already right. Pinned in `bombPotGuards.test.ts`.

## Sweep after merge (PR #3870 -> PR #3880 -> this branch)

Dan: "DO A FINAL SWEEP AND CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
REGRESSIONS OR WIRING ISSUES", then "DO A SECONDARY DEEPER SWEEP AND DIVE."
Three independent adversarial reads (server/money, client/React,
tests/docs) over the merged commit and the follow-up. Everything below is
fixed on this branch.

### The one that mattered: the pre-action fix was dead on the wire

`handleTurnChange` consumes the armed pre-action synchronously at its top -
BEFORE the visible beat, BEFORE the snapshot that puts the hero on the clock,
BEFORE the discrete `turn_change`. `PreActionEngine` emits
`PRE_ACTION_EXECUTED` right there, and since 2026-09-04 the engine pushed its
(now empty) copy to the hero at once, as a private frame. So the hero's
client received "nothing armed" a frame AHEAD of the turn: the bar disarmed,
`awaitingPreActionExec` was false, `suppressPanelForPreAction` was false, and
every surface - bell, ring, clock, panel, tile, pulse, tab badge - fired for
the beat plus a round trip, and then the fold landed. Both the 2026-08-29
suppression and the #3870 gate were correct on paper and had nothing to key
on in practice. That is Dan's glitch, still live after two fixes.

- **Engine**: no push on `PRE_ACTION_EXECUTED`
  (`ServerTableEngineBase`). The executed action clears the client's arm when
  it lands (`heroLastAction`). Every OTHER empty push carries its reason:
  `invalidated` (a bet under an armed Check), `cleared` (the player, or a new
  hand), `rejected` (pushed explicitly from `handleTurnChange`'s fallthrough
  when `performAction` refuses, so the player is prompted at once rather
  than at the end of the grace window), `resync` (RESYNC re-send,
  authoritative). Note: the early returns after the beat (hand replaced,
  seat moved) push nothing; the client's arm is then cleared by the
  street/hand reset, as before.
- **Client**: an empty frame with NO reason can only be the execution push
  of an older engine; it is held while an arm is up, bounded by the grace
  window. `PreActionBar` stays mounted through the beat
  (`suppressPanelForPreAction` in its gate) so the pressed button stays
  pressed instead of an empty strip between "armed" and "unarmed";
  `heroActionState` holds `'waiting'` through the beat instead of `'none'`
  (which collapsed the bottom chrome to 1px). The deferred bell is STATE
  (`turnAlertDeferred`), because the snapshot lands before the discrete
  `turn_change` and a ref write cannot re-run the effect. The multi-table
  reporting effect (tab badge, soft ping, dock countdown, Notification)
  reads `heroPromptedToAct`; the whole gate moved ~14,000 lines up, above
  that effect, because a const cannot be read before its declaration.
  `server/src/engine/PreActionPushDoesNotOutrunTheTurn.test.ts` drives the
  real `PreActionEngine` and fails on any of it reverting.

### The add-on, all the way through

1. **`add_on_applied` / `add_on_adjusted` were dead on production.** Every
   cash engine is lease-verified, so a mid-hand add-on is frozen into the
   hand's post-commit envelope and resolved inside
   `fn_ca_process_hand_post_commit_obligations`, which returns a COUNT.
   `processPendingAddOns` - the only emitter of both - runs on that path only
   for unbound rows before the next deal. New
   `announceEnvelopeResolvedAddOns` runs from settlement after the
   obligations land: reads the frozen ids from
   `hand_atomic_commits.post_commit_payload` and the resolved rows from
   `table_pending_addons` (both reads verified against production over
   PostgREST, read-only), emits the bubble per landed row and the private
   frame per reduced row. Gated on the RPC's own `pending_addons` count (0
   and an empty cache spend no read; tournaments never do; an absent count
   reads to find out), lease-fenced after every await, best effort - a
   failed read is reported, never thrown. Pinned from the settlement side in
   `PostCommitObligationBarrier.guard.test.ts` so deleting the call is red.
2. **A float reached the ledger and would have wedged a table.** `applied`
   was `Math.min(amount, maxBuyIn - stack)` unrounded (50 - 33.33 =
   16.670000000000002) and `atomic_table_addon` stores it verbatim: 49 such
   rows on production, ~2 a day. `resolve_pending_addon` returns
   `ROUND(applied, 2)` / `ROUND(refunded, 2)`, and the obligation check that
   went live on 2026-09-08 (`20260908175113`) refuses a receipt where
   `applied + refunded <> amount` - deterministically, so settlement would
   retry every 5s until the lease died and the table never dealt again. No
   unrounded row was open at the time of the fix. `addChips` rounds to the
   cent; so does `confirmBustRebuy` at the wire (its modal already did).
3. **The cap cache double-counted a landed add-on between hands.** The
   envelope path refreshed `player.stack` and left `pendingAddOns` alone, so
   `stack + pending` counted the same chips twice and refused a legitimate
   top-up as "already at the maximum". `rebuildPendingAddOnCache` rebuilds
   it from the rows still unresolved - after the envelope, and on engine
   start (`resolveOrphanedAddOns`; a restart with a frozen-but-unresolved
   row otherwise sized the next top-up as if the queued one did not exist).
   A rebuild overtaken by a concurrent mid-hand `addChips` (sweep generation
   moved under the read) is discarded; the sweep it asked for rebuilds.
4. **The client could apply the refund correction twice, or to a session
   that never made the debit.** The USER_EVENT effect re-runs when
   `handleHoleCardPayload` changes identity with the same frame in state;
   `onResync` fires on EVERY connect, not only a seq-gap RESYNC. Gated on
   frame identity, on the ledger row id (`pending_id`, on the frame), and on
   `queuedAddOnsThisMountRef` - only a mount that itself queued a mid-hand
   add-on (and debited its own figures) credits the refund; a reloaded page
   is told, never credited. A capped bust REBUY (`atomic_table_rebuy`
   directly, never debited client-side) is told, not adjusted.
5. **The frame is retained ONLY while undelivered** (`sendToUser` found no
   socket), delivered once on the next connect, then forgotten; dropped on
   leave. Retaining a delivered frame greeted the player on every reload
   until the hourly restart.
6. **Auto top-up**: "already at the maximum" is a silent no-op remembered per
   hand (it cannot see a queued add-on that already fills the seat, and the
   effect re-runs on every snapshot); a queued auto top-up is announced once
   (by `handleAddChips`), not twice; the success toast prints what landed.

### Smaller

- `BombPotOverlay` measures `offsetHeight`, not its own scaled rect, so a
  resize while the title is up cannot climb back onto the seats; the
  geometry lives in `src/lib/bombPotTitleAnchor.ts` (a component file
  exports only its component).
- `ANTES_POSTED` no longer stacks a second chip click on `BLINDS_POSTED`'s.
- The chip-flight label (`ChipAnimation`) squared off anything from 1 up
  (a 2026-08-14 rule against engine sub-chip noise, which #3358 has since
  removed at the source), so a 1.50 ante flew to the pot as "2" while the
  pill read "1.50". To the cent, two places when there are cents.
- A comment claimed a 900ms beat; it is 250ms.

Left as is, on purpose: hotkeys during the beat (engine dedupes; harmless),
and `lastAddChipsResultRef` being shared by manual and auto top-ups
(overlapping requests are not a real path).

## Verified

- `npx tsc --noEmit` clean (client and `server/`).
- Full client suite (`npx vitest run`) and full server suite
  (`cd server && npx vitest run`) green on the sweep branch, including the
  new `PreActionPushDoesNotOutrunTheTurn`, `AddOnAdjustsItself`,
  `bombPotTitleAboveTheBoard`, and the moved pins in `preActionPanelGate`,
  `reconnectIsAnEvent`, `all-in-cannot-leave-and-the-hud-slot`,
  `a-top-up-is-charged-once.law`, `bombPotGuards`.
- The two PostgREST reads the announcer issues were run against production
  (read-only, service role) and returned the expected shapes.
- Felt-harness screenshot of the title block at 390x844 and 1280x800
  (scratch, not committed).
