# A Paid Seat Is Not A Started Game — and seven other things Dan found in Spins

**2026-09-05** · branch `agent/claude-spins/fix/spins-sit-sound-prize-and-felt`

Dan reported eight things about Spins in one message. Six of them turned out to
be one root cause, so this is mostly the story of a single line.

---

## The root cause: a stack stopped meaning what it used to mean

`TablePage` keeps a latch called `playHasBegun`, and until today it was set by
three signals:

```ts
const begun =
  tableState.dealerSeat > 0 ||
  (tableState.handNumber ?? 0) > 0 ||
  tableState.players.some((p) => p && Number(p.stack ?? 0) > 0);
```

The third one had a comment explaining why it was decisive:

> a seat-first seat is a RESERVATION until the multiplier is known, because the
> starting stack is a property of the tier that has not been drawn yet, so a
> non-zero stack means the draw resolved and the game is running.

That was true when it was written on **2026-08-25**. It stopped being true on
**2026-09-01**, when Dan asked for the opposite — _"as soon as they buy in 300
chips should appear in their action box (not 0)"_ — and migration
`20260901154500_the_seat_holds_its_chips_from_the_moment_it_is_paid_for`
made **both** seating paths write `stack = starting_chips` at purchase:
`fn_take_seat_and_buy_in` for a human and `fn_seat_horse_in_seat_first_game`
for a horse, the same number in the same breath, because CLAUDE.md 10.5
requires it.

The comment outlived the invariant. From that day a seat held chips **before**
the game started, and this clause read the first seat SOLD as "play has begun".

### What Dan saw

> "WHEN I TRY TO JOIN A SPIN THAT ALREADY HAS HORSES REGISTERED, I DON'T GET OR
> HAVE A 'SIT +' BUTTON AVAILABLE. BUT WHEN I SIT AT A SPIN FIRST ON AN EMPTY
> TABLE THE SPIN STARTS."

Exactly the mechanism. On a Spin the fleet usually buys the first seats, so by
the time Dan opened the table two seats already held 1,000 chips each — read
live from production while diagnosing this:

| tournament                      | status      | seats                                                        |
| ------------------------------- | ----------- | ------------------------------------------------------------ |
| `10 Chip Deep Stack Spin PLO5`  | REGISTERING | seat 1 stack **1000** (horse), seat 2 stack **1000** (horse) |
| `3 Chip Deep Stack Spin PLO5`   | REGISTERING | seat 1 stack **1000** (horse), seat 2 stack **1000** (horse) |
| `100 Chip Deep Stack Spin PLO4` | REGISTERING | seat 1 stack **1000** (horse), seat 2 stack **1000** (horse) |

`playHasBegun` latched on the roster read, the D8 effect cleared
`seatFirstBuyIn`, `canSit` went false, and every open chair rendered as an
inert EMPTY plate. Sitting FIRST at an empty table still worked because nothing
had been bought at the moment he tapped.

**It is not a horse setting.** Dan's instinct that horses were involved was
right about the trigger and wrong about the cause: a human who bought the first
seat would have done exactly the same thing to the next person to arrive.
Horses just get there first.

### The second casualty

The D2 fallback that re-opens the Spin wheel when the `SPIN_REVEAL` broadcast
is missed is gated on the same latch. It therefore fired during REGISTERING,
burned all three of its attempts against a NULL `spin_multiplier` in three
seconds, and never ran again.

### The fix

The stack clause is gone. The button and the hand number stay, and the
tournament row — which says it directly — now latches the mount read:

```ts
if (!openForSeats) {
  playHasBegunRef.current = true;
  setPlayHasBegun(true);
}
```

That last part matters: the stack clause was also how a player ARRIVING at a
running game latched, which is what arms the bust watcher and `exitIfBusted`.

---

## 2. No countdown and no sound

The countdown and its three beeps exist in `SpinWheel` and are correct. They
were being **skipped**.

The wheel animates against a shared clock so three players see one wheel:

```ts
const elapsed = Math.max(0, Date.now() - data.revealAtMs);
const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
```

Every beat already behind `elapsed` fires at once. The engine understands this
exactly — `spinRevealWouldSkipABeat` re-anchors to `now` whenever its own
anchor has passed, so what it **broadcasts** is always playable in full.

The DB fallback paths do not get that packet. `buildSpinDrawFromRow` had only
`tournaments.started_at` to key on, and started_at is not the reveal anchor.
The engine's own telemetry says how far apart they are, in a comment in
`TournamentManagerBase`:

