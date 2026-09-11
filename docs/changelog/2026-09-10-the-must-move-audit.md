# 2026-09-10 - The Must Move audit: Classic, Action and Madness, line by line

Dan: "I NEED YOU TO DO A FULL AUDIT OF THE MUST MOVE GAMES, AND THE FUNCTIONALITY
BETWEEN CLASSIC, ACTION AND MADNESS ... FIND ANY AND ALL BUGS, GAPS, STUBS,
ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE ... WE NEED TO
INSURE THIS IS 100% GOOD TO GO BEFORE WE ADD ON 'LIGHTNING POKER'."

Ten lanes, each reading its surface line by line against the LIVE production
bodies rather than the repo's copy of them. Every lane's full record is under
`docs/audits/2026-09-09-must-move-audit/` (lane-A.md through lane-J.md, ~3,900
lines, every number stamped with the minute it was read). This file is the
summary and the shipping record.

## The headline: the three games really are three games

The felt keeps the promise the picker makes. Read from `hand_history` joined to
`cash_games` over 24,000 live hands, and independently a second time by lane J:

| template | sold as | what the felt did |
| --- | --- | --- |
| classic | No Antes, No Bombs, No VPIP Floor | 0 antes, 0 bombs, 0 floor |
| action | Small Blind Ante, VPIP Floor 30, Double Board Bomb Every 15 Minutes | all four, every table |
| madness | Big Blind Ante, VPIP Floor 50, Double Board Bomb Every Orbit | all four, every table |

0 of 109 enabled games and 0 of 141 open tables disagree with their template,
and 4,344 hands in the last hour carried zero cross-template mismatches. The
09-09 realignment held. What follows are the ways that was not yet GUARANTEED,
and the defects found underneath it.

## P0 - the horse session rotator was dead for three and a half hours

At 17:23:50 and 17:25:29 UTC on 09-09 two migrations added composite foreign
keys from `table_seats` to `tables`. That gave the pair THREE relationships,
and PostgREST refuses an unqualified embed when there is more than one
(PGRST201, HTTP 300). `HorseSessionRotator.rotate()`'s single read of the room
is that embed, and its error handler was a bare `return` - no log, no metric,
no alarm.

Everything on the fleet's departure side stopped at once: session ends, the
lone stand, tournament leaves, seat changes, top-ups, breaks, the retiring-table
drain, and the human release rule - the only thing that opens a seat for a
person on a waiting list. It was found from the felt, not from a log: four
cluster tables holding one horse for 415, 129, 121 and 54 minutes against a
ten-minute rule, and `grep -c SessionRotator` over three hours of engine log
returning 1, the boot banner.

The embed now names `table_seats_table_id_fkey`, so a future foreign key cannot
take it down again, and a failed page reports and warns naming what stops before
it declines the pass. Law: `aDeadReadIsNotAnEmptyRoom.law.test.ts`.

**`origin/main` never fixed this read.** #3982 disambiguated the lobby only;
migration `20260909205508` dropped the composite keys, so main's rotator works
today by accident and is one migration from going dark again. This branch
carries the only fix on that path.

## P1 - the balancer and the must-move step were fighting every hand

The largest thing on the floor, and in no handoff. `fn_cash_clusters_tick_all`
runs the tick and then `fn_cash_cluster_balance` on every pass. Tick step 2
holds every main FULL from the feeder; the balancer's pool was Main 2..N PLUS
the feeder, so it moved a player main -> feeder, and the next tick moved them
straight back.

Measured: 355 exact round trips in one hour, 47 players moved 787 times, two
players moved 55 times each - one move every 65 seconds - median 38 seconds
between the leg and the leg that reversed it, present in every one of the last
30 hours, worst exactly when the floor is fullest. It also drove the 55P03
lock-timeout tick errors and a `SEAT_MOVE_GAME_SCOPE_MISMATCH` burst. What a
player saw: a seat change they never asked for every minute, and "Moving After
This Hand" as the normal state of the game.

