# Diamond launch: owner steps, 2026-09-20

These are the production actions this session could not perform, in the order they have to happen. Every lane in this session had production database writes refused by its safety layer, so nothing below has been applied. Each step names its file, the `apply_migration` name and version, the SQL to read back afterwards, and the conditions under which you stop.

Two standing rules apply to every step.

Never apply inside the hourly break window, minutes :50 to :03 UTC. The database refuses non-temporary DDL from a `postgres` session in that window and rolls the whole transaction back, so nothing is recorded and nothing reloads (CLAUDE.md section 2 rule 8). Check `date -u` first and apply once after :03, never in a retry loop.

Apply each migration exactly once. If a call times out, do not re-send it. Read `supabase_migrations.schema_migrations` for the version first and decide from what the database says.

## Step A: the two gate migrations, then push the gate branch

These two are written and tested but live only in a local worktree. They are the first step because the transfer door is refused for every player until the second one installs.

**Branch:** `agent/cw-diamond-gate/fix/the-health-watch-resolves-what-it-filed`, commit `f3d2ce36db`, worktree `/Volumes/SmarterWork/agent-work/cw-diamond-launch/cw-diamond-gate`. The branch is not on origin yet.

### A1. The health watch resolves what it filed

**File:** `supabase/migrations/20260919223032_the_health_watch_resolves_what_it_filed.sql`
**apply_migration name:** `the_health_watch_resolves_what_it_filed`
**Version:** `20260919223032`

What it does: adds a nullable `resolution` column to `ca_diamond_incidents`, and teaches `fn_ca_diamond_health_watch` to resolve an open `DR0:health_critical` row once every area that row names has stopped reading critical, with a note saying which areas and what status was read. It also touches `fn_ca_diamond_trial_balance_watch`. Forty-five open critical rows, all written between 2026-09-09 07:35 and 2026-09-11 15:35, describe causes that have read ok since 2026-09-11 16:35. Nothing in the estate resolves them today, so the programme's release condition of no open critical incidents cannot be met however clean the books are.

**Readback:**

```sql
select version, name from supabase_migrations.schema_migrations
 where version = '20260919223032';

select count(*) filter (where resolved_at is null) as still_open,
       count(*) filter (where resolved_at is not null) as resolved
  from public.ca_diamond_incidents
 where rule = 'DR0:health_critical';
```

Expect the history row, and expect `still_open` to fall to 0 on the next hourly tick of `fn_ca_diamond_health_watch`. It will not fall the instant the migration applies; the watch resolves on its next run.

**Abort if:** the migration returns any error at all. Do not retry. Read the error, and read `schema_migrations` for `20260919223032` to learn whether it recorded. Abort also if `still_open` is unchanged after two full hourly ticks, because that means the watch is not resolving and the row cause should be read before anything else is applied.

### A2. The transfer door is named and DR16 has a consumer

**File:** `supabase/migrations/20260919223115_the_transfer_door_is_named_and_dr16_has_a_consumer.sql`
**apply_migration name:** `the_transfer_door_is_named_and_dr16_has_a_consumer`
**Version:** `20260919223115`

What it does, and this is the one that changes what a player can do. `send_wallet_diamond_transfer(uuid, integer, text, text)` exists, is granted to `authenticated`, journals both legs and writes both wallets in one transaction, exactly as ruling 4 as amended on 2026-09-08 requires. It runs under the sender's own JWT. `fn_guard_profile_privileged_columns` refuses any write to `profiles.diamonds` that is neither service-role nor made from a call stack naming a listed money RPC, and **this route is not on that list**. So every transfer any player has attempted since 2026-09-09 has answered 42501 at the first wallet UPDATE and rolled back. Verified independently on 2026-09-20: the guard body names `send_stream_gift`, `fn_arena_deposit` and `fn_arena_withdraw` but not `send_wallet_diamond_transfer`, and `diamond_wallet_transfers` holds zero rows.

The migration adds the route to the guard by marker against the live body, with the route's own md5 pinned so a route that changed underneath is re-read before the guard admits it. It also repoints `DR16:deposit_inside_settlement_window` at `fn_poker_diamond_reserve`, which is today's real deposit door; its original consumer `fn_arena_deposit` is a retired stub that raises. Without this the daily arming sweep tries to arm DR16 on 2026-09-22 and is blocked by "no function consults this rule".

