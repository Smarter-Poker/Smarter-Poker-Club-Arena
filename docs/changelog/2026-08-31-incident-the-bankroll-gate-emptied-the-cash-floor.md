# INCIDENT 2026-08-31 — the bankroll gate emptied the cash floor

**11:20–12:0x UTC. Every horse cash seat gone, 26 tables open and empty,
tournaments untouched. No chips lost.**

## What happened

At 11:21 the engine restarted onto a new build. Within one minute **133 cash
seats left** (normal rotation is about one a minute) and **nothing re-seated**
for the next forty. Tournaments were completely unaffected — 522 seats, hands
dealing continuously — so the engine was alive and only the cash seeder had
stopped.

## Root cause: three bugs, and it took all three

**1. The gate read the wrong clubs.** The bankroll map is loaded per club, from
`this.clubIds` — the round-robin used when _creating_ tables. That list is
`[SHARK, JAQK]`. Every open cash table belongs to `fade0000-…-0001`. The two
lists share **nothing**: those two clubs own **zero** cash tables between them.
So every lookup `bankrolls.get("fade0000-…:<horse>")` missed.

**2. A miss was written as a refusal.** The candidate filter read

```ts
const roll = bankrolls.get(`${table.club_id}:${h.id}`);
if (roll === undefined) return false; // no membership, no seat
```

That is wrong twice. It refuses on an _unknown_ value, and the doctrine of this
whole layer — stated in the comment directly above the loader — is that an
unreadable bankroll means **no bankroll opinion**, because `atomic_table_buyin`
still refuses a seat the balance cannot cover. This gate decides which games are
_sensible_, never which are _possible_. The failure the loader was carefully
written to avoid was re-introduced one line below it.

**3. A third bug had been hiding both.** `club_members` has no `id` column, so
`fetchAllRows` could not keyset-page it and returned `complete: false` every
cycle — `bankrollsLoaded` stayed false and **the gate never once ran**. PR #2101
(another agent, same morning) correctly fixed the paging. That switched the gate
on for the first time, and bugs 1 and 2 fired together on the next restart.

Either fault alone is survivable. Together they are a dead floor.

## What was ruled out first, with evidence

Time went into proving where the fault was _not_, because "the seeder is
refusing candidates" and "the seeder is not running" look identical from
outside:

- **Not the database.** A probe buy-in through `atomic_table_buyin`, run inside
  a transaction and rolled back per CLAUDE.md 11.5, **succeeded**.
- **Not seat holds.** Zero live `notified` waitlist rows, so no `SEAT_RESERVED`.
- **Not the rolls.** Median horse club balance 32,657, minimum above 5,000 —
  and all **323** horses who are members of the table-owning club could afford
  1/2. The gate was never rejecting on the merits; it never saw them.
- **Not table or horse state.** 26 tables open, all 584 horses `available`.
- **Not an unrelated PR.** Only two PRs touched `server/**` that day.

## Money

**No chips were lost.** `fn_unaccounted_seat_exits()` returned **0** throughout.
49,104 chips left the felt and **49,805 were credited back** through the normal
cash-out path. The seat-exit guard added on 2026-08-25 did exactly its job.

## The fix

1. **Derive the club set from the tables being seeded**, union'd with
   `this.clubIds`. This cannot drift: the clubs read are by construction the
   clubs whose seats are being decided.
2. **An unknown roll fails open** and is counted and logged. The silent version
   of that number is what cost forty minutes.
3. The gate still bites on a **known** poor roll — failing open on a missing row
   is not a licence to fail open on a bad one. Pinned separately.

## What I got wrong in the response

Two reverts were shipped before the cause was known (#2137, #2143), on the
reasoning that the floor being dead is a live incident and restoring known-good
beats guessing. The first was a guess and it was wrong: reverting the _newest_
PR assumed it was the culprit, when both PRs had in fact gone live in the _same_
restart because `MIN_RESTART_SPACING_SEC=1200` coalesces them. **The half-hour
of healthy floor after the first PR merged was still running the old binary** —
a merge time is not a deploy time, and I read one as the other.

Neither revert could have helped: the actual fault was in code that had been in
`main` since the morning and in another agent's paging fix, neither of which was
reverted.

## What would have caught it

A pin that the gate reads the clubs owning the tables, and a pin that a missing
row fails open. Both now exist, and all four mutations against them go red.

The deeper lesson is the one this repo keeps re-learning and had already written
down twice today: **a lookup keyed on something that can silently miss must be
pinned to its key.** The rotator's `club_id` was caught that morning precisely
because it was pinned. This was the same bug in the same shape, one file away,
and it was not.

---

## Resolution — verified in production

|                    |                                                           |
| ------------------ | --------------------------------------------------------- |
| Floor emptied      | 11:20 UTC                                                 |
| Root cause found   | 11:50                                                     |
| Fix merged (#2151) | 11:57                                                     |
| First seat back    | **12:15**                                                 |
| Steady state       | 12:19 — **30 seats across 21 tables**, cash hands dealing |
| Chips lost         | **zero** (`fn_unaccounted_seat_exits()` = 0 throughout)   |

31 joins and 1 leave in the five minutes after recovery: the floor is filling
normally, not thrashing between seat and eviction.

## Why recovery took 25 minutes after the fix merged

Worth knowing before the next incident, because none of it is a bug:

- **The drain gate held the deploy for about six minutes.** It waits for
  `handsInFlightTotal` to reach zero, and a busy tournament floor never goes
  quiet for long. That gate is correct — it exists so a restart cannot void a
  live hand — but it means **an emergency fix is not a fast fix**, and the
  incident response has to be planned around that rather than surprised by it.
- **Deploy runs cancel each other.** Three consecutive deploys were cancelled by
  newer merges landing behind them. On a busy merge day a fix can sit behind
  other people's traffic.
- **`MIN_RESTART_SPACING_SEC=1200` coalesces restarts**, which is what made two
  separate PRs go live in one restart and sent the first revert after the wrong
  suspect.

## One behaviour change to be aware of

261 of the 584 horses hold no membership in the club that owns the cash tables.
Under the old code the gate refused them; they now **fail open** and may be
seated. That is the correct outcome — `atomic_table_buyin` still resolves the
wallet through `fn_seat_club_for_user` and refuses anyone who genuinely cannot
pay — but it is a real change in who is eligible, and the new `rollUnknown`
warning is what makes it visible rather than silent.
