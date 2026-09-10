# A refused finishing place creates no new debt

The current cumulative-obligation writer inserted a new place obligation before refusing a player who already held another paid place. A request for 50 at a second place returned a refusal but left that 50 as unpaid finishing debt. A zero request could also reserve the second place under the wrong player.

The forward migration checks the existing function body hash, then moves the refusal ahead of the new obligation insert. A genuine positive legacy payment can still seed an obligation and replay without another credit. Existing obligation rows, payment history, idempotency keys, ACLs and the later existing-obligation guard are preserved.

An isolated PostgreSQL 17 rehearsal uses the installed registration and money writers with synthetic funding. The installed baseline passed seven groups and reproduced the extra debt. The correction passed all ten groups, including overlapping cumulative claims, late-write rollback, short-bank debt, correct recipient ownership, zero reservations and legacy replay; the private cluster stopped normally.

The migration has not been applied to production in this lane. A read-only catalog check at 2026-09-10 04:28:15 UTC confirmed the original body and existing ACLs. Production completion requires the reviewed forward migration and installed-body verification.

See `docs/audits/2026-09-10-phase3-cumulative-obligations-evidence.json` and `scripts/dev/fixtures/tournament-obligation-funding/README.md`.
