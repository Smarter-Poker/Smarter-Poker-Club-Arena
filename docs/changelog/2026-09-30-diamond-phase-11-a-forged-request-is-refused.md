# A Forged Request Is Refused (Diamond Phase 11, Line 1)

2026-09-30. Phase 11 line 1: "Test cross-asset request forgery and
unauthorized membership/management access."

We attacked every door a caller can reach and checked what each one did:

- 243 probes in a rolled-back production rehearsal;
- new CI replay cases;
- 39 new engine handler tests.

Production refuses every forged request by name. Three holes needed no owner
decision, and migration `20260930120000_a_forged_request_is_refused` closes
them. It was applied once, after a rehearsal of the exact file, and the
post-apply rehearsal passes all 243 probes.

## What changed

1. **The last four staff doors ask for a live session.** A staff token keeps
   working at the database after sign-out (tokens last seven days), unless the
   door asks whether its session still exists. The attack found fourteen staff
   doors that did not ask. Migration `20260930131500` (Phase 11 line 7) fixed
   ten of them the same morning. This migration fixes the last four:
   - creating a Diamond tournament;
   - the staff books;
   - the incident board;
   - an incident's trail.

   Each refuses in the words its desk already shows. All nineteen staff doors
   now refuse a signed-out, session-less or expired token.

2. **The Diamond Arena hosts no club games.** The club-games doors (wheel,
   plinko, crash, crossing, mines, Diamond Spins) used to accept the arena as a
   host. A staff member could configure a chip-paying game inside it. Now they
   answer "That Club Could Not Be Found" for the arena, as the client already
   behaved.
3. **Only platform staff operate another host's club games.** Any club owner,
   union owner or incident recipient could change, fund or read the games of a
   host that was not theirs. Now only platform staff can. Every person in that
   wider group today is platform staff, so nobody loses anything.

## What did not change

No grant, table, column or new function. Neither Diamond switch opens. No
Diamond moves.

## Evidence

- `docs/evidence/diamond-phase-11/request-forgery-and-access.md`: the full
  attack matrix, before and after.
- `docs/evidence/diamond-phase-11/request-forgery-rehearsal.sql`: the
  re-runnable rehearsal.
- `tests/sql/poker-diamond-forged-arena-acceptance.sql`: the CI replay cases.
- `server/src/handlers/aForgedRequestActsOnlyForItsToken.test.ts`: the engine
  handler tests.
- `tests/a-forged-request-is-refused.law.test.ts`: the law on the migration
  text.

## Open for Dan

- Which profile fields are public (Phase 10, line 2, unchanged).
- Whether the Diamond Arena's club row should name the system account as its
  owner instead of a personal platform account.
- Who counts as "management" at the chip-standard payout-freeze and
  manual-adjustment doors.
