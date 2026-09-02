# 2026-09-02 - chip standard, phase 1.5: the lane PRs unblocked, the live money migrations mirrored, and the cancel refund passes the gross entitlement

Branch `fix/chip-std-p1-repo-mirrors`. Roadmap item 1.5 in
`docs/CHIP-ACCOUNTING-ROADMAP.md`; audit items 3 and 5 in
`docs/audits/2026-09-02-chip-standard-round2/lane3-conflicts.md`. No migration
of its own: the two files under `supabase/migrations` are byte-exact exports of
statements production already ran.

## Part A - the open lane PRs

Every one of the seven was `mergeable: true, mergeable_state: blocked` at
22:24 UTC: nothing conflicted, they were waiting on a red or queued CI. The
token could not list check runs (403 on `/check-runs`), so the reds were read
from `/actions/runs?head_sha=` and the failed job logs.

What was red, from the logs:

- `Server Engine (typecheck + tests)` on #2709 (job 100442727374) and #2688
  (job 100443780986): `MaintenanceBreak.test.ts > the real engine treats a
maintenance pause as paused > is not paused before anything asks it to be`,
  timed out at 10,018 ms and 10,001 ms. The case did `await import(
'../engine/ServerTableEngine.js')` inside its body; on the loaded estate
  runner that single import took longer than the 10 s test budget, and the
  four cases behind it (module cached) passed. The same failure hit four
  unrelated branches between 21:54 and 21:56 (`agent/cowork-pgrst`,
  `fix/the-thaw-finishes-inside-the-api-budget`, and two more). Fix: the
  import moves to a `beforeAll` with a 120 s loading budget. 31/31 locally in
  995 ms. Applied to all seven branches (identical patch, so the merges do not
  conflict on it).
- `Rake Config Parity - client vs server` on #2688 (job 100440685925):
  `scripts/ci/check-rakeconfig-parity.mjs:113 getTierForBB has no cascade`.
  The branch moved the server tier table into `server/src/config/rakeSpec.ts`;
  `RakeConfig.ts` now re-exports `RAKE_SPEC.tiers` and `getTierForBB`
  delegates to `tierForBB`, which walks `TIER_ORDER` and returns the first
  tier whose `maxBB` the big blind does not exceed. The gate still anchored on
  a `STAKES_TIERS` literal and a `<= X) return STAKES_TIERS.x` cascade in the
  old file. It now reads the `TIERS` literal in `rakeSpec.ts` and derives the
  cascade from `TIER_ORDER` plus each `maxBB`, refusing if `tierForBB` stops
  selecting by `maxBB`. Output: `tiers compared: 6`, `cascade steps: 5`,
  `client and server rake config agree`. Negative control: moving the client
  micro boundary 0.8 -> 0.9 exits 1 with the drift named.
- `Telemetry Exposure` and `Silent Revert Guard`: green on all seven heads. No
  browser-executable SECURITY DEFINER was named, so no REVOKE migration was
  needed.
- Two older reds on these branches were already fixed on their heads before I
  touched them and are recorded here so nobody chases them: #2693 had
  `discardedErrorReadRatchet` (HydraService baseline 2 -> 0) red at 21:54,
  green after the main merge; #2692 had the Production Build entry-chunk gate
  red at 20:44, fixed by its own `8a441f906`; #2684 had
  `noFixedSizeSourceWindows` red at 21:54, its `ctor + 600` window is gone.

Each branch: `git merge --no-edit origin/main` (all seven merged clean, no
`docs/LAWS.md` conflict this time), the test patch, commit as Smarter-Poker,
`nohup git push`. All seven pushes landed (pre-push hook ran the changed
server test files).

