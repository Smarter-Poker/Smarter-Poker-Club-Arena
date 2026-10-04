# tests/a-diamond-satellite-seat-is-a-whole-ticket.law.test.ts

A Diamond satellite pays its prize bank in whole tickets into its Diamond
target, each ticket the target's buy-in plus its fee, and the rest as whole
Diamonds to the single bubble. The chip estate's two settlement authorities
(single winner and cohort), their receipt readers, the award capture trigger
and the creation guard are reused; what a Diamond seat needed is custody. The
new owner-only door fn_poker_diamond_tournament_seat_transfer moves the
ticket custody to custody: it drains the satellite's prize bank (a release
movement on each drained entry row), opens a new active entry custody row for
the qualifier in the target with one reserve movement, and writes a prize
ledger row out of the satellite and an entry ledger row into the target with
the target's own prize and fee parts. No wallet moves: the one journal row the
movements carry is amount 0 at the unchanged balance, which the register does
not follow, so the supply identity does not move. Both authorities call it
right after the target registration is written and before any chair is taken,
because the cohort deals a qualifier into a running target and a Diamond chair
is admitted only against an active funded entry.

The law pins the decisions the rehearsal proved: the unit divides nowhere (the
pool, the ticket and the remainder are whole Diamonds, a residue is refused by
name before any Diamond moves, so none is ever left or rounded away); the
assets never cross, refused by name at the Diamond creation door, in the guard
every satellite row passes through and in both settlement authorities, while
the two chip-rail seat doors refuse any Diamond satellite; duplicate
qualification is the chip rule untouched (a qualifier already holding a target
entry takes the ticket's value in whole Diamonds); a qualifier at the
four-table cap is refused by name, because the chip rule's noncash entry
ticket has no Diamond form; the readiness contract takes a Diamond satellite
that promises no seat, because a promised seat is a guarantee and a Diamond
guarantee is not built; the receipts prove a Diamond seat by its Diamond
ledger rows and custody row and a Diamond satellite's fee by its fee bank; the
seat door is registered before it exists, revoked from every client role,
watched and declared; every chip edit is an asserted substitution with its
live md5 pinned and the reverse proved; the switch is never opened and nothing
is priced.

Added October 4, 2026. Every pin above reads the migration's own text, which
proves what the migration said and not that the installed door does it. The
Diamond tournament lifecycle fixture now executes the seat door itself, against
the md5-pinned capture, on isolated PostgreSQL 17: the door joined
`tests/sql/diamond-tournament-lifecycle-doors.sql` as its forty-second door,
and case 14 of `tests/sql/diamond-tournament-lifecycle-cases.sql` reaches each
of its refusals by name. The divider is reached six ways (a fractional ticket,
a fractional prize part, a fractional fee part, whole parts that do not add up
to the ticket, a seat for nothing, and a movement with no key), the cross-asset
fence twice, the target gate three times, the qualifier-registration gate once,
and duplicate qualification twice: the door's own refusal, and the partial
unique index that would refuse a second open entry even if a door forgot to.
Every call is proved to have moved nothing. The law now also pins that
arrangement, so a future change cannot drop the door from the capture or delete
a case and still pass. The funded delivery itself is still not executed here:
it needs a prize bank, a Diamond prize bank is filled only through an entry
door that refuses while `tournaments_enabled` is false, and this fixture opens
no switch. That half remains proved by the rolled-back production rehearsal
under `docs/evidence/diamond-phase-9-funded-conservation/`.
