# A Spin level read as minutes, a roster reloaded per registration, and a dead library

**Date:** 2026-08-29

The last three open items, plus one measurement that closed a fourth.

## 1. A Spin level is stored in SECONDS and the service read it as minutes

`blind_structure` spells a level's length three ways. `durationMinutes` and
`duration_minutes` are minutes; **`duration` is seconds**, and every Spin is
written that way — `createSpin` stores `duration: 180` for a three-minute level
and no minutes key at all.

`TournamentService.getCurrentLevelState` read `.durationMinutes` directly at
four sites:

| site            | on a Spin                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| pre-start clock | `undefined * 60` → **NaN**                                                                              |
| running clock   | `(undefined \|\| 10) * 60` → **600s for a 180s level**                                                  |
| wall-clock walk | `undefined * 60 * 1000` → NaN, so the loop that walks the structure never matches and falls off the end |

The 600 is the one a player sees. `DetailOverviewTab`'s hero meter computes
`(1 - remaining / duration) * 100` against a `duration` the **page** normalised
correctly to 180 — so `(1 - 600/180) * 100` is **−233%**, clamps to 0, and the
meter sits visibly empty for the first seven minutes of a three-minute level
before snapping full. The clock beside it counts down from 10:00 on a level that
ends at 3:00.

Every read now goes through `blindLevelMinutes`, the canonical reader that gets
the precedence right (canonical keys first, seconds last, 0 for "unknown" rather
than a guess). The service's own 10-minute fallback is preserved for a structure
that genuinely does not say — it just no longer mistakes 180 seconds for 180
minutes. The three remaining `durationMinutes:` in the method are object
literals writing the canonical key on a synthesized default; those are correct
and stay.

## 2. UnionsTab reloaded its whole sweep for every new registration

`entrantKey` is the sorted join of entrant ids. It was introduced to stop the
club sweep re-running on every chip tick, and it does that. But it also changes
on every **registration**, and the load effect depended on it — so each new
player re-ran a paged `tournament_players` read of the whole field, a chunked
`club_members` read, a chunked `clubs` read and the union name. Four to sixteen
round trips per new player, during late registration, when players arrive
fastest and the field is largest. A 500-runner event re-read 500 rows to learn
about one person.

A club assignment does not change once resolved. So the resolved maps are
cumulative now and an entrant-set change only asks about ids that are not
already in them:

| case                                          | cost                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| cold load                                     | unchanged — the whole field                                                                 |
| one newcomer                                  | a chunked `.in()` for **one id**, and a club query only if their club is not already loaded |
| re-render, chip tick, **or a player leaving** | **zero queries**                                                                            |

A departure needs nothing because `groups` buckets from `entries`. The union
name is fetched once. A failed _top-up_ keeps the roster already on screen and
reports a warning — only a cold load has nothing to fall back to.

The reset for a new tournament or an explicit retry happens **inside** the load
effect, keyed on an identity string. Two effects sharing dependencies run in
declaration order, so a separate resetter declared after the loader would clear
the cache only after the loader had already read it — a retry would top up the
very data it was retrying because of.

### The test was wrong first, and this one matters

The first version asserted source strings. Disabling the top-up underneath them
— one edit, `const isTopUp = false` — left every string in place and **the whole
file still passed**. That is exactly the failure this repo has been bitten by:
a test that passes either way pins nothing.

So the decision is extracted into `planUnionLoad(prior, entrantIds)`, a pure
function returning `cold` / `topup` / `noop`, and the tests exercise it with
real inputs — including a 500-id field where one newcomer must produce exactly
`['newcomer']`. Regressing the behaviour now turns two cases red.

One assertion also used a 220-character window between `inChunks` and
`.in('user_id', chunk)` and failed because the generic argument is longer than
that. Widening the number would have been the wrong repair; it is bounded by
`sliceStatement` now, per `noFixedSizeSourceWindows`.

## 3. `metal-ui` was not one dead component — it was the whole library

The open item said `MetalIconBox` had zero usages. Checking properly: **all six
components, the barrel and the theme — 13 files — have zero consumers**, in Club
Arena or the World Hub. Nothing imports the barrel.

It was added 30 Jan / 2 Feb 2026 and genuinely used: commits applied it across
Club Arena pages, ClubsPage and the player stats page. Later redesigns removed
it from every consumer and left the library orphaned for seven months.

Put to Dan rather than decided unilaterally — deleting a design system that was
once estate-wide is his call, not mine. He chose delete. **Revivable in one
command from `edad4f2d8b`**, the last commit that touched it.

## 4. The `tournament_players` fan-out was already fixed

The standing item was "still 41–54 calls per load, `tournament_players` ×13–14,
last call at 8.6s". Measured on the live page, instrumenting `fetch` and
isolating the tournament page's own mount:

```
total calls        14
tournament_players  2
last call at      567ms
calls in the next 10 idle seconds   0
```

The handoff's numbers predate today's merges — the satellite N+1 fix alone took
one surface from 1+N round trips to 2, and the column trimming did the rest.
There is no fan-out left to coalesce. An in-flight coalescer now would be
speculative complexity against a problem that no longer exists, so the item is
closed with the measurement rather than with code.

## Verification

Full suite **599 files / 9,069 passing**, `npx tsc --noEmit` exit 0.

Both new tests verified red without their fix: the Spin case fails on the raw
`.durationMinutes` read, and `planUnionLoad` fails two cases when the top-up is
regressed.
