# 2026-09-02 - Clubs stop refreshing themselves, and the Promo Wallet shows the BBJ slice

**Dan:** "CLUBS SHOULD NOT BE 'RANDOMLY REFRESHING' ON THERE OWN, IT FEELS LIKE
A BUG OR GLITCH THAT SHOULDN'T HAPPEN... FIX WHAT EVER IS CAUSING THAT TO
HAPPEN. ITS ALSO HAPPENING INSIDE OF THE TABLE MANAGEMENT PAGE, FIX IT FOR
EVERY PAGE AND SUB PAGE OF THE CLUB ARENA."

**Dan:** "NONE OF THE CHIPS FROM THE BBJ RAKE ARE GOING INTO THE PROMO WALLET,
GET TO THE ROOT CAUSE OF WHY THATS NOT HAPPENING AND FIX IT PLEASE. THIS NEEDS
TO BE STANDARD AND HARD WIRED INTO EVERY CLUB, OLD AND NEW."

## 1. The pages were refreshing themselves several times a second

Not a glitch, and not random. Every Club Arena surface is wired the same way:
subscribe to a table, and on each row event re-read the page. That is correct
when the table changes a few times an hour. On a live floor these tables change
several times a second:

| Feed                     | Rate, measured 2026-09-02                 | What moves                               |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| `game_management_events` | 2,108 rows in 10 min for ONE club (3.5/s) | every running game writes one per update |
| `club_members`           | every buy-in and every cash-out           | that member's `chip_balance`             |
| `tables`                 | one UPDATE per hand, per table            | pot, seats, status                       |

So the club lobby ran a full `loadClubData` - `get_club_home` included - every
few seconds, and Table Management ran a five-round-trip `load()` on a 350 ms
debounce, which on that feed means starting again the moment the previous one
lands. That is the flash Dan sees. It is also why `get_club_home` sat near the
top of the database's cost table at 100+ calls a minute across the estate.

Postgres cannot tell us which column moved: these tables use the default
replica identity, so an UPDATE payload carries the new row and nothing to diff
it against, and raising them to `REPLICA IDENTITY FULL` would multiply the WAL
volume that is already the realtime pipeline's bottleneck. So the pages stop
trying to be event-driven and become floor-driven.

Two new pieces, both shared so this is fixed the same way on every page:

- **`useCoalescedRefresh`** (`src/hooks/useCoalescedRefresh.ts`) - at most one
  background refresh per interval however many events arrive; nothing at all
  while the tab is hidden; exactly one read on return; `refreshNow()` for the
  operator's own actions, which never wait.
- **`mergeById`** (`src/utils/mergeById.ts`) - the refresh that does happen
  keeps the identity of every row it did not change, so React leaves those rows'
  DOM alone. This is the half that survives every other fix: a list rebuilt from
  new objects flashes, closes an open menu and jumps the scroll position even
  when every value is identical. An unchanged list returns the same array, so
  `setState` bails out and nothing renders at all.

Applied to `ClubHomePage` (club_members: 30 s floor, joins and departures still
immediate) and `GameManagementPage` (20 s floor, rows merged by id).

## 2. The BBJ promo slice was being collected, banked, and then hidden

The chips were never missing. Deep Stack Society at 22:25 UTC:

```
bbj_contributions    14,341 hands, 4,928.83 dropped
                     main 2,464.52 / backup 1,233.18 / promo 1,231.13
bbj_pools            main 3,438.53 (1,000 seed + accrual)
                     backup 1,219.26, promo 14.78 (last few minutes, unswept)
clubs.promo_balance  1,220.19          <- the promo slice, swept and banked
```

The 50/25/25 split in `bbj_record_contribution` is correct and
`fn_sweep_bbj_promo` has been running all along (684 club sweeps for 29,962.67;
4,848 union sweeps for 57,806.50).

The bug is that nothing could **read** the club account. `fn_club_money_panel`
returns `club_treasury`, `club_pool`, `club_rake_treasury`, the BBJ pool and -
for union staff - `union_promo`, but never `clubs.promo_balance`. With no club
figure to show, `DynamicWallet` fell back to the viewer's own
`agents.promo_wallet_balance`, which is 0.00 for an owner who is not an agent.
1,220.19 of real club money, banked correctly, invisible on every surface.

