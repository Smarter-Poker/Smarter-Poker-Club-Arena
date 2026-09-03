# 33,309 duplicate rows, and a login streak you could farm by refreshing

Found by pulling the last thread from the 2026-08-28 load audit: the twelve
`training_user_achievements` queries fired on every page load. They were not an
N+1. They were a table tearing itself apart.

## 1. The table was 99.87% duplicates

Measured on production before the fix:

|                                |                 |
| ------------------------------ | --------------- |
| total rows                     | **33,353**      |
| real (user, achievement) pairs | **44**          |
| surplus rows                   | **33,309**      |
| worst single pair              | **13,047** rows |
| users with any achievement row | 8               |

The worst pair was still growing, one row per page load, while this was being
written.

**Mechanism.** There was no unique constraint on (user_id, achievement_id), and
the client wrote read-then-insert:

```ts
const { data: existing } = await supabase        // error DISCARDED
  .from('training_user_achievements')
  .select(...).eq(user).eq(achievement).maybeSingle();
if (existing) update(...) else insert(...)
```

`.maybeSingle()` **errors** when more than one row matches. Only `data` was
destructured, so the error was thrown away, `existing` came back undefined, the
code read that as "no row yet" and INSERTed. One duplicate begets the next.

Two consequences beyond the wasted rows:

- **Progress could not accumulate.** Every call read "no row", inserted a fresh
  row at progress 1, and the next call did the same. An achievement counted
  this way can essentially never be earned.
- **`target` was never written**, so every row carried the column default of 1
  — the database's own idea of "finished" was wrong on every row.
- **`unlocked`** (a real boolean column) had never been written by any code. It
  read `false` on all 33,353 rows while 8 were genuinely unlocked.

## 2. The login streak paid chips for refreshing the page

`onLogin` looped three streak ids and called `incrementProgress` on each, every
time Supabase raised an auth event — and it raises one on `INITIAL_SESSION`, on
`SIGNED_IN` and on `TOKEN_REFRESHED`. So "Log in 7 days in a row" advanced
seven times in an afternoon. `streak_30` pays 100 chips and `streak_100` pays
500, through `add_to_promo_wallet`.

Production carried the tell: **3 of 5 `streak_7` unlocks and 1 of 2
`streak_30` unlocks were stamped `unlocked_at` on the same day the row was
created** — which a consecutive-day achievement cannot legitimately do.

There was no day guard anywhere. `profiles.login_streak` existed and read **0
on all 1,023 profiles**; `profiles.last_login_date` existed and was stale on
all of them. Nothing had ever maintained either.

## The fix

**Migration `20260829020000`** — merges each duplicate group into one row
(progress = MAX, unlocked_at = EARLIEST non-null, so nobody loses progress or
an unlock they hold), deletes the rest, asserts zero groups remain, then adds
the UNIQUE index. Also backfills `unlocked` from `unlocked_at`. Result:
**33,353 rows -> 44, zero duplicate groups, index present, 9 unlocked rows
agreeing across both columns.**

The index is also what makes the existing `onConflict:
'user_id,achievement_id'` upsert legal. That call had been failing for as long
as it had existed, because ON CONFLICT needs a matching constraint.

**Migration `20260829020100`** — `fn_achievement_record_progress`, one
statement, and the database decides: progress only rises (`GREATEST`, clamped
to target), `unlocked_at` is set once and never cleared, `unlocked` is kept in
step, and it **returns true only on the call that performed the transition**,
so the reward is paid exactly once no matter how many tabs are open. Writes are
restricted to the caller's own rows via `auth.uid()`.

**`AchievementService`** — `incrementProgress` and `setProgress` both route
through that RPC, and the read error is HANDLED rather than dropped. Dropping
it is what turned "I could not read this row" into "this row does not exist".

**`onLogin`** — the streak is now a real streak, computed once per UTC day from
the two columns nothing had maintained. Same day: **one SELECT and no writes at
all**, however many times the page reloads. Yesterday: streak + 1. Older: back
to 1. The day is claimed BEFORE the achievement writes, so a failure there
costs a missed advance, never a day counted twice. The three achievements are
then set in parallel rather than awaited one at a time.

**Migration `20260829020200`** — `WaitlistService` has the same
discarded-error-then-insert shape, and `table_waitlist` had no unique
constraint either. Added a **partial** unique index on (table_id, user_id)
`WHERE status = 'waiting'`. Partial by design: that table keeps history, and a
player who joins, is seated, leaves and rejoins legitimately has several rows —
only being in one queue twice AT ONCE is wrong, because each live row is a
separate place in line. Verified zero current violations before applying, so it
locks in a state the data already satisfied.

I checked the other six services with the same read-then-insert shape
(`PromotionService`, `PlayerNotesService`, `TournamentService` x2,
`ReferralService`, `HorseOrchestrator`, `FriendListPanel`). All of their tables
already carry a unique constraint, so a discarded read error there produces a
failed insert rather than a duplicate. No change needed, and saying so is
worth more than a change that looks like diligence.

## Tests

`achievementsCannotBeFarmed.test.ts` pins the day rule across every branch:
same day writes nothing, yesterday continues, a gap restarts at 1, a new player
starts at 1, and all three achievements go in one pass.

`AchievementTriggerService.test.ts` had an assertion pinning the farm itself
("should increment streak_7"). Updated in this same commit, with the reason
written into it, per section 5 rule 8.

`npx tsc --noEmit` exit 0. `npx vitest run tests/` — **558 files, 8,555 tests,
all passing.**

## CI note, and one thing left broken that is not mine to land here

The first CI run failed on "Supabase Invariants — New Migrations Were Applied":
the migration declares `fn_achievement_record_progress` and
`scripts/ci/supabase-schema-manifest.json` did not list it. The function WAS
applied to production (verified in `pg_proc`, SECURITY DEFINER, correct
signature) — the manifest was simply stale, which is exactly the case that gate
exists to catch. Regenerated; the schema manifest gains **one line**, my
function, and nothing else.

`gen-schema-manifest.mjs` also rewrites two other manifests, and both were
reverted out of this PR rather than carried:

- `supabase-columns-manifest.json` picked up `profiles.player_tags`, somebody
  else's column and somebody else's PR to declare.
- `supabase-required-columns-manifest.json` churned **3,960 lines** with no
  content change at all: it is stored compact (`["action_type"]`) and the
  generator writes it expanded. That is precisely the Prettier oscillation the
  comment inside that generator says was fixed — it was fixed for the schema
  and column manifests (`JSON.stringify(..., 2)`) and NOT for this third one,
  which was added later. So every regeneration flips the file and the next
  `prettier --write` flips it back, which is what `detect-silent-revert.mjs`
  flagged in PR #360. Left alone here deliberately: it is a real bug in that
  script, it has nothing to do with achievements, and burying a 3,960-line
  reformat inside a money-adjacent PR is how a fix becomes unreviewable.
