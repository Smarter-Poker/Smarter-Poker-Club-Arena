# 2026-08-28 — the cap leak, and ghost seats in tournaments

Three defects were reported. Two were real and are fixed; the third was
already self-healing and is left alone, with the reasons written down so
nobody "fixes" it twice.

---

## 1. The four-table cap leaked — but not where the report said

**Reported:** 24 horses over the 4-game cap (20 at five, 4 at six), because the
fleet seeder, overlay guard, seat-first fill and tournament registration each
pass their own check and then all seat — "shuffling the candidates does not
make the claim atomic."

**Measured before writing anything**, which changed the fix:

```
seats  regs   horses
  1      4      13
  2      3       6
  3      2       3
  4      1       1
---------------------------------
max live seats held by ANY account:  4
accounts over 4 live seats:          0
```

**Not one account had breached the SEAT cap.** The 2026-08-24 trigger has never
let a fifth seat through. Every one of the 24 breaches was a _booking_ — a
registration for a tournament that has not started — and bookings had no
enforcement anywhere. The ceiling lived in TypeScript, in
`horseLoadMap`/`atCapacity`, read by four callers that each pass and then all
book.

### Why a booking has to count

A horse at 4 live seats and 1 pending registration — the bottom row above, live
on production — is an entrant that **cannot be seated**. The moment that
tournament starts, its seat insert meets the seat trigger and is refused with 23514. The field is short a player who is on the list, and the seat-first fill
spends its pass re-offering a chair nobody can take. Over-booking does not
create a fifth table; it creates a phantom entrant and a stalled fill.

### The fix — `20260828_the_four_table_claim_is_atomic_and_counts_bookings.sql`

- `fn_concurrent_game_load(user, [exclude seat], [exclude table], [exclude
tournament])` — one definition of "a game", in the database: live seats at
  open tables, plus bookings for tournaments that have not started.
- `fn_enforce_four_table_limit` (seats) rewritten to use it, and
  `fn_enforce_booking_game_cap` added on `tournament_players` — the half that
  had no enforcement at all. Six registration RPCs write that table; the
  trigger is the chokepoint, exactly as `table_seats` is for seats.
- **Both take `pg_advisory_xact_lock('table_cap:' || user_id)`** before
  counting — the same key `atomic_table_buyin` has used since 2026-08-19. That
  is what actually makes check-and-claim indivisible: two callers for the same
  account now queue instead of both reading 3 and both writing.
- The booking trigger is `BEFORE INSERT OR UPDATE **OF status**`, so the
  5-second chip sync never pays for it, and `registered -> playing` at late
  registration is never refused.

### A second bug found while measuring: the load map over-counts

`buildHorseLoadMap` summed seats and bookings blindly. Its comment argued
nothing could double-count because a RUNNING tournament's entrants arrive only
as seats — true, and not enough. **A seat-first game sells the chair before it
starts**, so a spin sitting at REGISTERING produces both a seat row and a
booking for the same horse and the same game.

The cost is the opposite of a leak: horses read _busier_ than they are, so the
picker declines them and fills starve. Of the 20 accounts reading as over the
cap, **only 3 actually were**. Seventeen horses were held out of every board by
a game they were playing once.

Fixed in both places, deliberately mirroring each other: the `NOT EXISTS`
clause in `fn_concurrent_game_load`, and the `seatedInTournament` dedupe in
`buildHorseLoadMap`. If one changes, change both. `horseLoadMap` now also joins
`tables` to exclude seats at **closed** tables, which the database has excluded
since 2026-08-24 and this read never had.

### Verified on production, by probe, rolled back

```
SUBJECT: 0 seats + 4 regs = load 4
  5th BOOKING: REFUSED [23514] FOUR TABLE LIMIT ...
  5th SEAT:    REFUSED [23514] FOUR TABLE LIMIT ...
A: load 3 -> 4th BOOKING ALLOWED (correct)
B: at-capacity registered -> playing ALLOWED (correct)
```

Nothing was written: every probe ran inside a `DO` block ended by a `RAISE`, per
CLAUDE.md 11.5. No `zz_probe*` functions were left in `public` (0), no probe
rows (0), no seat rows (0). Hand production held at 190–225/min across the
change.

### The 24 existing over-bookings are deliberately left alone

