# The Fleet Holds The Seat, The Felt Knows A Horse, And The Top Row Gets Its Size Back

**2026-09-05**, second round · branch `agent/claude-spins/fix/spins-sit-sound-prize-and-felt`

Dan: _"proceed with all of them, fleet should hold the seat for 90-350 seconds
max before filling the 3rd seat."_

The measurement that started this round, taken from production:

> **31,153 Spins ran in seven days. FOUR had a human in them.**
> 618,526 hands were written in twenty-four hours. **81** had a human in them.

---

## 1. `table_seats.horse_id` was never once written

Measured: NULL on **all 416 live seats** and on 339,077 of 339,108 rows ever
written. Four consumers read it:

| Consumer                                                    | What it believed                |
| ----------------------------------------------------------- | ------------------------------- |
| `TablePage.tsx` (x3) `isHorse: !!seat.horse_id`             | every horse is a human          |
| `TableService.getSeatedPlayers`                             | felt styling, same              |
| `AnalyticsDashboard` `.is('horse_id', null)`                | all 416 horses are real players |
| `trg_auto_cashout_on_table_close` `AND ts.horse_id IS NULL` | see below                       |

`profiles.is_horse` is deliberately not client-readable ("a horse is named only
to those entitled"), so the seat row is _designed_ to carry the flag. It just
never did. It is worst exactly where Dan was looking: a pre-start Spin board
has no engine snapshot yet, so the seat-first roster rebuild is the only
source, and it reported three horses as three people.

### The trap, and why this was one migration

`trg_auto_cashout_on_table_close` cashes out every live seat holding chips when
a cash table closes — **except**, it says, seats with a `horse_id`. Because the
column was never written, that exclusion never fired: horses **are** cashed
out today, which is correct and is what CLAUDE.md 10.5 requires.

Stamping the column would have woken that filter and started **stranding horse
chips on the felt of every closing table**. So the filter was removed in the
same transaction. That does not change what the platform does today — it keeps
it, and stops it changing under a column that is finally being filled.

Nothing else wakes: `dynamicPersonaRotation`, `smartSeatSelection` and the DB
function `schedule_horse_leave` all read `horse_id` and all have **no callers**.

### A trigger, not six writes

Five RPCs plus the engine create seats. A rule enforced in six places is a rule
about to be enforced in five, so `fn_stamp_seat_horse_id` fires
`BEFORE INSERT OR UPDATE OF user_id` and covers every path that exists and
every path anyone adds. `UPDATE OF user_id`, so an ordinary stack write costs
nothing.

**It deadlocked on the first attempt.** `CREATE TRIGGER` takes an
AccessExclusiveLock and `table_seats` is written continuously — 123 seats were
created during the three minutes it took to verify this. Nothing applied (the
transaction was atomic). Re-applied in three stages with `SET LOCAL
lock_timeout = '4s'`: functions (no table lock), then the trigger, then the
backfill row-by-row with per-row exception handling, because eight other BEFORE
UPDATE triggers get a vote and one refusal must not cost the fix.

**Verified live:** 565/565 live seats stamped, 0 humans wrongly flagged, and
123 seats created in the following three minutes all stamped by the trigger.

---

## 2. The fleet holds the last seat 90–350 seconds

The window already existed at **60–150s**. Widened to Dan's numbers. It lives
in three places and they move together or CI goes red:

| Surface                                                         | Value                                         |
| --------------------------------------------------------------- | --------------------------------------------- |
| `TournamentRecurringService.SEAT_FIRST_HUMAN_WINDOW_MIN/MAX_MS` | 90_000 / 350_000                              |
| `liveTournamentTableRecovery.FRESH_HUMAN_WINDOW_MIN/MAX_S`      | 90 / 350                                      |
| `fn_repair_seat_first_games`                                    | `v_window := 90 + floor(random() * 261)::int` |

`theClubProgrammeMirrorsTheHouse.test.ts` now also **derives** the three from
each other rather than restating three literals — the engine seating a horse at
90s while the repair sweep hands the same board a 60s window is a race nobody
would find by reading. Migration applied to production and read back.

---

## 3. The reveal lag: the reveal path is not the problem

I said last round that "five sequential round trips" sat inside the 3.3s lag.
**That was speculation and the data contradicts it.** Measured in
`pg_stat_statements`:

- the `spin_reserve_ledger` read I suspected: **0.2 ms** mean over 19,968 calls.

The reveal path does essentially no work. It is late because the **database is
oversubscribed**: 4.84 cores of demand on a 2-core instance over a 2½-day
window. The largest single identifiable load is `INSERT INTO hand_history` at
**0.96 cores**, writing 618,526 hands a day of which 81 involve a person.
Realtime WAL polling is another 0.74 cores. Seat-first seating is 0.206.

So the honest answer to "cut the reveal lag" is that you do not cut it in the
reveal path — you cut it by reducing what it queues behind. The 90–350s window
helps a little (fewer boards turning over per hour). The real lever is the
hand-history write volume, and **that is deliberately not changed here**:
CLAUDE.md 10.5 makes horse/human symmetry a hard law and Dan's retention
ruling is explicitly his ("it is a config row, not code. Do not 'fix' it").
Options are in the session notes for Dan to choose.

---

## 4. The top row's avatar cap: 56 → 76, and it is measured

The cap was a flat 56px, chosen when the avatar slot was a flat 84px — i.e.
two-thirds. The slot later became proportional
(`clamp(50px, --table-w * 0.158, 124px)`) and **the cap did not**, so on a
720px table the full slot is ~113.8px and the top row was rendering at less
than half the size of every other seat.

Measured in Chromium against the real stylesheet, 9-max top-cap seats, bust-art
clearance above the canvas top:

| cap    | clearance                   |
| ------ | --------------------------- |
| 56     | 14.2 px                     |
| **76** | **3.9 px**                  |
| 80     | 1.9 px                      |
| 84     | −0.2 px — inside the banner |

84 is the cliff; **76** is the last value with a margin comparable to the rest
of the ring. A 36% larger avatar on every table wider than ~480px, unchanged on
a phone (where the cap barely binds at all).

### And the 6-max canvas came back from 920 to 960

Last round I derived the short-ring canvas height _arithmetically_ from a prose
sentence in `SeatSlot.css` ("clears with 5px to spare") and concluded H ≥ 900
was safe, shipping 920. Measured:

| H    | clearance |     | H       | clearance  |
| ---- | --------- | --- | ------- | ---------- |
| 1000 | 4.2 px    |     | 940     | 1.2 px     |
| 980  | 3.2 px    |     | **920** | **0.2 px** |
| 960  | 2.2 px    |     |         |            |

**0.2px is not a margin.** The estimate was optimistic by a factor that matters,
and the lesson is worth more than the number: do not derive a clearance from a
description of a clearance. 960 keeps 2.2px at every shipped width.

### The cap belongs to the canvas, not to the app

76px on the short canvas measures **−8.1px** — eight pixels inside the banner,
because that canvas is shorter _and_ its only top seat sits at y 5 rather than
y 6. Same cap, different canvas, opposite answer. So it is two rules:
full canvas (7/8/9) gets 76, `[data-seats='2'…'6']` keeps 56.

**Verified against the shipped CSS with no overrides**, every ring at 360 / 600
/ 720 px: all eighteen combinations clear by ≥ 2px.

---

## Verification

- `npx tsc --noEmit` clean, client and `server/`.
- 7 client suites + 4 engine suites green (66 engine tests).
- Both migrations applied to production and read back.
- Chromium measurement of all 18 ring × width combinations: all clear.

## Left for Dan

**The hand-history write volume.** 618,526 hands a day, 81 with a human, ~1
core of a 2-core database. Reducing it is the single biggest lever on platform
latency — including the spin reveal — but it sits against 10.5 and against a
retention ruling Dan reserved to himself. Three options, none of which I have
taken: provision more database; shrink the fleet (identical treatment for every
horse, so no 10.5 conflict); or batch the inserts (currently one PostgREST
INSERT per hand at ~110ms — a pure efficiency win with no fairness implication,
and my recommendation).
