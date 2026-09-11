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
completes its launch through that RPC. The DB half of the recovery partly
exists (`fn_prove_played_spin_launch_recovery`, and the recovery branch inside
`fn_complete_tournament_launch_before_lease_generation`), but it does not
reach far enough, and that was measured rather than guessed.

All 40 were put through the sanctioned pair
(`fn_begin_tournament_launch_*` then `fn_complete_tournament_launch_*`) inside
one transaction that was rolled back, at 17:03 UTC. The result:

| outcome                            | events                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `ok: true`, REGISTERING to RUNNING | 9 (all spins, all still two-handed or three-handed with nobody eliminated) |
| `launch_roster_unproven`           | 31                                                                         |

Every refusal is the same shape: `active_players` 1 or 2 against
`required_players` 2 or 3. The completion RPC proves the roster as it would be
at a launch that has not dealt yet, and these dealt for two hours in 2026-09-08
before their engine died, so the field has since shrunk to its winner. The
`launch_stacks_uncredited` proof already has a played-game escape through
`fn_prove_played_spin_launch_recovery`; the roster proof does not, and the
recovery function itself is written for spins, while 18 of the 31 are heads-up
SNGs and one is an MTT.

So this settlement is two pieces of work, in this order, and neither of them
is a repair job:

1. **The roster proof admits a played field**, through the same kind of
   evidence the stacks proof already accepts, and that evidence covers
   heads-up and multi-table games as well as spins. This is a change to a
   money-critical RPC and it gets its own pass.
2. **An engine lane adopts a REGISTERING row that has already dealt hands**,
   claims the lease and completes its launch through that RPC. Today no lane
   looks at a REGISTERING row at all, which is why these have sat since
   2026-09-08.

Settling the 9 that already prove, while 31 cannot, would leave the record
half-written; they are held together. 40 events, 2,164.60 chips of finalized
pools, still owed.

The four SATELLITE heads-ups in that set carry a further decision after the
launch completes: their finish awards a seat into a target that may itself
have started since 09-08, which is the satellite settlement authority's
decision and not a status flip.
