# The ninth flow, and a guard that skipped itself

2026-08-30. Two live defects found by auditing my own previous work rather than
by anyone reporting them.

---

## 1. A logged-out caller could write anybody's achievements

`fn_achievement_record_progress` is `SECURITY DEFINER`, writes
`training_user_achievements`, takes `p_user_id` from the caller, and was
executable by **`anon`**. Its guard was:

```sql
v_caller uuid := auth.uid();
IF v_caller IS NOT NULL AND v_caller <> p_user_id THEN
  RAISE EXCEPTION 'refusing to write achievements for another user';
END IF;
```

`IF v_caller IS NOT NULL AND …` is the whole bug. For a logged-out caller
`auth.uid()` is NULL, the condition is false, and **the guard skips itself** —
the one case it exists to stop is the one case it waves through. A logged-out
request could set any achievement, to any progress, for any user id it named.
`SECURITY DEFINER` also means it runs with `BYPASSRLS`, so the table's own
policies were not standing behind it either.

Issue #1634 predicted this shape exactly: _"The rebuy hole of 2026-08-28 was a
guard that read `auth.uid()` and skipped itself when there was none, and the
only thing between that and a live exploit was this grant."_

**Both halves fixed.** `anon` loses `EXECUTE` — that is the defence that
actually holds. And a NULL caller is now **refused** rather than exempted, so a
future grant change cannot silently re-open it. The grant is the lock; the guard
is the bolt.

`authenticated` deliberately keeps `EXECUTE`: `src/services/AchievementService.ts`
calls this from a signed-in browser, and the signed-in path is untouched
(`v_caller` is their own uid, so the equality check behaves as before). The body
is otherwise copied verbatim, so progress maths, the unlock transition and the
"newly unlocked" return value cannot have changed.

Live count of anon-executable `SECURITY DEFINER` writers, platform-wide, after
this: **0**.

## 2. Issue #1498 lists eight flows. There are nine.

The one it misses is in `AchievementTriggerService.ts`:

```ts
pushNotificationService
  .notifyAchievement(userId, ach.name)
  .catch(...)
```

The call is split across lines, so every `pushNotificationService\.(...)` grep
used to build that list walked straight past it — **including mine, the first
time I checked.** Six of the eight were fixed server-side earlier on 2026-08-30
and the remaining two turned out to be a dead import and a comment, so this was
about to be the only live one left, in an issue everybody believed was closed.

Achievement unlocks have therefore notified **nobody** since 2026-08-19.

**Fixed at the transition, not the call site.** Issue #1498's remedy is "raise
the notification from the trusted context that already performs the action". For
achievements that context is the unlock transition on
`training_user_achievements`, not any one writer of it:

- `fn_achievement_record_progress` is one writer, but it takes an achievement id
  and never sees the display name, so notifying from there would need a
  signature change (a Tier-3 overload risk) and would still miss every other
  writer;
- `trg_notify_achievement_unlocked` covers all of them, now and later, and
  cannot be forgotten by the next path that unlocks something.

It fires **once**, on `unlocked_at` going NULL to non-NULL. Progress updates,
re-saves and backfills do nothing — the same "newly unlocked" semantics the RPC
already returns. It carries **no** `_push` key, so unlike the expiry notice this
is a real push: the mirror trigger enqueues it and `push-dispatch` applies
`gateDecision()`, which is the consent gating the browser call could never do.
And the whole body is wrapped so a failure to announce can never roll back the
achievement a player actually earned.

Proven against production inside a rolled-back transaction:

```
PROBE (rolled back)  achievement=bad_beat
  locked insert : +0   (no premature notify)
  on transition : +1   (fires exactly once)
  on re-save    : +0   (idempotent)
  title/message : Achievement Unlocked / Bad Beat Survivor
  push enqueued : 1    tag=achievement:47965354-…
```

The two now-dead imports of the retired service (`AchievementTriggerService`,
`SettlementService`) are removed with it. **No file in `src/` calls
`pushNotificationService` any more** — verified with a multi-line sweep, not the
single-line grep that missed this in the first place.

---

## Tests

`npx tsc --noEmit` clean on client and server. 2570 server tests and 9335 client
tests pass. Both migrations were applied to production before this branch was
pushed, and the schema manifest regenerated in the same commit so
`check-migrations-applied` judges them against a current snapshot.
