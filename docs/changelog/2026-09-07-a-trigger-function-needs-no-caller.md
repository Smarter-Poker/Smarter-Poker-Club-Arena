# A trigger function needs no caller, a policy asks once, and the disk was full

2026-09-07. Four things found in one sweep, three of them fixed here and the
fourth recorded because its cause is not what the guard's own remedy list would
have told you to do.

## 1. The Mac was out of disk, and had been silently accumulating for days

`/System/Volumes/Data` reached **100% of 926 GiB**. It presented as vitest
dying with `No space left on device` in the middle of an unrelated test run.
There were **224 registered git worktrees**.

The cause was not litter. `scripts/prune-stale-worktrees.sh` had been unable to
run at all: **`core.bare` was set true on the canonical clone**, so every git
command needing a working tree failed there, and the script refuses to run
outside the canonical clone. Its refusal named the one cause it was not
("Run from inside the canonical clone") and said nothing about the one it was.
The working files were all present; the flag was simply wrong. Setting it back
to `false` restored the clone, and the prune then removed 19 trees.

The dry run is the interesting part: of 224 trees, **18 were removable**, 126
are active and 37 are dirty. This is not a cleanup problem, it is a fleet-size
question, and it is Dan's.

Two fixes so the next one is loud rather than mysterious:

- `prune-stale-worktrees.sh` now detects `core.bare=true` beside a real working
  tree and prints the one-line repair instead of a refusal that misdirects.
- `scripts/worktree-pressure.sh`, wired into `.husky/pre-push`, warns when free
  space is under 25 GiB or the tree count is over 150. It **never blocks** - a
  hook that refuses to let you save your work because the disk is nearly full
  is worse than the full disk. Nothing in CI can see this, because the
  worktrees are on the Mac and the runners are not, so the reader has to be the
  person pushing. That is 10.86 rule 3: name the reader, or you do not have a
  guard.

## 2. Five SECURITY DEFINER trigger functions carried `anon` EXECUTE

`Schema Manifest Refresh` had been red on `main` since 00:18, on the job "No
unaccounted DEFINER writer is reachable from a browser". A trigger function is
invoked by Postgres as part of the triggering statement and never consults
EXECUTE on the caller, so those grants bought the triggers nothing and left five
SECURITY DEFINER entry points a caller with no account could name.

Revoked from PUBLIC, anon and authenticated. Verified after: `anon` can execute
none of the five, and `fn_guard_retired_club_mutation` still has all **22** of
its triggers attached and enabled.

## 3. The obvious fix for the OTHER five would have broken every anonymous read

The five functions that actually turned the check red are
`fn_is_public_video_playback_eligible`, `fn_is_video_library_asset_eligible`,
`fn_is_video_library_lineage_eligible` and both `legacy_transition_eligible`
overloads. The check's remedy list opens with "revoke PUBLIC and anon".

**All five are RLS policy helpers**, backing one or two policies each. A policy
expression is evaluated AS THE QUERYING ROLE, so revoking `anon` would deny
every anonymous SELECT on the video library, `social_posts` and `social_reels`.
This is exactly the trap CLAUDE.md 10.84 records for `fn_home_is_group_staff`,
which backs 15 policies across 8 tables.

The distinction that decides it, and the one worth carrying forward:

| shape            | needs EXECUTE?                    | so                       |
| ---------------- | --------------------------------- | ------------------------ |
| trigger function | no, Postgres invokes it           | safe to revoke           |
| policy helper    | yes, it runs as the querying role | revoking denies the read |

Baselined in `definer-exposure-baseline.json` with what an unauthenticated
caller learns from each: in every case, exactly what the public page already
shows them. The check now exits 0 against live production.

## 4. Five policies asked who was calling once per row

`auth.uid() = user_id` is evaluated for every row scanned. Wrapped in a scalar
subquery it is evaluated once per statement and compared as a constant.
Identical semantics; it matters most on `chip_transactions`, which is 2,008,091
rows. The union-overseer policy sitting beside it already used this form, so
this only brings its neighbour into line.

## The assertion that failed first, and should have

The migration asserts its own outcome. The first draft's regex for "still calls
`auth.uid()` per row" was `[^(] *auth\.uid\(\)`, which also matches
`SELECT auth.uid()` - the very form the migration had just introduced. The
migration aborted on its own success. Nothing was applied, the transaction
rolled back, and the second draft strips the subquery form before looking for
survivors. A guard that cannot tell its fix from the defect is not a guard, and
it is better to learn that from a refusal than from a green run.

## Files

- `supabase/migrations/20260907162128_a_trigger_function_needs_no_caller_and_a_policy_asks_once.sql`
  (applied and recorded on production, version `20260907162128`)
- `scripts/ci/definer-exposure-baseline.json`
- `scripts/prune-stale-worktrees.sh`, `scripts/worktree-pressure.sh`, `.husky/pre-push`