| PR    | Branch                                    | State at 22:24 UTC                    | What was red                                                  | What I did                                                         | New head    |
| ----- | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| #2709 | `fix/chip-std-obligations`                | open, mergeable, blocked              | MaintenanceBreak timeout (server suite)                       | merged main, pause-pin fix, pushed                                 | `750ba96e6` |
| #2688 | `fix/chip-std-rake-spec`                  | open, mergeable, blocked              | rakeconfig parity gate; MaintenanceBreak timeout              | merged main, parity gate reads rakeSpec.ts, pause-pin fix, pushed  | `a511198b0` |
| #2692 | `fix/chip-std-free-buy`                   | open, mergeable, blocked (CI queued)  | nothing on this head (older: entry chunk, fixed by 8a441f906) | merged main, pause-pin fix, pushed                                 | `a26c87d3e` |
| #2693 | `fix/chip-std-cash-latent`                | open, mergeable, blocked (CI queued)  | nothing on this head (older: ratchet baseline, green now)     | merged main, pause-pin fix, pushed                                 | `ae755c5a2` |
| #2684 | `fix/chip-std-spin-chips`                 | open, mergeable, blocked (CI running) | nothing on this head (older: source window, gone)             | merged main, pause-pin fix, pushed                                 | `8bdb621c2` |
| #2716 | `fix/chip-std-seat-guarantee-and-roadmap` | MERGED (`30b80ff17`)                  | -                                                             | nothing                                                            | -           |
| #2721 | `fix/chip-std-p1-bounty-refund-payers`    | open, mergeable, blocked (CI queued)  | nothing on this head                                          | merged main, pause-pin fix, pushed                                 | `2a861ed21` |
| #2722 | `fix/chip-std-p1-mirror-live-migrations`  | open, mergeable, blocked (CI queued)  | nothing on this head                                          | merged main, pause-pin fix, pushed (it carries 110 of the mirrors) | `35bfbceef` |

Merged-or-not is in the final status check at the bottom of this file. Per
the brief, I did not wait on CI beyond one check.

## Part B - live migrations with no repo file

Method: `supabase_migrations.schema_migrations where version >= '20260901'`
(388 rows at 22:30 UTC, 390 by 22:40) against the union of
`git ls-tree origin/main supabase/migrations` and the same on every open
`fix/chip-std-*` branch, matched with the repo's own `indexFrom` /
`recordedBy` from `scripts/ci/check-applied-migrations-are-recorded.mjs` (by
name, stamp-insensitive). Script: node + `pg` from the Mac, password from
`.env`, `createRequire(process.cwd())` for the worktree.

- Not on `origin/main`: 126.
- Of those, carried by an open lane PR: 121 (110 on #2722, 4 on #2693, 3 on
  #2709, 2 each on #2692 and #2684, 1 each on #2688 and #2721; #2719 carries
  `owners_and_co_owners_play_out_of_a_player_wallet_admins_do_not`).
- Carried by an active lane's local branch, PR not yet open (phase 1.2/1.3,
  `fix/chip-std-p1-declared-legs` / `fix/chip-std-p1-ledger-declarations`):
  `20260902220533 20260902220500_the_undeclared_legs_name_their_counterparty`,
  `20260902220819 20260902221500_the_horse_door_declares_the_same_way`, and
  the two applied while I worked, `20260902223519
20260902224000_every_entry_and_prize_leg_names_its_counterparty` and
  `20260902223750 the_board_row_arrives_whole`. Not mirrored here: they would
  duplicate a lane that is about to open.
- Missing everywhere, mirrored in this PR (byte-exact
  `array_to_string(statements, E'\n')`, file `<version>_<name>.sql`, which is
  the key both migration gates use):

| Version          | Name                                                       | Bytes  | What it is                                                                                              |
| ---------------- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `20260902221405` | `a_tab_is_a_query_not_a_filter_over_one_page`              | 10,924 | `fn_list_managed_games` rebuilt; REVOKE/GRANT in file. Not money; mirrored because the count was small. |
| `20260902222851` | `the_club_promo_wallet_the_bbj_has_been_funding_all_along` | 9,873  | `fn_club_money_panel` gains `club_promo_wallet` (clubs.promo_balance). Money surface: BBJ promo slice.  |

No manifest fragment: neither file creates a table or function the base
manifest lacks (`fn_list_managed_games` is a DROP + CREATE of an existing
function, `fn_club_money_panel` is CREATE OR REPLACE).

