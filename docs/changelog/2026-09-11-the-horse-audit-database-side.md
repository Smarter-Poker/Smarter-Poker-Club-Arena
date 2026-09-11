# The horse audit, database side: three doors applied to production

2026-09-11. The code half of the horse audit is PR #4322. This is the half
that lives in Postgres. Three migrations were applied to production this
afternoon, each probed first in a transaction that was rolled back
(CLAUDE.md 11.5), each recorded in `supabase_migrations.schema_migrations`.

| version          | what it changes                                                         |
| ---------------- | ----------------------------------------------------------------------- |
| `20260911162240` | a horse rebuy is funded by the club its seat represents                 |
| `20260911163011` | a reused seat row is handed to a horse the way it is handed to a person |
| `20260911163252` | the horse door admits late registration and names a finalized pool      |
| `20260911163821` | a stake band is projected onto the games the horse's own host deals     |

Each has its own header saying what was read, what changed and why. The two
that mattered on the floor today are below.

## The rebuy door was asking the wrong club for the chips

See `docs/changelog/2026-09-11-a-horse-rebuy-is-funded-by-the-club-its-seat-represents.md`.
Within six minutes of the apply, Club JAQK and SHARK CLUB carried their first
`horse_funding` ledger rows ever: 4 rows for 1,250.00 and 4 rows for 800.00.

## The horse door refused late registration that a human gets

`fn_register_for_tournament` admits a RUNNING event while
`fn_tournament_late_registration_open()` is true and seats the entrant through
`fn_seat_late_registrant`. The horse door refused every status outside
ANNOUNCED and REGISTERING with `registration_closed`, so every MTT's
`late_reg_levels` and the Free Buy's hour of late registration existed for
people only. Measured in the engine log between 12:27 and 13:27 UTC:
HorseOverlayGuard asked for 9 to 24 horses into "Morning Free Buy (NLH)" on
every two-minute pass and was refused twenty-four times.

Two smaller differences went with it. A finalized pool was not read by the
horse door at all, so the insert met a trigger that RAISED after the wallet
debit path and the locks (235 exceptions per top-up attempt on "Breakfast
Turbo"); it is now a reason, like the human door's. And the cached-count
assertion expected `v_players_before + 1` unconditionally, which is wrong
under RUNNING where the roster trigger does not refresh it.

The horse core, the lifecycle gate and the terminal gate are now the human
door's, line for line. The bodies applied are production's own text from
`pg_get_functiondef`, with only those changes made to them: the audit's draft
had dropped four comment blocks carrying incident history (ONE DEFINITION OF
FULL, MYSTERY BOUNTY, CHIP STANDARD 1.2, and the two lock-order notes in the
terminal gate) and every one of them is back.

Proved before applying: with the fixed bodies in `pg_temp`, a live horse was
put through the door of "DSS Friday $11 NLH Daily" (RUNNING, late
registration open) inside one rolled-back transaction. The production door
refused it with `registration_closed`; the fixed door admitted it, seated it
at table 7 with 10,000 chips, moved the roster from 24 to 25 and took 10.00
from a wallet of 43,937.55. After the rollback the roster was 24 and the
wallet was 43,937.55 again.

The first apply ABORTED on its own assertion, which is the assertion doing its
job: the newly created lifecycle gate had inherited PUBLIC EXECUTE, and the
migration refuses to leave an admission core reachable from a client. The
human lifecycle gate holds no grants at all. An explicit REVOKE was added and
the migration applied on the second run. Nothing was left behind by the first:
the whole transaction rolled back, and the history row written beside it was
deleted before the retry.

## A stake band was projected onto games the horse could never sit at

`fn_assign_horse_stake_bands` ranked every horse by bb/100 and projected the
ladder onto `fn_available_stake_bands()` - the bands with an enabled game
ANYWHERE on the platform. A horse only sits at its own host's tables, and the
two hosts are disjoint sets of horses. Deep Stack Society deals micro, low,
mid and high; Midway Union deals micro, low and mid. The single Deep Stack
25/50 game made 'high' "available" to every Midway horse.

Re-measured read-only at 16:40 UTC in a rolled-back transaction: the next
assignment run would have written 'high' onto 76 Midway horses, none of whom
has a high game to sit at, and `stakeBandAllows` is a hard gate whose downward
fallback only fires when the band is empty platform-wide - which it is not.
That is the 2026-09-05 shape (100 'high' horses with no game) about to happen
again. With the fix all 76 land on 'mid' and Deep Stack Society is unchanged
in every band.

`fn_available_stake_bands` now takes a host and answers for that host;
NULL still answers for the platform. The merit ladder, the hands floor, the
cut points, the hysteresis and the fail-open are untouched.

## What is NOT done, and why

`resume_the_games_dealt_on_0908_that_never_left_registering.sql` stays
unapplied, and its proposal is wrong in a way worth writing down. It flips 36
rows from REGISTERING to RUNNING directly. Probed against production, that
transaction is refused by `fn_refuse_new_entries_while_frozen`:

    TOURNAMENT_LAUNCH_RECEIPT_REQUIRED: REGISTERING to RUNNING belongs to the
    atomic launch completion RPC

The guard is right and the proposal was wrong. The sanctioned path is
`fn_begin_tournament_launch_atomic` then `fn_complete_tournament_launch_atomic`,
and the outer completion requires a live engine lease with a heartbeat under
thirty seconds old. So this settlement is not a migration at all: it is an
engine lane that adopts a REGISTERING row which has already dealt hands and
completes its launch through that RPC. The DB half of the recovery already
exists (`fn_prove_played_spin_launch_recovery`, and the recovery branch inside
`fn_complete_tournament_launch_before_lease_generation`); the engine half is
what is missing. 36 events, 2,164.60 chips of finalized pools unpaid, still
owed. See the note at the top of that file.
