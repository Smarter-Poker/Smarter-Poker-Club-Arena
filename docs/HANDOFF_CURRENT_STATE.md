# HANDOFF — MTT PAYOUT AUDIT, PHASES 1-3 COMPLETE, PHASE 4 NEXT

**Written 2026-09-02 by the outgoing agent. Every number here was read from
production or the workspace at the time of writing, and each claim is labelled
CONFIRMED, UNVERIFIED, or UNKNOWN.**

---

## 1. EXECUTIVE CONTINUATION BRIEF

### What is being built

Club Arena is a Vite + React 19 + TypeScript SPA served inside the
smarter.poker Next.js app, with a server-authoritative Node poker engine on
Hetzner and Supabase (PostgreSQL) as the system of record. This work is **not**
feature development. It is a **money audit** of tournament payouts.

### The business objective, in Dan's words

> "IT IS AN ABSOLUTE MUST THAT PLAYERS ALWAYS 100% GET PAID OUT OF EVERY SINGLE
> MTT, SPIN OR HEADS UP THEY PLAY (IF THEY EARNED A PAYOUT)."

Everything in this workstream serves that sentence. The method that emerged and
must continue: **find where money can go missing, prove it with production
evidence, fix the cause, ship a detector so it cannot recur unseen, pin the
detector with a law test, and write down what was actually observed rather than
what was intended.**

### Current phase

A six-phase plan was agreed. **Phases 1, 2 and 3 are complete, verified and
pushed. Phase 4 has not been started.**

| Phase  | Subject                                            | State              |
| ------ | -------------------------------------------------- | ------------------ |
| 1 of 6 | Prove the money checks are actually running        | CONFIRMED COMPLETE |
| 2 of 6 | Buy-ins that were never collected                  | CONFIRMED COMPLETE |
| 3 of 6 | Multi-day / XMTT flight advancement                | CONFIRMED COMPLETE |
| 4 of 6 | Re-entries and add-ons reaching the prize pool     | NOT STARTED        |
| 5 of 6 | Mystery bounty chests, draw by draw                | NOT STARTED        |
| 6 of 6 | Exact-cent allocation replacing the 0.05 tolerance | NOT STARTED        |

### The single most important thing to understand

**The engine has not restarted onto any of this code.** All seven money checks
show `run_count = 0` in `money_check_heartbeat` (CONFIRMED by query). The
database functions are live and correct; the `GameServer` code that _calls_
them hourly sits in an unmerged PR. The engine restarts on Dan's 7am/7pm
window, and deploys only when a merge to `main` touches `server/**`.

This single fact explains three things that otherwise look like bugs:

1. All seven heartbeats read stale / never-run.
2. `FeeReconciler` alerts are still accumulating unkeyed (112 open rows for one
   subject) even though the dedupe fix is written.
3. Nothing is automatically back-paying, so shortfall conditions accumulate.

**Do not "fix" any of those three. They are one pending deploy.**

### First action for the next agent

Go to **Section 22**. It is an executable checklist. In short: verify the
worktree is clean and pushed, confirm PR #2551's state, then begin Phase 4 by
reconciling `prize_pool + total_rake` against entries + rebuys + add-ons per
event.

---

## 2. USER REQUIREMENTS AND WORKING PREFERENCES

These are binding. Several are recorded in `CLAUDE.md` and several were given
directly in conversation.

### Non-negotiable, from CLAUDE.md

| Rule                                      | Source                         | Meaning                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Horses are players**                    | CLAUDE.md 10.5, Dan 2026-08-27 | Never write `is_horse` to exclude a horse from anything a human gets. Verbatim: _"HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING!"_ The test is **"is it identical"**, not "is it equivalent". |
| **No clawback from players**              | Dan 2026-08-28                 | Overpaid players keep it; the hosting club absorbs.                                                                                                                                                   |
| **Never spend real chips to test a rule** | CLAUDE.md 11.5                 | Probe money paths inside a transaction you ROLL BACK. Helpers in `pg_temp`, never `public`. Never DELETE a `table_seats` row.                                                                         |
| **Never push a red test**                 | CLAUDE.md 5.8, Dan 2026-08-21  | A failing test stops the World Hub publish for every agent. Use `it.skip()` with a note, never a red commit.                                                                                          |
| **Never rebase main**                     | CLAUDE.md 12                   | Use `git merge origin/main`. A hook refuses rebase.                                                                                                                                                   |
| **Never `--no-verify`**                   | CLAUDE.md 11.0                 | The pre-push hook is the gate.                                                                                                                                                                        |
| **Never sit in a loop watching CI**       | CLAUDE.md 10.8.3               | Push, report the PR number, end. One final check is fine.                                                                                                                                             |
| **"Em bars" means em dashes**             | CLAUDE.md 10.7                 | A _copy_ rule about U+2014 in player-facing text. It says nothing about artwork. Do not ban the hamburger menu.                                                                                       |
| **No emoji in source**                    | CLAUDE.md 5.3                  | Breaks the SWC compiler.                                                                                                                                                                              |
| **Popups: Title Case, no em dashes**      | CLAUDE.md 5.7                  | Enforced in `src/utils/popupStyle.ts`.                                                                                                                                                                |
| **Animations must always play**           | CLAUDE.md 10.6                 | No toggle may disable one.                                                                                                                                                                            |
| **Never auto-change tables**              | CLAUDE.md 10.6                 | Moving `activeIndex` without a user gesture is forbidden.                                                                                                                                             |
| **Own changelog file**                    | CLAUDE.md 10.9                 | `docs/changelog/YYYY-MM-DD-<slug>.md`. Never append to `MIGRATION-CHANGELOG.md`.                                                                                                                      |
| **Commit author**                         | WH CLAUDE.md 2.2 CHECK 15      | Must be `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>` or Vercel refuses to build.                                                                                                |
| **One DDL transaction per change**        | CLAUDE.md 2, DDL policy        | Each DDL fires a ~28s PostgREST schema reload. Batch related DDL.                                                                                                                                     |
| **Laws live in docs/LAWS.md**             | CLAUDE.md 10.8                 | Every `*.law.test.*` needs a row. Never resolve two conflicting laws by writing a third — STOP and ask Dan.                                                                                           |

### Working style Dan has repeatedly enforced

- **Verify on real hardware. "It compiles" is not verification.**
- **Do it right, not fast. However long it takes.**
- **When corrected, change course immediately.** Do not defend a rejected path.
- **Never ask permission for obvious work.**
- **Write it down.**

### The methodological standard this workstream converged on

Dan did not state these as rules; they emerged from repeatedly catching my own
errors, and the next agent should treat them as binding because every one of
them caught a real defect:

1. **Verify the instrument before believing the reading.** A query returning
   zero may mean the query is broken. Always run a positive control against a
   known-bad window.
2. **Distinguish "I did this" from "this should happen."** A sentence
   describing intent reads identically to one describing observation. Only the
   second is worth writing.
3. **Wall-clock timings on this database are noise.** Load swings measurements
   by 10x. Use `EXPLAIN (ANALYZE, BUFFERS)` and compare **buffers**, which load
   does not move.
4. **An absence assertion must match the CODE form of a name, not the bare
   word** — the bare word also appears in the prose explaining the removal.
   This defect occurred **three times** in one session.
5. **A pin whose slice begins on the line containing the asserted string cannot
   fail.** Negative-control every new pin by mutating the source and confirming
   it goes red.

### What the user explicitly asked for, repeatedly

After each phase: _"MAKE SURE EVERYTHING FROM THE PREVIOUS PHASE WAS 100%
COMPLETED, FINISHED EVERY STEP AND IT WAS PUSHED AND PUBLISHED, CHECK FOR ANY
AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND
EVERYWHERE AND FIX ANY ISSUES BEFORE MOVING ONTO PHASE N."_

**Treat the verification pass as a mandatory phase gate, not a formality.** It
found three real faults after Phase 1, three after Phase 2, and three after
Phase 3 — every single time.

---

## 3. PROJECT AND REPOSITORY IDENTITY