> `spin_reveal_lag_ms` now measures that path (**p50 4.2s**, and **93% of spins
> miss Dan's one-second rule outright**)

The lead-in is 1000ms and the countdown 3000ms. A 4.2s head start eats both
outright, so the wheel opened straight into the chase and all three countdown
beeps collapsed onto one millisecond. A silent spinner.

Fixed by writing the anchor down. Migration
`20260905065304_the_wheel_is_anchored_to_the_instant_the_engine_chose` adds
`tournaments.spin_reveal_at`; the engine writes it on the row write that
already carried `spin_reveal_lag_ms` (same instant, frozen by
`spinRevealEmitted`, so packet and row can never disagree); and
`buildSpinDrawFromRow` prefers it, keeping `started_at` as the fallback for
rows drawn before the column existed.

**Applied to production before this branch was pushed** — verified by reading
`information_schema.columns` back.

---

## 3. The prize was not on the felt after the spin

There has been a `spinMultiplierBadge` on the felt since August, gated on
`tableState.spinMultiplier`. The **live** `SPIN_REVEAL` handler never wrote it
— only the mount read did. So the badge appeared for somebody who refreshed
into a running spin, and never for the three players who actually watched the
wheel: `spinDraw` cleared on the wheel's own `onDone` and the felt went back to
saying nothing.

The handler now writes it, deliberately **before** the still-live check: a
reconnect that arrives after the sequence is over must not re-open the wheel,
but it is still telling us what this table is playing for, and that is exactly
when a persistent badge is the only thing left to carry it.

Dan asked for the **total prize** as well as the multiplier. The engine already
computes it, writes it to `tournaments.prize_pool` and puts it on the packet as
`prize_pool`; nothing on the client had ever read either. Both are wired, and
the badge now reads `12x | 36,000`.

---

## 4. The result card followed you around the app

`TournamentRankingHost` is mounted at the app root, outside `<Routes>`, and
that placement is right — the player is mid-navigation when the result arrives
and a route-level mount would be torn down under them. But "survives the
navigate off the table" was implemented as "survives every navigate forever",
so the card rode along to the cashier, the promotions page and everywhere else.

It now remembers the route it became visible on and lets go when the player
leaves it. **Nothing is on a timer** — Dan's 2026-08-30 ruling ("IT SHOULD
NEVER 'AUTO CLOSE', USER MUST CLICK THE 'X'") stands; leaving a page is a
deliberate act, and a card sitting on the lobby the player is reading stays
until they dismiss it.

The anchor is the first **non-table** route, because TablePage publishes and
THEN navigates: anchoring on `/table/<id>` would have cleared the card on the
exit navigation itself and Dan would never have seen it at all.

---

## 5. The multiplier odds are gone

> "HIDE THE MULTIPLIER ODDS, GET RIDE OF THAT ALL TOGETHER, NOBODY SHOULD EVER
> VISIBLY SEE THAT."

A "show/hide" disclosure on the seat-first buy-in sheet printed the whole
ladder — every tier, its prize at that stake, its 1-in frequency and its payout
split. Deleted: markup, state, and the eight CSS rules that dressed it.
Collapsing it or defaulting it closed would not have satisfied the instruction;
a toggle is still something a player can see.

`spinOddsTable()` **stays** in `src/config/spinSpec.ts` — the fairness and
ladder guards derive from it, it is how the platform checks itself. What it no
longer has is a render path.

`tests/unit/spinOddsOnBuyInSheet.test.ts` used to assert the sheet renders the
ladder. It now asserts the opposite, in the same commit, because a deleted
surface with a passing test still demanding it is how the next agent decides
something is missing and rebuilds it.

---

## 6. The "+" button offered cash games inside a Spin

Quick Join has always queried `tables` with `.is('tournament_id', null)` —
cash tables, by construction. A Spin is a tournament, so its boards were
excluded and the sheet offered 1/2 PLO to a player who had just chosen not to
be in a cash game.

`src/lib/quickJoinSpins.ts` adds the spin branch: same club scope as the cash
path (both the union hub and the entry club — scoping to the entry club alone
is what emptied this sheet for every union player in August), same stake first,
open boards only, and one batched table read rather than N sequential
`resolveTournamentLiveTable` calls on the critical path of a button press.

Every failure — and a readable-but-empty result — returns `null` and falls
through to the cash sheet. "No Open Seats Right Now" on behalf of a query that
could not run is the exact failure this sheet already had once.

---

## 7. The 6-handed table was as tall as the 9-handed one

`.table-scaler` carried one `aspect-ratio: 605/1000` for every table in the
app. The rings are not the same shape: 9-max fills the long oval (two bottom
caps at y 82.5, two rail seats a side, a three-seat top band), while 6-max uses
the same canvas for two rail seats a side and ONE seat on top — the bottom caps
and top diagonals are simply empty.

Every ring below 7 now draws on a **605/920** canvas. The seat count is
published as `data-seats` on `.table-page` because CSS cannot count seats.

**Why 920 and not the 860 I first wrote.** The number is bounded, and the bound
was already written down in `SeatSlot.css`: at `--sp-bust-scale: 1.05` the
top-centre seat's crown clears y 0 _"with 5px to spare"_ on the 605×1000
reference frame — and top-centre `{ x: 50, y: 5 }` **is** the 6-max ring, i.e.
exactly the seat this override moves. The seat centre sits at 5% of the canvas,
so every point of height removed lifts it 0.05px toward the BBJ banner:

```
lift = 0.05 × (1000 − H) ≤ 5px of spare   →   H ≥ 900
```

860 would have lifted it 7px through a 5px margin and put the bust art back
inside the banner — which is Dan's own item 10 from 2026-08-19, the bug the
56px top-row cap was introduced to fix. 920 spends 4 of the 5px and leaves one.
`tests/unit/spinsSitSoundPrizeAndFelt.test.ts` pins that arithmetic so the next
agent cannot reach for 860 without meeting it.

### What is NOT changed, and why

Dan's stated reason was _"so the avatars at the top don't have to be shrunk or
squished down"_. The top row's 56px cap is **not** touched, because the
geometry runs the other way: the cap is BBJ-banner clearance measured on the
canvas, and shortening the canvas makes that clearance **tighter**, not looser.
Lifting the cap would re-ship the 2026-08-19 bug. See the open item at the
bottom.

---

## 10. Shown-down cards were a third smaller on the top row

```css
--vh-card-h: max(17px, --seat-avatar-size * 0.346 * --vh-reveal);
```

Right for the resting rosette — a small marker that says "this player has
cards", scaled to the pod it sits on. Wrong the moment the faces are up. The
top row is capped at 56px for banner clearance, so on a 9-max cash table a top
seat showed a **31px** hand while every other seat showed **46.5px**, at the
one moment in the hand when every card on the felt is being compared with every
other.

The revealed cluster now sizes from `--seat-avatar-full`, which is declared on
`.seat` from `--table-w` and therefore computes the **same** value at every
seat whatever that seat's own avatar was capped to. Only on `--revealed`; the
resting cluster keeps its proportional size, which is the design. The top row's
vertical anchor still reads its own `--seat-avatar-size`, because where the
nameplate is depends on the real avatar.

Re-measured, because the row is taller now: on a 375px phone nothing changes
(the cap barely binds — full slot ~56.9px vs a 56px cap); on a 720px desktop
the card goes 31px → 63px and the row's top edge lands ~15px inside the canvas,
clear of the banner at y 0.

---

## Verification

- `npx tsc --noEmit` — clean, client and `server/`.
- `tests/unit/spinsSitSoundPrizeAndFelt.test.ts` — 26 new guards, green.
- `tests/unit/spinOddsOnBuyInSheet.test.ts` — rewritten, 7 green.
- Spin suite (`SpinWheel`, `spinPostReveal`, `spinChaseCatchUp`,
  `sharedSpinReveal`, `spinReveal`, `spinSpec`, `spinAnimationParity`,
  `spinEngineWiring`) — 172 green.
- Laws (`animations-always-play`, `no-auto-table-switch`, `handCompletionLaw`,
  `law-registry`, `shipped-invariants`, `the-spin-ladder-is-one-ladder`) — 286
  green.
- Migration applied to production and read back from
  `information_schema.columns`.

## Open, and deliberately not guessed at

**The top row's 56px avatar cap.** On a phone it is nearly a no-op (56 vs a
56.9px full slot). On a 720px-wide table the full slot is ~113.8px, so the cap
halves the top row's avatars — which is very likely what Dan is actually
looking at when he says "squished". Fixing it properly means re-measuring the
crown clearance on device (`tests/e2e/top-rail-seat.spec.ts` is the harness) or
raising the top-centre seat's y in step with the shorter canvas. It is a
measured job, not a bolder literal, and shipping a guess would put the bust art
back into the BBJ banner for the third time.