The pool is now the live FEEDERS and nothing else. A main never gives up a
player to the balancer, because step 2 is the one writer of main seats and its
order is Dan's must-move order (longest-seated first) while the balancer's is
the opposite (newest first) - two writers with opposite orders on the same
seats IS the round trip. Expected effect, measured against the 17:24-18:24 hour:
roughly 784 of 1,123 moves an hour stop happening.

## The rest, by lane

**A (cluster tick and lifecycle).** A move's deadline ran while the platform was
parking: the tick gates on `fn_platform_frozen()` while the executor gates on
the wider `fn_entry_purchases_frozen()`, so in the 2.5-minute gap the tick
expired moves the executor was guaranteed to refuse and wrote
`engine_did_not_execute_before_expiry` - blaming the engine for a platform
refusal. 102 of 269 expiries in 48 hours fell in the two five-minute buckets
around :55. A game whose only table was `lifecycle=closed / status=waiting` was
outside the worklist, so the repair written for it lived inside the tick that
could never run: two games, never ticked once. A breaking Main kept a number a
survivor was renumbered into. The cancelled-move back-off was keyed on plan
time rather than refusal time, so the minute a refusal is owed had usually
already lapsed - now `cash_seat_moves.resolved_at`, stamped by one trigger
rather than eleven UPDATE sites.

**B (seat moves, lobby, seat change).** A player who left the game kept their
move, their list place and their spent seat change: the destination chair stayed
reserved for someone who had gone (137 moves a day cancelled `player_not_seated`),
and a rejoin inside that window kept the old position against Dan's "bottom of
the list" rule. A seat change listed from a feeder that the tick renumbered to
Main 1 was still executed off the main game, against "NEVER TO THE MAIN GAME".
`authenticated` held INSERT/UPDATE/DELETE on `cash_seat_moves` behind SELECT-only
RLS - a grant lying about who may write. The join door returned a chair it did
not hold, so two players were told to take the same last seat and the loser was
refused at the buy-in; it now writes the same 60-second hold the open-seat offer
writes, which the buy-in gate already honours.

**C (templates).** The template promise was enforced at the front door only: the
trigger pinned the VPIP fields but a direct snapshot UPDATE could put an ante or
a bomb back on a Classic game. `fn_cash_game_ensure` did not know which template
it was ensuring - a Stable Hand order for Classic NLH 1/2 returned "NLH 1/2
Action". The reconciler reconciled half the table: 42 tables carried a stale
stakes label and two PLO5 tables sat at seven seats on a six-max game, one with
a player in seat 7.

**D (engine, moves).** A failed read released every swap hold, and because a
swap is landed by the PARTNER's table transaction, that let a player be moved
mid-hand - the one thing the whole design exists to prevent. A held swap side
wedged an idle table for ever when its move died. 391 terminal refusals in 24
hours told the player nothing after promising "Moving After This Hand". An entry
hold the once-per-process restore never saw re-billed a second big blind after
the next restart. Stale presence, time bank, straddle and pre-action stayed on
the old table after a move.

**E (engine, templates).** The engine cached the templated rules until restart,
so a Classic table realigned by the 09-09 migration would have kept dealing
bombs and charging antes until the next :55. The VPIP floor reset itself every
time the game moved you. Run It Twice was on one table of a game and off
another, so a player the cluster moved lost the feature mid-session with no
message.

**F (horse fleet).** The P0 above, plus: a horse's seat-change memo was keyed on
the game and held for 12 hours while the door's budget is per stay, so a
rejoining horse was denied a button a human gets (10.5). And Madness and Action
were evicting the fleet at hand 11 - 56% of Madness sittings and 27% of Action
sittings ended `vpip_evicted`, median at the first moment the rule can fire,
each writing a two-hour bar. The mean cleared the floor; the ten-hand SAMPLE did
not, and the horse aimed at floor+10 against ~15 points of standard error. The
cushion is now derived from the judged window rather than guessed. The floors
30 and 50 are untouched - they are Dan's.

**G (lobby).** Handoff item 5.2 is closed: the three derivations of "how many
players and tables in this game" are one definition. A disabled game offered
JOIN GAME that could only fail; a player already seated on the feeder was
offered it too; a table the controller closed stayed on the board; the status
chips called a must-move game Full.