| Field                     | Value                                                                      | Status                                      |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Project Name              | Club Arena (inside smarter.poker)                                          | CONFIRMED                                   |
| Repository Root           | `/Users/smarter.poker/Documents/.agent-trees/club-arena/swarm-mtt-payouts` | CONFIRMED (`git rev-parse --show-toplevel`) |
| Current Working Directory | same as root                                                               | CONFIRMED                                   |
| Git Repository            | `Smarter-Poker/Smarter-Poker-Club-Arena`                                   | CONFIRMED                                   |
| Current Branch            | `agent/swarm-mtt-payouts/phase7-no-result-without-a-hand`                  | CONFIRMED                                   |
| Remote Name               | `origin`, over SSH (`git@github.com`)                                      | CONFIRMED                                   |
| Primary Framework         | Vite + React 19 + TypeScript, React Router v7                              | CONFIRMED (CLAUDE.md 8)                     |
| Engine                    | Node.js + TypeScript in `server/`                                          | CONFIRMED                                   |
| Package Manager           | npm                                                                        | CONFIRMED                                   |
| Test Runner               | vitest (client v4.0.18, server v2.1.9 — two different versions)            | CONFIRMED from run output                   |
| Database                  | Supabase PostgreSQL, project ref `kuklfnapbkmacvwxktbh`                    | CONFIRMED                                   |
| Hosting (frontend)        | Vercel project `hub-vanguard` via the World Hub repo                       | CONFIRMED (CLAUDE.md 1.2)                   |
| Hosting (engine)          | Hetzner VPS, PM2, auto-deploy on merge to `main` touching `server/**`      | CONFIRMED (CLAUDE.md 11.1)                  |
| Node                      | via nvm; **NOT on the default PATH**                                       | CONFIRMED                                   |

**Branch name is misleading.** It says `phase7-no-result-without-a-hand`,
which was the original Phase 7 task from a previous agent's handoff. The branch
has since carried the entire 6-phase audit. Do not rename it — PR #2551 is
attached to it.

---

## 4. REPOSITORY MAP

Only paths relevant to continuation. `[MOD]` = modified by this work,
`[NEW]` = created by this work.

```
swarm-mtt-payouts/                    <- repo root, this worktree
├── CLAUDE.md                          Agent law for this repo. READ FIRST.
├── AGENT-PLAYBOOK.md                  Byte-identical across 7 repos. Worktree/push/PR flow.
├── MIGRATION-LAW.md                   11 laws governing the server-authoritative migration.
├── docs/
│   ├── LAWS.md                  [MOD] Registry of every *.law.test.*. 75 rows.
│   │                                  CONFLICTS ON EVERY MERGE FROM MAIN (see §15).
│   ├── HANDOFF_CURRENT_STATE.md [NEW] This document.
│   └── changelog/
│       ├── README.md                  Why each agent writes its own file.
│       ├── 2026-09-01-a-bounty-pool-belongs-to-a-player-too.md      [NEW]
│       ├── 2026-09-01-the-last-unwatched-money.md                   [NEW]
│       ├── 2026-09-02-phase-1-a-check-that-never-runs.md            [NEW]
│       ├── 2026-09-02-phase-2-a-seat-nobody-paid-for.md             [NEW]
│       └── 2026-09-02-phase-3-multi-day-does-not-exist.md           [NEW]
├── server/src/
│   ├── GameServer.ts            [MOD] THE HOURLY MONEY-CHECK PASS LIVES HERE.
│   │                                  7 checks + health board, ~line 3540-3760.
│   │                                  Private helper recordMoneyCheckRun() ~line 360.
│   ├── testHelpers/sourceWindow.ts    sliceMethod/sliceSqlStatement/etc.
│   │                                  MIRROR of tests/helpers/sourceWindow.ts.
│   │                                  Magic-number windows are outlawed; use these.
│   ├── services/
│   │   ├── financialAlerts.ts   [MOD] raiseFinancialAlert(..., dedupeKey?)
│   │   ├── FeeReconciler.ts     [MOD] per-tournament keyed alerts
│   │   ├── AlertsDoNotRepeat.law.test.ts        [NEW]
│   │   └── MoneyChecksProveTheyRan.law.test.ts  [NEW] 13 pins, Phase 1
│   └── tournament/
│       ├── tournamentRecovery.ts     [MOD] chips/hand evidence guards + bounty settle
│       ├── TournamentManagerBase.ts  [MOD] payout structure cannot narrow past a paid place
│       ├── recoveryRankEvidence.ts   (created earlier in the workstream)
│       ├── NoResultWithoutAHand.law.test.ts       (earlier)
│       ├── EveryEarnerIsPaid.law.test.ts    [MOD]
│       ├── ABountyPoolBelongsToAPlayer.law.test.ts  [NEW]
│       ├── ASeatNobodyPaidFor.law.test.ts   [NEW] 25 pins, Phase 2. SEE §15.
│       └── MultiDayIsRefusedUntilItIsBuilt.law.test.ts [NEW] 8 pins, Phase 3
├── supabase/migrations/          10 [NEW] files — see §11 ledger
├── scripts/ci/
│   ├── check-definer-authorization.mjs   Blocks browser-reachable SECURITY DEFINER writers.
│   │                                     Diffs vs HEAD~1 — sees only COMMITTED migrations.
│   └── schema-manifest.d/                Declare new schema here, NEVER hand-edit the manifests.
└── tests/law-registry.law.test.ts [MOD] Scans tests/ AND server/src for law files.
```

**Do not edit** `scripts/ci/supabase-schema-manifest.json` or
`supabase-columns-manifest.json` — they are nightly snapshots and the biggest
source of merge conflict in this repo.

---

## 5. APPLICABLE INSTRUCTIONS AND CONSTRAINTS

Read in this order before editing anything:

1. **`AGENT-PLAYBOOK.md`** (repo root) — how to ship without losing work; where
   every credential lives (the place, never the value).
2. **`CLAUDE.md`** (repo root) — the repo's binding law. Sections that matter
   most here: **1.2.5** (PR-only merges), **2** (Production DDL policy),
   **5.8** (never push a red test), **10.5** (horses are players), **10.8**
   (law registry, never wait on CI), **11.0** (which environment you are in),
   **11.5** (never spend real chips to test a rule), **12** (never rebase main).
3. **`docs/LAWS.md`** — the law registry and the resolved-conflicts list.
4. **`docs/changelog/README.md`** — why each agent writes its own file.
5. **`MIGRATION-LAW.md`** — governs the server-authoritative migration.

### Conflicts and ambiguities the next agent will hit

| Conflict                                                                                                                                | Resolution                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLAUDE.md §1.1.5 says server-side protection is "prepared, not yet active"; §1.2.5 says it is ACTIVE and verified against the live API. | **§1.2.5 wins.** Believe the API. Main is protected; PR is the only path.                                                                                 |
| `.husky/pre-push` check 0 says rulesets are disabled.                                                                                   | **Stale.** Same as above.                                                                                                                                 |
| CLAUDE.md §11.1 describes a cloud sandbox with no network.                                                                              | **Not this environment.** §11.0 applies: `mcp__counselors__host_terminal` exists, so this is Dan's Mac. Real bash, SSH works, `api.github.com` reachable. |
| The `mcp__github__*` MCP                                                                                                                | Returns `Bad credentials`. Do not build a plan around it. Use `curl` + the token in `~/Documents/club-arena/.env`.                                        |

---

## 6. COMPLETE DISCOVERY RECORD

Everything below was learned by inspection during this work. **This section
exists so the next agent does not repeat the discovery.**

### 6.1 How a tournament entry is actually paid for

There are **four** registration paths, and they do not behave alike:

| Function                           | Creates seat | Debits wallet                                    | Writes `chip_transactions` | Writes `wallet_transactions`               | Increments pool/rake |
| ---------------------------------- | ------------ | ------------------------------------------------ | -------------------------- | ------------------------------------------ | -------------------- |
| `fn_register_for_tournament`       | yes          | yes                                              | yes                        | **yes** (`related_entity_id` = tournament) | yes                  |
| `fn_register_horse_for_tournament` | yes          | yes                                              | yes                        | **yes**                                    | yes                  |
| `fn_award_satellite_seat`          | yes          | **no** (the seat IS the prize)                   | no                         | no                                         | yes                  |
| `atomic_tournament_register`       | yes          | **yes, directly on `club_members.chip_balance`** | **NO**                     | **NO**                                     | **no**               |

**`atomic_tournament_register` is a live architectural hole.** It moves money
with no ledger row of either kind. It has had **no caller since 2026-08-15**
(replaced by `fn_register_for_tournament`; the only remaining reference is an
explanatory comment at `src/services/TournamentService.ts:1008`). It sits on
the `fn_union_law_check` watch list, so **retiring it belongs to that
workstream, not this one.** `fn_uncollected_entry_check` names it as a known
blind spot inside its own alert payload.

**Key detail:** `atomic_deduct_wallet_and_log` writes `chip_transactions` with
**no `tournament_id` column** — the link is a name string in `notes`. Only
`log_wallet_transaction` carries `related_entity_id`. That is why
`wallet_transactions` is the joinable evidence and `chip_transactions` is the
second, independent witness.

