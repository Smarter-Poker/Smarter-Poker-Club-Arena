# Club Data reads the club from the money records

Date: 2026-10-17
Migration: `supabase/migrations/20261017161545_club_data_reads_the_club_from_the_money_records.sql`
Client: `src/components/club/ClubBottomNav.tsx`

## What was still wrong after #7262

Read from production between 16:00 and 16:20 UTC:

1. **The club lookup crossed tables.** `fn_ca_cash_reporting_club` returned the
   club of the seat a player took most recently at ANY table, and ignored the
   union. 150 players were seated at more than one cash table, 63 of them in two
   or more clubs, so their rake moved between clubs hand by hand. JAQK showed
   86 tables where its players had played at 133.
2. **Tournaments were never touched.** The #7262 header said the tournament
   lookup was updated; its SQL never changed `ca_reporting_tournament_clubs_for_user`,
   which credits a union player's fees and results to the first club they ever
   joined. Every JAQK member joined SHARK CLUB first, so JAQK's tournament fees
   for the day read 1.10.
3. **No past day was re-counted.** JAQK on 2026-10-16 read 41 games and
   1,250.32 in fees; on 2026-09-20, 7 games and 158.97.
4. **The Data button flashed** for regular players while the workspace role
   was loading, and stayed on pages outside a club, because `canSeeData` was
   true whenever the role was still unknown.

## The fix: read the club from the record the money already wrote

| Money | Record | Measured |
| --- | --- | --- |
| Cash rake | `rake_attributions` (player, hand, club) | equals `rake_records` to the cent on 2026-09-20 (61,430.89) and 2026-10-16 (165,952.61); every hand since 2026-09-18 |
| Tournament fee | `accounting_tournament_fee_sources` (entrant, fee, club) | equals `rake_records` to the cent on both days |
| Cash buy-in / cash-out | `chip_ledger` leg at that table, same instant | 11,068 of 11,068 cash wallet rows on 2026-10-16 |
| Tournament result | `tournament_players.club_id` (entry club) | agrees with the ledger buy-in leg on 16,482 of 16,482 entries |

Where a record is missing - cash hands of 2026-09-16/17 (before attributions
were written) and tournament fee reversals (which never get a fee source) - the
fallback is the player's seat or last buy-in **at that table**
(`fn_ca_cash_hand_club`) or their entry **into that event**
(`fn_ca_tournament_entry_club`).

Live writers: a statement trigger on `rake_attributions` (cash rake, hands,
players), a statement trigger on `accounting_tournament_fee_sources`
(tournament fees), the wallet trigger (buy-ins/outs and tournament results, one
entry club), and the rake trigger now only for fee reversals. Every rebuild
entry point (`fn_club_table_daily_refresh_day`, the hourly catch-up,
`ca_refresh_reporting_rollups_base`) goes through the same
`fn_ca_club_data_stage` / `fn_ca_club_data_publish`, so the rebuild and the live
writers cannot disagree.

Probe (rolled back, production, 2026-10-16 full day, 39 s):

| Club | Cash tables | Events | Cash fees | Tournament fees |
| --- | ---: | ---: | ---: | ---: |
| Club JAQK | 197 | 16,561 | 81,926.00 | 40,742.76 |
| SHARK CLUB | 198 | 14,688 | 83,284.81 | 34,236.15 |
| Deep Stack Society | 0 | 19,532 | - | 54,478.80 |
| Lightning Internal Pilot | 21 | 0 | 741.80 | - |

## Re-counting history

After the migration applies, each day from 2026-09-16 through yesterday is
re-counted one at a time, then today:

```sql
SELECT public.fn_ca_club_data_rebuild_day(d::date)
  FROM generate_series(date '2026-09-16', current_date - 1, interval '1 day') d;  -- one call per day
SELECT public.fn_ca_club_data_rebuild_day(current_date);
```

A past day takes only its own day lock. The live day is counted up to five
minutes before the call without stopping play, then holds the reporting lock
only to count those minutes and replace the rows that differ. Publishing
replaces only rows whose values changed.

## Footer

The Data button now shows only on a confirmed answer: the workspace role once
it is ready for that club, or `ca_club_data_access(club)` - the exact rule
`ca_club_data_screen` enforces - remembered per account and club. Unknown means
hidden. `fn_ca_club_user_reporting_scope` is no longer callable by clients (it
answered for any user id).

## Pinned by

- `tests/club-data-is-live-and-counts-the-felt.law.test.ts`
- `tests/components/ClubBottomNav.test.tsx` (the Data button appears only once access is confirmed)
