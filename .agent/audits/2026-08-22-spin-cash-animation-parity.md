# Spin / cash animation parity — the full audit

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena
**Brief (Dan):** the Spin path must be a true 1:1 clone of every cash-game animation.
**Tests:** `tests/config/spinAnimationParity.test.ts` (16), two new beats in
`tests/e2e/live-animations.spec.ts`

This is the end-to-end audit that handoff item 9.1 asked for and that had never
been done. It is written so the next person does not have to redo it.

---

## 1. The good news, established first

**Spin and cash render through one component tree.** There is no tournament
table page. `src/App.tsx` claims `/table/:tableId` with a component that returns
null; the real surface is `MultiTablePage` mounted beside `<Routes>` in
`PersistentTableLayer`, and it mounts one `TablePage` per tab. A Spin tab and a
cash tab are the same component.

So the core hand loop is shared **by construction**, not by discipline. These
files contain not one mention of a tournament, verified by grep and now pinned
by a test:

    DealAnimation · CommunityCards · PotDisplay · ChipPhysics · ChipStack
    ChipAnimation · PlayerCard · CardImage · HandReveal · ActionPanel
    PreActionBar · TimerBar · CircularTimer · RunItTwice · InsuranceModal
    RabbitHunt · BombPotOverlay · avatarChoreography
    useTableAnimations · useTableSound · useTableTimer · useTableSession
    useAnimationQueue

Deal, chip flight, board reveals, pot collection, showdown flips, winner pops,
muck, all-in theatre and the 3-max seat ring (`tableSeatGeometry.ts`
`SEAT_LAYOUTS[3]`) are identical at a Spin. The divergences were not in the hand
loop. They were four conditionals and two unhandled events.

---

## 2. Fixed

### 2.1 Every Spin resolved the player's MTT theme

`TablePage.tsx` called `useUserThemeSettings(userId, gameType, isTournament,
undefined)` under the comment _"tournamentType resolved internally from
gameType"_. That comment is false — `getThemeGameType` has no other source for
it, and its tournament branch is:

```ts
if (isTournament) {
  if (tournamentType === 'sng' || tournamentType === 'spin') return 'SNG';
  return 'MTT';
}
```

With `undefined` passed, the first branch could never be taken. **Every
tournament, Spin included, resolved the `MTT` theme row.**

This is the highest-impact item in the audit and the least obvious. `v8Theme`
drives the felt skin image, the background layers, the card back, and four
`data-*` attributes on the table root (`data-felt-theme`,
`data-background-theme`, `data-button-theme`, `data-theme-preset`). Any CSS
keyed off those resolves differently. A Spin did not merely miss a preference —
it rendered a different table from the one the player had set up.

Fixed by passing `tournamentFormat`, and by teaching the hook to **wait** rather
than guess while the format is still resolving. Guessing would have painted the
MTT felt for one render and swapped it under the player a moment later.

### 2.2 The sub-10bb warning did not run in tournaments

`SeatSlot.tsx` applied the stack-depth class only when `showStackInBB ||
!isTournament`. `seat__stack--critical` carries `stackCriticalPulse 1.5s
infinite`. A hyper-turbo Spin is the single format where a sub-10bb stack is the
normal state of affairs, and unless the player had toggled "show stack in BB"
the warning was suppressed exactly there. A cash table at 8bb pulsed; a Spin at
8bb sat still.

### 2.3 The seat-first Spin's open seats were not seats

`SeatSlot` short-circuited **before** `canSit` was consulted:

```ts
if (!player) {
  if (isTournament) {
    return <div className={containerClasses} aria-label={`Seat ${n}: empty`} />;
  }
```

Harmless at an MTT, where seats are assigned. Not harmless at a Spin. A
seat-first Spin sells its three seats by the click — `TablePage` wires
`onSit -> handleSeatClick -> fn_take_seat_and_buy_in`, and the footer reads
**"Spectating, Tap An Open Seat To Join"**. Those seats carried no label, did
not breathe (`emptyPulse` lives on `.seat--empty::before`, and the bare div had
neither class), and had no click handler. **The instruction on screen could not
be followed.**

This is the one item that is not really an animation bug. It was found by
auditing animations.