### 6.2 The evidence-start date — critical

`wallet_transactions` has carried `category='tournament_buyin'` **only since
2026-08-19**, when `log_wallet_transaction` was wired into the register path.

**Before that date, an absent debit proves the LOGGER was absent, not that
nobody paid.** 22,981 perfectly healthy seats sit behind it. Any query that
reaches back past 2026-08-19 and treats a missing `wallet_transactions` row as
an unpaid entry will report a catastrophe that never happened. I made this
mistake on the first pass and it produced a false 22,981-seat figure.

`fn_uncollected_entry_check` asserts this with a constant
`c_evidence_start = 2026-08-19 00:00:00+00` and refuses any window that starts
earlier.

### 6.3 `is_xmtt` does NOT mean multi-day

It is set as `is_xmtt: !!schedule.union_id`. **It means UNION event.** 815 rows
carry it. I read it as "multi-day" in Phase 2 and had to correct it in Phase 3.

### 6.4 Multi-day flight advancement does not exist

CONFIRMED by query across every tournament ever created:

```
parent_tournament_id ........ 0
survivors_advance_to ........ 0
flight_end_chips_snapshot ... 0
flight_number ............... 0
day_number > 1 .............. 0
total_days > 1 .............. 0
```

Nothing in the client, engine or database writes any of the five structure
columns. `fn_generate_recurring_home_games` mentions `day_number` but it is a
local `v_day_number` for day-of-week on `commander_home_groups` — a different
table entirely.

On 2026-08-26 a prior agent replaced a working "Multi-Day MTT" toggle (which
badged the lobby and changed nothing about how the event ran) with
"NOT AVAILABLE YET" plus `trg_tournaments_refuse_unbuilt_multi_day`. See
`src/lib/tournamentFromTableConfig.ts:350` and
`src/pages/TableConfigPage.tsx:2777` for their notes.

### 6.5 The alert dedupe architecture

`fn_raise_server_financial_alert(severity, source, message, context, dedupe_key)`
stores the key in `context->>'dedupe_key'` and returns an existing open row's id
rather than inserting a duplicate.

**Natural experiment CONFIRMED at handoff time:**

| Source                                                    | Open rows | Carrying a dedupe key |
| --------------------------------------------------------- | --------- | --------------------- |
| `fn_money_check_health` (raises from **inside** the DB)   | 7         | **7**                 |
| `FeeReconciler.bbj_unlinkable` (raised by the **engine**) | 112       | **0**                 |
| `FeeReconciler.bbj_drift` (engine)                        | 30        | **0**                 |
| `fn_tournament_money_conservation` (engine-driven)        | 115       | **0**                 |

Same function, same database, different caller. **The mechanism is proven; the
engine has not shipped.** Do not "fix" the dedupe.

### 6.6 Database performance facts, measured

- The service_role statement timeout is **8 seconds**.
- `rake_records` has **no index on `source`**. A 30-day scan filtered on
  `source` walks the `created_at` index discarding 644,620 rows.
- **Wall clock on this database is unreliable.** The identical query measured
  722ms / 13,494ms / 2,873ms / 1,968ms / 691ms / 7,471ms in interleaved A/B
  runs seconds apart. **Use `EXPLAIN (ANALYZE, BUFFERS)` and compare buffers.**
- Every DDL statement fires `pgrst_ddl_watch` → a ~28s PostgREST schema-cache
  reload on this database (~970 relations, ~2,700 functions).
- An index was added by this work:
  `idx_tournament_players_registered_at` on `tournament_players(registered_at)`.

### 6.7 Existing money-check inventory (7 registered)

| Check                                 | Interval (min) | Purpose                                                                                 |
| ------------------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `fn_payout_guarantee_check`           | 60             | vacant paid places, unpaid earners, retained bounty pools, unrecorded payouts           |
| `fn_cash_pot_conservation_check`      | 60             | pot = rake + bbj + awarded, per completed cash hand. **Capped at 48h** (168h timed out) |
| `fn_backpay_unfinalised_bounty_pools` | 60             | settles a funded bounty pool a completed event never paid                               |
| `fn_pay_backed_payout_shortfalls`     | 60             | pays what an event still owes                                                           |
| `fn_uncollected_entry_check`          | 60             | **[NEW, Phase 2]** seats with no auditable entry payment                                |
| `fn_detect_results_without_a_hand`    | 360            | a result no poker produced                                                              |
| `fn_tournament_money_conservation`    | 360            | per-event money in vs out                                                               |

Plus `fn_money_check_health(stale_multiple)` — the board, read **last** in the
hourly pass, in its own `try` block.

### 6.8 Technical debt and holes discovered but NOT fixed

| Hole                                                                                                                                                                                        | Evidence                                                                    | Owner                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `atomic_tournament_register` moves money with zero ledger rows                                                                                                                              | function body read                                                          | `fn_union_law_check` workstream          |
| **Nothing guards default grants on NEW TABLES.** `check-definer-authorization` guards functions only. Every table created since that gate carries `anon`/`authenticated` grants unexamined. | found when `money_check_heartbeat` came up with `arwdxtm` for browser roles | unowned — **recommend raising with Dan** |
| `public.wallets` is frozen with 732,591,994.33 chips stranded; nothing reads it                                                                                                             | CLAUDE.md 11.5                                                              | pre-existing                             |
| Hand-history retention is 7 days for horse-only hands                                                                                                                                       | Dan's explicit ruling 2026-08-27                                            | **DO NOT "FIX"**                         |
| `docs/LAWS.md` conflicts on every single merge from main                                                                                                                                    | 3 for 3 this session                                                        | see §15                                  |

---

## 7. WORK COMPLETED DURING THIS CHAT

### Workstream A — Phase 1: prove the money checks are running

**Problem:** the audit ended with six checks reporting zero, and there was no
evidence any of them had ever run. Precedent: Open Claw fired
`/api/cron/rakeback-period-settle` weekly at a handler that had never been
written; every fire 404'd silently and **281,108.01 chips** of player rakeback
accrued behind it.

**Shipped:**

- `money_check_heartbeat` table, **seeded with the expected set** so a check
  that never fires reads as _missing_, not as _nothing_.
- `fn_record_money_check_run(check, result)` — stamped by the **driver**, not
  the check. Never throws.
- `fn_money_check_health(stale_multiple)` — the board, one deduped critical per
  quiet check.
- Wired into `GameServer.ts`: six stamps + the health read.

**Migrations:** `20260902012048`, `20260902013940`
**Verification found 3 faults after I called it done:**

1. The health read was **nested inside the bounty back-pay's `try`** — the
   watchdog-shares-a-failure-domain mistake, two hours after quoting it. Moved
   to a sibling block, pinned.
2. `money_check_heartbeat` was created with schema-default grants giving `anon`
   and `authenticated` full read **and write**. Inert under RLS-with-no-policies
   but live the moment anyone adds a policy. Revoked.
3. The changelog claimed a probe row "was then deleted" — **I never ran that
   delete.** Corrected honestly.

### Workstream B — Phase 2: a seat nobody paid for

**Diagnosis (all CONFIRMED against production):** 464 seats across 81 events,
2,530.80 chips of entry, **all between 2026-08-19 00:01 and 2026-08-20 23:45**,
none since. Horses were **seeded** into fields rather than registered. Two
independent witnesses agree: no `wallet_transactions` debit and no
`chip_transactions` row. `rake_records` proves the register functions never ran
— across the 39 COMPLETED events in that window there is **exactly one** rake
row, from `fn_spin_settle_game`. Those events collected 6.00 chips of entry and
0.00 in fees, and paid out 1,734.00 in prizes (1,373.00 of it guaranteed money
the club had already promised).

**Instrument check performed before believing it:** the `chip_transactions`
matcher found **11,626 of 11,626 (100%)** for seats that provably have a
`wallet_transactions` row, and 0 of 464 for those that do not.

**The cause was already fixed, and not by me.**
`fn_register_horse_for_tournament` began charging horses real chips on
2026-08-19; the last unfunded seat was created the following night. **No engine
change was made.** Re-fixing a fixed bug is how a repo acquires two laws
demanding opposite things.

**The live finding:** `fn_award_satellite_seat` writes a `tournament_payouts`
row for the seat it awards. That block landed in migration `20260831192927` at
2026-08-31 19:29. The last satellite seat was awarded 2026-08-30 20:10.
**The block had never once executed.** Zero `source='satellite_seat'` rows
existed platform-wide. **23 seats worth 4,600.00 chips** of prize value were
absent from the payout ledger. Back-filled from the rake row
`fn_award_satellite_seat` itself wrote, under the key the live function uses.
A re-drive writes **0 rows** — proved inside a rolled-back transaction.