Unregistering somebody is a money decision — refund or not, and on whose
authority — and inventing one is exactly the mistake section 10.5 was written
about. They drain as their tournaments start and finish; the seat trigger holds
the hard line meanwhile; no new over-booking can be created.

### Horses are players (10.5)

There is no `is_horse` in any of the three function bodies, and a test asserts
there never is. Checked against the live population before writing rather than
after: of all accounts carrying any load, exactly one is human, at load 1.

---

## 2. Ghost seats in tournaments

**Reported:** one horse (ShoveWhale) at 0 chips, not marked eliminated, for 22
minutes, in a running 326-player freeroll that had recorded **zero**
eliminations.

### Root cause: the sweep gets slower as the field gets bigger

Nothing was stuck. The elimination sweep read seats with **one awaited
round-trip per table**, and `$100 Freeroll 12:00 AM` had **37 tables**. At even
150ms apiece that is 5.5 seconds of reads inside a 5-second interval, so
`isProcessingEliminations` dropped tick after tick. The bigger the field, the
later the sweep — precisely backwards, because a big field is where busts come
fastest.

That event has since caught up on its own: 322 eliminated, 4 playing. It was
lag, not a wedge — which is why nothing looked broken to any existing guard.

**Fixed:** one paged query over `tables.tournament_id`. Cost no longer scales
with table count.

It also closed a blind spot: the old loop read `this.tableEngines`, an
**in-memory** map. A table adopted late, created by the balancer between
hydrations, or orphaned by a restart was invisible — its players' chips never
synced, so they could never enter the bust list, so they could never be
eliminated, and their seats sat there permanently.

### The missing recovery path

Cash tables have had `recoverBustedSeatedHorses` on every idle tick since
2026-08-15. Tournament tables had nothing of their own. Added
`releaseDeadTournamentSeats()`, running in the same place in the dealing loop,
above the active-player filter so a chair freed this tick is free for _this_
hand.

What it does: if the field already says you are out (`eliminated`, `winner`, or
no roster row at all), you do not keep the chair — released, with the same
per-player teardown settlement performs.

What it deliberately does **not** do: eliminate anybody. Eliminating is
assigning a finishing place and paying a prize against it, and a second writer
of finishing places is the exact shape of the 206 duplicated places found on
2026-08-27. A bust still marked `playing` belongs to the sweep, however late the
sweep is — but one that nobody has resolved in two minutes is now escalated
once as `ServerTableEngine.tournament_ghost_seat`, rather than sitting silent.

An unreadable roster is UNKNOWN, not "everybody is fine": releasing on a failed
read would take a live player off the felt mid-hand.

No `is_horse` test (10.5) — a human whose seat release failed is in the same
ghost chair for the same reason.

---

## 3. The unactable seat and the stuck-horse reset — no change

One `horse_seat_unactable` in two hours, correctly escalated to the watchdog,
and one `Reset stuck horses to available`. Self-healing worked in both cases,
so there is nothing here to fix and a "fix" would only add a second writer to a
path that is already resolving itself.

Worth recording that `horse_seat_unactable` is the same _class_ as defect 2 —
a seat that cannot act — so the sweep speed-up and the new release path should
reduce how often it fires. If it starts firing more, that is a real regression
and this is the note that says so.

---

## Verification

- `npx tsc --noEmit` — clean, server and client.
- `npx vitest run` — **197 test files, all passing.**
- New/updated tests: `TournamentGhostSeat.test.ts` (11 cases, including the
  four things the release must never do), `FourTableLimit.test.ts` (rewritten —
  see below), `HorseConcurrency.test.ts` (seat-first dedupe),
  `PayoutIntegrity.mttFinish.test.ts` (sweep is one read, paged, engine-map
  independent).
- One existing test changed behaviour and was updated in the same commit, per
  section 5 rule 8: `PayoutIntegrity` pinned `if (seatsErr)`, now
  `if (seatsErr || !chunk)` — a null page is the same UNKNOWN and must bail
  the same way.
- `FourTableLimit.test.ts` used to read the one file whose name contained
  `four_table_limit` and assert against its function body. That is a trap in a
  repo where a later migration redefines the function: the old file never
  changes, so the suite stays green while pinning a body production stopped
  running. It now resolves the **latest** migration defining each function.