The distinction that matters is not tournament-ness but whether the seat can be
taken, which `canSit` already expresses. `TablePage` now includes seat-first in
it, and `SeatSlot` no longer branches any visual on `isTournament` at all — a
seat that cannot be taken still falls to the passive EMPTY marker, whose CSS
already suppresses the pulse. Side effect, deliberate: MTT empty seats now read
"EMPTY" instead of rendering blank.

### 2.4 The two beats after the wheel were never animated

`server/src/tournament/TournamentManagerBase.ts::scheduleSpinPostReveal` exists
solely to choreograph Dan's sequence — _"AFTER THE SPIN COMPLETES, CHIP STACKS
GET ADDED, BUTTON RANDOMLY ASSIGNED AND THE SPIN STARTS!"_ — and says so:

> Three beats, each with its own broadcast **so the client can animate them
> rather than discovering them in a state diff**

It broadcasts `spin_chips` at reveal-end and `spin_button` 900ms later, and
holds the deal 1.8s for them. **The client had no `case` for either.**
`SPIN_REVEAL.CHIP_DROP_MS` and `BUTTON_DRAW_MS` had zero consumers in `src/`.

The chips and the puck did still appear — whenever the next snapshot happened to
land. So the beats existed on the engine's clock and nowhere on the player's,
and 1.8s of deliberate room went to dead air.

Both are handled now. Neither handler invents anything: each writes the value
the engine has already committed, on the instant the engine chose, and lets the
animations that already exist run — the stack diff drives `stackBounceUp` /
`stackDeltaFloat` / `seatStackGlow`, and the button seat mounts
`.seat__position-chip`, whose `dealerButtonAppear` is a mount animation. A
dropped event costs the choreography and nothing else, because the snapshot
behind it carries the same values.

The button seat is **not** drawn client-side. The engine picks it at random —
deliberately, because the old `sortedSeats[0]` default handed a positional edge
to whoever clicked first in a seat-first format — and a second opinion here is
how two players would see two different buttons.

---

## 3. Differences left alone, and why

Parity does not mean identity. These are correct as they stand:

| Difference                                   | Why it stays                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Straddle control hidden                      | There is no straddle in a tournament                                                       |
| Rebuy opens `RebuyModal`, not `CashierModal` | Different transaction with different rules                                                 |
| `SessionHUD` is cash-only                    | It reports session P/L in chips that have cash value. Tournament chips do not              |
| `BuyInModal` skipped in seat-first           | The seat-first flow _is_ the buy-in; a range picker would be meaningless at a fixed buy-in |
| Tournament masthead adds a level clock       | More information, not different information                                                |
| `SpinWheel` blocks the viewport for 14.8s    | Intentional, shared-clock theatre. It is the format's identity                             |
| MTT/final-table/bounty overlays              | Additive. A Spin has no bounties, so those stay dark                                       |

---

## 4. What is still not proven

**Nobody has watched a Spin run from a real seat since these changes.** The
fixes are pinned by 16 source-level assertions and by two new E2E beats running
against a real build of this commit, and 9 of the 16 fail against `origin/main`.
That is verification that the code says what it should. It is not verification
that a player sees it.

The cheap confirmation for whoever is next at a live table:

1. Register three seats on a Spin. Before the third pays, the two open seats
   should show `+ SIT` and breathe. Tapping one should take it.
2. When the wheel finishes: chips should **land** on the three seats with a
   bounce and a floating `+N`, and ~900ms later the dealer button should be
   **dealt in** with a spin-scale, not simply be present.
3. The felt, background, deck and button art should match the player's SNG
   theme — the same one a heads-up table uses — not their MTT one.
4. Late in the Spin, any stack under 10bb should pulse red.

If (2) looks instant rather than sequenced, check that the engine is emitting
`spin_chips` / `spin_button` at all: `scheduleSpinPostReveal` only runs on the
shared-reveal path, and the DB-derived fallback wheel trigger in `TablePage`
(gated on `spin_multiplier > 0` and a 90s window) has no equivalent.

## 5. Coverage gap this closes

Before this session, **no spec anywhere rendered a table in tournament mode**.
`live-animations.spec.ts` tested the SpinWheel and the tournament overlays as
isolated hand-mounted DOM; `multi-table.spec.ts` has zero matches for
`spin|tournament`; `GameplayAnimations.simulation.test.tsx` likewise. Every
difference in section 2 was invisible to CI, which is how four of them survived
into a format Dan had explicitly asked to be a clone.
