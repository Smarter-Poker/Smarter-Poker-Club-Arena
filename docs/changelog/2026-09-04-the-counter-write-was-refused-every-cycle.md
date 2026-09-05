# The counter write was refused on every cycle, and returning zero hid it

2026-09-04, Club Arena, Operation Stable Hand.

## What was wrong

`stable_hand_horse_state` was created at 08:42 and had not been written since.
All 1,000 rows still carried `counters_reset_on = NULL`, `minutes_played_today
= 0` and an empty `cash_sits_today`, so all three counter-driven gates in the
seating mutex - the per-key sit cap, the daily minute cap, and the two-hour
window that stops a horse buying straight back into a game it just left - were
comparing zero against their limits and passing everything.

The cause was one line of reasoning that is wrong only against a real table.
`StateRow` deliberately omitted `rest_weekday` and `daily_cap_minutes`, because
those two belong to the tagger rather than to the counters, and because an
upsert conflicting on `horse_id` takes the `DO UPDATE` branch, which only
touches the columns you name.

Postgres checks NOT NULL on the proposed tuple **before** it looks for the
conflict. Those two are the only columns on this table declared NOT NULL with
no DEFAULT. So every chunk was rejected with 23502 before the conflict was ever
detected, on every cycle, for fourteen hours:

```
[StableHandState.writeStateRows] {
  code: '23502',
  message: 'null value in column "rest_weekday" of relation
            "stable_hand_horse_state" violates not-null constraint'
}
```

## Why nothing said so

`writeStateRows` swallows its error and returns 0 on purpose: a bad counter
write must never take the floor down with it. That is the right call and it is
also exactly why nobody saw this. The only report was `reportError`, and
Sentry's own budget was dropping hundreds of events an hour that day
(`[Sentry:Server] budget dropped 298 event(s) since last summary`). A failure
that is designed to be survivable has to be designed to be VISIBLE, separately.

## The fix

- `StateRow` carries `rest_weekday` and `daily_cap_minutes`, read from the
  state the tag book already holds. Nothing is invented: they are the tagger's
  values, passed through.
- A horse the tagger has never seen gets no row at all, and `foldMutations`
  returns `skippedUntagged` so the count is logged. Guessing a rest day for it
  would hand it one the tagger then disagrees with; skipping costs one
  unrecorded sit for a horse that has no tags to enforce yet.
- A fold that produced rows and wrote none now raises a throttled
  `financial_alerts` row (`HorseFleet.stableHandState`), so the next occurrence
  is a fact about the platform rather than a log line on a box nobody tails.

## The pin

`stateRowCoversEveryRequiredColumn` reads
`supabase/migrations/20260904060838_stable_hand_tag_and_state_tables.sql`,
extracts every column that is NOT NULL with no DEFAULT, and asserts each one
appears in the row this module writes with a non-null value. It also asserts
that list is exactly `rest_weekday, daily_cap_minutes` today, so if the
extraction ever silently returns nothing the test says so instead of passing
vacuously. A NOT NULL column added to that table in future fails a unit test
here rather than switching the counters off in production for a day.

One existing test was deliberately replaced in the same commit and its old
assertion is quoted in place: it pinned that an unseen horse produces a row,
which is the row that could never land.
