# Being booted is now visible, the buy-in window expires, and you must play a hand before sitting out

2026-08-28 — agent/cowork-claude/fix/boot-notice-and-seat-hold

Follow-up to `2026-08-28-the-sit-out-clock-and-the-lobby-door.md`, driven by Dan
testing the eviction on his own seat at table `a2183324`.

**The eviction itself worked, first time, in production.** He sat out at
21:35:21, and `atomic_seat_cashout_locked` returned all 10,040 chips to his
wallet at 21:37:43 (balance 491,665.25 → 501,705.25). That was the **2-orbit**
half of the rule firing before the 5-minute half — "2 ORBITS OR 5 MINUTES,
WHICHEVER IS FIRST", as written.

What did not work was everything the player sees afterwards.

---

## 1. "I SHOULD GET A BOOTED NOTIFICATION ON MY SCREEN AND THE SITTING OUT BUTTON SHOULD DISAPPEAR"

He was cashed out and the felt carried on showing **"You Are Sitting Out"**, an
**"I'm Back"** button, and **"Seat Reserved, You'll Be Dealt In Next Hand"** —
over a seat he no longer held, with his chips already back in his wallet.

Three separate causes:

### 1a. My own bug from this morning

The `seat-sitout-` subscription added earlier today only iterated rows that came
BACK from `select … where left_at is null`. So it could set the sit-out flag and
clear it for a player who was still seated — and could **never** clear it for one
who had left, because a departed seat is filtered out of the result entirely.
The id sat in `sittingOutIdsRef` forever, and the footer is gated on exactly that
Set. Now every id not in the returned set is dropped.

### 1b. The `SEAT_LEFT` handler toasted and stopped

It has told the player why since 2026-08-23, but it never touched the seat
claim. Every control in that footer is gated on `heroSeat > 0` or on membership
of `sittingOutIdsRef`, so the UI could not correct itself. It now clears
`heroSeatRef`, `heroSeat`, `showSitOut`, `sitOutSince`, `sitOutNextHand` and the
sit-out id — which is what actually flips the footer back to the spectator bar.

Two reason strings were also missing from its `EXPLANATIONS` map, so
`busted_no_rebuy` (new this morning) and `nit_game_vpip` fell through to the
generic sentence.

### 1c. One websocket event was the only detector

Even fixed, 1b depends on catching a single `seat_left` frame. Miss it — socket
blip, sleeping tab, a resync racing it — and the player is stranded in a false
seated state with no way back. So the **ten-second seat read is now the
authority**: if the hero believes they are seated and their row is gone, it
clears the same state and shows the notice. The two paths dedupe through
`bootNoticeShownRef`, which resets whenever a seat is taken, so a second removal
is announced again.

A buy-in still in flight is excluded by the existing 15-second `seatAcquiredAtRef`
grace — an unlanded buy-in is not an eviction.

---

## 2. The seat is held for 60 seconds while you buy in

> "A SEAT IS HELD (WHILE THE PLAYER IS BUYING IN) FOR 60 SECONDS. IF THEY DO NOT
> COMPLETE THE BUY IN, IN 60 SECONDS THEY ARE REMOVED FROM THE TABLE AND SENT
> BACK TO THE LOBBY."

**Where that hold actually lives is not where you would guess, and it is worth
writing down.** On a cash table there is **no database row until the money
moves**: `atomic_table_buyin` debits the wallet and INSERTs the seat in the same
transaction, so an unpaid seat cannot exist server-side. (The seat-first
spin/heads-up path _does_ insert a reservation row — but `fn_register_for_tournament`
has already charged for it, so it is not unpaid either.)

The hold is the client's optimistic paint — `pendingSeat` / `selectedSeat` — and
it is real: while the sheet is open those guards lock the player out of every
other seat at the table. It simply never expired. A player could open the buy-in
sheet and sit on it indefinitely, unable to take any other seat and occupying the
one the felt was painting for them.

So the window is client-side because that is the only place the hold exists. On
expiry the sheet closes, the optimistic seat is released exactly as a cancel
releases it, the idempotency key is rotated, and the player is sent to the lobby
(`CLOSE_TABLE_TAB` then `navigate`, in that order — firing them together lets
three destinations race, which the leave path learned the hard way).

The countdown is **wall-clock, not a decrement**: a background tab throttles
`setInterval` to once a minute, so counting ticks would leave the sheet open long
past the window and then jump.

`BuyInModal` already had a `countdown` prop documented as "Seconds remaining to
buy in", rendered at the top of the sheet — neither call site had ever passed it
a value. It is passed one now.

---

## 3. You must play a hand before you can sit out

> "A PLAYER MUST ALSO PLAY AT LEAST ONE HAND, BEFORE THEY CAN SIT OUT."

Without it, sit down → sit out immediately is a way to hold a seat at a table you
never intend to play: the seat counts toward the table, blocks a paying player,
and the only thing that ends it is the five-minute eviction — which the same
player can reset at will by sitting back in for one beat. Refused at the point of
entry instead, in `ServerTableEngineSeating.sitOut()`, which is the single
chokepoint every caller goes through.

The oracle is **`dealtInUserIds`**, which already existed for the button rule
("NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING DOWN"). It is per-table, written
at the deal, pruned the instant a seat empties — so leave and come back and you
are new again — and seeded on the engine's first loop pass from whoever is
already seated, so a restart does not strip veterans of the right to sit out.

- **Only the outbound direction is gated.** Sitting back IN is always allowed; a
  player must never be trapped in a sit-out they cannot leave.
- **Tournaments are exempt.** The seat is bought, the player is committed, they
  are dealt in and blinded off either way, and a late entrant who has not yet had
  a hand has an obvious reason to sit out at once.
- The guard is raised **before** the `pendingSitOut` branch, or a mid-hand
  request would be queued and then drained by the idle sweep and the refusal
  would be decorative.

### The refusal had to be made audible first

`GameServerAPI.setSitOut` returned `Server error (${status})` on any non-2xx, and
`handlers/sitout.ts` answers a refusal with **HTTP 400 and the reason in the
body**. So every engine refusal was replaced by a status code before a human saw
it. Survivable while the only refusal was "Player not found at this table";
not survivable for a rule the player has to be told about, or the button just
looks broken. It now reads the body first and falls back to the status only when
there is nothing usable in it.

---

## 4. Fixed in passing: main was red again

`server/src/services/HorseFleetNoDuplicateTables.test.ts` (from
`f73df9b2a7 fix(tables): every boot added another copy of the same cash table`)
declared `let onError: ReturnType<typeof vi.fn>`. With no implementation, vitest
infers `Mock<Procedure | Constructable>`, which has no call signature to match
`(e: any) => void` — **seven TS2345s**, taking `Server Engine (typecheck + tests)`
down for everyone. Giving the mock a one-line implementation lets vitest infer
the real signature; the mock API is unchanged.

Verified pre-existing: a clean checkout of `main` reproduces all seven.

---

## Verification

- `tsc --noEmit`: client **0**, server **0** (server was red on main before this)
- server vitest: **211 files / 2308 tests** pass
- client vitest: **545 files / 8406 tests** pass
- Production evidence for the eviction itself: `wallet_transactions` row
  "Cash-out from table", 10,040 chips, 21:37:43Z.

New: `server/src/engine/SitOutRequiresAHand.test.ts` (5).

Two notes on writing those specs, both caught by the specs failing first: a
source pin compared raw offsets and matched its **own explanatory comment**
before the code it described, and a second one searched for `response.status`
which lives inside a template literal that `blankNonCode` blanks. Both now anchor
on comment-stripped source at a token that is really code.
