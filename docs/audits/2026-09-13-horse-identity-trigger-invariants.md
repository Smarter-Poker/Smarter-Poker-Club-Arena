# Horse identity trigger audit

Three reviewed trigger paths had reproducible inconsistencies. The September
13 production census found zero NULL horse flags, zero member bot-stamp
mismatches and zero active seat horse-stamp mismatches. These findings establish
code defects and regression exposure; they do not establish existing corruption.

| Trigger                              | Root cause                                                                                                    | Resulting behavior                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `trg_reject_horse_name_on_human`     | `ILIKE` interprets a player's name as a pattern, so `Alpha_Pro` matches the different horse name `Alpha Pro`. | Trimmed, case-insensitive literal equality rejects only the actual borrowed name. Literal percent and underscore characters remain meaningful. |
| `trg_club_members_bot_follows_horse` | A NULL profile flag falls back to the supplied `is_bot`, allowing a true stamp without a canonical horse.     | Only a true canonical profile flag produces a true bot stamp. Existing foreign keys still reject missing profiles.                             |
| `trg_stamp_seat_horse_id`            | `UPDATE OF user_id` misses writes that modify only `horse_id`.                                                | Inserts, occupant changes and direct stamp writes all derive the stamp from the occupant. Stack-only updates do not query profiles.            |

The seat defect is a trusted-writer consistency gap. Existing table-seat RLS
reserves writes to the service role; this audit does not claim browser access
to that write path. The separate horse-profile authority guard retains its own
native role/RLS proof. This migration preserves function access grants, performs
no player or balance backfill, and declares the seat trigger in the money-trigger
registry. Exact predecessor hashes and a three-second lock timeout prevent an
unreviewed installation from overwriting drift or waiting behind live play.

`scripts/ci/test-horse-identity-triggers.py` runs PostgreSQL 17 against exact
reviewed production function definitions and the candidate migration. All 42
checks passed locally. Four baseline observations demonstrate the three bugs;
post-install cases exercise literal names, NULL/default identities, inserts,
direct writes, occupant changes, missing-profile foreign keys, preserved grants,
rollback, atomic drift refusal, unchanged data, and a stale stamp write waiting
behind a concurrent occupant change. A deliberately failing temporary handler
proves that stack-only writes do not invoke the identity trigger. The required
accounting PostgreSQL CI job runs the same suite.

This is a disposition for three trigger paths. The wider inventory of 139
triggers and 221 functions remains under review; inventory completion is not
whole-system qualification. Production application and source publication must
be verified separately before closing the individual audit incidents.

Production application: September 13 at17:43:13UTC, ledger version
`20260913174313`, name `20260913173936_horse_identity_triggers_use_canonical_profiles`.
Seven rollback-only cases against the installed handlers passed at17:43:39UTC
using temporary probe tables; no real profile, seat or member rows were modified.
The enabled seat trigger includes both identity columns, browser EXECUTE grants
remain closed, and all installed function hashes match the reviewed result.
Source publication is still pending the normal PR checks.
