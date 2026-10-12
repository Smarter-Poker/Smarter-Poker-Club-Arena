# tests/the-arena-belongs-to-the-system.law.test.ts

The Diamond Arena belongs to the system (Ruling 22, decided by Claude on Dan's
delegation of 2026-09-30). The arena's club row names the system account
(`system@smarter.poker`, `00000000-0000-0000-0000-000000000001`) as its owner,
and never an account a person signs in as. So no door that trusts a club's
owner admits a person to the arena, and platform staff run it through the staff
doors.

Migration `20260930235500` does four things. It names the system account, only
after proving that nobody can sign in as it. It lets the owner-wallet trigger
skip a club that does not play in chips. It opens a Diamond hand to platform
staff with a live session and records `platform_admin` on the audit row, while a
chip hand opens as before. It makes the watched arena guard refuse any Diamond
owner but the system account, as "The Diamond Arena Belongs To The System".

The law holds that migration to its shape:

- every edit is a pinned, asserted, reversible substitution;
- it moves the arena only from its former owner;
- it declares the guard redefinition and one live proof per change;
- it asserts every edit at the end;
- it opens no switch, moves no Diamond and grants nothing.

The rolled-back production rehearsal that proves the doors, before and after,
is `docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system-rehearsal.sql`.
