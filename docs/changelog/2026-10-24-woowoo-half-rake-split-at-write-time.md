# 2026-10-24 - WooWoo's half-rake split is written with the hand, not by a timer

## The rule (unchanged)

Dan, 2026-10-24: half of WooWoo's earned cash rake is removed from his credit
and given to KingFish (player #1). Reporting only - fee redemptions adjust the
earned-rake and fee displays; no chips move.

## What was there

`20261024223153_woowoo_half_earned_rake_credited_to_kingfish` was applied
straight to production with no file in this repo. It widened the
`player_fee_redemptions` CHECK to `amount_cents <> 0`, credited KingFish with
the 520.52 first cut, and scheduled pg_cron job `woowoo-half-rake-to-kingfish`
(`*/5`) running `smarter_private.fn_woowoo_half_rake_to_kingfish_sync()`. That
function recounted, per UTC day, `round(sum(rake_paid) * 50)` cents over every
WooWoo cash `ca_hand_facts` row after 2026-10-24 22:21:59.97593+00 and upserted
`woowoo-half-split-<day>` (+half, WooWoo) and `kingfish-from-woowoo-split-<day>`
(-half, KingFish), both under KINGS CLUB.

That is an after-the-fact adjustment job (CLAUDE.md 10.12), and it was behind
the hands between ticks: at 2026-10-25 03:01 UTC the stored 2026-10-25 rows said
7851 cents while the hands already written said 7878.

The file is now recorded byte-exact
(`supabase/migrations/20261024223153_woowoo_half_earned_rake_credited_to_kingfish.sql`,
md5 `06c2de274fd75213f0decf83b2b62f20`, equal to
`fn_ca_migration_text('20261024223153').md5`).

## What replaces it

- `20261025030142_woowoo_half_rake_split_functions_before_the_window` (ordinary
  install): `smarter_private.fn_woowoo_half_rake_day_cents(date)` - the job's own
  expression restricted to one UTC day - and the trigger function
  `smarter_private.tr_woowoo_half_rake_split()`.
- `20261025030249_woowoo_half_rake_is_split_when_the_hand_fact_is_written`
  (`-- @install-window: daily-maintenance`): three row triggers on
  `public.ca_hand_facts` (AFTER INSERT; AFTER UPDATE OF user_id, tournament_id,
  played_at, rake_paid; AFTER DELETE), each with a WHEN clause that admits only
  WooWoo's cash facts after the cut; unschedules the job; drops the sync
  function; writes the day rows once under the trigger lock (the job's own
  final pass); and aborts unless every day row equals the job's GROUP BY
  expression and the 520.52 first cut is untouched.

Same keys, same reasons, same club, same cents, same skip of a non-positive day.
No `ca_hand_facts.club_id` filter, exactly like the job: WooWoo's cash facts
carry the union club (Midway Union) while he is funded by KINGS CLUB.

### Why a recount, and why it cannot miss a concurrent hand

The job rounds once on the day total, so incrementing a rounded half would lose
the half cent the job keeps. The trigger recounts the day (an index range scan
over ~100-200 facts). WooWoo can sit at several tables, so the first writer of a
day creates the row (`ON CONFLICT DO NOTHING`), and every other writer takes the
row `FOR UPDATE` - waiting for the holder to commit - and only then recounts in
a new READ COMMITTED statement that sees the holder's hand. The last writer to
commit always writes the full day. No advisory lock and no new table.

UPDATE and DELETE are covered because `ca_append_hand_fact_revision` corrects
`rake_paid` and voids facts, and the job's recount saw those too.

### Why the daily window

`CREATE TRIGGER` takes SHARE ROW EXCLUSIVE on `public.ca_hand_facts`, which
blocks its writers. It is hot: 30,574 rows in the ten minutes to 02:58 UTC
(~51/s), written by every hand commit, ~74M rows / 57 GB. CLAUDE.md section 2
rule 10 sends that to the 04:00 America/Chicago freeze. The functions carry no
relation lock and install as soon as they merge; until the window they exist
and nothing calls them, and the job keeps producing the same numbers.

## Equality proof (read-only, production)

| UTC day    | job's GROUP BY (cents) | per-day rule (cents) | equal |
| ---------- | ---------------------- | -------------------- | ----- |
| 2026-10-24 | 4474                   | 4474                 | yes   |
| 2026-10-25 | 7878 (03:01 UTC)       | 7878                 | yes   |
| 2026-10-25 | 8092 (probe, moments later) | 8092            | yes   |

The second measurement was a single rolled-back `DO` block with its helpers in
`pg_temp`, `transaction_read_only` on, ending in `RAISE EXCEPTION`.

## Pinned by

`tests/the-woowoo-half-rake-split-is-written-with-the-hand.law.test.ts`.