**Shipped:** `fn_uncollected_entry_check` with **four enumerated exemptions**
(wallet debit / satellite seat award / day-past-the-first / freeroll),
registered in the heartbeat, stamped by GameServer, deduped alert, moves no
money, bounded at 48h, refuses windows before 2026-08-19.

**Migrations:** `20260902041336`, `20260902050552`
**Verification found 3 faults:**

1. **The awards CTE looked back 30 days** and needed 6 hours. Premise disproven:
   `fn_award_satellite_seat` writes the rake row and the roster row in the same
   statement — verified on all 23 awards, `created_at` equals `registered_at`
   exactly, worst gap **0.000000 seconds**. Buffers: **231,267 → 90,202**.
2. **I nearly shipped a 6x-worse rewrite** justified by wall-clock noise
   (539,362 buffers vs 90,202). Discarded. See §15.
3. A law pin was **vacuous** — it sliced from the line containing the string it
   asserted.

### Workstream C — Phase 3: multi-day does not exist

**Finding:** there are no flights (see §6.4). Nothing to reconcile, nobody to
pay.

**The real work:** `trg_tournaments_refuse_unbuilt_multi_day` fired on
`UPDATE OF is_multi_day, total_days` — the two columns that paint the **lobby
badge** — and left open the five that would **structure** a flight. Proved in a
rolled-back transaction:

```
is_multi_day = true ............ REFUSED, 0A000
total_days   = 3 ............... REFUSED, 0A000
day_number = 2 ................. NOT GUARDED
parent_tournament_id ........... NOT GUARDED
survivors_advance_to ........... NOT GUARDED
flight_number = 2 .............. NOT GUARDED
flight_end_chips_snapshot ...... NOT GUARDED
```

A half-built flight has no badge to warn anyone, nothing to advance a survivor,
**and it would have switched on Phase 2's day-2 exemption**, excusing seats from
the was-this-paid-for check for a Day 2 that does not exist.

**Shipped:** the guard widened to all seven columns, on the function **and** in
the trigger's `UPDATE OF` list (a trigger that does not name a column never
fires on an update touching only it). Plus a correction to Phase 2's own
predicate, which read the union flag as multi-day.

**Migrations:** `20260902052302`, `20260902052604`
**Verification found 3 faults** — see §15 (the pin-staleness cascade).

---

## 8. VISUAL AND PRODUCT DECISIONS

**NOT APPLICABLE TO THIS WORKSTREAM.** No UI, component, asset, image,
breakpoint, typography, colour or responsive work was performed or discussed.
No reference images were supplied. No `src/components/**` or `src/pages/**`
file was modified.

The only client-side files _read_ (never edited) were
`src/lib/tournamentFromTableConfig.ts` and `src/pages/TableConfigPage.tsx`,
to establish that the multi-day toggle had been deliberately removed.

**If the next agent is asked for UI work, none of this workstream's decisions
apply and there are no locked visual references to honour.**

---

## 9. FUNCTIONAL AND ARCHITECTURAL DECISIONS

| Area                                      | State                                          | Note                                                                                  |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| MTT payout guarantee                      | **Implemented**                                | `fn_payout_guarantee_check`, 4 counters, all reporting 0 at handoff                   |
| Bounty pool settlement on the rescue path | **Implemented**                                | `tournamentRecovery.ts` settles before flipping COMPLETED                             |
| Payout structure narrowing                | **Implemented**                                | `TournamentManagerBase.fitPayoutStructureToField` refuses to narrow past a paid place |
| No result without a hand                  | **Implemented**                                | `recoveryRankEvidence.ts` — `chipsCannotRank`, `noHandWasEverDealt`                   |
| Uncollected entry detection               | **Implemented**                                | `fn_uncollected_entry_check`, 4 enumerated exemptions                                 |
| Money-check heartbeat                     | **Implemented in DB, NOT YET RUNNING**         | engine has not restarted                                                              |
| Alert dedupe                              | **Implemented in DB, engine side NOT SHIPPED** | proven by natural experiment §6.5                                                     |
| Multi-day / flights                       | **DOES NOT EXIST, refused at the DB**          | all 7 columns                                                                         |
| Satellite seat as a payout                | **Implemented + back-filled**                  | 23 rows, 4,600.00 chips                                                               |
| Cash pot conservation                     | **Implemented**                                | 48h cap, measured                                                                     |
| Re-entries / add-ons reaching the pool    | **NOT STARTED — Phase 4**                      | population in §20                                                                     |
| Mystery bounty chests                     | **NOT STARTED — Phase 5**                      |                                                                                       |
| Exact-cent allocation                     | **NOT STARTED — Phase 6**                      | currently a 0.05 tolerance in `earner_not_paid`                                       |
| Rakeback settlement                       | **BLOCKED ON DAN**                             | cause fixed in PR #1084; 281,108.01 chips owed                                        |
| Overpay clawback                          | **REJECTED BY DAN**                            | 19,665.23 chips across 65 events; club absorbs                                        |
| Hand-history retention asymmetry          | **DECIDED BY DAN, DO NOT CHANGE**              | 7 days for horse-only hands                                                           |

---

## 10. EXACT CURRENT STATE

All CONFIRMED at the time of writing.

```
Branch          agent/swarm-mtt-payouts/phase7-no-result-without-a-hand
HEAD            dd852fb83  "merge origin/main, resolving the LAWS.md registry by union"
Remote HEAD     dd852fb83  (identical — nothing unpushed)
git status      clean; no staged, unstaged, untracked or generated files
vs origin/main  1 behind, 33 ahead
PR              #2551, state=open, mergeable=true, mergeable_state=blocked, 33 commits
```

`mergeable_state=blocked` means required checks have not all reported. It is
**not** a conflict. `dirty` would be a conflict.

```
Server tests    3652 passed / 328 files      CONFIRMED
Client tests    11460 passed / 836 files     CONFIRMED
Server tsc      clean                        CONFIRMED
Client tsc      clean                        CONFIRMED
Law registry    78 assertions, 75 rows       CONFIRMED
Definer gate    OK                           CONFIRMED
```

**Running processes:** no dev server, no preview, no build. One stray vitest-ish
process matched a loose grep; nothing this work started is still running.

**Database:** all 6 migrations applied and recorded. All function bodies
md5-verified against `pg_proc.prosrc` — see §11.

**Deployment:** frontend deploys via the World Hub on merge to `main`; engine
deploys on merge touching `server/**`. **Neither has happened for this branch.**

---

## 11. CHANGED-FILE LEDGER

Verified with `git diff --name-status $(git merge-base origin/main HEAD)...HEAD`.

