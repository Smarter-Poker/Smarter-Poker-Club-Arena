# The applied P6 tournament engine is recorded in the sibling repo, not here

2026-10-05. `Installed and merged migrations agree` failed on every pull request
in this repository for about six minutes, naming one gap past its grace:

```
[applied-migrations-recorded] 1 of 375 migration(s) applied since 20260928000000 have NO FILE in this repo:

  20261001200000  trivia_p6_nightly_tournament_engine

  0 of them are younger than 24h (in flight; not failed), 1 are older (failed).
```

**It is recorded, and it is recorded in the right place.** The file is
`supabase/migrations/20261001200000_trivia_p6_nightly_tournament_engine.sql` in
`Smarter-Poker/Smarter-Poker-World-Hub`, added by that repository's PR #2120
(commit `b51ee15d1a92`, 2026-10-05T11:12:59Z). Club Arena deliberately carries
no copy of it. This note exists so the next reader does not create one.

## The export is byte exact, and here is the proof

| what | value |
| ---- | ----- |
| applied version | `20261001200000` |
| applied name | `trivia_p6_nightly_tournament_engine` |
| statements | 1 |
| length | 201,595 characters, and `octet_length` 201,595, so the text is pure ASCII |
| `md5(array_to_string(statements, E'\n'))` | `88a6a9ae0b4d690c4c4e5dc5b76ad06b` |
| trailing newline | the recorded text ends with one `\n`, so the file must too |
| World Hub file | 201,595 bytes, `md5` `88a6a9ae0b4d690c4c4e5dc5b76ad06b`, last byte `0a` |
| World Hub blob sha | `4d5ae1792beb1a0b4503b00416ad0c63c83168e3` |

Both ends were measured on 2026-10-05, read only: production through the
Supabase MCP inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ
ONLY`, and the file by downloading the blob and hashing it locally, with
`git hash-object` agreeing with the sha GitHub reports so the download was
intact. Equal length plus equal md5 is the same standard of proof the one row in
`scripts/ci/applied-migration-aliases.json` already rests on.

## Why there is no second file here, and no alias row

One production database, two repositories that write migrations to it. A
rebuild from source reads both. `check-applied-migrations-are-recorded.mjs`
indexes the sibling repository's `supabase/migrations` for exactly this reason,
so a file in World Hub records the migration as completely as a file here would.
Backfilling a second copy into Club Arena would put the same 201 KB of DDL into
a master reset twice, which is the hazard the header of
`scripts/ci/migration-aliases.mjs` names when it explains why aliases exist
instead of duplicate files.

An alias row is also wrong here and would be refused anyway. `loadAliases`
honours a row only when its `file` exists in THIS tree, and this file does not.
Nor is one needed: the applied version and the applied name both match the
sibling file exactly, so no name divergence has to be bridged.

World Hub is the migration's owner, not an accident of where it landed. The
Phase 5 predecessor `20261001011044_trivia_p5_pvp_engine.sql` is in the same
directory, and this migration's own header says its human registration path is
"called by the World Hub API".

## What the two gates read now

`check-applied-migrations-are-recorded.mjs` resolves it by VERSION. `indexFrom`
puts `20261001200000` into `index.versions` from the sibling filename, and
`recordedBy` returns on its first test, `index.versions.has(version)`. Confirmed
by CI rather than by reasoning: run 37301593248, the first pull request run
after the World Hub commit, printed

```
[applied-migrations-recorded] OK — all 375 migration(s) applied since 20260928000000 have a file in supabase/migrations or a sibling repo.
```

the same 375 as the failing run, with the gap gone.

`check-migrations-are-live.mjs` is the gate that could have produced the
opposite failure, "merged but not live". It cannot here: its `DIR` is this
repository's `supabase/migrations` only, it never reads the sibling listing, so
a file that is not in this tree is never judged. The same run reported
`every migration in the window is live in production`.

Had Club Arena carried the file, that gate would still have passed it on step 1,
NAME. The stem's slug is `trivia_p6_nightly_tournament_engine`, 35 characters,
and `schema_migrations` stores the name untruncated at that length, so
`matchedByName` would hit `recorded.has(slug)` exactly, with no reliance on the
55 character prefix and no fall through to an object or `@live-proof` check.
That is a reason the filename shape is safe, not a reason to add the file.

## The migration itself

Read before trusting it, head and tail in full and the body by search. It is a
real migration, not a placeholder and not a credential: 15 tables, 61
`CREATE OR REPLACE FUNCTION`, 19 indexes, 9 triggers and 1 view, opening with a
`DO $pre$` preflight that refuses unless the Phase 2 ledger and Phase 3 session
RPCs are present, and closing with a `DO $post$` block of postconditions. It
ships dormant.

Scanned for anything secret and found none: no `postgres://` or `http(s)://`
string anywhere, no `eyJ` JWT, no quoted base64 or hex literal of 32 characters
or more, no `sb_`, `sbp_`, `ghp_`, `sk-` or `xox` prefixed token. Every one of
the 56 keyword hits is an identifier or a role name. The `secret` hits are all
the table `public.trivia_tournament_secrets`, whose seeds are generated at
runtime by `extensions.gen_random_bytes`, and which the migration REVOKEs from
`PUBLIC`, `anon`, `authenticated` and `service_role` with a postcondition
asserting it stayed owner only. The `service_role` hits are that role named in
GRANT and REVOKE.

Installation was confirmed live, read only: all 15 declared tables exist, 61
`trivia_tournament%` functions exist, `enter_trivia_tournament_v2` exists,
`has_table_privilege('service_role', 'public.trivia_tournament_secrets',
'SELECT')` is false, and 1,000 horse personas are seeded. The migration's own
postcondition about the secrets table holds in production.

## Deliberately left alone

No `schema_migrations` row was read for anything but its text, and none was
edited or deleted. Nothing was replayed. No version was reserved, since an
exported file must carry the version it was applied under. `list_migrations` was
not called (section 2 rule 8). No guard, assertion or check was weakened.
