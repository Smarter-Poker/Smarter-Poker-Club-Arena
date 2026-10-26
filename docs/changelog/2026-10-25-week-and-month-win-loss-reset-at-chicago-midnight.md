# Win / Loss: This Week and This Month reset at 12 AM Chicago

Dan, 2026-10-25, on the member Win / Loss card note "Club Chips. Today Resets At
12 AM Chicago Time. Week And Month Use UTC.": "NO THIS WEEK AND MONTH NEEDS TO BE
DONE AT 12AM CHICAGO TIME AS WELL. NOT UTC."

## What changed

- `20261026011138_week_and_month_win_loss_reset_at_chicago_midnight.sql`:
  This Week now starts Monday 12:00 AM America/Chicago and This Month starts on
  the 1st at 12:00 AM America/Chicago, DST aware, for cash and tournament money,
  in both readers (`ca_club_member_win_loss` for the player record and
  `ca_club_members_win_loss` for the member list). Overall is unchanged.
- New internal helper `ca_club_member_chicago_cash(club, user, from, to)` sums
  the existing UTC daily facts covering the Chicago range and removes the two
  partial UTC-day edges from `ca_hand_facts`, the same method Today already
  used. Not callable by anon or authenticated.
- The card note now reads "Club Chips. Today, Week And Month Reset At 12 AM
  Chicago Time."

## Proof

`scripts/dev/test-member-record-live-postgres.sh` gains a week/month block: the
fixture fails against the old readers, passes after the migration (one
microsecond before each Chicago boundary is excluded, the boundary is included,
spring-forward and fall-back weeks, a month and a year rollover, accounting
cutoff, access refusal, record and list agree for every period), and a replay is
refused by the preimage guard.
