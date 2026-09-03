# Round 16 — the spin Dan actually played, traced end to end

2026-08-30. Dan registered for a spin and reported three things:

> "THE MOMENT THE 3RD SEAT IS BOUGHT AND PAID FOR THE SPIN ANIMATION MUST
> START 1 SECOND LATER! ... IT DID SPIN ABOUT 20 SECONDS LATER, NEVER FINISH
> AND 'ANNOUNCE THE AMOUNT'. THEN BOOTED ME OFF THE TABLE, CLOSED THE GAME AND
> SENT ME BACK TO THE LOBBY!"

All three are real. All three are fixed. This is the evidence for each.

## The game

`53874058-7025-4872-90e3-872f1b55a000` — "20 Chip Spin PLO4", table
`9ef748f0-abb0-455e-a1f7-0ab35cdda87f`.

| moment                              | time (UTC)       |
| ----------------------------------- | ---------------- |
| seat 1 (horse, clara hellström)     | 07:30:53.372     |
| seat 2 (horse, olivia rossi 2)      | 07:32:39.784     |
| **seat 3 — Dan, the third payment** | **07:33:41.366** |
| `started_at`                        | 07:34:20.959     |
| first hand completes                | 07:36:40.605     |

**39.6 seconds** from the third paid seat to the start. The rule is one.

## 1. It started 39.6s late — the lane slept for five of them

Measured against production, 524 spins over six hours, third paid seat to
`started_at`:

| p50  | p90  | max   | over 5s    |
| ---- | ---- | ----- | ---------- |
| 5.4s | 7.7s | 73.8s | 299 of 524 |

`discoverSeatFirstStarts` is already the cheapest loop in the engine — two
bounded reads per pass — but it slept on `TOURNAMENT_DISCOVERY_INTERVAL`,
the 5-second constant shared with two much heavier loops. One second of
Dan's rule was that `sleep`, by construction, on every spin ever played.

It has its own constant now, `SEAT_FIRST_START_INTERVAL = 1000`. The
per-game fill throttle (12s) and the synchronous engine-map check mean the
faster cadence adds no work per game — only the two reads per second, which
is nothing beside the ~200 hands a minute this database already takes.

It stays a poll rather than a LISTEN deliberately: the engine holds no direct
Postgres connection (supabase-js only), so NOTIFY would mean a new dependency
and a new silent-failure mode on the one path that must never stop.

Dan's 39.6s also had a second cause, and it was not the code: **the engine
restarted inside that minute.** Platform hand throughput went 182 → **88** →
119 → 214 per minute across 07:33–07:36. Not one of my deploys (the last
finished 06:55) — an unscheduled restart. The one-second lane does not
prevent that; it does mean the normal case is now ~1s instead of ~5.4s.

## 2. The wheel spun and never announced — the client was told it had already run

The reveal is anchored to the third payment so the wheel is not charged for
the engine's start-up work. The client honours that anchor exactly:

```js
const elapsed = Math.max(0, Date.now() - data.revealAtMs);
const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
```

Every beat already behind `elapsed` fires **at once**. The safety valve for a
late start only tripped when fewer than `COUNTDOWN_MS` (3s) of the
**14,800 ms** sequence remained — so anything between 3s and 14.8s of lateness
shipped as a partially elapsed reveal, and the countdown, the chase and the
winner flash collapsed into a single instant. A blur, then a result card.
Exactly "spun, never finished, never announced" — and worst precisely when
the start was late, which is when the player is already annoyed.

**ANIMATION LAW (CLAUDE.md 10.6, binding):** every animation plays every time
it is owed, _for its full duration_. A wheel shortened because the SERVER was
slow is the plainest violation of it — the player pays for the engine's
lateness in the one moment the format exists to sell.

The threshold is now the honest one: if the hold cannot still cover the whole
sequence, re-anchor to now.

```ts
if (this.spinHoldUntil - now < spinRevealToDealMs()) { ... }
```

The client's catch-up arithmetic is untouched and still does its real job — a
player who refreshes mid-spin rejoins the shared moment in progress. What it
no longer absorbs is the engine's own delay. The overrun is still reported.

## 3. Booted to the lobby off a seat he had paid for — and this one was mine

The evidence that made it findable:

- the seat was **bought** — `registered_at` 07:33:41.366, seat 3, stack on the
  felt, and the game carried on running without him;
- **Sentry logged zero client events** in that window.

Nothing threw. So a deliberate code path decided to leave, and exactly one
closes the tab and navigates to the lobby while logging nothing: the
60-second buy-in window.

Round 14 (mine) handed the seat-first sheet to that clock, whose guard was:

```ts
const sheetOpen = showBuyInModal || seatFirstConfirm !== null;
```

`seatFirstConfirm` is cleared only **after** `fn_take_seat_and_buy_in`
resolves. So pressing Buy In, the RPC, and the round trip were all still
"sheet open" with the clock running. The effect's own comment claimed this
could not happen "because onConfirmBuyIn closes the modal before the RPC
resolves" — true of the cash modal, never true of the sheet round 14 added,
and I wrote that line.

The odds ladder (round 9) made it likelier _by design_: it gives the player
something to read, so spending fifty seconds on this sheet is now the normal
way to use it. Add one slow RPC — the engine was restarting — and the timer
beats a purchase that already succeeded.

Two guards, because the second kills the whole class:

1. **A commit in flight is not an open sheet.** `seatFirstPending` means chips
   are moving; the decision window is over whatever the network does next.
2. **A seated player is never sent to the lobby by a decision clock.**
   `heroSeat > 0` means the seat is held and paid for. No timeout about
   _deciding_ to buy in may eject someone who has already bought in.

Both are dependencies of the effect, so pressing Buy In tears the interval
down in that same commit — a guard that never re-runs is not a guard. And the
expiry re-reads both refs in the instant it would eject, because a whole
second separates the guard from the fire and the RPC can land inside it.

## Verification

- `npx tsc --noEmit` — client exit 0, server exit 0
- client vitest: **628 files / 9,349 tests** green
- server vitest: **232 files / 2,581 tests** green
- run serially (in parallel the server's HorseLeague benchmarks starve the CSS
  timeouts and produce false failures)
- new pins: `aPaidSeatIsNeverEjected.test.ts` (7),
  `SpinStartsInOneSecondAndPlaysInFull.test.ts` (11)

### Two of my own guards caught me, and neither was weakened

- `noFixedSizeSourceWindows` failed the first draft of the new server test for
  using `.slice(0, 400)` — the exact rule I enforce. Fixed with a
  brace-matching window inlined in the server tree (which cannot import the
  client helper).
- `oneBuyInWindowNoBrokenExit` pinned the literal line that caused this bug.
  It was updated **in the same commit** to pin the two guards instead, per
  CLAUDE.md section 8 — and now asserts the old unguarded form can never
  return.