**Readback:**

```sql
select version, name from supabase_migrations.schema_migrations
 where version = '20260919223115';

select pg_get_functiondef(p.oid) like '%send_wallet_diamond_transfer%' as guard_names_the_route
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'fn_guard_profile_privileged_columns';

select * from fn_ca_diamond_unreachable_money();
select * from fn_ca_diamond_rule_flip_due(true);
```

Expect the history row, `guard_names_the_route` true, `fn_ca_diamond_unreachable_money()` down from two findings to zero, and DR16 no longer reported as a rule with no consumer.

**Abort if:** the migration reports that the pinned md5 does not match. That means `send_wallet_diamond_transfer` or the guard changed after this migration was written, and the route must be re-read before the guard admits it. Do not edit the md5 to make it pass. Abort also if `fn_ca_diamond_unreachable_money()` still reports the transfer finding after the readback, because then the guard did not take the edit.

### A3. Push the branch

After both apply, push `agent/cw-diamond-gate/fix/the-health-watch-resolves-what-it-filed` and open its PR. The order matters: the pre-push hook runs `check-migrations-applied`, which refuses a push whose migration is not already live. Pushing before applying will simply be refused.

## Step B: the two F06 migrations already on main

Both files are on `main` and neither version is in `schema_migrations`, verified 2026-09-20. **They are prerequisites of any engine activation**, so they come before Step C and not after it.

### B1. Mixed F06 custody transfer retains original operations

