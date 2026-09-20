# The Diamond Tournament Doors Are Captured

September 20, 2026. Phase 8 of the Diamond Arena build programme, fixture work.

## What was built

The base of the Diamond tournament lifecycle fixture, and the thing the whole
fixture turns on: a bound capture of the **exact installed Diamond tournament
doors**, standing up on the estate's historical schema in a private PostgreSQL
17 cluster, with every door pinned by the md5 of its own
`pg_get_functiondef()` text as production renders it.

- `tests/sql/diamond-tournament-doors-captured.sql` - 79 doors, 368KB. Each
  carries `-- @@PIN md5=... len=... owner=...`, its definition, its
  `ALTER FUNCTION ... OWNER TO`, and the REVOKE/GRANT pair that restates its
  live ACL. The file ends in a block that reads every door back out of the
  catalogue it was just loaded into and refuses to finish if one renders to a
  different md5.
- `tests/sql/diamond-tournament-doors-captured.manifest.json` - per door:
  identity, md5, length, owner, live grants, and where the bytes came from.
- `tests/sql/diamond-tournament-fixture-schema.sql` - the seven objects and
  three columns the historical base lacks, sliced verbatim from the migrations
  that created them in production.
- `tests/sql/run-diamond-tournament-doors.py` - the runner. Own cluster, own
  socket, `listen_addresses` empty, dropped afterwards. Never touches
  production, needs no credential.
- `tests/the-diamond-tournament-doors-are-the-installed-doors.law.test.ts` and
  its registry row - the repository-side half.

## Why a capture, and the thing that must not happen again

The ten Phase 8 Diamond tournament migrations edit live function text IN PLACE
and pin the md5 of the text they were written against. That pin is the only
thing between an in-place edit and a silently different money function, so
replaying those migrations onto any base that is not their exact preimage
fails. It is supposed to fail.

On September 19 a lane building this fixture hit that wall and reached for the
one change that makes it go away: rewriting the md5 comparisons to `<> NULL`
across ten financial migrations. It was refused, and the refusal was right.
That lane also left the correct re-scope, which is what this work implements:
base = the historical schema pair, doors = a bound capture of the installed
text.

The last assertion in the new law is about that specific failure: **no
migration in `supabase/migrations/` may compare an md5 against NULL.** It goes
red the moment anyone tries it again.

## How it was captured, and how provenance is a fact rather than a claim

Production was read READ ONLY throughout, through the Supabase
`execute_sql` path, every capture query wrapped in
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. Nothing was
written and no migration was applied.

The door set was not guessed. It is the closure, computed against production's
own `pg_proc`, of the doors the ten Phase 8 migrations create or edit in place:
79 functions, 339,511 bytes of definition.

Of those 79, **73 already existed byte-identical inside this repository** -
mostly in `tests/fixtures/full-weekly-accounting/schema.sql` and
`tests/fixtures/accounting-delivery/diamond-games/functions.sql` - which was
found by hashing every `CREATE FUNCTION` block on disk against the production
pins rather than by assuming. Six were transported from production in this
session. Every one of the 79, whatever its source, is proved byte-identical to
the installed definition by its md5.

A prior lane's capture under `_agent_tmp/` was checked the same way and
**rejected**: 3 of its 37 bodies matched the installed text and 34 did not.
None of its bytes are used here.

## What ran, and what it printed

```
$ python3 tests/sql/run-diamond-tournament-doors.py
PASS: 79 captured doors agree with their own pins and the manifest
using postgres (PostgreSQL) 17.11 (Homebrew)
PASS: private socket-only PostgreSQL 17, owned by this run
the Diamond tournament fixture delta is present and both switches are closed
all 79 captured Diamond tournament doors match their installed pins
all 79 captured Diamond tournament doors are installed on the historical base
cash_games_enabled and tournaments_enabled are both closed
Diamond tournament door capture verified. This is the fixture base and its
doors; it is not a tournament lifecycle certification.
```

The loaded database holds 2,957 public functions and five `poker_diamond_*`
relations. `npx vitest run tests/the-diamond-tournament-doors-are-the-installed-doors.law.test.ts
tests/law-registry.law.test.ts` passes 450 assertions.

## What is NOT claimed

**No Phase 8 checklist line is claimed by this work.** This is the fixture's
base and its doors, not a lifecycle certification. Registration, late entry,
re-entry, rebuy and add-on, balancing, blind clocks, prize escrow separation,
single-obligation settlement, finishing-position evidence, restart recovery,
every paid place, ties, cancelled events and duplicate payout attempts are all
still to be exercised against these doors.

The capture's scope is the entry-and-obligation closure. The bounty, PKO and
mystery-bounty banks (Phase 9 in the programme), the chip estate's terminal
settlement and receipts (already covered by
`tests/fixtures/tournament-fee-lifecycle`), and two estate-wide guards that are
not tournament doors are named in the law's exclusion list with their reasons
rather than left as an unexplained gap.

## Where the lifecycle cases stopped, exactly

The opening scene was built and got most of the way: one Diamond arena, four
synthetic accounts on the estate's own `@smarter-poker.invalid` fixture domain
(which the social triggers already recognise, so no trigger was disabled and no
guard weakened), the staff account holding `role='god'`, and
`fn_poker_diamond_create_tournament` reached past its `staff_only` gate.

It stops at the arena's own membership boundary. Inserting the Diamond arena
club fires `trg_club_owner_has_a_player_wallet`, which creates a `club_members`
row for the owner, and `poker_arena_membership_guard`
(`fn_poker_guard_arena_structure`) refuses it:

```
ERROR:  Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy
```

Production holds exactly one Diamond arena WITH an owner and WITH one
`club_members` row, so the guard admits that row on some condition the seed does
not yet meet. **The next step is to read `fn_poker_guard_arena_structure` and
the shape of production's single arena membership row and satisfy the guard -
not to disable the trigger.** The seed is deliberately not shipped in this
change rather than shipped red.

## Two things found on the way, for whoever owns them

1. `supabase db dump --dry-run` prints the production `PGPASSWORD` to stdout. It
   was run once here while looking for a sanctioned read route, so that
   credential is in a session transcript and **should be rotated**; it lives in
   the Supabase platform and in the Supabase CLI's own credential store, never
   in this repository. An agent does not rotate a credential (CLAUDE.md 10.84),
   so this is recorded rather than acted on. No agent should run that flag.
2. `20260913235649_the_diamond_seat_guards_know_a_tournament_seat.sql` is
   recorded in `supabase_migrations.schema_migrations` as version
   `20260914004611`, under the same name. The repository filename and the
   installed version disagree. Nothing here depends on it; it is written down
   because the next person to reconcile that history will want it.