Migration `20260902222851_the_club_promo_wallet_the_bbj_has_been_funding_all_along`
adds `club_promo_wallet` to the panel, beside `club_treasury` and at the same
sensitivity. Three accounts wear the label "Promo Wallet" and the row now picks
by surface, then by role - the same rule that decides the Club Bank row:

| Surface / viewer     | Account                                         |
| -------------------- | ----------------------------------------------- |
| union                | `union_wallets.promo_wallet` (the swept slice)  |
| club, Club Bank role | `clubs.promo_balance` (this club's slice)       |
| club, agent          | `agents.promo_wallet_balance` (their own float) |

A club inside a union banks its promo slice in the union wallet, so the club
figure is honestly 0 there and `union_promo` continues to carry it on the union
surface - the wallet separation law is unchanged.

## 3. Two database repairs that needed no deploy

**32 heads-up boards that had been retrying since 2026-09-01 18:42** - Deep
Stack Society SNGs with one paid seat each and no opponent ever coming.
Cancelled through `atomic_cancel_tournament`, which refunded 852.00 chips to 32
horses and closed the tables; the deferred `tournaments_cancel_must_refund`
trigger enforced the refund on every one.

**Migration `20260902224053_a_count_that_did_not_move_is_not_a_write`** -
`fn_sync_seat_first_player_count` wrote `current_players` on both the table and
the tournament unconditionally, and it is called on every seat change on every
seat-first board plus every retry of the engine's fill loop: 24,490 calls in 76
minutes, nearly all of them rewriting a row to the value it already held. An
UPDATE that changes nothing still writes a heap tuple, touches every index,
writes WAL, and has that WAL decoded and RLS-checked by Realtime for every
subscribed client - and the realtime WAL poller was the single largest consumer
on the database (4,072 s, 538 ms mean, over that same window). Three guarded
writes remove the write, the WAL and the decode together.

## Verification

`tsc --noEmit` clean. Client suite 11,555/11,555, including 17 new tests
(`theClubStopsRefreshingItself`, `theClubPromoWalletIsTheBbjSlice`). Both
migrations were probed inside a rolled-back transaction before being applied,
and both repo mirrors are byte-exact exports from `schema_migrations`.

## Addendum 2026-09-03 - Shark Club and Club JAQK showed ACTIVE 0

**Dan:** "SHARK CLUB & CLUB JAQK AREN'T DISPLAYING THE 'ACTIVE PLAYERS' THIS BUG
NEEDS TO BE FIXED."

Both cards read MEMBERS 593 / 584 and ACTIVE 0. Measured that morning:

| Club                            | Members | `t.club_id = club` | club OR its union |
| ------------------------------- | ------- | ------------------ | ----------------- |
| SHARK CLUB                      | 593     | 0                  | 475               |
| Club JAQK                       | 584     | 0                  | 471               |
| Deep Stack Society (standalone) | 417     | 234                | 234               |

Both are member clubs of Midway Union, and a union floor's tables are stamped
with the **union's** id - that is what a union is: one shared floor every member
club's players sit at. `fn_batch_club_realtime_active_counts` required
`t.club_id = requested.club_id`, so for a club inside a union the join could
never match. The answer was not stale or racy, it was structurally 0 forever,
however busy the floor.

Migration `20260903080748_a_union_clubs_active_players_sit_at_union_tables`
counts a member as active when they hold a live seat on their club's **floor** -
the club's own tables, or, when the club belongs to a union, that union's
tables. The union is read from the club row, never from a parameter. A
standalone club has a NULL `union_id`, so the second arm can never fire and its
count is byte-for-byte what it was.

Verified live immediately after applying: SHARK CLUB 477/593, Club JAQK 473/584,
Midway Union 248/328 and Deep Stack Society 234/417 both unchanged. This is a
database-only fix, so the cards corrected themselves without a publish.

The club card was the last reader still counting by `club_id` alone -
`get_club_home` and `get_club_players_playing` already resolve the union scope.