| File                                                                 | Status | Purpose                                       | What changed                                                                                            | Verified                       | Committed |
| -------------------------------------------------------------------- | ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ | --------- |
| `server/src/GameServer.ts`                                           | MOD    | hourly money-check pass                       | added `recordMoneyCheckRun()` helper, 7 stamps, health read as a sibling block, the Phase 2 check block | tests + index-order assertions | yes       |
| `server/src/services/financialAlerts.ts`                             | MOD    | alert sender                                  | optional `dedupeKey` param                                                                              | tests                          | yes       |
| `server/src/services/FeeReconciler.ts`                               | MOD    | fee/BBJ audit                                 | per-tournament keyed alerts                                                                             | tests                          | yes       |
| `server/src/tournament/tournamentRecovery.ts`                        | MOD    | stuck-COMPLETING rescue                       | chips/hand evidence guards; bounty pool settled before COMPLETED                                        | tests                          | yes       |
| `server/src/tournament/TournamentManagerBase.ts`                     | MOD    | payout structure fitting                      | refuses to narrow past a paid place                                                                     | tests                          | yes       |
| `server/src/tournament/EveryEarnerIsPaid.law.test.ts`                | MOD    | law                                           | extended                                                                                                | run                            | yes       |
| `tests/law-registry.law.test.ts`                                     | MOD    | law registry                                  | scans `server/src` too                                                                                  | run                            | yes       |
| `docs/LAWS.md`                                                       | MOD    | law registry                                  | +5 rows; merged by union 3x                                                                             | registry test                  | yes       |
| `server/src/services/MoneyChecksProveTheyRan.law.test.ts`            | NEW    | Phase 1 law, 13 pins                          | —                                                                                                       | run                            | yes       |
| `server/src/services/AlertsDoNotRepeat.law.test.ts`                  | NEW    | alert-noise law                               | —                                                                                                       | run                            | yes       |
| `server/src/tournament/ABountyPoolBelongsToAPlayer.law.test.ts`      | NEW    | bounty law                                    | —                                                                                                       | run                            | yes       |
| `server/src/tournament/ASeatNobodyPaidFor.law.test.ts`               | NEW    | Phase 2 law, 25 pins                          | —                                                                                                       | run + negative controls        | yes       |
| `server/src/tournament/MultiDayIsRefusedUntilItIsBuilt.law.test.ts`  | NEW    | Phase 3 law, 8 pins                           | —                                                                                                       | run + negative controls        | yes       |
| `docs/changelog/2026-09-01-a-bounty-pool-belongs-to-a-player-too.md` | NEW    | changelog                                     | —                                                                                                       | —                              | yes       |
| `docs/changelog/2026-09-01-the-last-unwatched-money.md`              | NEW    | changelog + **correction**                    | —                                                                                                       | —                              | yes       |
| `docs/changelog/2026-09-02-phase-1-a-check-that-never-runs.md`       | NEW    | changelog                                     | —                                                                                                       | —                              | yes       |
| `docs/changelog/2026-09-02-phase-2-a-seat-nobody-paid-for.md`        | NEW    | changelog                                     | —                                                                                                       | —                              | yes       |
| `docs/changelog/2026-09-02-phase-3-multi-day-does-not-exist.md`      | NEW    | changelog                                     | —                                                                                                       | —                              | yes       |
| `supabase/migrations/20260901192531_*.sql`                           | NEW    | cash pot check, 48h cap                       | applied earlier                                                                                         | md5                            | yes       |
| `supabase/migrations/20260901193047_*.sql`                           | NEW    | close repaired findings                       | applied earlier                                                                                         | —                              | yes       |
| `supabase/migrations/20260901194756_*.sql`                           | NEW    | bounty back-pay                               | applied earlier                                                                                         | md5                            | yes       |
| `supabase/migrations/20260901195005_*.sql`                           | NEW    | guarantee check + bounty                      | applied earlier                                                                                         | —                              | yes       |
| `supabase/migrations/20260901131129_*.sql`                           | MOD    | guarantee check                               | —                                                                                                       | md5                            | yes       |
| `supabase/migrations/20260902012048_*.sql`                           | NEW    | heartbeat + recorder + board                  | Phase 1                                                                                                 | md5                            | yes       |
| `supabase/migrations/20260902013940_*.sql`                           | NEW    | heartbeat table service_role only             | Phase 1 fix                                                                                             | applied                        | yes       |
| `supabase/migrations/20260902041336_*.sql`                           | NEW    | uncollected entry check + satellite back-fill | Phase 2                                                                                                 | md5                            | yes       |
| `supabase/migrations/20260902050552_*.sql`                           | NEW    | awards lookback 30d → 6h                      | Phase 2 fix                                                                                             | md5                            | yes       |
| `supabase/migrations/20260902052302_*.sql`                           | NEW    | multi-day guard widened to 7 columns          | Phase 3                                                                                                 | md5                            | yes       |
| `supabase/migrations/20260902052604_*.sql`                           | NEW    | union flag is not multi-day                   | Phase 3                                                                                                 | md5                            | yes       |

**No user-owned or unrelated changes exist in this worktree.** The tree is
clean. Other agents work in **separate worktrees** (`git worktree list` shows
~20). Do not touch them.

### Function bodies — repo file vs production, md5 CONFIRMED

| Function                                  | md5                                | bytes |
| ----------------------------------------- | ---------------------------------- | ----- |
| `fn_uncollected_entry_check`              | `a0100e602a1042d2cded3d9f184b956b` | 8111  |
| `fn_tournaments_refuse_unbuilt_multi_day` | `428b31045fc54a32e6207a6c15200cf5` | 1700  |
| `fn_record_money_check_run`               | `0582c8967634a8e3e7e5ba320adbd37e` | 717   |
| `fn_money_check_health`                   | `fe57453f27b0adec72fa6570a6b33091` | 2219  |
| `fn_cash_pot_conservation_check`          | `0e3898647e1fb5b4bcac56077d06b3a5` | 5111  |
| `fn_backpay_unfinalised_bounty_pools`     | `9e57c98a3c5234acf461bfa19d33c179` | 2768  |
| `fn_payout_guarantee_check`               | `9d06324aa69260cdeb985d7111209674` | 11379 |

---

## 12. ASSET LEDGER

**NO VISUAL ASSETS WERE CREATED, MODIFIED, UPLOADED, APPROVED OR REJECTED.**
No images, icons, frames, headers, footers, logos or game-card references are
involved. Nothing is in temporary storage. There is no asset at risk.

---

## 13. COMMANDS AND TOOLS USED

All run from `/Users/smarter.poker/Documents/.agent-trees/club-arena/swarm-mtt-payouts`.