Gate output, this worktree:

```
$ node scripts/ci/check-migrations-applied.mjs origin/main
[check-migrations-applied] 2 changed migration(s) vs origin/main; 0 unapplied object(s).
OK - every object these migrations declare exists in the live schema.
$ node scripts/ci/check-new-migration-version-collisions.mjs
[migration-version-collisions] 2 new migration(s) against origin/main; all versions are unique.
$ node scripts/ci/check-applied-migrations-are-recorded.mjs --since 20260901000000
[applied-migrations-recorded] 126 of 390 migration(s) applied since 20260901000000 have NO FILE in this repo:
  (126 rows; 124 are on an open lane PR or an active lane's local branch, listed above;
   20260902221405 and 20260902222851 are no longer in the list)
```

The 126 collapses to the four in-flight ones once #2722 and the lane PRs
merge; that is the point of Part A.

## Part C - the cancel refund passes the gross entitlement

`server/src/tournament/tournamentRecovery.ts`, `refundAndCloseCancelledTournament`.
Read the live `fn_settle_tournament_obligation` (pg_get_functiondef, 22:33
UTC): `p_amount` is the TOTAL owed; on first contact with a `refund`
obligation it seeds `amount_paid` from
`wallet_transactions ... type='credit' and lower(category) in ('refund',
'tournament_refund')` for that user and tournament, sets
`amount_owed = GREATEST(p_amount, seeded)`, and pays
`LEAST(p_amount, amount_owed) - amount_paid`.

The engine computed `paid = debits - refund credits` (the same credits) and
passed that net as the total. Worked example: buy-in 10 + rebuy 10, one
earlier partial refund of 5. Engine passed 15; DB: owed 15, seeded paid 5,
paid 10; the player was 5 short, and a re-run (net now 10, owed 15, paid 15)
paid nothing. Passing the gross 20: owed 20, seeded 5, pays 15.

Change: `gross` (buy-in + rebuy + add-on debits) is what goes to the settle
function; the prior-refund sum is kept only for the cheap "already refunded in
full" skip. New `tournamentRecovery.cancelRefund.test.ts` drives the real
helper with a scripted supabase and a spied settle path: 5/5 green, and the
first case goes red on the old code (`expected 15 not to be 15`). Engine code:
lands at the next deploy window; the database side is correct with either
build (the old build under-pays, it never over-pays).

```
$ cd server && npx vitest run src/tournament/tournamentRecovery
 ✓ src/tournament/tournamentRecovery.cancelRefund.test.ts (5 tests) 3ms
 Test Files  1 passed (1)   Tests  5 passed (5)
$ cd server && npx tsc --noEmit
exit=0
$ npx vitest run tests/law-registry.law.test.ts tests/unit/migrationVersionUniqueness.test.ts tests/unit/noFixedSizeSourceWindows.test.ts
 Test Files  3 passed (3)   Tests  55 passed (55)
```

## Not built, and why

- No REVOKE migration: Telemetry Exposure was green on every head.
- The four in-flight migrations above are left to the lanes that applied
  them.
- I did not re-run the lane branches' full CI locally; the reds I fixed are
  the ones the logs named on the current heads.

## Final status check

22:47 UTC, one check, no loop. This PR is #2726. None of the seven has merged
yet: every head is `mergeable: true, blocked` with `CI - Build & Type Safety`
queued or in progress on the estate runners (the queue was ~40 minutes deep
all evening; runs started at 22:03 were still running at 22:40). Telemetry
Exposure and Silent Revert Guard are green on each. They auto-merge on green.

| PR    | Head        | CI at 22:47 |
| ----- | ----------- | ----------- |
| #2709 | `750ba96e6` | queued      |
| #2688 | `a511198b0` | in progress |
| #2692 | `a26c87d3e` | queued      |
| #2693 | `ae755c5a2` | in progress |
| #2684 | `8bdb621c2` | queued      |
| #2721 | `2a861ed21` | queued      |
| #2722 | `35bfbceef` | queued      |
| #2726 | this branch | queued      |
