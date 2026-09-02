# A read whose error is discarded, deciding whether to write

**Date:** 2026-08-29

## The shape

```ts
const { data: existing } = await supabase   // <- error DISCARDED
  .from('T').select('id').eq(...).maybeSingle();
if (existing) { /* already there */ } else { insert(...) }
```

A Supabase query builder **resolves** with `{data: null, error}` — it does not
reject. Destructure only `data` and every failure of that read becomes
`existing === null`, which the next line reads as _"the row is not there"_, and
it writes.

This is how `training_user_achievements` reached **33,353 rows for 44 real
(user, achievement) pairs** — 99.87% duplicates, worst single pair 13,047, still
growing one per page load. `.maybeSingle()` errors when more than one row
matches, so once there were two the read failed _every_ time and the insert ran
_every_ time. It compounds.

Nothing catches it at any other level: no exception is thrown, no `catch` fires,
and a test that stubs a happy path sees nothing. The only place it is visible is
the destructuring.

## The gate

`scripts/ci/check-discarded-read-then-write.mjs`, wired into `ci.yml` and
`all-gates.sh`. It flags only the compound that can actually duplicate a row: a
read from table T whose `error` is not destructured, with an `.insert(`/
`.upsert(` into the same T within 60 lines after it.

There are ~345 discarded-error reads in `src/`. The gate deliberately ignores
the ones that only paint a screen. A discarded error on a read that _gates a
write_ is a data-integrity bug; the rest are untidy.

`check-maybe-single.mjs` cannot see any of this: every call site below already
uses `.maybeSingle()` correctly. It is the destructuring that is wrong.

### The gate was wrong first, and reported clean

Version one split each file into functions and related a read to a write inside
the same one. The heuristic for "a function starts here" also matched
`if (existingErr) {` — an `if` at low indent has the same shape as a method
signature. So adding a comment and a guard between a read and its write pushed
them into different "functions", and **the gate went quiet on a call site it had
flagged five minutes earlier**. It printed `clean`.

That is worse than no gate. It was caught only by re-introducing a fixed bug and
finding that nothing fired — the verification step, doing its job. Replaced with
a proximity window measured in **lines**, so a long explanatory comment above a
write cannot push it out of range the way a character budget did.

The stronger version immediately found **eight** sites the fragile one had
missed, including three nobody had listed.

## What was found

| Site                               | Read                          | Then                       | Consequence of a failed read                                                                                                                                                                           |
| ---------------------------------- | ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClubsService.ts:194`              | duplicate club **name** check | creates the club           | **the name check is skipped and a duplicate-named club is created**                                                                                                                                    |
| `PromotionService.ts:187`          | already-claimed check         | claims, which **pays out** | a guard on a money path that cannot see its own failure                                                                                                                                                |
| `ReferralService.ts:58`            | existing referral code        | mints a new one            | a player's code changes, invalidating every link they have shared                                                                                                                                      |
| `WaitlistService.ts:163`           | idempotent-join check         | inserts a queue row        | falls through to the insert; the 23505 is then misdiagnosed as a lost race                                                                                                                             |
| `PlayerNotesService.ts:140`        | existing note                 | inserts a second           | `retryAsync` burns all three attempts on a 23505 and reports a save failure                                                                                                                            |
| `FriendListPanel.tsx:231`          | already-friends check         | inserts a friendship       | the player sees a raw database error where "Already friends" was the truth                                                                                                                             |
| `HorseOrchestrator.ts:1161`        | club-in-union check           | attaches it                | re-inserts a membership that exists                                                                                                                                                                    |
| `HorseOrchestrator.ts:2064`        | existing club members         | batch-inserts the missing  | **an empty result means "no horse is in this club", so it re-adds the entire fleet**                                                                                                                   |
| `PlayerNotesPanel.tsx:81`          | loads the note for display    | (no write)                 | shows an empty note, so the player types over the one they already had                                                                                                                                 |
| `AchievementTriggerService.ts:433` | player stats                  | (no write)                 | every field coalesces to 0, so a failed read looks like a player who has never played — which is exactly the input "first hand" and "first tournament" milestones fire on, and some of those pay chips |

Every one now either handles the error or, where the read is only informational,
reports it instead of laundering it into a zero or a null.

Several of these tables do have a unique index, so the duplicate row was refused
rather than written. That is the better defence and it is why this was not a
second 33,309-row incident. But an index turns silent duplication into a 23505
the caller has to handle, and a caller that discarded the _read_ error generally
discards that one too — which is precisely what produced the wrong diagnosis in
`WaitlistService` and the raw error in `FriendListPanel`. Both halves.

## Two false positives, both instructive

`CreditRequestService` and `DisputeService` read `profiles` and then insert into
a _different_ table. The first version allowed any text between `.from('T')` and
`.insert(`, so an unrelated chain a few lines later counted as a write to `T`.
Fixed by requiring the two to be links in the same chain — no second `.from(`
between them.

`NotificationService:214` reads an unread **count** for a badge, and inserts a
notification forty lines later in a different method. A count is not an
existence gate, so reads that do not destructure `data` are excluded.

## Not done

`TournamentService`'s final-table lookup was on the list from the 2026-08-28
handoff and had already been fixed the same day by another agent — the comment
there is dated "ROUND 8 (2026-08-29)". Verified rather than assumed.

The remaining ~340 discarded-error reads that only affect display are untouched
and unlisted. Worth a pass, but they are a different severity and would bury
this diff.

Full suite: 569 files / 8,729 passing. `npx tsc --noEmit` exit 0.