**H (the felt).** The lobby printed raw database errors into the corner
(`GAME_NOT_FOUND: <uuid>`, PostgREST JSON). A must-move re-pointed the tab but
the URL kept naming the OLD table, so a reload after a move re-opened a table
the hero had left - and after a break, one that no longer existed. The masthead
ellipsized the stakes on a phone: "MADNESS NLH 1/2 + BB Ante" printed as
"MADNESS NLH 1/..." at both 375 and 393px.

**I (create flow).** The rules step still offered an ante radio and four bomb-pot
controls that the server stopped reading on 09-09 - a control the server ignores
is a lie to the host, so there is none now; the four locked rules are printed as
the template's promise. `GAME_EXISTS` named the wrong game for the band case. A
locked key that arrived different was silently ignored and now raises
`OVERRIDE_LOCKED`. Two taps in one tick could create two games.

**J (production, read-only).** The evidence base every other lane was checked
against, and the source of the two P1s above. All nine cluster invariants clean
at both reads (446 seats = 446 roster rows, zero drift); 109/109 games ticked
inside 90 seconds; 187 breaks started and 187 completed.

## What is NOT in this branch, and why

- **The `hand_projection_outbox` stall** (lane J, J-2): 108,823 rows, oldest
  08:13 UTC, stats and missions and rakeback basis late by up to ten hours for
  every hand in the window, and nothing alarmed. It drains again and the backlog
  is gone, but it belongs to the engine's projection lane, not this one. It
  needs a reader for "outbox oldest row age" (10.86 rule 3).
- **`table_waitlist` RLS is FOR ALL** (lane B, F11), so a browser can insert its
  own `notified` hold at any table for any duration. Pre-existing, security, and
  it needs the client's direct-write callers enumerated before the policy is
  narrowed or a legitimate leave-waitlist button breaks.
- **The buy-in gate ignores the planner's pending-move reservations** (lane B,
  F10): 17 of 41 `destination_full` cancels in 24 hours were a buy-in taking a
  chair the tick had already promised. The one-clause patch is written out in
  lane-B.md section 7.5.
- **Eight other files carry the same unqualified PostgREST embed** the P0 was
  (tournament x5, client x3). Not broken now that the composite keys are gone,
  one identifier each, listed with line numbers in lane-F.md.
- **No engine-side teardown of the in-process mirrors for an eliminated
  tournament player** since main retired `releaseDeadTournamentSeats` (lane D).
  Flagged rather than fixed: putting it back in that file is what 10.12 forbids.

## Migrations

Eleven, all probed ROLLED BACK against production (`kuklfnapbkmacvwxktbh`) in
one psql transaction in version order, every inline assertion passing, and the
live bodies verified untouched afterwards. None is applied. Apply in version
order: `20260909181230` before `20260909191454`.

## The brief named the wrong database

The swarm brief carried project `ydsaqnnuwyvtyxgvrnys`. That is pepnationlab-prod
and it holds no `cash_*` object at all; Club Arena is `kuklfnapbkmacvwxktbh`.
Every lane caught it independently and re-read against the right one, and lane J
discarded the two readings it had taken before it noticed. Recorded because an
empty answer from the wrong database reads exactly like a healthy platform, which
is the 10.86 failure this estate keeps paying for.

## Gate

Merged `origin/main` (176 commits across two catch-ups; four conflicts, each
resolved by keeping both sides' intent). Root `npx tsc --noEmit` clean, server
`npx tsc --noEmit` clean, `npx vitest run tests/` 1,381 files and 18,872 tests
passed, server `npx vitest run` 665 files and 9,146 tests passed, `npm run build`
exit 0.

Twelve tests went red on the merge and every one was a pin whose mechanism had
moved, not a behaviour that had broken. Each was moved in the same edit and
several came back stricter: the `activeIndex` pin was case-sensitive and could
never have matched `setActiveIndex(`, so it was tripping on the word in a comment
while blind to the call beside it; four byte-counted source windows became
structural ones; a cache fixture that hardcoded `v3` was silently orphaned by a
deliberate bump to `v4`. Where a pin moved, it was proved it can still fail by
inserting the defect it forbids and watching it go red.
