# The doctrine asks what a function does, not what it mentions (2026-09-18)

Two migrations, both applied and recorded, correcting `fn_ca_settlement_lane_doctrine()` — the CI-readable statement of the settlement lane rules declared by `20260917191322` and rewritten for speed by `20260917193840`.

| Migration                                                                        | Applied (UTC) | What it does                                                                                  |
| -------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `20260918000622_the_doctrine_asks_what_a_function_does_not_what_it_mentions.sql` | 00:09:50      | Every rule tests for a call, not for a name                                                   |
| `20260918001056_the_doctrine_narrows_before_it_reads.sql`                        | 00:12:10      | A LIKE runs in front of every regex, so the question fits the engine role's statement timeout |

## What was wrong

The doctrine asked its two name questions with `LIKE` over whole function sources: which functions name the finish-lane key, and which name the global lane helper. Both are the right questions asked the wrong way, and within six hours each produced a false refusal on the live catalog.

`fn_ca_horse_fleet_metrics`, the Phase 3 observer, read `pg_locks` and labelled each lane's key pair with its source string in a comment. It never takes a lane. The doctrine refused it under `f_named_only_by_finish_helpers`, and `20260917233109` took the comment out.

`fn_ca_guard_mtt_admission_contract`, a contract guard deployed by another workstream, carries an expected manifest that pins `public.fn_ca_lock_settlement_lane_global()` with its definition md5, so that a silent change to the helper is refused. It never calls it. The doctrine refused it under `global_lane_callers_are_reviewed`, and the rolling-authority walk then found `fn_award_satellite_seat` behind it — a path made entirely of quoted names inside a JSON string.

A rule a reader trips by mentioning a name turns into an allowlist of everyone who ever wrote the name down, which is not a rule. The doctrine exists to say who _takes_ a lane.

## What changed

Rule 1 and rule 2 ask for the `hashtextextended()` call that turns a key into a lock, not for the key's text. Rule 3, the set of global authorities in rule 4, and rule 4's walk seeds ask for a plpgsql call — `PERFORM`, `SELECT` or an assignment, schema-qualified — not for a name. Rule 4's edges are extracted the same way: a call in this codebase is written `public.fn_x(`, preceded by whitespace, an opening paren or a comma; a manifest writes the same signature behind an escaped quote and no longer matches.

Measured against the live catalog before applying: 30 functions mention one or the other. The call-shaped tests return exactly the 28 reviewed global authorities plus the two lane helpers, and exactly the three finish-lane helpers for F. The contract guard answers false to both, which is what it should always have answered.

Three probes run inside the migration's own transaction and are dropped before it commits: a function that only names the global helper is accepted, one that calls it is refused, and one that takes the finish lane is refused.

## Why the second migration

Asking for a call meant a regular expression where there had been a `LIKE`, and a regex over 3,592 function sources and 8.7 MB of text answered in 4.4 and 6.1 seconds end to end. The engine role reads the doctrine through PostgREST under an 8 s statement timeout; `20260917193840` exists because the doctrine once crossed that timeout and CI read a 57014 instead of an answer. Two seconds is not a margin.

Every full-catalog scan now runs a `LIKE` first and the regex only over what the `LIKE` kept. Each regex is strictly narrower than the `LIKE` in front of it, so every answer is unchanged. Measured after: 1.8 s end to end through PostgREST, and the migration's own postcondition refuses to commit a body that takes longer than 2 s inside the database.
