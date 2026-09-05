# The break counts orbits, not only minutes (2026-09-05, 03:50 CDT)

Migration `20260905083756_the_break_counts_orbits_not_only_minutes.sql`,
applied to production 03:53 CDT (recorded in `schema_migrations`). Branch
`fix/the-break-counts-orbits-not-only-minutes`. Companion engine change on
`fix/a-buyer-is-counted-once-and-a-barred-horse-is-not-a-buyer` (the feeder
loop's other half).

## What was read

Six hours to 02:35 CDT: 81 `feeder_opened`, 12 `feeder_live`, 69
`feeder_abandoned`, 60 `table_break_completed`. Last hour: 12 opened, 2 live,
11 abandoned. Every abandoned feeder had the same shape: Main 1 full at 6/6,
the controller told two buyers existed, the feeder opened, nobody ever sat on
it (`feeder_seats_ever = 0`), it died at 3 minutes, rested 2, reopened. One
game did that every 5.5 minutes all night.

The engine log had the answer: 341 of 349 buy-in refusals in the hour were
`VPIP_BARRED` (`Removed for low VPIP: no seat in this game until the bar
lifts`). 35 horses held 57 two-hour bars (migration 20260905064000), all on
host `fade0000`. The fleet counted them as buyers and picked them; the door
refused them. And one spare horse was counted as a buyer for every full game
on the host at once. That half is the engine branch.

## What this migration changes in `fn_cash_cluster_tick`

1. **BREAK (step 5) counts orbits.** OPORD 1.4 section 18.3: the close
   condition must hold for the SHORTER of two completed orbits on the
   candidate or five minutes. The tick used the clock only, so a table that
   dealt twenty hands with the whole game fitting elsewhere still waited the
   fifth minute and usually lost its eligibility to a refill first. Now:
   five minutes have passed, OR `hand_history` rows on the candidate since
   `break_eligible_since` >= 2 x its seated count. A candidate with fewer
   than two seated deals no hands, so only the clock runs for it. One
   indexed read (`idx_hand_history_table_created_id`), only for a game with
   an eligible candidate. `table_break_started` now carries
   `eligible_since`, `hands_since_eligible`, `orbit`.
2. **RECONCILE: lifecycle follows status.** 15 cluster tables had
   `status = 'closed'` with `lifecycle = 'live'` (the operator close-game
   action and the pre-controller close path write status only). The census
   reads status and drops them; the roles step reads lifecycle and counts
   them. With nobody seated the lifecycle now follows, with a
   `lifecycle_followed_status` event.
3. **ROLES: a lone feeder becomes Main 1.** Found live: `NLH 0.05/0.10
Classic` (disabled by an operator 2026-09-04 16:47), Main 1 closed by
   status, five horses still on its feeder with no Main to be on, and
   nothing promoted it because the roles step only renumbers mains. Per
   1.3 s9.2 (oldest live table is Main 1) the oldest live feeder is promoted
   when no main is live, with `feeder_promoted_to_main {reason:
no_live_main}`.

## The live body was not in the repo

The running function was 20260905060000's body plus two string
substitutions applied to the live source (20260905041557's expired-hold
rest and the Gate 5 snapshot block). No file held the result; this one does,
whole. The migration asserts the live md5 before (4aa56484...) and after
(a7636d29...) so it aborts rather than overwrite a tick that moved.

## How it was proven (rolled back, psql, one transaction each)

- Board 0: the disabled game above. Actions: `lifecycle_followed_status: 1`,
  `feeder_became_main1`. The feeder is `main/1 live running` afterwards.
- Board A: enabled game, feeder with 4 seated, Main 1 widened so everyone
  fits, eligible 90 s ago, 8 synthetic hands since. Breaks:
  `hands_since_eligible 8, orbit 4`.
- Board B: 7 hands, 90 s. Stays eligible, does not break.
- Board C: 7 hands, eligible 6 minutes ago. Breaks on the clock arm.

## How to verify live

```sql
select payload->>'orbit' orbit, payload->>'hands_since_eligible' hands,
       (at - (payload->>'eligible_since')::timestamptz) waited
  from cash_cluster_events where kind='table_break_started' and at > now() - interval '6 hours';
```

`waited` under five minutes with `hands >= 2*orbit` is the new arm firing.
Feeder health is `feeder_live / feeder_opened` over the same window; it was
12/81 and should climb once the engine branch ships.

## Second migration on this branch: one chair per player per game, every tick

`20260905090006_one_chair_per_player_per_game_is_reconciled_every_tick.sql`,
applied 04:05 CDT. The "roster drift" in the handoff (298 roster rows against
303 seats, later 192 against 193) was not drift: the roster is per player,
and the gap was exactly the players holding two chairs in one game (five
pairs earlier, one at 03:58). The pairs predate the one-seat-per-game door;
the tick settled a second chair only on a breaking table. Now RECONCILE walks
every player with more than one live chair in the game: the oldest chair is
theirs; each newer chair on a `waiting` table is cashed out now through the
same three calls the breaking branch uses (idempotent, credits the club
wallet), and on a running table is flagged `leave_pending` so the engine
cashes it out at the hand boundary. Events `second_chair_cashed_out {where:
reconcile}` and `second_chair_leave_pending`.

Proven rolled back on the real pair (horse d49f4819, NLH 0.25/0.50 Classic):
running feeder -> `leave_pending` set, chips untouched; feeder set to
`waiting` -> chair cashed out, 76.72 moved from the felt to the wallet
(11224.17 -> 11300.89), `fn_unaccounted_seat_exits()` empty for that table,
second tick a no-op, roster 193 = seats 193.

Money paragraph (CLAUDE.md 10.9): one player, a horse, gets its own 74-77
chips back from a chair it should never have had, through the platform's own
cash-out. Nothing is taken from anyone.

## Afternoon, 2026-09-05: two more migrations on this branch, both from Dan's report

Dan, 14:40 CDT: "GAMES ARE NOT RUNNING RIGHT, LOBBIES SAY 50 PLAYERS, AND
ONLY ONE SITTING." Read live: `NLH 0.05/0.10 Classic` with 42 players on 16
tables (main1=9 ... main7=1 main10=0 ... feeder=0); `PLO6 0.50/1 Classic`
with 1 player on 4 tables; the same on three more. The card was right
(`cluster_players` counts every seat in the game); the table you land on
had one. Two defects, one of them mine.

**`20260905194329_main_one_is_looked_up_on_the_live_board_not_the_oldest_row`**
(applied 14:47). The R3 repair ("an enabled game always has Main 1 open")
selected the OLDEST table ever numbered Main 1, closed or not. On the loop
game the original Main 1 was closed for good - `lifecycle_followed_status`
from 083756 had made its lifecycle agree with its status, where before it
read `live` and took the harmless status-repair branch - and the game was
re-enabled at 08:01. From then on every tick found a closed row and opened a
NEW Main 1: `main_opened` 3,000 between 08:01 and 10:29, `main_renumbered`
3,114, `move_planned` 10,989; 3,002 table rows on one game. Now R3 looks for
a LIVE or opening Main 1; a game with any live table but no such Main 1
opens nothing (the ROLES step promotes the oldest live table, 1.3 s9.2);
only a game with no live table at all opens one; and an enabled game's Main
1 is exempt from lifecycle-follows-status so a status-only close is repaired
in place. Probed rolled back: the loop game opens nothing; an empty Main 1
closed by status is reopened in place (same id); a game with no live table
opens exactly one Main 1 and only once. The 2,986 closed rows are left as
history; nothing is deleted.

**`20260905194840_the_break_consolidates_a_thin_game_the_floor_was_never_a_bar`**
(applied 14:51). `break_eligible_since` was NULL on every table of both
games: the BREAK rule never armed, because it required
`seated_total >= floor x remaining_tables` (the rest must average at or
above the maintain floor after the break). Breaking a table never makes the
rest shorter, so that clause could only refuse the breaks that matter most:
1 >= 3 x 3 and 42 >= 4 x 15 are never true. Games grew (R3 loop, feeder
over-count) and could not shrink. The clause is gone; the STRICT fit stays
(everyone fits AND a seat stays open, so the OPEN rule cannot fire on the
same board). The candidate order prefers an empty table, then the feeder,
then the highest main. A candidate with nobody or one player has no hand to
protect, so its window is 60 seconds; two-plus seated keeps two orbits or
five minutes. Probed rolled back: the 1-player/4-table game sheds a table per
minute down to one; the 16-table game arms its empty table first; a full
two-table game (10 of 12 seats) does not arm. Live at 14:51:16, twenty
seconds after apply: 5 tables armed, 0 tick errors.
