# A standing rake share replaces the WooWoo cron (2026-10-25)

## The ruling

Dan, 2026-10-24: from 2026-10-24 22:21:59.97593 UTC, half of WooWoo's
(`69f2cefa`) earned rake in KINGS CLUB (`a41434bb`) is reported as KingFish's
(`47965354`). Reporting only. No chips move, and no settled hand, rake
attribution, commission, rakeback or wallet row changes.

## How it first shipped, and why that was a band-aid

Two writes went to production out of band:

- a hand-written row, `woowoo-half-earned-rake-20261024` (+520.52), with no
  migration behind it;
- migration `20261024223153_woowoo_half_earned_rake_credited_to_kingfish`, which
  widened the `amount_cents` CHECK on `smarter_private.player_fee_redemptions`
  from `> 0` to `<> 0`, wrote the mirror row
  `kingfish-from-woowoo-half-earned-rake-20261024` (-520.52), and created
  `smarter_private.fn_woowoo_half_rake_to_kingfish_sync()`. pg_cron job 505,
  `woowoo-half-rake-to-kingfish`, ran it every five minutes.

On each run the function grouped WooWoo's cash hand facts after the cutoff by
UTC day and upserted a `woowoo-half-split-<day>` / `kingfish-from-woowoo-split-<day>`
pair. Three readers subtract those rows: `ca_club_member_fee_totals` (Cash Fees,
member statistics, roster, exports), `ca_player_rake_stats` and
`ca_player_rake_stats_by_club`. That is a compensating write (CLAUDE.md 10.12).
The reported figures trailed the hands by up to five minutes, and the rule
existed only as constants inside a function body.

## The root fix: `20261025030629_a_standing_rake_share_replaces_the_woowoo_cron`

- **`smarter_private.player_rake_share_rules`**: one row per standing share,
  holding `club_id`, `from_user`, `to_user`, `share_bps`, `effective_from`
  (inclusive), an optional `effective_until` and a reason. The table is
  service-only with RLS on. It holds one row: WooWoo to KingFish, 5000 bps,
  from the cutoff. To end the rule, set `effective_until`. Do not delete the row.
- **The readers apply it at read time**, from the rows they already count:
  - the fee reader reads it from the `rake_attributions` rows its
    `ca_club_rake_daily_user` rollup is built from (same UTC day, same
    `fn_ca_launch_accounting_accepts` filter);
  - the two statistics readers call
    `smarter_private.fn_player_rake_share_hand_cents`, which reads the cash hand
    facts. It attributes each hand to its funded club exactly as
    `ca_player_rake_stats_by_club` does (buy-in receipt, then rake attribution,
    then the table's club).

  Rounding follows the cron: per rule and UTC day, `round(rake * share)`. The
  giver loses exactly the cents the receiver gains. `fee_redemption` keeps its
  meaning (the net reporting adjustment), and a new `rake_share` key shows the
  signed share.
- **The same transaction retires the cron**: it unschedules
  `woowoo-half-rake-to-kingfish`, drops the sync function, and deletes only the
  `*-split-<day>` rows it wrote. The `<> 0` CHECK, both fixed 520.52 rows and
  the October 23 lifetime-VIP row are kept as declared one-off events.
- **Guards and assertions before COMMIT**, in one REPEATABLE READ snapshot:
  - the md5 of each body it replaces;
  - the fixed figures, including the closed day 2026-10-24 at exactly 44.74 each way;
  - every closed day's split equal to the rule's share to the cent;
  - for WooWoo and KingFish, lifetime and 7-day, in every reader: the new figure
    equals the old figure moved by exactly the cents the cron had not yet
    written.

## The probe (production, 2026-10-25 03:15:29 UTC, rolled back)

The probe was one self-aborting DO block. It used pg_temp copies of the new
helper and readers and a pg_temp rule table, and it wrote nothing. It ran
under repeatable read with 0 mismatches.

| | Before (cron) | After (rule) |
| --- | --- | --- |
| WooWoo, every reader (fees, stats, club stats; lifetime and 7 days) | 652.59 | 652.59 |
| KingFish, Cash Fees | 895.69 | 895.69 |
| KingFish, rake stats, lifetime | 1,369.57 | 1,369.57 |
| KingFish, rake stats, 7 days | 696.86 | 696.86 |
| KingFish, club rake stats, lifetime | 978.68 | 978.68 |
| KingFish, club rake stats, 7 days | 696.86 | 696.86 |

The cron split was 132.09 (2026-10-24: 44.74; 2026-10-25: 87.35). The rule's
share is 132.09 from both the hand facts and the attributions. The lag at that
instant was 0.00, because the cron had just run at 03:15.

## Recorded, and pinned

- `supabase/migrations/20261024223153_woowoo_half_earned_rake_credited_to_kingfish.sql`
  is the byte-exact recording (md5 `06c2de274fd75213f0decf83b2b62f20`), with
  its row in `scripts/ci/recorded-migrations.manifest.json`.
- `scripts/ci/test-player-fee-redemption.sh` rebuilds the out-of-band state,
  adds a hand the cron has not seen, and checks two things: the fix fails
  before the migration, and after it the share is exact and immediate, respects
  the funded club, ends with the rule, keeps the grants, and leaves no cron
  writing the redemptions.
- `tests/a-rake-share-is-read-not-written-by-a-cron.law.test.ts` replays every
  migration's cron schedule and unschedule and refuses any job left writing the
  fee redemptions. It also pins that the readers read the rule.