**Node is not on the default PATH.** Every command must be prefixed:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
```

| Command                                           | Purpose                 | Result                                 | Changes files | Rerun?                     |
| ------------------------------------------------- | ----------------------- | -------------------------------------- | ------------- | -------------------------- |
| `cd server && npx tsc --noEmit`                   | server type check       | clean                                  | no            | yes, before every push     |
| `cd server && npx vitest run --reporter=dot`      | server suite (~25s)     | 3652 pass                              | no            | yes                        |
| `npx tsc --noEmit`                                | client type check       | clean                                  | no            | yes                        |
| `npx vitest run --reporter=dot`                   | client suite (~26s)     | 11460 pass                             | no            | yes                        |
| `npx vitest run tests/law-registry.law.test.ts`   | law registry            | 78 pass                                | no            | after any law change       |
| `node scripts/ci/check-definer-authorization.mjs` | definer gate            | OK                                     | no            | after any migration commit |
| `git merge origin/main`                           | sync (**never rebase**) | conflicts on `docs/LAWS.md` every time | yes           | as needed                  |
| `git push`                                        | push (hook runs ~3 min) | see §15                                | no            | yes                        |
| `curl … /repos/…/pulls/2551`                      | PR state                | see §10                                | no            | once at end                |

**Migrations** were applied with the Supabase MCP `apply_migration` tool, never
raw `execute_sql` (CLAUDE.md requires migrations for auditability).

**`gh` is NOT installed.** Use `curl` with `GITHUB_TOKEN` from
`~/Documents/club-arena/.env`.

**`setsid` does NOT exist on macOS.** Attempts to use it silently failed. Use
`nohup … & disown`.

---

## 14. VERIFICATION AND TEST RESULTS

| Verification                        | Method                                        | Result                                  | Phase | Follow-up                      |
| ----------------------------------- | --------------------------------------------- | --------------------------------------- | ----- | ------------------------------ |
| Server type check                   | `npx tsc --noEmit`                            | PASS                                    | 1,2,3 | —                              |
| Client type check                   | `npx tsc --noEmit`                            | PASS                                    | 1,2,3 | —                              |
| Server unit tests                   | `npx vitest run`                              | **3652 pass, 328 files**                | 3     | —                              |
| Client unit tests                   | `npx vitest run`                              | **11460 pass, 836 files**               | 3     | —                              |
| Law registry                        | vitest                                        | **78 assertions pass**                  | 3     | —                              |
| Definer authorization gate          | `check-definer-authorization.mjs`             | OK                                      | 2,3   | only sees committed migrations |
| Function body vs production         | md5 of `pg_proc.prosrc`                       | **all 7 match**                         | 1,2,3 | —                              |
| Positive control (Phase 2)          | known-bad window                              | **464 / 81 / 2,530.80**                 | 2     | asserted inside the migration  |
| Instrument control (Phase 2)        | matcher vs known-good seats                   | **11,626/11,626 = 100%**                | 2     | —                              |
| Idempotency (satellite back-fill)   | rolled-back re-drive                          | **0 rows**                              | 2     | —                              |
| Guard refusal (Phase 3)             | rolled-back probe, 7 columns                  | **all refuse 0A000**                    | 3     | asserted inside the migration  |
| Guard non-interference              | clone of **every** stored column, rolled back | **inserts cleanly**                     | 3     | —                              |
| Guard in production                 | live insert rate over 9.4h                    | **3,900 inserts, 3 via scheduled path** | 3     | —                              |
| Negative control: multi-day pin     | mutate each branch                            | **all 7 discriminate**                  | 3     | —                              |
| Negative control: try-block pin     | mutate GameServer                             | **fails as required**                   | 2     | —                              |
| Negative control: stale-pointer pin | point at older migrations                     | **fails as required**                   | 3     | —                              |
| Prose-only pin sweep                | script over both law files                    | 9/35 → **5/32**, remaining 5 deliberate | 3     | —                              |

### NOT TESTED — the next agent must know this

| Not tested                                                             | Why                                              | Risk                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| **The GameServer hourly pass has never executed**                      | engine has not restarted                         | HIGH — the wiring is unproven at runtime. All 7 heartbeats read `run_count = 0`. |
| **`fn_award_satellite_seat`'s payout-record block has never executed** | no satellite seat awarded since 2026-08-31 19:29 | MEDIUM — the first real award will be its first run                              |
| End-to-end / Playwright                                                | not run locally                                  | covered by CI on the PR                                                          |
| Production build (`next build`)                                        | belongs to the World Hub repo                    | covered by CI                                                                    |
| Migration rollback                                                     | **never executed**                               | MEDIUM — each migration has a written ROLLBACK section, none exercised           |
| Visual / responsive / accessibility                                    | no UI work                                       | none                                                                             |

---

## 15. SETBACKS, FAILED APPROACHES, AND LESSONS

**This is the most valuable section. Every item cost real time.**

### 15.1 I nearly shipped a 6x-worse query rewrite on noise

Wall-clock said the restructure took 11.4s → 833ms. I wrote it, and the
migration's own budget assertion refused it twice (11,413ms, then 19,956ms with
a different approach). Running A/B **in the same statement**:

```
722ms / 13,494ms   then   2,873ms / 1,968ms   then   691ms / 7,471ms
```

Interleaved, so neither ordering nor caching explains it. On **buffers**:
restructure **539,362** vs original **90,202** — six times worse. **Discarded
the whole rewrite; kept only the one clause that was demonstrably wrong.**

**Lesson: on this database, never justify a change with wall clock. Use
`EXPLAIN (ANALYZE, BUFFERS)`.**

### 15.2 Never put a wall-clock assertion in a migration

My first two attempts asserted "must complete in under 4000ms". Under load that
fails randomly, and a flaky gate teaches everyone to re-run migrations until
they pass. **Assert structure, not stopwatch.**

### 15.3 The self-refusing assertion — three times

Asserting a name is **absent** from a function body by matching the bare word
fails, because the bare word also appears in the prose explaining the removal.

- `'%30 days%'` matched my own comment → migration refused itself
- `'%is_xmtt%'` matched my own comment → migration refused itself
- The multi-day pin matched `is_multi_day` in the **error message**, so deleting
  its branch left the pin **green** — the dangerous direction

**Lesson: match the CODE form — `interval '30 days'`, `t.is_xmtt`,
`v_field := 'is_multi_day';`.**

### 15.4 The pin-staleness cascade (Phase 3 verification)

1. A prose-only sweep found 9 of 35 positive assertions matched only comments.
2. Repairing the exemption pin (labels must sit on the clause they name) made
   `ASeatNobodyPaidFor.law.test.ts` **fail** — it was still reading
   `20260902050552` while production ran `20260902052604`.
3. **Every assertion in that file had been passing against a body production
   had stopped running** — the exact failure the file's own header warns about,
   in a note I wrote hours earlier and did not follow.
4. Correcting the pointer surfaced a **third** staleness: the day-2 pin still
   matched the pre-Phase-3 inline shape.

**Fix: a note asking a human to remember is not a guard.** There is now a pin
that scans the migrations directory, takes the newest file defining the
function, and fails if it is not the one the pins read.

### 15.5 A contaminated guard probe that passed for the wrong reason

I first probed `trg_tournaments_refuse_unbuilt_multi_day` against a COMPLETED
tournament. The **lifecycle lock** ("cannot be modified after a player has
registered") refused the write first, and a guard that had never been exercised
looked like it was working. **Only a row with no registrants can test it.**

### 15.6 Prettier turned a plus into a minus in a money sentence

A wrapped changelog line began `+ 133 rebuys`; markdown read it as a bullet and
Prettier normalised it to `- 133 rebuys`. **In a sentence about money.** Write
arithmetic in words in prose, or keep operators off line starts.

### 15.7 A false 123,638.57-chip alarm

Bounties credit under category `'bounty'`, not `'prize'`. The real figure was
76.70. **Always enumerate the categories before summing.**

### 15.8 A false 22,981-seat alarm

Reached back past 2026-08-19 where the logger did not exist. See §6.2.

### 15.9 Shell/tooling traps on this Mac

| Trap                                                         | Symptom                                                                                | Workaround                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `setsid` does not exist on macOS                             | detached jobs silently die                                                             | `nohup … & disown`                                                                            |
| A timed-out `host_terminal` call **kills the process group** | pre-push hook's test runner dies mid-flight; left **10 orphaned `git push` processes** | launch detached, then poll with **instant** commands only — never `sleep` in the polling call |
| Pre-push hook takes ~3 minutes                               | exceeds the call timeout                                                               | launch detached, poll                                                                         |
| `gh` not installed                                           | —                                                                                      | `curl` + token from `~/Documents/club-arena/.env`                                             |
| `hstore` extension not installed                             | a clone probe failed                                                                   | use a dynamic column list from `information_schema`                                           |

### 15.10 `docs/LAWS.md` conflicts on every merge — 3 for 3

Both sides append rows to the same table. **Resolution recipe that worked all
three times:** take the **union keyed on the law file path**, after checking
that no law appears on both sides with a _different_ description (that would be
two laws demanding opposite things — STOP and ask Dan; zero occurred).

I also found **main was red**: `spinRepairsCanFinish.law.test.ts` existed with
no registry row. Fixed under fix-first, since you cannot ship past it anyway.

### 15.11 An unsubstantiated claim I made and had to retract

The Phase 1 changelog said a probe row "was then deleted." **I never ran that
delete.** I wrote intent as observation. Corrected in the file.

The Phase 0 changelog claimed alert noise cut "244 → 1 and 18 → 2". That
measured rows I had **resolved**, not a condition I had **stopped** — the fix
is engine-side and has not shipped, so it re-accumulated to 112. A correction
block was added to that changelog.

---

## 16. KNOWN DEFECTS AND ARCHITECTURAL HOLES

| Priority | Defect / hole                                                      | Evidence                                                              | Impact                                                                        | Recommended fix                                                                | Status                                                                                           |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **P0**   | **Engine has not restarted onto any of this code**                 | all 7 heartbeats `run_count = 0`                                      | no money check is running automatically; no dedupe; no auto back-pay          | merge PR #2551; engine deploys on merge touching `server/**`; restarts 7am/7pm | OPEN — awaiting merge                                                                            |
| **P1**   | `atomic_tournament_register` moves money with **zero** ledger rows | function body                                                         | a seat it creates is unauditable; would false-positive in the Phase 2 check   | retire it — **belongs to the `fn_union_law_check` workstream**                 | OPEN, documented in the check's alert                                                            |
| **P1**   | **Nothing guards default grants on NEW TABLES**                    | `money_check_heartbeat` shipped with `anon`/`authenticated` `arwdxtm` | any new table is browser-writable the moment a permissive RLS policy is added | extend `check-definer-authorization` to tables, or add a sibling gate          | OPEN — **recommend raising with Dan**                                                            |
| **P2**   | 64 stale `earner_not_paid` alert rows                              | check now reports **0**; 64 open rows remain from the 05:13 run       | alert-board noise; could mislead the next reader                              | resolve the 64 rows, or let the engine's next pass supersede them              | OPEN — **no money is missing**, proved: 2,300.00 pooled vs 2,300.01 credited, 0 events underpaid |
| **P2**   | `FeeReconciler` alerts unkeyed and accumulating (112 + 30 open)    | 0 of them carry `dedupe_key`                                          | alert-board noise                                                             | same as P0 — one deploy                                                        | OPEN                                                                                             |
| **P2**   | Migration rollbacks never exercised                                | no rollback run                                                       | a bad rollback is discovered during an incident                               | rehearse one in a rolled-back transaction                                      | OPEN                                                                                             |
| **P3**   | `docs/LAWS.md` conflicts on every merge                            | 3 for 3                                                               | merge friction for every agent                                                | consider one row per file per line with a stable sort, or split the table      | OPEN                                                                                             |
| **P3**   | 5 prose-only law pins remain                                       | sweep script                                                          | they cannot fail on a code change                                             | acceptable — they hold immutable migration text to its recorded form           | ACCEPTED                                                                                         |
| **P3**   | `rake_records` has no index on `source`                            | EXPLAIN                                                               | any `source`-filtered scan is expensive                                       | consider a partial index if Phase 4+ needs it                                  | OPEN                                                                                             |

### Money questions that are OPEN and are Dan's to decide

| Item                      | Amount                        | State                                                                                                                                                     |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rakeback owed to players  | **281,108.01 chips**, 3 clubs | cause fixed in PR #1084; cron next fires Mon 2026-09-07; 75,802.74 fundable now, 205,305.27 needs funding. **Awaiting Dan's word to trigger settlement.** |
| Overpaid duplicate places | 19,665.23 chips, 65 events    | **Dan ruled no clawback**; the hosting club absorbs. Closed.                                                                                              |
| Spin/SNG chip drift       | issue #2406                   | 691/691 recorded champions won their final hand, so no wrong winners. Open, low priority.                                                                 |

---

## 17. SECURITY, SECRETS, AND CREDENTIALS

**No secret values appear in this document, in any committed file, or in any
command output recorded here.**

| Name                                      | Where configured              | Used by                 | Available?              |
| ----------------------------------------- | ----------------------------- | ----------------------- | ----------------------- |
| `GITHUB_TOKEN`                            | `~/Documents/club-arena/.env` | PR API calls via `curl` | YES — confirmed working |
| `SENTRY_AUTH_TOKEN` / `_ORG` / `_PROJECT` | `~/Documents/club-arena/.env` | Club Arena build        | UNVERIFIED this session |
| `SUPABASE_SERVICE_ROLE_KEY`               | Hetzner engine env            | engine (bypasses RLS)   | not touched             |
| `CRON_SECRET`                             | Open Claw dispatcher + Vercel | cron auth               | not touched             |
| Supabase access                           | via the Supabase MCP tool     | migrations + queries    | YES — confirmed working |

**No credential was exposed.** Pushes use SSH (`git@github.com`); no token
appears in any remote URL. `AGENT-PLAYBOOK.md` documents where every credential
lives (the place, never the value).

Secret scanning runs in the push path and blocks the two GitHub personal-access
token prefixes. (Those literal prefixes are deliberately not written out here:
the scanner matches on file content, so quoting them in a document would block
the document's own push.)

---

## 18. DATABASE, MIGRATION, AND SEED STATUS

**Provider:** Supabase PostgreSQL, project ref `kuklfnapbkmacvwxktbh`.
**There is no separate local database. All work was against PRODUCTION.**

### Migrations applied by this work — all CONFIRMED recorded

| Version          | Name                                                         | Applied |
| ---------------- | ------------------------------------------------------------ | ------- |
| `20260902012048` | `a_check_that_never_runs_looks_like_a_check_finding_nothing` | yes     |
| `20260902013940` | `the_heartbeat_table_is_service_role_only`                   | yes     |
| `20260902041336` | `a_seat_nobody_paid_for`                                     | yes     |
| `20260902050552` | `the_awards_lookback_was_a_month_and_needed_six_hours`       | yes     |
| `20260902052302` | `a_half_guarded_feature_is_a_feature_that_can_be_half_built` | yes     |
| `20260902052604` | `is_xmtt_means_union_event_not_multi_day`                    | yes     |

(Four more from earlier in the workstream: `20260901192531`, `20260901193047`,
`20260901194756`, `20260901195005`.)

**Every repo migration filename matches its recorded version.** This was a
Phase 1 defect that was fixed; keep it true.

### Objects created

- **Table `money_check_heartbeat`** — columns `check_name` (PK),
  `expected_interval_minutes`, `last_run_at`, `last_result` (jsonb),
  `run_count`, `registered_at`, `note`. RLS **enabled, no policies**. Grants:
  `postgres` + `service_role` only. **Seeded with 7 rows** (the expected check
  set) — the seeding is the point; a check with no row reads as nothing rather
  than as missing.
- **Index `idx_tournament_players_registered_at`** on
  `tournament_players(registered_at)`.
- **Functions:** `fn_record_money_check_run`, `fn_money_check_health`,
  `fn_uncollected_entry_check`. All `SECURITY DEFINER`,
  `SET search_path TO 'public','pg_temp'`, **revoked from PUBLIC/anon/
  authenticated**, granted to `service_role` only.
- **Trigger `trg_tournaments_refuse_unbuilt_multi_day`** — rewritten to
  `BEFORE INSERT OR UPDATE OF` **all seven** multi-day columns.

### Data written (the only rows this work inserted)

**23 rows into `tournament_payouts`**, `source='satellite_seat'`,
`recorded_by='phase2_backfill'`, total **4,600.00 chips**. Every field
reconstructed from the `rake_records` row `fn_award_satellite_seat` itself
wrote. Keyed `tourney:{satellite_id}:seat:{user_id}` — the same key the live
function uses, so a re-drive writes nothing (**proved: 0 rows, rolled back**).

**No chips were moved to or from any wallet by this work.**

### Rollback

Every migration carries a written `ROLLBACK` section. **None has been
executed.** UNVERIFIED.

### Seeds

`money_check_heartbeat` seeding uses `ON CONFLICT (check_name) DO UPDATE` —
**idempotent**. CONFIRMED.

### Production-data risk

All work was on production. The DDL policy (one transaction per change; no DDL
probes; batch related migrations) was followed. Two migrations were refused by
their own assertions and re-applied — each refusal was a **failed apply that
changed nothing**, not a partial state.

---

## 19. CURRENT BLOCKERS AND DECISION POINTS

### Blocker 1 — PR #2551 is not merged (TECHNICAL, resolves itself)

- **Blocked:** every runtime behaviour in this workstream.
- **Evidence:** `mergeable_state=blocked`, all heartbeats `run_count = 0`.
- **Options:** (a) let autopilot merge it — **recommended**, it is the
  documented flow; (b) merge by hand once checks are green.
- **Do NOT** sit and watch CI (CLAUDE.md 10.8.3).

### Blocker 2 — rakeback settlement (REQUIRES DAN'S AUTHORITY)

- **281,108.01 chips owed to players across 3 clubs.** 75,802.74 fundable now;
  205,305.27 needs funding.
- Cause fixed in PR #1084; the cron next fires **Monday 2026-09-07**.
- **This is money owed to real players and it is the largest open item in the
  entire audit.** It is a funding decision, not a technical one.

### Decision point 3 — the new-table grant hole (RECOMMEND RAISING)

Nothing guards default grants on new tables. Options: extend
`check-definer-authorization`; add a sibling gate; or accept and document.
**Recommend putting it to Dan** — it is a security posture decision.

### Decision point 4 — the 64 stale alert rows (LOW, AGENT MAY DECIDE)

The check reports 0; the rows are from a superseded run. Safe to resolve them
with a note. **No money is missing** — proved. Do not pay against them; paying
would double-pay 836.79 chips.

---

## 20. REMAINING WORK

### CRITICAL

1. **Merge PR #2551** so the engine picks up the money-check wiring.
2. **Rakeback settlement** — Dan's decision, 281,108.01 chips.

### HIGH PRIORITY

3. **Phase 4 of 6 — re-entries and add-ons reach the prize pool.**
   Population CONFIRMED over the last 14 days:

   | Category           | Rows    | Chips        |
   | ------------------ | ------- | ------------ |
   | `tournament_buyin` | 175,173 | 3,827,567.60 |
   | `rebuy`            | 12,888  | 71,776.70    |
   | `addon`            | 8,022   | 50,810.00    |

   Core question: does `prize_pool + total_rake` reconcile per event against
   entries + rebuys + add-ons + satellite seats? A worked precedent exists —
   Sunday $200 Deep Stack: `44,640 + 4,960 = 49,600 = 248 x 200`, and
   `248 = 92 registrations + 23 satellite seats + 133 rebuys`. Exact.

4. **Phase 5 of 6 — mystery bounty chests, draw by draw.**
5. **Phase 6 of 6 — exact-cent allocation** replacing the 0.05 tolerance in
   `earner_not_paid`.

### MEDIUM

6. Retire or ledger-ise `atomic_tournament_register` (other workstream).
7. Close the new-table grant hole.
8. Rehearse one migration rollback.
9. Resolve the 64 stale alert rows.

### LOW / OPTIONAL

10. Reduce `docs/LAWS.md` merge friction.
11. Consider a partial index on `rake_records(source)`.
12. Spin/SNG chip drift (issue #2406).

---

## 21. PRIORITIZED NEXT-PHASE EXECUTION PLAN

### Phase 0 — Recover and verify current state (do this first, ~5 min)

- **Objective:** confirm nothing drifted since this handoff.
- **Steps:** §22 checklist.
- **Completion:** clean tree, `local == remote`, both suites green.
- **Risk:** another agent merged to main; `docs/LAWS.md` will conflict.

### Phase 1 — Protect completed work

- Do **not** revert, "tidy", or re-fix anything in §7. Each item has a law test
  and a changelog entry.
- Do **not** re-fix the horse-seeding leak (already fixed 2026-08-19).
- Do **not** "fix" the stale heartbeats or unkeyed alerts — one pending deploy.
- Do **not** touch other agents' worktrees.

### Phase 2 — Merge and confirm the deploy

- Confirm PR #2551 merges. After the engine restarts (7am/7pm), verify
  `money_check_heartbeat.run_count > 0` for all seven.
- **This is the single highest-value action available.**

### Phase 3 — Phase 4 of 6 diagnosis

- **Inspect:** `process_tournament_rebuy`, the add-on path, `fn_tournament_entry_split`,
  `tournaments.prize_pool` / `total_rake` / `bounty_pool`.
- **Reconcile per event:** `prize_pool + total_rake` vs the sum of every entry,
  rebuy, add-on and satellite seat.
- **Mandatory:** run a **positive control** against a known-bad window before
  believing any zero.
- **Completion:** the population is explained, or a defect is proven with
  evidence.

### Phase 4 — Fix the cause, if there is one

- Fix at source. Do not re-fix something already fixed.
- Probe money paths **inside a rolled-back transaction** (CLAUDE.md 11.5).

### Phase 5 — Ship the detector

- Registered in `money_check_heartbeat`, stamped by `GameServer` in its **own**
  `try` block **before** the health read, deduped alert, **moves no money**,
  bounded window, structure assertions (**never wall-clock**), positive control
  inside the migration.

### Phase 6 — Law test + registry

- Pins must read the **live** migration, and include a **stale-pointer guard**
  like the one in `ASeatNobodyPaidFor.law.test.ts`.
- **Negative-control every new pin.**
- Add the row to `docs/LAWS.md` in the same commit.

### Phase 7 — Verify and document

- md5 the function body against `pg_proc.prosrc`.
- Both suites + both tsc + definer gate.
- Changelog in `docs/changelog/YYYY-MM-DD-<slug>.md`, recording **observed**
  results, including anything that went wrong.

### Phase 8 — Commit, push, report

- Correct author. Never `--no-verify`. Push detached, poll with instant
  commands. Report the PR number and **stop**.

---

## 22. EXACT FIRST ACTIONS FOR THE NEXT AGENT

```bash
# 1. Enter the worktree
cd /Users/smarter.poker/Documents/.agent-trees/club-arena/swarm-mtt-payouts

# 2. Node is NOT on the default PATH — do this in every shell
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"

# 3. Confirm state
git status --short --branch
git rev-parse --abbrev-ref HEAD          # expect agent/swarm-mtt-payouts/phase7-no-result-without-a-hand
git log --oneline -3                      # expect dd852fb83 at the tip
git ls-remote origin agent/swarm-mtt-payouts/phase7-no-result-without-a-hand | cut -c1-9
```

4. **Read, in this order:** `AGENT-PLAYBOOK.md`, `CLAUDE.md`, `docs/LAWS.md`,
   this file, then `docs/changelog/2026-09-02-phase-3-multi-day-does-not-exist.md`.

5. **Check PR #2551:**

```bash
TOKEN=$(grep -m1 '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2- | tr -d '"'\'' ')
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/2551" \
  | python3 -c "import json,sys;p=json.load(sys.stdin);print(p['state'],p.get('mergeable_state'),p.get('commits'))"
```

6. **Confirm the engine deploy state** (the P0 blocker) — via the Supabase MCP:

```sql
SELECT check_name, run_count, last_run_at FROM money_check_heartbeat ORDER BY check_name;
-- run_count 0 across all seven = the engine still has not restarted onto this code
```

7. **Do NOT modify:** anything listed in §11 without reading its law test and
   changelog; any other worktree; the schema manifests.

8. **Resume at:** Phase 4 of 6 — re-entries and add-ons reaching the prize pool
   (§20 item 3, §21 Phase 3).

---

## 23. ACCEPTANCE CRITERIA

### For Phase 4 (the next unit of work)

- [ ] The rebuy/add-on population is fully explained against production data.
- [ ] Any discrepancy is proven with a positive control, not merely observed.
- [ ] If a cause exists it is fixed at source, or explicitly deferred with an owner.
- [ ] A detector exists, is registered in `money_check_heartbeat`, is stamped by
      `GameServer` in its own `try` block before the health read, moves no money,
      and files one deduped alert.
- [ ] A law test exists, reads the **live** migration, has a stale-pointer
      guard, and every new pin is negative-controlled.
- [ ] The law is registered in `docs/LAWS.md` in the same commit.
- [ ] Function body md5 matches `pg_proc.prosrc`.
- [ ] Server and client suites and both `tsc` are green.
- [ ] `check-definer-authorization` passes.
- [ ] A changelog records **observed** results, including failures.
- [ ] Committed with the correct author, pushed, PR number reported.

### For the overall audit

- [ ] Every player who earned a payout has been paid, provably, across MTT,
      Spin and Heads-Up.
- [ ] Every money check runs on a timer and proves it ran.
- [ ] Every detector moves no money and is separate from every back-pay.
- [ ] No `is_horse` exclusion anywhere except identification and the horse's
      input device.
- [ ] Every claim in every changelog is an observation, not an intention.
- [ ] The rakeback decision is made and executed.

---

## 24. RECOMMENDED COMMIT STRATEGY

| #   | Message                                                                      | Files                                                                   | Tests required first                           |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `docs(handoff): continuation state for the MTT payout audit at Phase 4 of 6` | `docs/HANDOFF_CURRENT_STATE.md`                                         | law registry (a new doc adds no law)           |
| 2   | `feat(money): <phase 4 finding stated as a fact>`                            | the phase-4 migration + `GameServer.ts` + the law test + `docs/LAWS.md` | server + client suites, both tsc, definer gate |
| 3   | `docs(changelog): phase 4 of 6 - <slug>`                                     | `docs/changelog/2026-09-0X-*.md`                                        | none                                           |
| 4   | `fix(...): <whatever the verification pass finds>`                           | as needed                                                               | full re-run                                    |

**Never mix a migration with an unrelated fix.** **Never commit a red test.**

---

## 25. FINAL CONTINUATION SUMMARY

**Exact stopping point:** Phases 1, 2 and 3 of the six-phase MTT payout audit
are complete, verified against production, committed and pushed. Branch
`agent/swarm-mtt-payouts/phase7-no-result-without-a-hand` at **`dd852fb83`**,
clean, in sync with its remote, PR **#2551** open with 33 commits and
`mergeable=true`. Phase 4 has not been started.

**Work on first:** confirm PR #2551 lands (it is the P0 blocker — nothing this
workstream built is _running_ until the engine restarts onto it), then begin
Phase 4 by reconciling `prize_pool + total_rake` per event against entries,
rebuys, add-ons and satellite seats.

**Most important locked requirements:** players always get paid; horses are
players in every respect; no clawback from players; never spend real chips to
test a rule; never push a red test; never rebase main; never `--no-verify`;
commits authored `Smarter-Poker <254329056+…>`.

**Greatest technical risk:** the entire hourly money-check pass has **never
executed**. All seven heartbeats read `run_count = 0`. The wiring is verified by
tests and source-order assertions but is **unproven at runtime**. The first
restart after the merge is the moment to watch.

**Greatest visual risk:** none. No UI work exists in this workstream.

**Greatest data-integrity risk:** `atomic_tournament_register` can still move
money with no ledger row of any kind. It is dead code today, on another
workstream's watch list, and named as a blind spot inside the Phase 2 check's
own alert — but it remains callable by `service_role`.

**Decisions that still require Dan:** the **281,108.01 chips** of player
rakeback (funding decision, cron fires Monday 2026-09-07), and whether to close
the new-table default-grant hole.

**How to continue without restarting discovery:** everything learned is in
§6 (discovery), §15 (failed approaches and lessons) and §16 (defects). The
method that works on this codebase is in §2 under "the methodological standard":
verify the instrument before believing the reading, distinguish what you did
from what should happen, use buffers rather than wall clock, match code forms
rather than bare words in assertions, and negative-control every pin. Read
§22, run those commands, and pick up at Phase 4. Nothing in §7 needs to be
redone, and re-doing any of it risks reintroducing a bug that is already closed.