**File:** `supabase/migrations/20260918232558_mixed_f06_custody_transfer_retains_original_operations.sql` (PR #4907)
**apply_migration name:** `mixed_f06_custody_transfer_retains_original_operations`
**Version:** `20260918232558`

This is the migration whose absence is refusing the staged engine. `server/src/tournament/mixedF06Custody.ts` calls five functions defined only here, and `scripts/ci/check-engine-doors-exist.mjs` reads production's `pg_proc` before the break gate and fails the deploy because none of them exists.

**Readback:**

```sql
select version, name from supabase_migrations.schema_migrations
 where version = '20260918232558';

select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.proname in ('fn_f06_admit_mixed_manager_custody',
                     'fn_f06_complete_mixed_manager_custody',
                     'fn_f06_find_mixed_manager_custody',
                     'fn_f06_mixed_custody_intent',
                     'fn_f06_prepare_mixed_manager_custody')
 order by 1;
```

Expect the history row and all five function names. Fewer than five means the engine door gate will still refuse the build, and you should stop rather than deploy.

**Abort if:** fewer than five names return, or the apply errors. Do not retry the apply.

### B2. Unresolved F06 custody retains its lease evidence

**File:** `supabase/migrations/20260919024039_unresolved_f06_custody_retains_its_lease_evidence.sql`
**apply_migration name:** `unresolved_f06_custody_retains_its_lease_evidence`
**Version:** `20260919024039`

**Readback:**

```sql
select version, name from supabase_migrations.schema_migrations
 where version = '20260919024039';
```

**Abort if:** it errors. Note that B2 depends on B1, so apply B1 first and confirm its readback before starting this one.

After B1 and B2 both read back, re-run the door gate before anything else:

```
node scripts/ci/check-engine-doors-exist.mjs
```

with `DATABASE_URL` set. It should report that all the functions the build calls exist in production.

## Step C: the engine activation decision

This step is a decision, not a command, and it is yours. Here is the diagnosis in full so it can be made without re-deriving it.

**What is running.** Production serves `8825af51817f379c4261658ca29ecc9d8d81932d`, instance `1-3846b8bb`, confirmed at `https://engine.smarter.poker/health` on 2026-09-20.

**Why it never hands over.** One in-process F06 permit keeps `maintenance.readyForRestart` false at every hourly break. Health reports `unparkedTables: 0` with `unparkedReasons: {"f06_preparation_unresolved": 1}`. The restart certificate in `server/scripts/engine-release-transaction.sh:426` requires `readyForRestart` true AND `unparkedTables` zero, so the certificate is never issued and the host transaction never gets to cut over. The break itself is fine; the engine simply never says it is ready.

**Why the sanctioned route cannot activate any engine as the data stands.** Two independent blocks, and neither can be worked around honestly.

The first is the newest engine. It calls five RPCs from the uninstalled `20260918232558`, so the door gate refuses it. Step B clears this one.

The second is the predecessor. `engine-release-transaction.sh:18` pins `CHECKPOINT_8825_SHA=8825af51817f379c4261658ca29ecc9d8d81932d`, and lines 975 to 981 set `LEGACY_CHECKPOINT_REQUIRED=1` whenever the sealed predecessor is that SHA. Production's predecessor is exactly that SHA, so main's release control hard-requires the legacy checkpoint. That checkpoint's database preconditions do not exist: it wants stale `engine_tournament_leases` rows for tournaments `5a387a75` and `615783bf`, and `aborted_unsettled` dispositions. Measured 2026-09-20, `engine_tournament_leases` holds 477 rows and **zero** for either tournament. **Those rows must not be fabricated.** Writing them would be inventing evidence that a hand was abandoned, which can either void a dealt hand or let one be dealt twice.

So rolling forward to any engine, including a rollback to an older one, is blocked by a checkpoint that cannot run.

**The fix, which needs review and is not a production action.** A reviewed change to `server/scripts/engine-release-transaction.sh` that does two things:

1. Accepts a break where `readyForRestart === false` **solely** because `unparkedReasons == {f06_preparation_unresolved: 1}`, with `unparkedTables <= 1` and `remainingMs >= 285000`, and only while the serving instance is `1-3846b8bb`. Every one of those conditions is load-bearing. The instance pin makes it expire by itself the moment the engine restarts, so it cannot become a permanent loosening.
2. Skips the legacy checkpoint when its preconditions are absent, rather than dying on a checkpoint that has nothing to check.

The pins in `tests/unit/engineReleaseMaintenanceCertificate.test.ts`, `tests/legacyEngineCheckpointAdmission.test.ts`, `tests/unit/deployCannotPinStaleCode.test.ts` and `tests/unit/theDeployProvesItself.test.ts` move with it, in the same commit, per CLAUDE.md section 5 rule 8.

**The underlying platform defect, which is not a Diamond one.** Measured 2026-09-20, `smarter_private.f06_hand_permits` holds **697 permits in state `reserved` across 470 running tournaments** (also 63 `aborted_unsettled` across 26 tournaments). `fn_f06_finish_hand` offers only two outcomes and neither can resolve these: `accepted` needs a completed `hand_atomic_commits` row that does not exist, and `never_started` needs a `park_requested` operation that almost none of them have. Every engine restart adds to the pile, which is why it grows and never falls. This belongs to the F06 owner and wants the third outcome described in `docs/changelog/2026-09-18-the-permit-nobody-can-resolve.md`, whose proof is stronger than `never_started`: the permit is reserved, there is no hand commit and no hand history at that table and hand number, and the caller holds the live lease. No data was changed to work around it, deliberately.

**The decision in front of you:** whether to take the reviewed release-control change above, or to wait for the F06 owner's resolver. The Diamond work does not force the choice. Both arena switches are off, no funded Diamond game or tournament has ever run in public, `poker_diamond_custody` holds zero rows, and nothing a player owns is stranded by the engine staying where it is.

## Step D: the two arena switches

**No agent flips these. They are yours alone.**

```sql
-- read only; this is the current state, confirmed 2026-09-20
select cash_games_enabled, tournaments_enabled, settlement_window_days
  from public.ca_arena_settings;
```

Both `cash_games_enabled` and `tournaments_enabled` are false, and every Diamond door refuses by name while they are. They stay false until you decide otherwise, and the build brief for every lane in this session forbids an agent changing them under any circumstances.

Before either is considered, the programme's own exit conditions are worth reading back rather than assumed:

```sql
select * from fn_ca_diamond_health();
select * from fn_ca_diamond_trial_balance();
select count(*) from public.ca_diamond_incidents
 where severity = 'critical' and resolved_at is null;
```

As of 2026-09-20 the money identity, deploy gate and trial balance all read ok, the last `DR11:trial_balance_break` was 2026-09-11 15:20 UTC, and four areas read attention: rules overdue, per-user caps, budget plans and unreachable money. Step A2 clears unreachable money. Budget plans are fiction by ruling 21 and refuse nobody, so that one is a forecast to set rather than a defect to fix.
