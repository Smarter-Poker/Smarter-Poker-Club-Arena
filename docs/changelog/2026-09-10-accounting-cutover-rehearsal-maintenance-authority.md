# Accounting Cutover Rehearsal Maintenance Authority

Phase 3 remains open.

## Confirmed Verification Defect

The disposable Stage 1 freeze-authority probe installs the initial September 8
entry-freeze predicate, whose body MD5 is cff283a255830f34ad7488bbfbf70bc6.
Every current Stage 1 migration requires the live release-aware predicate,
MD5 a29498531e4b7d3889532e80fafc8d57. The real PostgreSQL rehearsal therefore
refuses its own setup before checking any cutover behavior. Production has the
required predicate and serializer, verified by read-only catalog inspection.

## Correction

Kept the production migration and its exact body, owner, language, volatility
and trigger checks unchanged. Gave the isolated probe the captured executable
release-aware predicate and its real release-certificate reader. Added the small
structural fixture those functions read. Kept the older predicate as an explicit
negative case. Exercised last-hand, countdown and certified-release behavior.
Used standard grep for the harness checks so PostgreSQL tests do not depend on
an undeclared ripgrep installation.

No production DDL, money movement, scheduler change or guard bypass is part of
this correction. This probe certifies only maintenance authority, not all
tournament accounting or Phase 3 completion.

## Verification

PostgreSQL 17.11 passed canonical authority, eight maintenance admission and
release behaviors, and seven refusal cases including the obsolete predicate.
The server tournament, hand-generation and time-bank suite passed 1,398 tests
in 132 files. Re-read: yes. Root TypeScript and all 31 catalog-authentication source-law assertions pass.
