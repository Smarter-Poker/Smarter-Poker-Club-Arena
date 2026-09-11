# A horse rebuy is funded by the club its seat represents

2026-09-11, lane E of the horse audit. Applied to production at 16:24 UTC as
migration `20260911162240`.

## What was wrong

`fn_horse_fund_from_treasury` is the only funding path the engine has for a
busted horse at a cash table (`autoRebuyHorse` ->
`recoverBustedSeatedHorses`, and step 5 of settlement). Both layers of it
resolved the treasury to debit as `SELECT club_id FROM tables WHERE id =
p_table_id`.

Every Midway cluster table carries `tables.club_id = fade0000-...-0001`, the
union's own club row. That row's `chip_treasury` is 0.50. The horses sitting
on those tables are members of Club JAQK (937,497.23) and SHARK CLUB
(885,816.01), and their seats are stamped with those clubs by
`fn_seat_club_for_user`, exactly as a human's seat would be.

So the door answered `insufficient club treasury` to every Midway rebuy,
`autoRebuyHorse` mapped that to `declined`, and the engine released the seat
with reason `busted_unfunded`.

Read from rows on 2026-09-11:

| club                  | horse_funding ledger rows                     |
| --------------------- | --------------------------------------------- |
| Deep Stack Society    | every day, 117 to 4,683                       |
| Midway Union          | 81 rows on 09-02, then nothing for nine days  |
| Club JAQK, SHARK CLUB | zero, ever. Their treasuries were never asked |

Live cash seats at the time of the fix: 225 on Deep Stack Society (table club
== seat club, so reloads worked), 166 JAQK and 121 SHARK on Midway tables
(table club != seat club, so none of them could reload). Midway horse cash
exits in the preceding 24 hours: 484, of which 310 left with a zero stack.

This is CLAUDE.md 10.5. A Deep Stack horse that busts reloads and keeps
playing; a Midway horse that busts stands up and the seat empties. Same
platform, same code, different club.

## The fix

Both layers now resolve the funding club as the live seat's `club_id`,
falling back to the table's club only when the seat carries none (no live
cash seat does). The treasury locked, debited, journalled and replay-checked
is that club. Every other money door on the platform already worked this way:
`atomic_credit_wallet_and_log` reads `table_seats.club_id` first, the addon
reads the seat's club, and the engine reads the rebuy roll at the seat's club.
This door was the one that did not.

The receipt keeps `club_id` as the TABLE's club, because the deployed engine
verifies `data.club_id === this.tableInfo.club_id`; returning the funding club
there would turn every Midway reload into `unknown` after the chips had
already moved. The funding club is reported alongside it as
`treasury_club_id`.

Nothing else in either body changed. The production bodies were read from
`pg_proc` before and after (md5 `87eff86b...` and `3ae90f74...` before).

## How it was proved

CLAUDE.md 11.5: both fixed bodies were installed into `pg_temp` and run
against a real live Midway horse seat inside one psql transaction that was
rolled back. The production door refused the same seat with `insufficient
club treasury` (treasury 0.50, needed 200.00); the fixed door returned
success, moved the seat from 400.00 to 600.00, took 200.00 from Club JAQK
(937,497.23 to 937,297.23), left the union row untouched at 0.50, and wrote
one `horse_funding` ledger row at the seat's club. After the rollback the
treasury, the ledger and the seat were all unchanged.

## The effect

Within six minutes of the apply, `chip_ledger` carried the first
`horse_funding` rows either member club has ever had: Club JAQK 4 rows for
1,250.00, SHARK CLUB 4 rows for 800.00.

## Not a repair job

No row is back-filled and nobody is paid for a past bust. A horse that was
stood up kept its wallet; nothing was taken from it. CLAUDE.md 10.11 and
10.12: the line that produced the wrong outcome is the thing that changed.
