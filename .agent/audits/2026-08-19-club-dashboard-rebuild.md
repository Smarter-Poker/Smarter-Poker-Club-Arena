# 2026-08-19 — Club Dashboard rebuild (Data tab)

## What was broken

The club dashboard (/clubs/:id/dashboard) had no real functionality:

1. Top Players showed +0.00 for everyone: the leaderboard read
   club_members.chips_won/chips_lost/hands_played, which NOTHING writes
   (0 non-zero rows across 327 members of the busiest club).
2. Recent Activity showed "No activity yet" forever: it queried a
   club_activity table that does not exist in production.
3. Online Now was 0 with a running table: it read club_members.last_active,
   which nothing updates. Actual occupancy lives in table_seats.
4. The Time Range filter (Today/Week/Month/All) was wired to nothing.
5. "View All Activity" linked to ?tab=activity but the tab param was never
   read.
6. Ranks 1-3 rendered as empty strings (stripped emoji medals).
7. Tables tab was a stub (two links, no table list).
8. Active-table count missed tables with status='running' but
   is_deleted=true (engine keeps dealing on them).
9. Emoji in source (rule violation) across quick actions and tab labels.

## Fix

DB (migration 20260819_club_dashboard_rpcs.sql, applied to production):

- club_member_daily_stats: per (club,user,day) aggregates, maintained by an
  exception-safe AFTER INSERT trigger on hand_history; backfilled
  2026-05-21 -> 2026-08-19 from 2.25M hands via ca_backfill_club_member_stats.
- ca_club_top_players(club, since, limit): real profit/hands leaderboard
  with time-range support.
- ca_club_dashboard_stats(club): one-shot stats (members, online-now from
  live seats + recent activity, active tables, hands/rake today, new this
  week).
- ca_club_activity(club, limit): activity feed synthesized from member
  joins, announcements, big pots (>= 40BB, 48h), table starts.
- Grants: authenticated + service_role only; backfill service_role only.

Frontend: ClubDashboard.tsx, ClubStatsCards.tsx, ClubActivityFeed.tsx moved
to the RPCs; Time Range drives p_since; ?tab= deep-linking works; Tables tab
lists real tables with status badges and /table/:id links; rank badges are
styled 1/2/3 circles; silent-refresh + coalesced bus reload preserved from
origin/main; emoji removed.

## Verified

- ca_club_top_players for Midway Union week range returns real profits.
- ca_club_dashboard_stats: online_now=8, hands_today=1018, rake=432.12.
- ca_club_activity returns big-hand events with player names.
- tsc --noEmit clean and vite production build green on origin/main + these
  changes (clean overlay; the dirty shared working tree was not used).
