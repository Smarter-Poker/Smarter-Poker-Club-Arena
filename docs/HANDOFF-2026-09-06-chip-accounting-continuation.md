# HANDOFF PROMPT — CLUB ARENA CHIP ACCOUNTING, PHASE 2 OF 9

**Paste this entire file as the first message of a new chat.**

Gathered and verified 2026-09-06 **13:50 UTC** against live production. Every
table below says when it was measured. Re-run the commands before trusting any
of it, because another agent is working the same tree.

**This is ONE document, updated in place. There is no companion, no part two and
no addendum. If you are holding an earlier copy, discard it.**

---

# PART 0 — WHO YOU ARE AND WHAT YOU ARE PICKING UP

You are continuing Dan's chip-accounting programme on smarter.poker's Club
Arena. You are on Dan's Mac in a Cowork session with `mcp__counselors__host_terminal`
(real bash) and a Supabase MCP pointed at production (`kuklfnapbkmacvwxktbh`).
This is a live money system: ~200 hands a minute, real chip balances, real
players.

The programme is 9 phases, planned in `docs/CHIP-ACCOUNTING-ROADMAP.md` Part Two.
**Phase 1 is merged and published. Phase 2 has not started.** The prior session
ran 2026-09-06 roughly 04:00 to 13:20 UTC and shipped 9 migrations and one PR
(#3272).

Blunt sentence about what went wrong: **the prior agent (me) reported work as
verified three times when it was not.** Twice a defect survived every test
written for it, and once CI had been failing for three pushes while I reported
"checks pending". Part 7 lists all of it. Read Part 8 before you trust any
instrument in this system.

---

# PART 1 — STOP CONDITIONS. READ BEFORE ANY WORK.

## 1.1 Dan's binding instructions, verbatim

> "WE AREN'T USING ANY CRONS TO 'MONITOR OR FIX' THATS A BANDAID, NOT A HARD
> CODED SOLUTION! WE NEED TO FIX THE ISSUES AT THE CODE LEVEL!"

> "NOT CONSTANTLY RUNNING AROUND RECONCILING..."

> "I WANT NOTHING BUT CODE BASE FIXES FOR ANY AND ALL CHIP DRIFT ISSUES"

> "AND HAVE THE PUSH NOTIFICATIONS STOP UPDATING ME FOR 0.00 OR FIXES, ONLY
> CRITICAL ERRORS THAT NEED MY ATTENTION ONLY SHOULD BE SENT TO MY PHONE."

He was angry when he said the first three. I had answered a chip drift by
scheduling a repair cron. **A repair sweep, a backfill pass or a reconciliation
job is not an acceptable answer to a chip drift. The answer is the write that
cannot lose.** Detectors stay (a detector tells you whether the code fix worked).
Repairs are banned.

## 1.2 What you must NOT do

- **Do not schedule any cron** to monitor or repair chip drift. I scheduled two
  and had to unschedule them (`20260906100735`), then deleted the roster I built
  to watch them (`20260906114257`). Do not rebuild either.
- **Do not use the Claude scheduled-tasks tool.** CLAUDE.md 10.85, binding.
- **Do not set any credential anywhere.** CLAUDE.md 10.84. Read where one lives,
  say which is wrong and what shape the value should be. Never the value.
- **Do not type `is_horse` to exclude horses from anything a human gets.**
  CLAUDE.md 10.5. Horses are players.
- **Do not push to `fix/chip-std-drain-waits`.** Its PR is merged. A push there
  exits 0 and reaches nobody. New branch off `main`, always.
- **Do not attach the bomb-pot constraint trigger** until Part 5 TASK C passes.
- **Do not run `vercel deploy`, call a deploy hook, or edit alert rules on
  engine-01 by hand.**

## 1.3 Currently gated on purpose

| thing                                     | state                                            | re-enable condition                                                                                                            |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `fn_ca_bomb_hand_keeps_its_award_units()` | exists in production, **attached to no trigger** | Part 5 TASK C: engine deployed AND 0 bomb gaps over 90 minutes with >50 bomb pots. Migration `20260906101230` records why.     |
| `fn_ca_collusion_scan`                    | `status='retired'` in `ca_detector_registry`     | leave retired. Findings still land in `ca_collusion_signals` (104 rows preserved). It is a review queue, not a drift detector. |

## 1.4 Decisions that are Dan's alone, not yours

- **The horse-hand recording gate** (Part 6, MEDIUM). Put it to him with costs.
- Anything setting what players are owed in **future** events (prices, rake,
  guarantees, payout structures, retention).
- Money leaving the platform.
- Rewriting or deleting a settled record.

---

# PART 2 — ENVIRONMENT BOOTSTRAP. RUN THESE FIRST.

## 2.1 Confirm you are in the right place

```bash
ls ~/Documents/.agent-trees/club-arena/promo-route && echo "worktree OK"
```

If `mcp__counselors__host_terminal` is absent you are NOT on the Mac and
CLAUDE.md 11.1 (cloud sandbox) applies instead. Everything below assumes the Mac.

## 2.2 Quirks that will cost you an hour each

```bash
# node is NOT on the default PATH. Prefix EVERY command:
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
```

- **`host_terminal` times out at about 100 seconds and kills the process group.**
  `nohup ... & disown` **died on me twice mid-push**. The working incantation:
  ```bash
  screen -dmS jobname bash -c 'export PATH="..."; cd <dir> && <command> > /tmp/job.log 2>&1'
  # then poll /tmp/job.log in later calls
  ```
- **The pre-push hook takes about 3 minutes** (guards, tsc, tests covering your
  diff). Never `--no-verify`.
- **`gh` is NOT installed.** Use `curl` with `GITHUB_TOKEN`.
- **The GitHub REST API limit is 5,000/hour and I exhausted it** polling CI. It
  cost me the ability to read a failing job's log. `git fetch` costs nothing.
  Prefer it. Check CI once, never in a loop (CLAUDE.md 10.8.3).
- **`new-migration.mjs` takes about 60 seconds.** Run it in screen.

## 2.3 Paths

| what                                                      | where                                             |
| --------------------------------------------------------- | ------------------------------------------------- |
| Worktree (use this)                                       | `~/Documents/.agent-trees/club-arena/promo-route` |
| Main clone (mirror of origin, do not originate work here) | `~/Documents/club-arena`                          |
| World Hub                                                 | `~/Documents/Smarter-Poker-World-Hub`             |
| Commander                                                 | `~/Documents/smarter-poker-commander`             |

## 2.4 Credentials: the place, never the value

| what                                                  | where                         |
| ----------------------------------------------------- | ----------------------------- |
| `GITHUB_TOKEN`                                        | `~/Documents/club-arena/.env` |
| `SUPABASE_DB_PASSWORD`                                | `~/Documents/club-arena/.env` |
| Service identity (`daniel@smarter.poker`, role `god`) | `.env.local`                  |
| Supabase project ref                                  | `kuklfnapbkmacvwxktbh`        |

**You may read these. You may never write, rotate or paste one.** One
environment variable (`PROBE_LOGIN_EMAIL` set to Dan's own address) started a
22-hour outage. CLAUDE.md 10.84.

## 2.5 Migrations

```bash
node scripts/new-migration.mjs "what it does"          # never hand-pick a version
node /tmp/felt/apply_v.mjs <file> <slug> <version>     # apply
# parity check
PW=$(grep '^SUPABASE_DB_PASSWORD=' ~/Documents/club-arena/.env | cut -d= -f2- | tr -d '"')
node /tmp/export-one.mjs "$PW" <version> && cmp /tmp/applied_<version>.sql <file>
```

One migration = one `BEGIN`/`COMMIT`. Every DDL statement costs a ~28 second
PostgREST schema reload on this database (CLAUDE.md 2).

**Declare every new DB object** in `scripts/ci/schema-manifest.d/<branch>.json`.
Allowed keys are exactly `_owner`, `tables`, `functions`, `columns`. The
validator rejects anything else (I tried `_note`; it failed the build). Never
declare something you dropped, and never hand-edit the big manifest.

## 2.6 Shipping

```bash
git checkout -b fix/<slug> origin/main
git add -A && git -c user.name="Smarter-Poker" \
  -c user.email="254329056+Smarter-Poker@users.noreply.github.com" commit -F -
screen -dmS pu bash -c 'export PATH="..."; cd <worktree> && git push origin HEAD:refs/heads/fix/<slug> > /tmp/push.log 2>&1'
```

Commit author **must** be that exact string. Vercel refuses to build a commit it
cannot attribute and the deployment goes BLOCKED with **no build logs at all**.

Then stop. `agent-open-pr.yml` opens the PR, `agent-autopilot.yml` merges on
green, `publish-club-arena.yml` publishes. You do none of it.

---

# PART 3 — HOW THE THING ACTUALLY WORKS

## 3.1 Code to player

```
your branch push
  -> agent-open-pr.yml           opens the PR within seconds
  -> agent-autopilot.yml         enables squash auto-merge; merges when green
  -> publish-club-arena.yml      builds, runs the 4-way sharded test gate,
                                 rsyncs dist/ to ca-static.smarter.poker,
                                 swaps the `current` symlink atomically
  -> World Hub rewrite           /hub/club-arena/* -> that origin
  PROOF OF LIVE: curl -s https://smarter.poker/hub/club-arena/build-info.json
                 ca_sha must equal or descend from your squash commit
```

**The ENGINE ships separately.** `server/**` changes go through
`auto-deploy-hetzner.yml`, which waits for the `:55` maintenance break
(CLAUDE.md 13: at :53 tables finish their hand, at :55 the platform freezes and
the engine restarts, at :00 `fn_thaw_platform` gives deadlines back). **So a
server-side fix is not running until the next :55 after merge.**

## 3.2 A hand's money path (the part Phase 1 touched)

```
ServerTableEngineDealing.dealingLoop
  -> settlement barrier   waits on postHandTasksPromise before dealing the next hand
  -> ServerTableEngineSettlement.settleCompletedHand
       builds bombAwardUnits from snap.perPotAwards
  -> logHandHistory({ ..., bombAwardUnits })       services/supabase/handHistory.ts
       -> insertHandHistoryRow(row, 'settlement', bombUnits)
            if units: supabase.rpc('fn_ca_insert_hand_with_awards', {p_row, p_units})
                      ONE transaction: hand_history row + bomb_pot_award_units
            else:     .from('hand_history').insert(row)
       -> on failure: enqueueHandHistory(row, bombUnits)  background retry queue
                      the queue CARRIES the units (fixed 2026-09-06)
  -> GameServer.drainHands() on SIGTERM
       refuses to call a table parked while engine.hasSettlementInFlight()
```

## 3.3 The incident pipeline

```
detector fn (about 40 of them)
  -> fn_ca_raise_drift_incident(source, class, severity, dedupe_key, amount, ...)
       - returns NULL if the source is 'retired' in ca_detector_registry
       - folds on exact dedupe_key
       - folds on key-minus-period-label WHEN THE AMOUNT MATCHES TOO
       - raises a mirrored financial_alert ('drift_incident:<source>')
       - calls fn_ca_incident_notify unless severity='info' or storm-suppressed
  -> fn_ca_incident_notify -> fn_raise_notification -> Dan's phone
  resolution propagates BOTH ways between financial_alerts and ca_drift_incidents
```

**Healthy cadence:** ~125 bomb pots/hour, ~200 hands/minute, and the incident
board should be _shrinking_. If new incidents outpace closures, a detector is
misfiring (see Part 5 TASK A).

---

# PART 4 — COMPLETE STATE INVENTORY

## 4.1 Metrics, before and now

| metric                                  | session start            | **13:20 UTC now**                               | how                                                   |
| --------------------------------------- | ------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
| open drift incidents                    | 323                      | **108** (126 before TASK A)                     | `ca_drift_incidents where resolved_at is null`        |
| critical                                | 135                      | **42**                                          | same, `severity='critical'`                           |
| resolved total                          | ~1,264                   | **1,901**                                       | same, `resolved_at is not null`                       |
| NEW incidents in last 3h                | n/a                      | **40, of which 17 were the TASK A false alarm** | `detected_at > now()-interval '3 hours'`              |
| unresolved financial_alerts             | 894 claimed / 379 actual | **278**                                         | `financial_alerts where not resolved`                 |
| bomb pots with no award units, last 90m | 3/hour                   | **2 of 178**                                    | see Part 9                                            |
| banned repair crons                     | 2 (mine)                 | **0**                                           | `cron.job where jobname ilike '%bomb%' or '%roster%'` |
| collusion signals preserved             | 104                      | **104**                                         | `ca_collusion_signals`                                |

**The board went UP from 91 to 126 while the handoff was being written.** That is
not regression in Phase 1; it is a live inflow, and Part 5 TASK A is the cause of
most of it.

## 4.2 Repo and deploy state

| item                                                             | value                        | verified how                         |
| ---------------------------------------------------------------- | ---------------------------- | ------------------------------------ |
| `main` head                                                      | `59e657a234`                 | `git log --oneline origin/main -1`   |
| PR #3272                                                         | **MERGED** as `f33035d32b`   | on main                              |
| `TheDrainWaitsForTheMoney.law.test.ts` on main                   | YES                          | `git cat-file -e`                    |
| `TheBombBreakdownTravelsWithTheHand.law.test.ts` on main         | YES                          | `git cat-file -e`                    |
| `fn_ca_insert_hand_with_awards` refs in `handHistory.ts` on main | 3                            | `git show origin/main:...`           |
| published `ca_sha`                                               | `a9dfcf6943` at 13:18:56 UTC | `build-info.json`                    |
| **engine deployed with Phase 1**                                 | **NOT CONFIRMED**            | 2 bomb gaps in last 90m. See TASK C. |
| **`6f1a454f93` (other agent's CI fix)**                          | **STRANDED, not on main**    | `git merge-base --is-ancestor`       |

## 4.3 Migrations applied (9, all at file-vs-applied parity)

```
20260906092846  the_fifteen_abandoned_settlements_were_three_shutdowns
20260906095606  one_condition_is_one_incident_counted_in_chips_that_closes_w
20260906100405  a_cron_job_that_vanishes_is_not_invisible          [REVERTED by 114257]
20260906100735  a_bomb_pot_cannot_commit_without_saying_who_won_which_board
20260906101230  the_bomb_guard_waits_for_the_engine_that_can_satisfy_it
20260906102144  the_incident_raiser_states_its_own_grants
20260906113554  the_atomic_hand_insert_lets_the_defaults_apply_and_proves_it
20260906113923  the_propagation_says_why_and_cannot_fail_in_silence
20260906114257  the_cron_roster_goes_too
```

## 4.4 New database objects (live)

| object                                           | purpose                                          |
| ------------------------------------------------ | ------------------------------------------------ |
| `fn_ca_insert_hand_with_awards(jsonb,jsonb)`     | one transaction for hand row + bomb award units  |
| `fn_ca_stable_dedupe_key(text)`                  | strips a trailing period label from a dedupe key |
| `fn_ca_alert_resolution_reaches_the_incident()`  | trigger on `financial_alerts`                    |
| `fn_ca_incident_resolution_reaches_the_alerts()` | trigger on `ca_drift_incidents`                  |
| `fn_ca_bomb_hand_keeps_its_award_units()`        | **defined, deliberately NOT attached**           |

**Dropped again on purpose:** `ca_expected_cron_jobs`, `fn_ca_cron_roster_watch`.

---

# PART 5 — THE TASKS THAT BLOCK EVERYTHING ELSE

Do these in order. Do not mark one done until its acceptance criteria are
_measured_.

---

## TASK A — SHIPPED 2026-09-06 13:35 UTC. VERIFY IT HELD.

**This was the top task and it is done.** Migration
`20260906132947_only_a_critical_that_needs_a_person_reaches_a_person`, pinned by
`tests/only-a-critical-reaches-a-person.law.test.ts`.

### What it fixed

**A1. `fn_ca_escrow_on_close` judged a postcondition as a precondition.** It is
an AFTER UPDATE trigger on `tournaments` firing the instant status becomes
COMPLETED, and at that instant **the prizes have not been paid yet**, so
`prize_balance` is still the whole pool. It reported that pool as chips left in
escrow, up to 2,375.00 a time, roughly six an hour.

Measured, its ten most recent: **8 of 10 now read `prize_balance 0.00`**, and
three checked against `tournament_payouts` had `prize_out` equal to the sum of
their payout rows exactly. Only 2 of 10 were genuinely stuck (20 Chip Spin PLO4
55.20, NLH Heads-Up 20 Turbo 217.36).

It now stamps `closed_at` and `close_note` and raises nothing.
**`fn_ca_escrow_vs_counter_check` still detects genuinely stuck escrow**, after
settlement has had time to happen. No sweep was added.

**A2. `fn_ca_incident_notify` pushed on warnings, on 0.00, and on resolutions.**
Three gates now sit on the push only, checked in this order: a resolution never
pages (checked first, or a resolved critical slips through), anything below
critical never pages, a zero never pages. The incident is still filed, the board
still shows everything, and the reason a push was withheld is recorded as
`ca_incident_events.kind = 'notify_withheld'`.

### Verify it held

```sql
select
 (select count(*) from ca_drift_incidents where resolved_at is null
    and source='fn_ca_escrow_on_close')                                   escrow_close_open,
 (select count(*) from ca_drift_incidents where source='fn_ca_escrow_on_close'
    and detected_at > now()-interval '2 hours')                           escrow_close_new_2h,
 (select count(*) from pg_proc where proname='fn_ca_escrow_on_close'
    and prosrc ~ 'fn_ca_raise_drift_incident')                            close_still_raises,
 (select count(*) from ca_incident_events where kind='notify_withheld')   withheld,
 (select count(*) from ca_incident_events where kind='notified'
    and at > now()-interval '2 hours')                                    pages_2h;
```

**Healthy:** `escrow_close_open` 0 · `escrow_close_new_2h` 0 ·
`close_still_raises` **0** · `withheld` climbing · `pages_2h` small and every one
a non-zero unresolved critical.

**Measured immediately after the migration (13:35 UTC):** 0 · 0 · 0 · 0 · 0, and
the board fell 126 to 108.

**PROVED LIVE at 13:50 UTC**, with a self-aborting probe against the real
function (this is how to re-prove it, and the error IS the success case):

```sql
DO $probe$
DECLARE v_inc uuid; v_sent int; v_w int;
BEGIN
  INSERT INTO public.ca_drift_incidents
    (classification, severity, layer, source, dedupe_key, discrepancy_amount, suspected_cause)
  VALUES ('ledger_imbalance','critical','ledger','zz_live_probe','zz-live-zero',0,'live gate probe')
  RETURNING id INTO v_inc;
  v_sent := public.fn_ca_incident_notify(v_inc,'notified','live probe zero',false);
  SELECT count(*) INTO v_w FROM public.ca_incident_events
   WHERE incident_id=v_inc AND kind='notify_withheld';
  RAISE EXCEPTION 'LIVE_GATE sent=% withheld_rows=%', v_sent, v_w;
END $probe$;
```

It returned **`LIVE_GATE sent=0 withheld_rows=1`**: a 0.00 critical sent nothing
and recorded why. The probe rolled itself back.

**A NOTE ON READING `pages_2h` BEFORE YOU PANIC.** At 13:50 there were still 11
`notified` rows in the previous 30 minutes, all 0.00 criticals from
`financial_alerts:fn_payout_guarantee_check` - and every one of them was stamped
**13:18:00, fifteen minutes BEFORE the migration applied**. Check the timestamp
against the migration before concluding the gate leaks. `fn_payout_guarantee_check`
raising criticals with a 0.00 discrepancy is itself in the backlog at H8.

**IF `pages_2h` IS ZERO FOR A DAY, CHECK THE OTHER DIRECTION.** The gates could
be drawn too tight. The migration proves a real critical carrying 12,345.67 chips
still delivers, but prove it again against live data before assuming silence
means health. Silence and no monitoring are the same observation.

## TASK B — LAND THE STRANDED COMMIT

`6f1a454f93` (`test(rit): pace multiway all-in runout at test speed (reveal=1ms)
to eliminate 10s CI timeout`) was written by another agent to fix the CI failure
that blocked #3272. **It sits on `fix/chip-std-drain-waits`, whose PR is merged.**

Under CLAUDE.md 10.82 a push to a merged branch exits 0 and delivers nothing.
World Hub #1387 shipped 1 of 3 commits exactly this way.

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
cd ~/Documents/.agent-trees/club-arena/promo-route && git fetch origin -q
git merge-base --is-ancestor 6f1a454f93 origin/main && echo "ALREADY LANDED - task closed" || echo "STRANDED - proceed"
```

If STRANDED:

```bash
git checkout -b fix/rit-runout-test-speed origin/main
git cherry-pick 6f1a454f93
screen -dmS pu bash -c 'export PATH="..."; cd ~/Documents/.agent-trees/club-arena/promo-route && git push origin HEAD:refs/heads/fix/rit-runout-test-speed > /tmp/push_rit.log 2>&1'
```

**ACCEPTANCE:** after autopilot merges, `git cat-file -e origin/main:<the RIT test
file>` and diff it. **Verify the file, never the tick.**

**FAILURE MODE:** `guard-merged-branch.sh` blocks the push. That is the guard
working; confirm you are on the new branch, not the merged one.

---

## TASK C — VERIFY THE ENGINE DEPLOYED, THROUGH THE DATABASE

**Never use `https://engine.smarter.poker/health` to verify a deploy. It is
CDN-cached and will lie to you.**

```sql
-- 1. the restart dip
select date_trunc('minute',created_at) m, count(*) hands
from hand_history where created_at > now()-interval '2 hours'
group by 1 order by 1 desc limit 90;

-- 2. THE PROOF (must be 0)
select count(*) from hand_history h
where h.bomb_pot is not null and h.created_at > now()-interval '90 minutes'
  and round(coalesce(h.pot_size,0)-coalesce(h.rake_amount,0)-coalesce(h.bbj_amount,0),2) > 0
  and not exists (select 1 from bomb_pot_award_units a where a.hand_history_id=h.id);

-- 3. context (a 0 with 0 bombs proves nothing)
select count(*) from hand_history
where bomb_pot is not null and created_at > now()-interval '90 minutes';
```

**ACCEPTANCE:** query 2 returns **0** while query 3 returns **> 50**.
**Measured 13:20 UTC: query 2 = 2, query 3 = 178. Not yet deployed.**

**Baseline for comparison:** before the fix, 3 of 125 bomb pots per hour had no
award units; 18 of 25,888 over 7 days. The detector `fn_bomb_pot_ledger_gaps`
under-reports (grace period plus epoch floor), so trust the query, not the
detector.

---

## TASK D — ATTACH THE BOMB-POT GUARD (only after TASK C passes)

**Precondition: TASK C acceptance met. Do not attach on a hopeful reading.** I
attached it once before the engine could satisfy it, which was the wrong order.

Write it as a migration and **guard the DDL**:

```sql
BEGIN;
DO $attach$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.hand_history'::regclass
                    AND tgname='zz_ca_bomb_hand_keeps_its_award_units') THEN
    SET LOCAL lock_timeout = '10s';
    CREATE CONSTRAINT TRIGGER zz_ca_bomb_hand_keeps_its_award_units
      AFTER INSERT ON public.hand_history
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.bomb_pot IS NOT NULL)
      EXECUTE FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units();
  END IF;
END $attach$;
COMMIT;
```

**WHY THE GUARD:** a bare `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER` on
`hand_history` takes `AccessExclusiveLock` against ~200 inserts/minute. **It
deadlocked on me twice (`40P01`)** and one migration failed outright until it was
wrapped in an existence check plus `lock_timeout`.

**ACCEPTANCE:** trigger in `pg_trigger`; bomb pots still committing 10 minutes
later; TASK C query 2 still 0.

**ROLLBACK if bomb pots stop committing:**

```sql
SET lock_timeout='9s';
DROP TRIGGER IF EXISTS zz_ca_bomb_hand_keeps_its_award_units ON public.hand_history;
```

Then record the drop in a follow-up migration. Never leave files and database
disagreeing.

---

# PART 6 — THE FULL BACKLOG, PRIORITISED

## HIGH — the remaining 126 incidents, by write path

### H1. Escrow at close (18 open, ~6/hour inflow) — see TASK A

Detector defect. Fix the detector, not the data.

### H2. Escrow vs counter (30 open, static)

`fn_ca_escrow_vs_counter_check`, 24 info + 6 warning, **all club
`fade0000-0000-0000-0000-000000000001` (Midway Union)**. Two distinct shapes.

**Shape A, paid MORE than escrow held (negative residue):**

| tournament_id                          | event                                  | amount  |
| -------------------------------------- | -------------------------------------- | ------- |
| `f2502226-d3d0-4de5-8067-41858de3c06e` | Union Grand Championship (NLH), bounty | -920.00 |
| `1f97c186-bf78-4336-aaad-afffd196335d` | Union Mystery Bounty (PLO5)            | -700.00 |
| `4375d276-de0e-4ffa-aaee-a7c0121de4cb` | Evening Mystery Bounty (PLO5)          | -350.00 |
| `f1b134c0-6a71-4349-a8ef-e344ff12439e` | $100 Freeroll 6:00 PM                  | -100.00 |
| `91dd8dbf-108c-4b4e-b067-3f36d16bb746` | Sunday Deep Stack Satellite $5         | -92.00  |
| `39f751e9-b905-4735-8cab-fe431220fd43` | $100 Freeroll 12:00 AM                 | -41.71  |
| `9a7f48d2-2c34-4f97-8993-ed784d75bcbd` | Turbo Tuesday Opener                   | -32.00  |

**Shape B, fee left in escrow (positive residue):** ~20 heads-up SNGs, 0.10 to
190.00, pattern `fee N.NN left in escrow`.

**Check first whether H2 is the same false positive as H1** before hunting a
money bug: read `prize_balance` / `fee_balance` on those tournaments now. If they
are zero, this is the same stale-read defect and closes with TASK A.

**Done means:** either the close path drains the fee sub-balance, or the detector
stops reading a transient state. Not a repair pass.

### H3. The live 2,523.48 (7 incidents, kill switch tripped)

```
account_key : club_treasury:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:clubs.chip_treasury
moved       : +938.24 between 2026-09-06 01:21:01.377743+00 and the reading
journal says: -1585.24
unexplained : 2523.48 this interval, 2523.88 cumulative
kill switch : threshold 1000, verdict UNCONFIRMED, persists false
```

**"UNCONFIRMED / persists false" means ONE reading.** Confirm it recurs before
treating it as a leak. Same detector, same family:

- `spin_reserve:2d968239-acdd-4a2c-99f2-a369ff37ae31:spin_bonus_pools.balance` — **430.00**
- `table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack` — **-10.74**

**Same club as H4. Check whether H4's missing baseline is polluting the replay
before hunting a leak.**

### H4. Deep Stack Society treasury, 9,981,736.92 (5 incidents) — NOT A LEAK

Club `2a1132b9-5ba2-42e6-9f01-30a7fcffebe3`, created **2026-08-31 19:02**.

**Evidence it is an unregistered opening balance, not a loss:**

- `ca_treasury_baseline` registers unledgered opening gaps for three clubs. An
  independent recomputation from `chip_ledger` matched **all three to the cent**:
  Club JAQK 33,223,391.23, SHARK CLUB 8,450,449.72, Midway Union 9,766.78.
- That snapshot was taken **2026-08-31 10:45:50**, eight hours before Deep Stack
  existed. It has no row.
- **The gap is constant.** Measured twice minutes apart: journal and stored both
  moved 17.53 in lockstep, gap unchanged to the cent.

**Two code defects:**

1. The baseline is a one-shot snapshot with **no rule for clubs created later**.
   Give club creation the baseline row.
2. **Only `reconcile_ledger_nightly` subtracts the baseline.** Verify:
   ```sql
   select proname, prosrc ~ 'ca_treasury_baseline' as reads_baseline
   from pg_proc where pronamespace='public'::regnamespace
     and proname in ('reconcile_ledger_nightly','fn_ca_quick_reconcile','fn_ca_auto_reconcile_tick');
   ```
   `fn_ca_quick_reconcile` and `fn_ca_auto_reconcile_tick` return false, so they
   re-report the three _explained_ clubs forever.

**The same defect produces `fn_ca_quick_reconcile:frozen_pool` (-10,700).** That
detector does not read `ca_frozen_pool_baseline` either, and the baseline was
already moved to 732,581,294.33 for the authorised phantom-promo retirement. Fix
once, close both.

### H5. Frozen pool residual 0.30

`ca_frozen_pool_baseline.frozen_total` = 732,581,294.33.
`select sum(balance) from wallets` = 732,581,294.03. **Residual 0.30 that no
change record explains.** 601 wallet rows touched since the 2026-08-21 freeze,
all now 0.00. The pool's own rule is that any movement is critical.

### H6. Diamonds (2 incidents)

```
2026-09-02-18 : +619,829  (cert 234,480 · wallet 619,879 · profile 1,030,092)
2026-09-05-19 :   -8,000  (cert 233,980 · wallet 1,022,232 · profile 1,022,232)
```

Detector text: _"a diamond writer is bypassing the journal."_ On 09-05 wallet
equals profile; on 09-02 it does not. That divergence is the lead.
`diamond_transactions` is the journal.

### H7. Insurance offers unresolved (2, -1.00 each)

| entity_id                              | table_id                               | hand    | last offer          |
| -------------------------------------- | -------------------------------------- | ------- | ------------------- |
| `9eb2a231-a42f-4162-8818-3f14ebc19385` | `19ae6284-4fb9-4cb9-a524-1bd0c522b9eb` | 5539051 | 2026-09-04 00:01:30 |
| `00000000-0000-0000-0000-000000000027` | `4b29fe59-e882-48eb-8de8-fed17f3e56dc` | 4765667 | 2026-09-02 23:55:15 |

### H8. The rest (~40)

`fn_spin_book_entry` (5, 4 new in 3h) · `financial_alerts:fn_payout_guarantee_check`
(4) · `financial_alerts:fn_settle_tournament_obligation` (5) ·
`r3_money_path_log` (5, tournament credits written outside
`fn_settle_tournament_obligation`, log-only) · `fn_ca_journal_append_only` (4,
`reason_kind` NOT in the recognised list; recognised ones self-resolve) ·
`fn_ca_guard_defs_watch` (4, **mostly self-inflicted by our own migrations —
re-baseline, do not investigate**) · `bbj_promo_bank_check` 6,705.21 (2) ·
`bbj_conservation_check` 70,795.11 (1) · `fn_ca_money_rpc_drift` (2) ·
`fn_ca_ratchet_watch` (1) · `fn_ca_suspense_regression_check` 117.20 (1) ·
`suspense_flow` 20,000 + 15.40 (2) · `fn_tournament_payout_reconcile` (3).

## MEDIUM — Phases 3 to 9

| #   | phase                                                                                   | why                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | **One definition of a chip.** Scale 2 everywhere.                                       | Today: scale 2 on journal/wallet/felt/treasury; **scale 4** on `agents.agent_wallet_balance`, `club_wallets.chip_balance`, `rake_records.rake_amount`; **unconstrained numeric** on the union bank, all three escrow banks, `tournament_payouts.amount`, tournament pools. A 4-dp balance against a 2-dp journal leaks by construction. **No sub-cent residue in live data today**, so it is cheap now and expensive after a reset re-bases everything. |
| 4   | Realtime load: partition and `DROP PARTITION` (roadmap 8.4).                            | WAL 1,854 kB/s against 1,880 kB/s capacity, and it fails as a spiral (a lagging slot reads WAL from disk).                                                                                                                                                                                                                                                                                                                                              |
| 5   | Anchor the daily attestation outside the database; give the journal a retention policy. | `ca_ledger_day_manifests` hashes the journal and is stored **in the database it attests to**.                                                                                                                                                                                                                                                                                                                                                           |
| 6   | A player can audit their own chips.                                                     | `chip_ledger` RLS **already** permits it. No surface exists. Cheapest support tool on the platform.                                                                                                                                                                                                                                                                                                                                                     |
| 7   | Audit the second writer.                                                                | The World Hub has its own money routes in another repo, never checked against the door register.                                                                                                                                                                                                                                                                                                                                                        |
| 8   | The other currencies get a ledger.                                                      | VIP points, rakeback, agent commissions are **counters only**. That is why 16,426.46 of duplicate rake stayed invisible for five months.                                                                                                                                                                                                                                                                                                                |
| 9   | The reset is a phase; write the restatement policy.                                     | `ca_financial_epochs.is_current` is the hook. **No restatement policy exists** and the 16,426.46 sits behind five months of paid VIP points and commissions.                                                                                                                                                                                                                                                                                            |

## BLOCKED ON DAN, not an agent's call

**The horse-hand recording gate.** A prior handoff proposed skipping the
`hand_history` write for horse-only hands to relieve realtime load. **Do not
build it.** It breaks CLAUDE.md 10.5 for recording, is irreversible (data not
written cannot be backfilled), and bounty attribution reads those rows to decide
who busted whom in tournaments paying real chips. Alternative A ("keep the row,
kill the trigger cascade") is **not** the safe middle: those triggers feed
`player_stats`, VIP points and the rakeback basis, so skipping them for horses is
the exact `is_horse` shape 10.5 forbids. Only option C (partition and
`DROP PARTITION`) is a clean storage decision. **Put it to Dan with costs.**
Precedent: he decided the 7-day horse-only retention himself, on the record.

## DONE DIFFERENTLY THAN SPECIFIED

- **`check-migrations-applied.mjs` was changed**, not worked around. It now
  subtracts objects the branch drops. `ca_expected_cron_jobs` and
  `fn_ca_cron_roster_watch` were created and dropped in the same branch after
  Dan's no-cron ruling: they genuinely ran and are genuinely gone, and the gate
  failed anyway. Its only escapes were to lie in a manifest fragment (the nightly
  refresh turns that red within a day) or stamp `BACKFILLED` on a file that was
  not backfilled. A gate whose only exits are dishonest gets routed around, so it
  learned the case instead.

---

# PART 7 — EVERY DEFECT FOUND, AND ITS LESSON

## 7.1 The settlement barrier reported the wrong fault (fixed, shipped)

**Symptom, real output:** fifteen criticals reading
`"Table <id>: settlement for hand #N exceeded 300s; dealing resumed while it ran"`
and every one carrying `waitedMs: 30000`.

**Cause:** `while (!settled && waited < maxWaitMs && this.running)` with
`maxWaitMs = 300_000`. At 30,000 the timeout was still false, so it exited on
`this.running`. They were **shutdowns**: three of them, five tables each, inside
one second (09-05 16:07, 09-05 17:50, 09-06 04:10).

**Underneath sat the real hole:** `GameServer.drainHands()` counted a table parked
the moment `!isRunning()` while `postHandTasks` (settlement, rake record, hand
history) was still writing. The drain reported a clean stop and the process
exited on in-flight money. **At :55. Every hour.**

**Lesson:** when a guard fires, check which of its conditions actually ended the
wait. A message that names the wrong cause is worse than no message, because
people stop reading the class.

## 7.2 A function that failed on every call, with green tests (fixed)

**Symptom:** `23502 null value in column "id" of relation "hand_history" violates
not-null constraint`, from a probe. Zero callers had noticed because the engine
change had not deployed yet.

**Cause:** `INSERT INTO hand_history SELECT * FROM jsonb_populate_record(null::hand_history, p_row)`.
Over a NULL base that supplies an **explicit NULL for every column the caller did
not name**, and an explicit NULL **overrides a DEFAULT**. `hand_history.id` is
`uuid NOT NULL DEFAULT gen_random_uuid()`.

**Why every test passed:** they asserted the engine _called_ the RPC and that the
units were built from `perPotAwards`. All true. None touched the thing on the
other end of the wire.

**Lesson, adopted as practice:** **a migration that defines a money-path function
must CALL it against the real table, check what it wrote, and roll back in a
subtransaction, aborting the migration if it cannot work.** Pattern in
`20260906113554` and `20260906113923`. Copy it.

## 7.3 Two triggers that never once fired, hidden by my own handler (fixed)

**Symptom:** resolved a probe alert, read the mirrored incident back: still open.

**Cause:** `fn_ca_resolution_needs_a_cause` refuses any resolve without a
**40-character `root_cause`** and a `correction_ref` in one of its accepted forms
(`migration <name>` · `PR #<n>` · `chip_ledger <id>` · `correction:<key>` ·
`ruling: <decision>` · `verified: <evidence>` · `no-change-needed: <why>`). My
triggers set neither, raised P0404 every time, and my
`EXCEPTION WHEN OTHERS THEN RAISE WARNING` swallowed it into the Postgres log,
**the exact place CLAUDE.md records 901 consecutive failures once hiding**.

**Lesson:** never let a trigger's failure handler write only to the Postgres log.
Record it where a person reads (`ca_incident_file_failures`).

## 7.4 A rule attached before the code that could obey it (reverted)

I attached the bomb constraint trigger while the engine still wrote hand and
units separately, then saw a 2m41s gap in bomb pots, concluded I had broken live
play, and dropped it. **Both readings were wrong:** normal maximum gap that hour
was **489s**, and three unit-less hands committed _while the trigger was live_,
so it was not blocking either.

**Lesson:** a rule lands with or after the code that can satisfy it, never
before. And do not act on a distribution you have not finished reading.

## 7.5 The retry queue lost the same thing the fix protected (fixed)

`QueuedHand` held `{row, attempts, queuedAt, bytes}` and the drain called
`insertHandHistoryRow(entry.row, 'retry-queue')` with no units. A bomb hand that
missed its first attempt was replayed and written with **no award units**, and
the settlement-side fallback my own comment pointed at this case had already
returned.

**Lesson:** when you make a hot path atomic, follow every other path that reaches
the same table.

## 7.6 A flag that was true when nothing had been written (fixed)

`wroteAwardUnits: handId !== null && bombUnits.length > 0` is also true on the
duplicate-recovery path, where the RPC failed 23505 and **rolled back whole**.
The caller then skipped its fallback.

**Lesson:** a "did we write it" flag must be set by the write, not inferred from
its inputs.

## 7.7 The shape they share

**Every one is an instrument that was confidently wrong.** A message naming the
wrong cause; a test asserting the call instead of the effect; a handler logging
where nobody reads; a flag inferred rather than observed. Not one was a hard
algorithmic bug. **In this system, suspect the instrument before the mechanism.**

---

# PART 8 — TRAPS AND INSTRUMENTS THAT LIE

| trap                                           | what it looks like                                                                                                                                                                       | detection                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **`mergeable_state: unknown`**                 | reads as "still running". It means GitHub has not computed it. **CI had been FAILING for three pushes while I reported "checks pending".**                                               | `curl .../actions/runs?branch=<b>` and `.../commits/<sha>/check-runs`                   |
| **The engine health endpoint**                 | returns a stale SHA. CDN plus 15-minute fetch cache.                                                                                                                                     | Verify deploys **through the database** (Part 9).                                       |
| **A merged PR**                                | "merged" is not "landed" and not "published".                                                                                                                                            | `git cat-file -e origin/main:<path>`, then `build-info.json`                            |
| **A pushed commit on a merged branch**         | `git push` exits 0 and delivers nothing.                                                                                                                                                 | `git merge-base --is-ancestor <sha> origin/main`                                        |
| **GitHub API 403**                             | reads like an auth failure. It is the 5,000/hour rate limit.                                                                                                                             | the body says `API rate limit exceeded for user ID`                                     |
| **A cron job created by an applied migration** | can simply vanish. `20260831112020` is recorded applied; its job was not in `cron.job`. Every cron check measures jobs that **run and fail**, and a job that does not exist never fails. | `select * from cron.job where jobname='<name>'`                                         |
| **`fn_bomb_pot_ledger_gaps`**                  | under-reports (grace period plus epoch floor). Reported 18 in 7 days when the live rate was 3/hour.                                                                                      | use the raw query in Part 9, not the detector                                           |
| **`fn_ca_escrow_on_close`**                    | files up to 2,375.00 for prizes that were paid in full. Reads escrow at the instant of close.                                                                                            | join to `tournament_escrow.prize_balance` and `tournament_payouts`                      |
| **`discrepancy_amount`**                       | held three different units. The board's "worst discrepancy" of 97,085,751.26 was a deleted-row chip **volume**.                                                                          | read `suspected_cause` before believing a number                                        |
| **A Supabase MCP transaction**                 | does **not** span two calls. `BEGIN` / probe / `ROLLBACK` across three calls **commits the probe**.                                                                                      | one call, one `DO` block ending in `RAISE EXCEPTION`. **An error is the success case.** |
| **`DROP TRIGGER IF EXISTS` on a hot table**    | takes AccessExclusiveLock even when there is nothing to drop; deadlocks against ~200 inserts/min.                                                                                        | guard with an existence check plus `SET LOCAL lock_timeout`                             |

---

# PART 9 — VERIFICATION COMMANDS

## 9.1 Did the previous work land

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
cd ~/Documents/.agent-trees/club-arena/promo-route && git fetch origin -q
git log --oneline origin/main | grep -m1 3272                       # expect f33035d32b
git show origin/main:server/src/services/supabase/handHistory.ts | grep -c fn_ca_insert_hand_with_awards   # expect 3
git show origin/main:server/src/services/supabase/handHistory.ts | grep -c "units: structuredClone(units)" # expect 1
git show origin/main:server/src/GameServer.ts | grep -c hasSettlementInFlight                              # expect 1
git merge-base --is-ancestor 6f1a454f93 origin/main && echo LANDED || echo STRANDED
curl -s https://smarter.poker/hub/club-arena/build-info.json
```

## 9.2 Production health, one query

```sql
select
 (select count(*) from ca_drift_incidents where resolved_at is null)                          open_incidents,
 (select count(*) from ca_drift_incidents where resolved_at is null and severity='critical')  criticals,
 (select count(*) from ca_drift_incidents where resolved_at is null
     and detected_at > now()-interval '3 hours')                                              new_3h,
 (select count(*) from financial_alerts where not resolved)                                   alerts_open,
 (select count(*) from cron.job where jobname ilike '%bomb%' or jobname ilike '%roster%')      banned_crons,
 (select count(*) from pg_trigger where tgname='zz_ca_bomb_hand_keeps_its_award_units')        bomb_guard,
 (select count(*) from ca_collusion_signals)                                                   collusion_kept,
 (select count(*) from hand_history h where h.bomb_pot is not null
     and h.created_at > now()-interval '90 minutes'
     and round(coalesce(h.pot_size,0)-coalesce(h.rake_amount,0)-coalesce(h.bbj_amount,0),2) > 0
     and not exists (select 1 from bomb_pot_award_units a where a.hand_history_id=h.id))       bomb_gaps_90m,
 (select count(*) from hand_history where bomb_pot is not null
     and created_at > now()-interval '90 minutes')                                             bombs_90m,
 (select count(*) from ca_incident_file_failures)                                              file_failures;
```

**Healthy:** `banned_crons` 0 · `collusion_kept` 104 or more · `bomb_gaps_90m` 0
with `bombs_90m` > 50 · `open_incidents` **trending down**, and `new_3h` small.
**Measured 13:20 UTC:** 126 · 42 · **40** · 278 · 0 · 0 · 104 · **2** · 178 · 10.

## 9.3 Full local gate before any push

```bash
cd ~/Documents/.agent-trees/club-arena/promo-route
npx tsc -p server/tsconfig.json --noEmit                 # expect silence
cd server && npx vitest run                              # expect 431 files / 6192 tests, 0 failed
cd .. && npx vitest run tests/law-registry.law.test.ts   # expect 201 passed
CA_BASE_REF=origin/main node scripts/ci/check-migrations-applied.mjs
```

Run the server suite in `screen`; it takes about 2.5 minutes and will be killed
by the tool timeout otherwise. If a test fails that you did not touch, run it
again with `env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_URL CI=true` before
assuming it is yours.

---

# PART 10 — FILE MAP

| path                                                                  | what it does                                                 | state                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `server/src/engine/ServerTableEngineDealing.ts`                       | settlement barrier; distinguishes shutdown from abandonment  | live on main                            |
| `server/src/engine/ServerTableEngineBase.ts`                          | `settlementInFlight` + `trackSettlementInFlight`             | live on main                            |
| `server/src/engine/ServerTableEngineSettlement.ts`                    | builds `bombAwardUnits`, hands them to `logHandHistory`      | live on main                            |
| `server/src/services/supabase/handHistory.ts`                         | atomic insert, retry queue carrying units, `wroteAwardUnits` | live on main                            |
| `server/src/GameServer.ts`                                            | `drainHands` refuses to park a table mid-settlement          | live on main                            |
| `server/src/engine/TheDrainWaitsForTheMoney.law.test.ts`              | pins the drain and barrier                                   | live                                    |
| `server/src/engine/TheBombBreakdownTravelsWithTheHand.law.test.ts`    | pins the atomic write, the queue, the flag                   | live                                    |
| `scripts/ci/check-migrations-applied.mjs`                             | now subtracts branch DROPs                                   | live                                    |
| `scripts/ci/schema-manifest.d/fix-chip-std-drain-waits.json`          | declares 5 new functions                                     | live                                    |
| `docs/CHIP-ACCOUNTING-ROADMAP.md`                                     | Part Two is this programme                                   | reference                               |
| `docs/changelog/2026-09-06-the-drain-waits-for-the-money.md`          | Phase 1 engine                                               | reference                               |
| `docs/changelog/2026-09-06-the-323-open-drift-incidents.md`           | the incident sweep                                           | reference                               |
| `docs/changelog/2026-09-06-the-deep-dive-that-found-two-of-my-own.md` | the defects in my own work                                   | reference                               |
| `fn_ca_bomb_hand_keeps_its_award_units()` (DB)                        | constraint function                                          | **defined, NOT attached, on purpose**   |
| `fn_ca_collusion_scan` (DB)                                           | collusion review queue                                       | **retired in the registry, on purpose** |

---

# PART 11 — HOW TO BEHAVE ON THIS WORK

1. **Read real output before believing a test.** Part 7.2 is what happens
   otherwise.
2. **Fix-first.** Find an issue, fix it fully, move on. Do not audit ten things
   and ask what to fix (CLAUDE.md 4).
3. **Write your own changelog file**, `docs/changelog/YYYY-MM-DD-<slug>.md`.
   Never append to `MIGRATION-CHANGELOG.md`; two files written independently
   cannot conflict.
4. **Measure, do not assume.** Every number you report carries how you got it.
   Check distribution before reporting a total: "3,471 failures in 7 days" was a
   3-day outage that had ended; "42,801 chips" was 10,700 counted four times.
5. **Suspect the instrument.** Part 7.7.
6. **Say separately what is merged, what is published, and what is neither.**
   Never collapse them into "done".
7. **Own errors plainly and move on.** No self-flagellation, no burying.
8. **Under CLAUDE.md 10.9 you decide the money** when all five conditions hold:
   outcome read not assumed · nobody paid twice · nothing clawed back for our
   mistake · proved in a rolled-back transaction · you can write the paragraph
   naming every affected player. Fail one and it goes to Dan **as options with
   costs and your recommendation**, never as a question.
9. **A settlement is finished when all four exist:** the migration with reasoning
   in the header, the changelog, the `financial_alerts` row resolved with a
   `resolution` note, and the code fix that stops recurrence.

---

# PART 12 — OPENING MOVES, IN ORDER

1. Run **Part 9.1** and **Part 9.2**. Write the numbers down. They are your
   baseline and they are already 15 minutes stale.
2. **TASK A is SHIPPED.** Run its verification block and confirm it held,
   including the other direction (a real critical must still page).
3. **TASK B** — cherry-pick `6f1a454f93` onto a new branch off `main`.
4. **TASK C** — verify the engine deployed, through the database.
5. **TASK D** — only if C passes, attach the bomb guard with a guarded, lock-timed
   migration.
6. Then **H2**, checking first whether it is the same stale-read defect as H1.
7. Report to Dan: _"Phase 2 of 9 — N of 126 incidents remain,"_ stating merged,
   published and neither, separately.

**While blocked** (waiting on a `:55` deploy, or on a Dan ruling): H4 is pure
reading and needs no deploy; so is H6. Both can be fully diagnosed offline.

**The last line, and the one that matters most: never answer a chip drift with a
cron, a sweep, or a reconciliation pass. Fix the write.**
