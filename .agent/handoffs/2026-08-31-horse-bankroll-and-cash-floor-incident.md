# HANDOFF — Horse bankroll management, and the cash-floor outage of 2026-08-31

**Written:** 2026-08-31 ~12:35 UTC by the Cowork/Claude agent working in
`~/Documents/.agent-trees/club-arena/cowork-fable`.
**Status of the floor at time of writing: HEALTHY.** 47 horse cash seats across
23 tables, 272 tournament seats, 308 cash hands in the last 10 minutes, zero
unaccounted seat exits.

> Read `AGENT-PLAYBOOK.md` and `CLAUDE.md` before touching anything. This
> document is the _state_; those are the _rules_. Section 5 lists the rules that
> actually bit during this work.

---

## 1. Executive continuation brief

### What is being built

A **bankroll-management layer for the horse fleet** in Club Arena. Horses are
the platform's AI players (CLAUDE.md 10.5: they are **never** called bots, and
they are **never** excluded from anything a human gets). Dan asked, verbatim:

> "WE WILL HAVE TO ADD BANKROLL MANAGEMENT FUNDAMENTALS TO ALL THE HORSES WHERE
> THEY NEED TO BE AWARE OF THEIR CURRENT BANK ROLL WHEN CHOOSING WHAT GAMES TO
> PLAY, IF THEY RUN OUT OF CHIPS, THEY MUST PLAY FREE ROLL'S TO EARN THERE CHIPS
> BACK, AND WAIT FOR THEIR WEEKLY RAKE BACK FROM THE CLUB OR UPLINE AGENT THEY
> ARE ASSIGNED TOO. THEY NEED TO UNDERSTAND THE FUNDIMENTALS OF BANKROLL
> MANAGEMENT AND LEARN HOW TO BOOK WINS AND NOT RISK MORE OF THEIR STACK THEN
> THEY SHOULD BE... GOING DOWN OR UP IN STAKES AS THEIR BANK ROLL GROWS OR
> SHRINKS. FULLY ADD THIS LOGIC, CONCEPT AND LAYER INTO EACH AND EVERY HORSE
> BEFORE MOVING ON."

### Business objective

Dan is **resetting every horse's chip balance to 10,000** and **relaunching all
micro cash games, all cash games, and all tournaments**. The horses must then
behave like real bankrolled players: pick affordable games, book wins, stop
losses, move down when they lose, move up when they win, and fall back to
freerolls plus weekly rakeback when broke.

### Current phase

**Post-incident stabilisation.** The core layer is live and correct. Six
extensions were built, shipped, and then **reverted during a production
incident** and must be re-landed one at a time.

### Major work completed

1. Core bankroll module + seating gate (live).
2. Reload cap + session exit in the rotator (live).
3. Six extensions built and tested — **currently reverted** (section 7.3).
4. A dead chip-minting DB function dropped (live, migration applied).
5. **A production incident: the cash floor emptied for ~55 minutes.** Root cause
   found, fixed, verified (section 7.5). No chips lost.

### The single most important thing to understand

**The 11:20 UTC outage was NOT caused by the newest code.** It was caused by two
latent faults in the _morning's_ bankroll gate that had been invisible because a
third bug kept the gate switched off. Another agent's PR #2101 fixed that third
bug, the gate ran for the first time ever, and the other two fired. Two reverts
were shipped chasing the wrong suspect before the real cause was found. **Do not
assume a merge time is a deploy time** — `MIN_RESTART_SPACING_SEC=1200`
coalesces restarts, so several PRs can go live in one restart.

### First action for the next agent

Run the Phase 0 checklist in section 22. It is four read-only commands and one
SQL query, and it takes two minutes. **Do not re-land anything before confirming
the floor is still seating.**

---

## 2. User requirements and working preferences

### Non-negotiable laws (from CLAUDE.md, set by Dan)

| Law                                     | Requirement                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10.5 HORSES ARE PLAYERS**             | "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!" Never write `is_horse` to deny a horse something a human gets. Test is **"is it identical"**, not "is it equivalent". **Timing is part of the treatment** — same pauses, same timers. |
| **10.5 exception**                      | `is_horse` is legal for exactly two things: identification (badges, rosters, the fleet plumbing) and the horse's _input device_ (HorseLogic, `scheduleHorseAction`, synthetic heartbeat, `autoRebuyHorse`).                                                                                        |
| **10.5 sanctioned asymmetry**           | Hand-history retention **stays at 7 days** for horse-only hands. Dan's decision. It is a config row. **Do not "fix" it.**                                                                                                                                                                          |
| **10.6 ANIMATIONS**                     | Every animation and its sound plays every time it is owed, full duration. Never weaken a pin in `tests/animations-always-play.law.test.ts`.                                                                                                                                                        |
| **10.6 NO AUTO TABLE SWITCHING**        | Never move `activeIndex` without a user gesture.                                                                                                                                                                                                                                                   |
| **5.7 POPUPS**                          | Toasts render Title Case; **em dashes forbidden** in popup text. Never bypass the Toast layer.                                                                                                                                                                                                     |
| **5.8 NEVER PUSH A RED TEST**           | A red test stops the World Hub sync for every agent. Write specs `it.skip()` if the implementation is not there yet.                                                                                                                                                                               |
| **11.5 NEVER SPEND REAL CHIPS TO TEST** | Probe money paths **inside a transaction you roll back**. Helper functions in `pg_temp`, never `public`. Never DELETE a `table_seats` row to clean up.                                                                                                                                             |
| **12 NEVER REBASE MAIN**                | The Mac's `main` is a mirror. Ship via PR.                                                                                                                                                                                                                                                         |
| No emoji in source                      | Breaks the SWC compiler.                                                                                                                                                                                                                                                                           |
| `.maybeSingle()` never `.single()`      | PGRST116 on 0 rows.                                                                                                                                                                                                                                                                                |
| Changelog                               | Write your **own** file at `docs/changelog/YYYY-MM-DD-<slug>.md`. **Never** append to `MIGRATION-CHANGELOG.md`.                                                                                                                                                                                    |

### Working preferences observed this session

- **Fix-first**: find an issue, fix it fully, move on. Do not audit ten things
  then ask what to fix.
- **Verify against reality**, not compilation. Dan rejects "it compiles".
- **Do not ask permission for obvious work.**
- **When corrected, change course immediately** and do not defend the old path.
- Dan asks for exhaustive sweeps: _"CHECK FOR ANY AND ALL BUGS, GAPS, STUBS,
  ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE"_ and
  _"DO NOT LEAVE ANYTHING UNFINISHED."_

### Things Dan explicitly rejected earlier in this workstream

- **"Equal outcome by a different mechanism"** as an excuse for horse/human
  differences. Rejected outright on 2026-08-27. The five-second rebuy pause
  applies to horses too, because _"NOT EVERY HORSE ALWAYS REBUYS IN THE CASH
  GAMES, AND IF YOU DIDN'T GIVE THEM THE SAME EXACT FEATURES AND FUNCTIONALITY,
  PEOPLE WOULD NOTICE!"_

### Things Dan repeatedly corrected

- The agent once reported Dan's play style from the **wrong account**
  (`danbek4545@gmail.com`, zero table_seats ever). His real playing account is
  **`daniel@bekavactrading.com`** — 600 hands, AF 3.51, correctly tagged as a
  maniac. **Always use `daniel@bekavactrading.com` when checking Dan's own play.**

---

## 3. Project and repository identity

```text
Project Name:            Club Arena (Smarter Poker) — horse bankroll layer
Repository Root:         /Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-fable   [CONFIRMED]
Canonical main worktree: /Users/smarter.poker/Documents/club-arena                             [CONFIRMED — main is checked out THERE, not here]
Current Working Dir:     /Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-fable   [CONFIRMED]
Git Repository:          git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git             [CONFIRMED]
Current Branch:          docs/handoff-bankroll-incident (created to carry this doc)            [CONFIRMED]
Remote Names:            origin (only)                                                         [CONFIRMED]
Primary Framework:       Vite + React 19 + TypeScript (client); Node/TS engine (server/)        [CONFIRMED]
Package Manager:         npm (no packageManager field in package.json)                          [CONFIRMED]
Runtime:                 node v26.3.0 locally; CI uses "Setup Node 22"                          [CONFIRMED]
Database:                Supabase Postgres, project ref kuklfnapbkmacvwxktbh                    [CONFIRMED]
Hosting:                 Frontend via World Hub -> Vercel `hub-vanguard`; engine on Hetzner     [CONFIRMED from CLAUDE.md]
External Services:       Supabase, Hetzner, GitHub Actions, Sentry                              [CONFIRMED from CLAUDE.md]
```

**Do not expose or print secret values.** None were read during this work.

### Worktree warning

This repo has **many** live agent worktrees (`git worktree list` shows 12+).
`main` is checked out at `~/Documents/club-arena` — you **cannot** `git checkout
main` in this worktree; git will refuse. Work on feature branches here.

---

## 4. Repository map (relevant paths only)

```
server/src/services/
  HorseBankroll.ts                 CORE. Pure arithmetic: temperaments, policies,
                                   canSit / canMoveUp / shouldMoveDown /
                                   bankrollBuyIn / sessionVerdict / topUpAllowance /
                                   canOpenAnotherTable / isBroke / bestAffordableGame.
                                   MODIFIED this session. Production code. EDIT HERE
                                   for policy changes.
  HorseBankroll.test.ts            Unit tests for the above. MODIFIED.
  HorseBankrollWiring.test.ts      Source-contract pins: the seating path must call
                                   the gate. MODIFIED (a pin was MOVED, see 7.4).
  HorseBankrollGateClubs.test.ts   NEW this session. Pins the incident fix.
  HorseFleetManager.ts             Seeding cycle. Loads bankrolls, filters candidates,
                                   sizes buy-ins, seats horses. MODIFIED — this is
                                   where the outage lived. Production code.
  HorseSessionRotator.ts           Every 90s: tops up short stacks, ends sessions.
                                   Holds topUpAllowance + sessionVerdict wiring.
  HorseBehavior.ts                 gameLaneFor / isActiveNow / stakeBandFor /
                                   stakeBandAllows / stakeBandForBigBlind /
                                   setHorseStakeBands. Bands are EARNED on bb/100.
  HorseLaneLoader.ts               Calls setHorseStakeBands() + fn_assign_horse_stake_bands.
                                   Runs at boot and every 30 min.
  TournamentRecurringService.ts    registerHorses() — tournament entry. Was modified
                                   then REVERTED.
  supabase/wallets.ts              autoRebuyHorse (treasury-funded), readClubChipBalances.
  supabase/pagination.ts           fetchAllRows — keyset pager. `idKey` matters; see 6.9.

server/src/engine/
  ServerTableEngineSettlement.ts   Post-hand: bust detection, horse rebuy, auto-cashout.
  ServerTableEngineDealing.ts      Dead-table recovery: second horse rebuy site.

docs/changelog/                    296 files. One file PER AGENT PER CHANGE. Never
                                   append to a shared file.
.agent/handoffs/                   Repo convention for handoffs. THIS FILE lives here.
.agent/workflows/                  migration-safety.md, live-cash-games-policy.md.
supabase/migrations/               SQL migrations, checked in.
tests/                             Client vitest suite (725 files / 10,179 tests).
tests/helpers/sourceWindow.ts      MANDATORY for source-pin windows. See 6.12.
tests/unit/noFixedSizeSourceWindows.test.ts   The gate that enforces it.
.github/workflows/ci.yml           Jobs: changes, stub_gate, typecheck, unit, server, build.
.github/workflows/auto-deploy-hetzner.yml     Engine deploy. MIN_RESTART_SPACING_SEC=1200.
```

**Files the next agent should NOT edit without reading first:**
`AGENT-PLAYBOOK.md` (byte-identical across seven repos, checked hourly by
`estate-integrity` — changing it breaks the estate check),
`MIGRATION-CHANGELOG.md` (frozen history).

---

## 5. Applicable instructions and constraints

| File                                                                  | Scope                          | Why it matters here                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT-PLAYBOOK.md`                                                   | All seven repos                | Claim a worktree, commit, push, PR, stop. Credential locations. **Do not edit.**                                                                      |
| `CLAUDE.md` (repo root)                                               | This repo                      | Sections 1.2.5 (PR-only to main), 5 (code safety), 10 (working rules), **10.5 horses are players**, 10.6, 11.5 (money paths), 12 (never rebase main). |
| `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md` | Architecture                   | Wins over CLAUDE.md if they conflict. **NOT read this session — UNVERIFIED whether it constrains the bankroll layer.**                                |
| `.agent/workflows/migration-safety.md`                                | Migrations                     | Four-step protocol; Tier 3 (DROP) needs a pasted ROLLBACK. Followed for the `atomic_seat_horse` drop.                                                 |
| `MIGRATION-LAW.md`, `MASTER-MIGRATION-DOCUMENT.md`                    | Server-authoritative migration | **NOT read this session — UNVERIFIED** whether the bankroll work touches the phase order.                                                             |

### Known ambiguity

The **World Hub** `CLAUDE.md` says `.agent/handoffs/` is "CLOSED for deploy,
push and build work". The **Club Arena** `CLAUDE.md` carries no such rule, and
three handoffs merged into club-arena `main` today (#2169, #2170, #2171). This
document follows the Club Arena convention. It is a _state record_, not a
request for a human to deploy anything.

---

## 6. Complete discovery record

### 6.1 The two chip pools — and which one is real

This is the highest-value discovery of the session.

| Pool     | Table/Column                | Status                                                                                                                                 |
| -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **LIVE** | `club_members.chip_balance` | The real chip pool. `atomic_table_buyin` debits it, cash-out and tab-close credit it. **This is what Dan's 10,000 reset must target.** |
| **DEAD** | `public.wallets.balance`    | Frozen since 2026-08-21. **718,146,564 chips** sit in horse hands here (avg **1,229,703 each** across 584 horses). Nothing reads it.   |

**Verified money paths (read from `pg_get_functiondef`, not assumed):**

| Path                                   | Function                                                      | Pool touched                                                                                       |
| -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Cash buy-in (all players incl. horses) | `atomic_table_buyin`                                          | debits `club_members.chip_balance` ✅                                                              |
| Cash-out, explicit                     | `atomic_seat_cashout_locked` → `atomic_credit_wallet_and_log` | credits `club_members.chip_balance` ✅                                                             |
| Cash-out, tab close                    | `player_leave_table` → `fn_add_chips`                         | credits `club_members.chip_balance` ✅                                                             |
| Horse rebuy                            | `autoRebuyHorse` → `fn_horse_fund_from_treasury`              | debits `clubs.chip_treasury`, credits the seat directly. **Never touches the horse's own wallet.** |
| **DEAD** legacy horse seat             | `atomic_seat_horse`                                           | debited `public.wallets`. **DROPPED this session.**                                                |

**Consequence to remember:** because rebuys come from the club treasury, a horse
**cannot truly go broke on cash** through busting alone. Its wallet only shrinks
when it _buys in_. This is a real design fork and **Dan has not ruled on it**
(section 19).

### 6.2 Two independent axes decide where a horse sits

- **Merit — the stake band.** `profiles.horse_profile->>'stakeBand'` ∈
  `micro | low | mid | high`, assigned by `fn_assign_horse_stake_bands` on
  **bb/100** (winnings per 100 big blinds faced), re-ranked every 30 minutes,
  hydrated into memory by `HorseLaneLoader` → `setHorseStakeBands`.
  Band → stake mapping (`stakeBandForBigBlind`): `bb<=0.5 micro`, `bb<=2 low`,
  `bb<=6 mid`, else `high`.
- **Affordability — the bankroll.** `club_members.chip_balance` vs the policy.

`stakeBandAllows()` is an **exact match**, so today a horse plays exactly one
band and cannot move down. See 6.10 for why that matters.

### 6.3 Live fleet and floor numbers (measured 2026-08-31 ~12:30 UTC)

| Metric                                                     | Value                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Horses                                                     | 584                                                                            |
| Horse club memberships                                     | 1,487                                                                          |
| Horse club wallet: mean / median                           | 107,450 / **32,748**                                                           |
| Horses with a membership in the **cash-table-owning club** | **323 of 584**                                                                 |
| Band split                                                 | micro **127**, low **336**, mid **73**, high **48**                            |
| Open cash tables                                           | **26**, all owned by club `fade0000-0000-0000-0000-000000000001`               |
| Stakes open                                                | 1/2 ×22 (min 80 / max 400), 2/4 ×1 (160/800), 2/5 ×3 (200/1000)                |
| Micro tables                                               | **ALL CLOSED** (0.05/0.10, 0.10/0.20, 0.25/0.50, 0.50/1 all `status='closed'`) |
| Freerolls REGISTERING                                      | 12                                                                             |
| Tournament cost tiers next 24h                             | 0, 3, 5, 10, 15, 25, 100                                                       |
| Rakeback to horses                                         | **1,012 of 1,014 payouts** — the rail already works                            |

### 6.4 The temperament policy table (`HorseBankroll.ts`, live in main)

|                           | nit (20%) | standard (60%) | gambler (20%) |
| ------------------------- | --------- | -------------- | ------------- | --------------------------- |
| `buyInsToSit`             | 40        | 25             | 12            |
| `buyInsToMoveUp`          | 55        | 35             | 16            |
| `moveDownAt`              | 28        | 17             | 8             |
| `maxBankrollFraction`     | 0.03      | 0.05           | 0.10          |
| `stopWinBuyIns`           | 2         | 3              | 5             |
| `stopLossBuyIns`          | 2         | 3              | 4             |
| `tournamentBuyInsToEnter` | 100       | 60             | 30            | ← **REVERTED, not in main** |

Temperament is a stable hash of the horse id (`bankrollTemperamentFor`).
`referenceBuyIn(bb, min, max)` = `min(max(bb*100, min), max(min, max))` — i.e.
**100bb clamped to the table's own limits**, not the table minimum.

### 6.5 The ladder, priced at a 10,000 reset

| stake     | ref (100bb) | gambler (12) | standard (25) | nit (40) | who can sit   |
| --------- | ----------- | ------------ | ------------- | -------- | ------------- |
| 0.05/0.10 | 10          | 120          | 250           | 400      | all           |
| 0.10/0.20 | 20          | 240          | 500           | 800      | all           |
| 0.25/0.50 | 50          | 600          | 1,250         | 2,000    | all           |
| 0.50/1    | 100         | 1,200        | 2,500         | 4,000    | all           |
| 1/2       | 200         | 2,400        | 5,000         | 8,000    | all           |
| 2/4       | 400         | 4,800        | 10,000        | 16,000   | std + gambler |
| 2/5       | 500         | 6,000        | 12,500        | 20,000   | gambler only  |

**The micro relaunch is load-bearing.** With micros closed, 1/2 is the cheapest
game; a standard horse that loses half its roll has nowhere to step down to.

### 6.6 Tournament entry

`fn_register_horse_for_tournament` refuses **only** on `insufficient_balance` —
solvency, not discipline. A 1,000-chip horse can enter a 950 event.
Measured: at a 10,000 roll with the (reverted) gate, **every scheduled tier in
the next 24 hours admits 100% of the fleet.** The first tier that would bite is
200, and none are scheduled.

### 6.7 The rebuy sites (two of them, previously divergent)

`ServerTableEngineSettlement.ts` (~line 1760) and `ServerTableEngineDealing.ts`
(~line 2574). Both sized reloads as `big_blind * 100` flat and stopped at a
hard-coded `currentRebuys >= 2`. Neither consulted the table's own min/max or
the horse's roll.

### 6.8 The rotator

`HorseSessionRotator.ts` runs every 90s. Reloads any horse under 45% of a buy-in
at 25% probability. Now capped by `topUpAllowance` and exits on `sessionVerdict`
(both **live in main**). `invested` is read from `chip_ledger` using
`from_entity_id` + `table_id` — **no money path was touched to obtain it.**

### 6.9 `fetchAllRows` and the `idKey` trap

`server/src/services/supabase/pagination.ts` keyset-pages by a column, default
`id`. **`club_members` has no `id` column** (PK is `(club_id, user_id)`), so the
default returned `complete:false` every cycle and silently disabled the bankroll
gate. Fixed by another agent in **PR #2101** by paging **per club** with
`idKey: 'user_id'` (legal only once narrowed to one club, since `user_id` is
unique within a club but not across clubs).

### 6.10 Architectural hole: merit is a hard partition, not a ceiling

Because `stakeBandAllows` is an exact match, **175 of 584 horses (30%) are
banded into a stake with no open table**:

- **127 `micro`** — every micro table is closed.
- **48 `high`** — nothing above 2/5 exists.

They cannot sit anywhere and have no legal way to move. The fix (merit as a
**ceiling**, bankroll picks beneath it, with hysteresis) was built and is
**currently reverted**. It rescues the 48; the 127 need the micro relaunch.

### 6.11 Chip-conservation guardrail that already exists and works

Migration `20260825_chips_cannot_leave_the_felt_unnoticed` puts a
`BEFORE DELETE OR UPDATE OF left_at` trigger on `table_seats` that logs every
non-zero-stack exit to `ca_seat_stack_exits` with `db_role` and `app_name`.
`fn_unaccounted_seat_exits()` lists exits with no matching wallet credit.
**During the outage it read 0 the entire time.** This guardrail is proven.

### 6.12 Test-infrastructure rules discovered the hard way

- `tests/unit/noFixedSizeSourceWindows.test.ts` **fails the build** if any test
  bounds a source pin with a magic byte count (`.slice(i, i + 700)`). Use
  `tests/helpers/sourceWindow.ts` (`sliceMethod`, `sliceCall`,
  `sliceEnclosingBlock`, `sliceStatement`, …) or an adjacency regex.
- `sliceEnclosingBlock` can be **too coarse** — see 15.4.
- Server tests run with **cwd = `server/`**, so source-reading tests must use
  `join(process.cwd(), 'src/...')`, not `'server/src/...'`.
- Importing `./supabase/wallets.js` at module scope **aborts the process** when
  `SUPABASE_SERVICE_ROLE_KEY` is unset. Use a **dynamic import inside the async
  function** so the module stays unit-testable.

### 6.13 Deploy mechanics that shape incident response

- `MIN_RESTART_SPACING_SEC=1200` — restarts coalesce into a 20-minute window,
  so **several PRs go live in one restart**. A merge time is not a deploy time.
- The **drain gate** waits for `handsInFlightTotal` to reach zero. A busy
  tournament floor never goes quiet; it held one deploy ~6 minutes.
- Deploy runs **cancel each other**; three consecutive deploys were cancelled by
  newer merges landing behind them.
- A `*/20` catch-up cron re-attempts coalesced deploys.
- **Verify deploys through the database**, never `engine.smarter.poker/health`
  (CDN + 15-min fetch cache). A restart shows as a per-minute dip in
  `hand_history`.

---

## 7. Work completed during this chat

### 7.1 WORKSTREAM A — Reload cap + session exit (PR #2073, MERGED, **LIVE**)

**Problem.** `HorseSessionRotator` reloaded any horse under 45% of a buy-in to a
full buy-in, every 90s cycle at 25% probability, wallet-funded, **with no
bankroll reference at all**. Separately, `sessionVerdict` had shipped tested and
**nothing called it** — the rotator left on a probability curve over
`stack / (bb*100)`, an _assumed_ buy-in.

**Changed.**

- `HorseBankroll.ts` — added `topUpAllowance()` (stop-loss first, per-table
  exposure ceiling, must still `canSit` after paying, no sub-sliver reloads) and
  `canOpenAnotherTable()` + `AGGREGATE_EXPOSURE_MULTIPLE = 3`.
- `HorseSessionRotator.ts` — added `club_id` to the seat select, loaded `rolls`
  from `club_members` and `investedBySeat` from `chip_ledger`, capped the top-up
  by `topUpAllowance`, and made the session exit **certain** (not probabilistic)
  when `sessionVerdict` fires on real P&L (`stack - invested`).

**Verified.** tsc clean both roots; services 626/56 files, engine 1,502/133
files; **six mutations caught**, including one that would have silently disabled
the cap (`club_id` missing from the seat select).

**Status: LIVE IN MAIN. Not reverted.**

### 7.2 WORKSTREAM B — The dead minting path (migration APPLIED, **LIVE**)

`atomic_seat_horse` debited `public.wallets` and inserted a `table_seats` row.
CLAUDE.md 11.5 ends: _"If you find a money path writing to it, that path is
broken."_

**Evidence it was dead:** no TypeScript caller (the fleet seats through
`atomic_table_buyin`); no DB caller (its only mention is its own name inside the
`guard_wallet_balance_write` allowlist — a string, not a call); **no anon or
authenticated EXECUTE grant**; **zero rows in 30 days** matching its audit
signature (`wallet_transactions.description LIKE 'Buy-in at %'`).

**Applied:** migration `20260831104745` /
`20260831_retire_atomic_seat_horse_the_dead_minting_path`. Both facts are
re-asserted at apply time in `DO $$ … RAISE EXCEPTION $$` blocks; the full
original body is pasted as a commented ROLLBACK. The allowlist entry was
**deliberately left alone** — editing `guard_wallet_balance_write` means
touching the trigger that protects every wallet write, and an allowlist naming a
function that no longer exists is inert.

**Post-apply verified:** `atomic_seat_horse` count = 0, `atomic_table_buyin`
intact, 383 seats still open at the time.

> ⚠️ **The migration FILE is not in `main`** — it was reverted with #2143 as
> part of that PR's diff. **The database change stands.** The file must be
> re-added (section 20, Critical #2) so the repo matches production.

### 7.3 WORKSTREAM C — Six extensions (PRs #2118 + #2128, MERGED then **REVERTED**)

| Extension                | What it does                                                                                                                                                       | State    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Tournament bankroll gate | `canEnterTournament()`; nit 100 / std 60 / gambler 30 buy-ins; priced on **buy-in + fee**; **freeroll always allowed**                                             | REVERTED |
| Freeroll routing         | Broke horses sorted to the **front** of the freeroll queue; "broke" measured against the cheapest **paid event on the board**, never a constant                    | REVERTED |
| Rebuy decision           | `rebuyDecision()` + `HorseRebuyPolicy.ts`; both engine sites ask _whether_ and _how much_; standard temperament stops in exactly the same place as the old `>= 2`  | REVERTED |
| Aggregate exposure       | `canOpenAnotherTable` wired into the fleet manager; `stack` added to the seat select; exposure updated **immediately** after seating                               | REVERTED |
| Telemetry                | `HorseBankrollTelemetry.ts`, 13 reasons, zero-suppressed; `ladder_exhausted` is a **gauge** (last value wins), written unconditionally so it can fall back to zero | REVERTED |
| Stake descent            | `HorseStakeDescent.ts` — merit as a **ceiling**, bankroll picks beneath, three-threshold hysteresis (enter 25 / leave 17 / return 35)                              | REVERTED |

Also in #2128 and reverted: the rotator's `left_underrolled` exit
(`shouldMoveDown` per seat, at the looser bar), and the deletion of the two
never-called helpers `isBroke` and `bestAffordableGame`.

**All were verified before shipping:** tsc clean both roots; server
**3,078 / 268 files**; client **9,959 / 702 files**; **19 mutations caught**
across the day.

### 7.4 Pins MOVED, not deleted (important for anyone re-landing)

`HorseStakeBands.test.ts` and `HorseBankrollWiring.test.ts` both pinned
`stakeBandAllows(h.id, table.big_blind)` in the candidate filter. The descent PR
**moved** each pin to `resolveStakeBand` while keeping the property it was
really guarding (the band decision happens before the weighted pick; the
bankroll sits _alongside_ the band, not instead of it). **Those pin moves were
reverted with #2128** — `HorseBankrollWiring.test.ts` in `main` is back to
pinning the current shape. Re-landing descent means moving them again.

### 7.5 WORKSTREAM D — THE INCIDENT (PR #2151, MERGED, **LIVE — this is the fix**)

**Timeline (UTC, all measured):**

| Time          | Event                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ~10:50        | #2118 merged                                                                                                                             |
| 11:18:18      | #2128 merged                                                                                                                             |
| **11:21**     | Engine restarts onto a build carrying **both** (restart coalescing). Per-minute hands dip to **25** — the only restart dip of the window |
| **11:20**     | **133 cash seats leave in ONE minute** (normal rotation ≈ 1/min), 132 with chips                                                         |
| 11:20 → 12:15 | **Zero horse cash seats. Zero joins.** Tournaments untouched (522 seats, dealing continuously)                                           |
| 11:31         | #2137 merged (revert of #2128) — **wrong suspect**                                                                                       |
| 11:46         | #2143 merged (revert of #2118)                                                                                                           |
| ~11:50        | **Root cause found**                                                                                                                     |
| 11:57:48      | **#2151 merged — the real fix**                                                                                                          |
| 12:15:03      | **First seat back**                                                                                                                      |
| 12:19         | 30 seats / 21 tables, cash hands dealing                                                                                                 |
| 12:30         | **47 seats / 23 tables, 308 cash hands in 10 min**                                                                                       |

**Root cause — three bugs, and it took all three:**

1. **The gate read the wrong clubs.** Bankrolls are loaded per club from
   `this.clubIds` — the round-robin used when _creating_ tables,
   `[SHARK_CLUB_ID, JAQK_CLUB_ID]` =
   `a41434bb-8d0c-400a-8f0d-e8b3d65afed4`, `a0000000-0000-0000-0000-000000000001`.
   **Every open cash table belongs to `fade0000-0000-0000-0000-000000000001`.**
   Those two clubs own **zero** cash tables. Every lookup
   `bankrolls.get("fade0000-…:<horse>")` missed.
2. **A miss was written as a refusal:** `if (roll === undefined) return false;`
   — refusing on an _unknown_ value, one line below a comment stating that an
   unreadable bankroll must mean _no opinion_.
3. **A third bug had been hiding both** — the `fetchAllRows` `idKey` problem
   (6.9). `bankrollsLoaded` was always false, so **the gate had never once run**.
   PR #2101 correctly fixed it; the gate ran for the first time; 1 and 2 fired.

**Ruled out first, with evidence (each was tested, not assumed):**

- **Not the DB gate** — a probe buy-in through `atomic_table_buyin`, run **inside
  a transaction and rolled back** per CLAUDE.md 11.5, **SUCCEEDED**.
- **Not seat holds** — zero live `notified` waitlist rows, so no `SEAT_RESERVED`.
- **Not the rolls** — median 32,657, minimum above 5,000; all **323** members of
  the table-owning club could afford 1/2.
- **Not table or horse state** — 26 tables open, all 584 horses `available`.
- **Not another PR** — only these two touched `server/**` that day (#2124 and
  #2126 are client-only).

**The fix (#2151):**

1. `const clubIdsToLoad = new Set<string>(this.clubIds);` then add every
   `t.club_id` from the tables being seeded. **Cannot drift** — the clubs read
   are by construction the clubs whose seats are being decided.
2. `if (roll === undefined) { rollUnknown++; return true; }` — **fails open**.
3. A `console.warn` reporting `rollUnknown` per cycle. The silent version of
   that number is what cost forty minutes.
4. The gate **still bites on a known poor roll** — pinned separately.

**New test:** `server/src/services/HorseBankrollGateClubs.test.ts` — 5 pins,
**4 mutations all caught**, including restoring the exact line that emptied the
floor.

**Money:** `fn_unaccounted_seat_exits()` = **0** throughout. 49,104 chips left
the felt; **49,805 credited back**. **Nothing was lost.**

### 7.6 Documentation written

- `docs/changelog/2026-08-31-bankroll-enforcement-reloads-and-booking-wins.md` — IN MAIN
- `docs/changelog/2026-08-31-incident-the-bankroll-gate-emptied-the-cash-floor.md` — IN MAIN (includes the resolution table and an honest account of the wrong-suspect revert)
- `docs/changelog/2026-08-31-bankroll-the-loop-that-closes.md` — **NOT in main** (reverted with #2118)
- This handoff.

---

## 8. Visual and product decisions

**No visual, UI, asset, or design work occurred in this session.** No images
were uploaded, generated, approved, or rejected. No component, breakpoint,
typography, colour, or responsive decision was made or changed.

The one client-side file that shares the name — `src/components/stats/
BankrollTracker.tsx` / `.css` — **was not touched and is unrelated** to this
server-side layer. Do not confuse them.

Section 12 (Asset Ledger) is therefore empty by fact, not by omission.

---

## 9. Functional and architectural decisions

| Area                                                         | Decision                                                                               | State                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------- |
| Bankroll denominated in **buy-ins**, never chips             | A chip figure means nothing across a ladder                                            | ✅ Implemented, live                |
| `referenceBuyIn` = 100bb clamped to table limits             | Pricing off the _minimum_ would let a horse sit games it cannot play at a normal stack | ✅ Live                             |
| Three temperaments, stable per horse id                      | nit 20 / standard 60 / gambler 20                                                      | ✅ Live                             |
| Seating gate: band **and** bankroll must both agree          | Merit says EARNED, bankroll says AFFORDS                                               | ✅ Live                             |
| Buy-in capped at policy share of roll                        | `bankrollBuyIn`; 0 means skip the seat                                                 | ✅ Live                             |
| **Fail open on an unreadable bankroll**                      | The gate decides which games are _sensible_, never which are _possible_                | ✅ Live (the #2151 fix)             |
| Reload held to a **stricter** test than the first seat       | Must still `canSit` after paying; per-table ceiling; stop-loss ends it                 | ✅ Live                             |
| Session exit from **real P&L**, certain not probabilistic    | Booking a win is a decision, not a coin flip                                           | ✅ Live                             |
| Aggregate exposure ≤ 3 single-table shares                   | `canSit` answers the same for table 1 and table 4                                      | ⛔ Built, tested, **reverted**      |
| Tournament bar ≫ cash bar (variance)                         | nit 100 / std 60 / gambler 30, on buy-in **+ fee**                                     | ⛔ Built, tested, **reverted**      |
| **A freeroll is never gated**                                | It is the recovery path; gating it means the loop never closes                         | ⛔ Built, tested, **reverted**      |
| Broke horses to the **front** of the freeroll queue          | Measured against the cheapest **paid event on the board**                              | ⛔ Built, tested, **reverted**      |
| Rebuy = decision + sizing, temperament-driven stop-loss      | Standard lands exactly where the old `>=2` did                                         | ⛔ Built, tested, **reverted**      |
| **Merit is a ceiling, bankroll picks beneath it**            | Never above the earned band; three-threshold hysteresis                                | ⛔ Built, tested, **reverted**      |
| Seated horse stands up when it can no longer afford the game | At the **looser** bar (`shouldMoveDown`, 17) so it finishes what it is doing           | ⛔ Built, tested, **reverted**      |
| Rakeback pays horses                                         | 1,012 / 1,014 payouts                                                                  | ✅ Pre-existing, verified           |
| Hand-history retention asymmetry                             | 7 days, horse-only hands                                                               | 🔒 **Dan's ruling. Do not change.** |
| Rebuys funded from club treasury                             | Horse cannot truly go broke on cash                                                    | ❓ **Unresolved — needs Dan**       |

**Not touched this session and out of scope:** Bomb Pots, Run It Twice,
Insurance, straddles, weighted rake, BBJ, spins, heads-up SNG, lobby filtering,
permissions, union scoping, replays, hand histories, anti-rathole, VPIP
enforcement (except noting horses are subject to nit eviction per 10.5).

---

## 10. Exact current state

Captured 2026-08-31 ~12:35 UTC.

```text
Branch (this worktree):  docs/handoff-bankroll-incident  (branched from origin/main)
Working tree:            CLEAN before this document was written (git status --porcelain = 0 lines)
origin/main HEAD:        fe058a998f  docs(handoff): Crazy Pineapple phases 3 and 4 (#2171)
                         ^ MOVING TARGET. Other agents merge every few minutes. Re-fetch.
Bankroll commits in main: 9e4ba8aa99 docs(incident) (#2172)
                          816bdf9e2f fix(horses): bankroll gate wrong clubs (#2151)
Staged changes:          none
Unstaged changes:        none
Untracked:               none (before this doc)
Dev server (this tree):  NOT running
Other agents' processes: vite + tsc running in OTHER worktrees — do not kill
```

**Type checking (run on `origin/main`, this session):**

- `npx tsc --noEmit -p server` → **rc=0, clean**
- `npx tsc --noEmit` (client) → **rc=0, clean**

**Tests (run on `origin/main`, this session):**

- Server: **273 files, 3,078 tests, ALL PASS**
- Client: **725 files, 10,179 tests, ALL PASS**

**Production (Supabase, measured 12:30 UTC):**

```text
cash_seats               47
cash_tables_live         23
tourney_seats            272
cash_hands_10min         308
all_hands_10min        2,250
unaccounted_exits          0
atomic_seat_horse          0   (dropped, confirmed)
```

**Migration status:** `20260831104745` applied and listed in
`supabase_migrations.schema_migrations`. **The .sql file is NOT in `main`.**

---

## 11. Changed-file ledger

Net effect on `main` after all merges and reverts.

| File                                                                              | Status                   | Purpose                            | What Changed                                                                                                                                                                    | Verified                               | Committed                                        |
| --------------------------------------------------------------------------------- | ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `server/src/services/HorseBankroll.ts`                                            | MODIFIED                 | Core policy arithmetic             | `topUpAllowance`, `canOpenAnotherTable`, `AGGREGATE_EXPOSURE_MULTIPLE` added and kept. `canEnterTournament`, `rebuyDecision`, `tournamentBuyInsToEnter` added then **reverted** | tsc + 25 unit tests                    | ✅ in main                                       |
| `server/src/services/HorseFleetManager.ts`                                        | MODIFIED                 | Seeding cycle                      | **Incident fix:** `clubIdsToLoad` derived from tables; unknown roll fails open; `rollUnknown` counter + warn                                                                    | tsc + 3,078 server tests + 4 mutations | ✅ in main (#2151)                               |
| `server/src/services/HorseSessionRotator.ts`                                      | MODIFIED                 | Reloads + session exit             | `club_id` in seat select; `rolls` + `investedBySeat`; `topUpAllowance` cap; certain `sessionVerdict` exit                                                                       | tsc + 6 mutations                      | ✅ in main (#2073)                               |
| `server/src/services/HorseBankrollGateClubs.test.ts`                              | **NEW**                  | Pins the incident fix              | 5 pins: club derivation, no `this.clubIds` loop, fail-open, loud counter, gate still bites                                                                                      | 4 mutations caught                     | ✅ in main (#2151)                               |
| `server/src/services/HorseBankroll.test.ts`                                       | MODIFIED                 | Unit tests                         | Extended, then partially reverted with #2143                                                                                                                                    | 25 tests pass                          | ✅ in main                                       |
| `server/src/services/HorseBankrollWiring.test.ts`                                 | MODIFIED                 | Source-contract pins               | Pin loosened to match the telemetry-bearing refusal block; the `resolveStakeBand` pin move was **reverted**                                                                     | 11 tests pass                          | ✅ in main                                       |
| `docs/changelog/2026-08-31-bankroll-enforcement-reloads-and-booking-wins.md`      | NEW                      | Changelog                          | Workstream A                                                                                                                                                                    | n/a                                    | ✅ in main                                       |
| `docs/changelog/2026-08-31-incident-the-bankroll-gate-emptied-the-cash-floor.md`  | NEW                      | Incident record                    | Full RCA + resolution                                                                                                                                                           | n/a                                    | ✅ in main (#2172)                               |
| `server/src/services/HorseBankrollTelemetry.ts`                                   | **DELETED by revert**    | 13-reason counters + gauge         | Built, tested                                                                                                                                                                   | 3 mutations                            | ⛔ **not in main**                               |
| `server/src/services/HorseRebuyPolicy.ts`                                         | **DELETED by revert**    | Rebuy decision + sizing            | Built, tested, lazy supabase import                                                                                                                                             | 4 mutations                            | ⛔ **not in main**                               |
| `server/src/services/HorseStakeDescent.ts`                                        | **DELETED by revert**    | Merit-as-ceiling ladder            | Built, tested, 2 self-found bugs fixed                                                                                                                                          | 4 mutations                            | ⛔ **not in main**                               |
| `server/src/services/HorseBankrollLoop.test.ts`                                   | **DELETED by revert**    | 24 pins for the extensions         | Built                                                                                                                                                                           | —                                      | ⛔ **not in main**                               |
| `server/src/services/HorseStakeDescent.test.ts`                                   | **DELETED by revert**    | 13 pins for the ladder             | Built                                                                                                                                                                           | —                                      | ⛔ **not in main**                               |
| `server/src/services/TournamentRecurringService.ts`                               | **REVERTED**             | Tournament gate + freeroll routing | Built                                                                                                                                                                           | —                                      | ⛔ back to original                              |
| `server/src/engine/ServerTableEngineSettlement.ts`                                | **REVERTED**             | Rebuy site 1                       | Built                                                                                                                                                                           | —                                      | ⛔ back to original                              |
| `server/src/engine/ServerTableEngineDealing.ts`                                   | **REVERTED**             | Rebuy site 2                       | Built                                                                                                                                                                           | —                                      | ⛔ back to original                              |
| `supabase/migrations/20260831_retire_atomic_seat_horse_the_dead_minting_path.sql` | **REVERTED (file only)** | Drops the dead function            | **DB CHANGE IS APPLIED AND STANDS**                                                                                                                                             | post-apply asserted                    | ⛔ **file missing from main — MUST BE RE-ADDED** |
| `docs/changelog/2026-08-31-bankroll-the-loop-that-closes.md`                      | **REVERTED**             | Changelog for the extensions       | Written                                                                                                                                                                         | n/a                                    | ⛔ not in main                                   |

### Recovering the reverted work

Every reverted file is intact in git history. Local branches in this worktree:

```text
feat/bankroll-close-the-loop     (local + remote)  — extensions
feat/stake-descent-ladder        (local only)      — descent + rotator exit + deletions
```

Merged commits in history: `6eae5e2b90` (#2118), `ef1f656003` (#2128).
Recover with `git show <sha>:<path>` or `git cherry-pick`.

**No unrelated user changes exist in this worktree.** It was clean.

---

## 12. Asset ledger

**EMPTY BY FACT.** No visual assets, reference images, icons, frames, headers,
footers, logos, or mockups were uploaded, created, approved, rejected, or
implemented in this session. This was entirely server-side TypeScript + SQL.

---

## 13. Commands and tools used

All from `~/Documents/.agent-trees/club-arena/cowork-fable` unless noted.

| Command                                                         | Purpose                       | Result                  | Changed files              | Rerun?                   |
| --------------------------------------------------------------- | ----------------------------- | ----------------------- | -------------------------- | ------------------------ |
| `npx tsc --noEmit -p server`                                    | Server type check             | rc=0 clean              | no                         | Yes, before every commit |
| `npx tsc --noEmit`                                              | Client type check             | rc=0 clean              | no                         | Yes                      |
| `cd server && npx vitest run --silent`                          | Server suite                  | 273 files / 3,078 pass  | no                         | Yes                      |
| `npx vitest run tests/ --silent`                                | Client suite                  | 725 files / 10,179 pass | no                         | Yes                      |
| `npx vitest run src/services/<file>.test.ts`                    | Single suite (from `server/`) | pass                    | no                         | As needed                |
| `git checkout -q -B <branch> origin/main`                       | Branch from fresh main        | ok                      | yes (worktree)             | —                        |
| `git revert --no-edit <sha>`                                    | Emergency reverts             | ok                      | yes                        | **No**                   |
| `gh pr create --body-file /tmp/pr.md`                           | Open PR                       | ok                      | no                         | —                        |
| `gh api repos/.../actions/runs/<id>/jobs`                       | Watch CI + deploy steps       | ok                      | no                         | Yes                      |
| `gh run list --workflow=auto-deploy-hetzner.yml`                | Deploy status                 | ok                      | no                         | Yes                      |
| Supabase MCP `execute_sql`                                      | All production diagnosis      | ok                      | read-only except the probe | Yes                      |
| Supabase MCP `apply_migration`                                  | Dropped `atomic_seat_horse`   | success                 | **yes, production DB**     | **No**                   |
| Mutation harness (inline bash: copy → patch → vitest → restore) | Prove pins bite               | 19 + 4 caught           | temporarily                | Yes when adding pins     |

⚠️ **The mutation harness stranded a mutation once** when the shell connection
dropped mid-loop (section 15.2). Run mutations **one at a time**, and verify a
clean baseline afterwards.

⚠️ **GitHub API rate limit was hit once** (`HTTP 403 … rate limit exceeded`).
Fall back to Supabase for verification — which CLAUDE.md prefers anyway.

---

## 14. Verification and test results

| Verification                   | Command or method                                     | Result                                      | Phase                            | Follow-up                             |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------- | -------------------------------- | ------------------------------------- |
| Server type check              | `npx tsc --noEmit -p server`                          | **PASS** rc=0                               | On `origin/main`, end of session | —                                     |
| Client type check              | `npx tsc --noEmit`                                    | **PASS** rc=0                               | Same                             | —                                     |
| Server unit/integration        | `vitest run` in `server/`                             | **PASS** 273 files / 3,078                  | Same                             | —                                     |
| Client unit                    | `vitest run tests/`                                   | **PASS** 725 files / 10,179                 | Same                             | —                                     |
| Mutation testing, extensions   | Inline harness                                        | **19 mutations, all caught**                | Before #2118/#2128               | Re-run on re-land                     |
| Mutation testing, incident fix | Inline harness                                        | **4 mutations, all caught**                 | Before #2151                     | —                                     |
| Money-path probe               | `atomic_table_buyin` in a **rolled-back** transaction | **SUCCEEDED** — DB was never the blocker    | During incident                  | —                                     |
| Chip conservation              | `fn_unaccounted_seat_exits()`                         | **0** throughout                            | Continuous                       | Re-check after any seat work          |
| Chip return                    | `chip_transactions` cashout sum                       | 49,104 out / **49,805 back**                | During incident                  | —                                     |
| Migration post-apply           | `pg_proc` count for `atomic_seat_horse`               | **0** — dropped                             | After apply                      | —                                     |
| Live-path integrity            | `atomic_table_buyin` still present                    | **1**                                       | After apply                      | —                                     |
| Floor recovery                 | `table_seats` + `hand_history`                        | 0 → 21 → 30 → **47 seats / 23 tables**      | 12:15–12:30                      | —                                     |
| Restart resilience             | Floor drained at 12:22, refilled by 12:24             | **PASS**                                    | 12:24                            | —                                     |
| CI on the fix                  | GitHub Actions, PR #2151                              | Stub Gate ✅ TypeScript ✅ Server Engine ✅ | 11:57                            | —                                     |
| Rollback of the migration      | —                                                     | **NEVER TESTED**                            | —                                | ROLLBACK SQL is pasted but unexecuted |

### Explicitly NOT run

- ESLint / any linter — **never run this session. UNKNOWN.**
- Production build (`npm run build`) — not run locally; CI's "Production Build"
  job was **skipped** by the `changes` gate (server-only diffs). **UNVERIFIED.**
- Client E2E / CSS Beat E2E — **skipped** by the same gate. **UNVERIFIED.**
- Any browser or visual verification — none. No UI changed.
- Accessibility, responsive, performance testing — **not applicable, not run.**
- The reverted extensions have **no CI run on current `main`**; they were green
  against an older main and must be re-verified on re-land.

---

## 15. Setbacks, failed approaches, and lessons

### 15.1 The wrong-suspect revert — the biggest process failure

Two reverts were shipped before the cause was known. The first (#2137) reverted
the **newest** PR on the assumption that the newest change is the culprit. It
was wrong, because `MIN_RESTART_SPACING_SEC=1200` had coalesced **both** PRs
into the **same** restart — the "healthy half hour" after #2118 merged was still
running the **old binary**. **A merge time is not a deploy time.**
**Lesson: before reverting, establish when the engine last restarted** (a dip in
per-minute `hand_history`), and revert to the last binary that was _actually
running_, not the last commit that merged.

### 15.2 The mutation harness stranded a mutation

The shell connection dropped mid-loop and left one mutation applied
(`horseExposure.set(...)` deleted). It was caught because the next test run went
red, but it could have been committed. **Lesson: run mutations one at a time,
and check `git diff` before committing after any mutation session.**

### 15.3 Three tests passed for the wrong reason

- A wiring pin passed with the call short-circuited behind `false &&` — it only
  asserted the function _appeared_ in the file.
- A `rebuyDecision` test used a roll small enough that the sizing arithmetic
  returned 0 on its own, so it stayed green with the rule deleted. Fixed by
  choosing the **discriminating** value (2,000, where the 5% share clears the 80
  minimum but the sit bar still refuses).
- `sliceEnclosingBlock` was too coarse: the innermost block containing the
  aggregate guard **also** held the `capped <= 0` refusal, so its `continue`
  satisfied the assertion with the guarded one deleted.
  **Lesson: a pin you have not seen fail is theatre. Mutate every new pin.**

### 15.4 The repo's own guard caught me

`tests/unit/noFixedSizeSourceWindows.test.ts` failed my first draft because I
used `.slice(guard, guard + 700)`. Replaced with an adjacency regex.

### 15.5 Two bugs my own tests found before shipping

- **Empty ladder:** with nothing priceable, the descent loop fell through every
  band and landed on the cheapest — a cycle where the table read came back empty
  would have re-banded the **entire fleet** to `micro`, and the latch would have
  persisted it. An empty ladder is an _unknown_, not a verdict.
- **Merit demotion:** a horse that had descended `high`→`mid` carries `mid` in
  the latch; if merit demotes it to `low`, the latch must lose or the horse
  plays above its earned band.

### 15.6 A false alarm I caught before reporting

I initially believed `atomic_seat_horse` was a **live** chip-printing loop
(buy-in from the dead pool, cash-out into the live pool). Further inspection
showed the fleet seats through `atomic_table_buyin`, which is correct, and that
`atomic_seat_horse` had **zero writes in 30 days**. **Lesson: verify the caller
before reporting a money leak.**

### 15.7 Python-patching source files is fragile

A greedy index-based cut removed `sessionVerdict` along with its neighbours.
Recovered with `git checkout <file>`. **Lesson: cut by line numbers you have
just printed, assert the removed segment does NOT contain what you meant to
keep, and re-run tsc immediately.**

### 15.8 Tool/environment limitations

- `mcp__counselors__host_terminal` times out around ~4–5 minutes; long
  `sleep`+poll loops fail. Poll in short bursts.
- `list_migrations` output exceeds the token cap — query
  `supabase_migrations.schema_migrations` directly instead.
- `pg_get_functiondef` over all of `pg_proc` errors on PostGIS aggregates —
  filter `prokind='f'` and `prolang = plpgsql`.
- The Read tool cannot reach this worktree (outside connected folders); use
  `host_terminal` + `sed`/`grep` for file inspection here.

---

## 16. Known defects and architectural holes

| Priority | Defect / hole                                                            | Evidence                                                                                                 | Impact                                                                                                                                        | Recommended fix                                                                                             | Status                               |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **P0**   | Migration `.sql` file missing from `main` while the DB change is applied | `git ls-tree origin/main` finds no `atomic_seat_horse` migration; DB shows `atomic_seat_horse` count 0   | Repo no longer describes production. A fresh environment rebuilt from migrations would re-create a chip-minting function                      | Re-add the file exactly as applied (body preserved in `.agent/handoffs` history and in commit `6eae5e2b90`) | **OPEN**                             |
| **P0**   | 175 of 584 horses banded into stakes with **no open table**              | Live query: micro 127 (all micro tables closed), high 48 (nothing above 2/5)                             | 30% of the fleet cannot sit any cash game                                                                                                     | Micro relaunch (Dan) rescues 127; re-land stake descent rescues 48                                          | **OPEN**                             |
| **P1**   | Horses cannot truly go broke on cash                                     | `fn_horse_fund_from_treasury` credits the seat from `clubs.chip_treasury`, never debits the horse wallet | The "run out → freerolls → rakeback" loop Dan asked for is unreachable on cash                                                                | **Needs Dan's ruling** — money path + conservation change                                                   | **OPEN, BLOCKED**                    |
| **P1**   | Tournament entry has solvency, not discipline                            | `fn_register_horse_for_tournament` refuses only `insufficient_balance`                                   | A 1,000-chip horse can enter a 950 event                                                                                                      | Re-land `canEnterTournament`                                                                                | **OPEN (built, reverted)**           |
| **P1**   | Broke horses are not routed to freerolls                                 | Nothing prefers a broke horse; the hourly rotation picks by id                                           | Recovery loop does not close                                                                                                                  | Re-land freeroll routing                                                                                    | **OPEN (built, reverted)**           |
| **P1**   | Rebuy ignores table limits and the roll                                  | `rebuyAmount = big_blind * 100` at both engine sites                                                     | Reloads a game the horse cannot afford, at a stack the table may not permit                                                                   | Re-land `HorseRebuyPolicy`                                                                                  | **OPEN (built, reverted)**           |
| **P2**   | Aggregate cross-table exposure uncapped                                  | `canSit` answers identically for table 1 and table 4                                                     | Latent today (floor runs ~1–2 tables/horse); binds when micros widen the floor                                                                | Re-land `canOpenAnotherTable` wiring                                                                        | **OPEN (built, reverted)**           |
| **P2**   | No bankroll telemetry                                                    | Every refusal is silent; a refusal and an outage look identical                                          | This is _precisely_ what made the outage take 30 min to diagnose                                                                              | Re-land `HorseBankrollTelemetry` **first**                                                                  | **OPEN (built, reverted)**           |
| **P2**   | 261 horses now fail open at seating                                      | 584 total − 323 members of the cash club                                                                 | Behaviour change: they may now be seated where the old code refused. Correct (the RPC still refuses anyone who cannot pay) but **unmeasured** | Watch `rollUnknown` in engine logs; consider onboarding them into the cash club                             | **OPEN, needs observation**          |
| **P2**   | `bestAffordableGame` + `isBroke` are dead code in `main`                 | 0 production callers (verified by grep on `origin/main`)                                                 | Dead-but-tested code reads as working machinery — exactly how the outage hid                                                                  | Delete on re-land (was done, then reverted)                                                                 | **OPEN**                             |
| **P3**   | Drain gate can defer an emergency deploy indefinitely                    | Held one deploy ~6 min; a busy tournament floor never reaches 0 hands in flight                          | Slow incident recovery                                                                                                                        | Consider a bounded wait with an escape hatch — **design discussion, not a fix**                             | **OPEN**                             |
| **P3**   | Deploy runs cancel each other                                            | 3 consecutive deploys cancelled by newer merges                                                          | A fix can sit behind other agents' traffic                                                                                                    | Concurrency-group review                                                                                    | **OPEN**                             |
| ?        | Lint never run                                                           | No lint command executed this session                                                                    | Unknown lint debt on changed files                                                                                                            | Run the repo's lint task                                                                                    | **UNKNOWN, NEXT AGENT MUST INSPECT** |

---

## 17. Security, secrets, and credentials

**No secret values were read, printed, or handled during this session.**

| Name                                                  | Where configured              | Used by                                           | Available?                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`                           | Hetzner env; local `.env`     | Engine (`server/src/services/supabase/client.ts`) | Present in prod (engine running). **Absent in the local test shell** — module-scope import of the client aborts; use dynamic import in testable modules |
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | `~/Documents/club-arena/.env` | Build/sync                                        | UNVERIFIED                                                                                                                                              |
| `GH_PAT`                                              | Local `gh` auth               | PRs, CI reads                                     | Present; **hit the API rate limit once**                                                                                                                |
| Supabase project ref `kuklfnapbkmacvwxktbh`           | —                             | MCP + engine                                      | Not a secret; identifier only                                                                                                                           |
| Hetzner SSH key                                       | GitHub Actions secret         | `auto-deploy-hetzner.yml`                         | Present (deploys succeeded)                                                                                                                             |

**No secret exposure occurred.** `AGENT-PLAYBOOK.md` documents where every
credential lives (the place, never the value).

**One security-relevant check performed:** `atomic_seat_horse` had **no anon or
authenticated EXECUTE grant** before it was dropped — it was not reachable from
a browser.

---

## 18. Database, migration, and seed status

- **Provider:** Supabase Postgres, ref `kuklfnapbkmacvwxktbh`.
- **Migration applied this session:** version `20260831104745`, name
  `20260831_retire_atomic_seat_horse_the_dead_minting_path`. Confirmed present
  in `supabase_migrations.schema_migrations`.
  - **Type:** Tier 3 (DROP FUNCTION).
  - **Pre-flight assertions:** aborts if any plpgsql function actually calls
    `atomic_seat_horse(`, or if `wallet_transactions.description LIKE 'Buy-in at %'`
    has any row in 30 days.
  - **Post-apply assertion:** raises if the function still exists. **Passed.**
  - **ROLLBACK:** full original body pasted as a comment. **NEVER EXECUTED —
    rollback is untested.**
- **No schema changes.** No tables, columns, constraints, indexes, RLS policies,
  or permissions were added or altered.
- **No seeds** were written or run.
- **Tables read (read-only):** `tables`, `table_seats`, `club_members`,
  `profiles`, `clubs`, `hand_history`, `chip_transactions`,
  `wallet_transactions`, `tournaments`, `tournament_players`, `table_waitlist`,
  `ca_seat_stack_exits`, `supabase_migrations.schema_migrations`, `pg_proc`,
  `information_schema.routine_privileges`.
- **The one write outside the migration:** the `atomic_table_buyin` probe, run
  **inside a `DO $$` block that raises at the end**, discarding every side
  effect. No chips moved. This follows CLAUDE.md 11.5 rule 1 exactly.
- **Production-data risk:** none identified. `fn_unaccounted_seat_exits()` = 0.
- **Local vs remote DB:** all work was against **production**. No local database
  was used. **No backup was taken** — the drop is reversible via the pasted
  ROLLBACK, and the function was provably dead.

---

## 19. Current blockers and decision points

### BLOCKER 1 — Treasury-funded rebuys (**requires Dan**)

- **Blocked:** the whole "run out of chips → play freerolls → wait for rakeback"
  loop, on cash games.
- **Why:** `autoRebuyHorse` → `fn_horse_fund_from_treasury` credits the seat from
  `clubs.chip_treasury` and never debits the horse's own `club_members.chip_balance`.
  A horse's wallet only shrinks when it _buys in_, never when it _busts_.
- **Evidence:** function body read from `pg_get_functiondef`; 0 treasury-funding
  rows in the last 7 days, so the path is currently quiet.
- **Type:** business + money path + chip conservation. **Not an agent's call.**
- **Options:**
  1. **Leave as is.** Zero risk. The recovery loop stays partly decorative on
     cash; freerolls still matter for tournament-lane horses.
  2. **Debit the horse's wallet for rebuys** (treasury still supplies the chips,
     wallet is reduced). Makes bust real. **Changes chip conservation** — needs a
     reconciliation review.
  3. **Cap treasury rebuys per horse per period.** Middle ground, still a money
     path change.
- **Recommended:** ask Dan. If he wants the loop to bite, option 2 with a
  conservation audit. **Do not implement any of these without his word.**

### BLOCKER 2 — Micro-game relaunch timing (**Dan's operational action**)

127 micro-banded horses cannot sit anywhere until micro tables reopen. Nothing
an agent can do; descent cannot rescue them because micro is the bottom rung.

### DECISION POINT 3 — Re-land order and pace (**agent may decide**)

Recommended: telemetry **first** (so the next problem is visible), then one
extension per PR with a live-floor check between each. See section 21.

### DECISION POINT 4 — The 261 fail-open horses (**needs observation, maybe Dan**)

261 horses have no membership in the cash-table-owning club and are now seated
under the fail-open rule. Correct, but it means the bankroll gate does not
constrain them at all. Options: onboard them into that club (data change), or
accept that `atomic_table_buyin` is their only gate. **Measure `rollUnknown`
first.**

---

## 20. Remaining work

### Critical

1. **Verify the floor is still healthy** before anything else (Phase 0).
2. **Re-add the `atomic_seat_horse` migration file** so the repo matches the DB.
3. **Re-land bankroll telemetry** — everything else is harder to verify without it.

### High priority

4. Re-land the **tournament bankroll gate** (`canEnterTournament`).
5. Re-land **freeroll routing** for broke horses.
6. Re-land the **rebuy decision** (`HorseRebuyPolicy`, both engine sites).
7. Re-land **stake descent** (`HorseStakeDescent`) — rescues the 48 `high` horses.
8. Re-land the rotator's **`left_underrolled`** exit.

### Medium priority

9. Re-land **aggregate exposure** wiring.
10. Delete the dead `isBroke` / `bestAffordableGame` again.
11. **Measure `rollUnknown`** in engine logs and decide on the 261 horses.
12. Run **lint** on all changed files (never run — unknown state).
13. Verify the **production build** and the **client E2E** suites, which CI
    skipped on server-only diffs.

### Low priority

14. Move-up / move-down telemetry dashboards.
15. Re-calibrate the ladder once the micro stakes are actually open.
16. Consider a bounded drain gate for emergency deploys.

### Optional enhancement

17. Per-club bankroll views for Dan's admin UI.
18. A `p_include_horses`-style report of bankroll health per band (**must default
    to true**, per 10.5).

---

## 21. Prioritized next-phase execution plan

### Phase 0 — Recover and verify current state (do this first, ~5 min)

**Objective:** confirm the floor is healthy and nothing regressed since 12:30 UTC.
**Prereqs:** none.
**Steps:** run the section 22 checklist.
**Completion:** cash seats > 0 and rising; `fn_unaccounted_seat_exits()` = 0;
server + client suites green; tsc clean.
**Risk:** if the floor is at 0 again, **stop and diagnose** — do not re-land
anything. Re-read section 7.5 for the diagnosis order that worked.

### Phase 1 — Protect completed work (~10 min)

**Objective:** stop the reverted work from being lost, and make the repo match
the DB.
**Actions:**

- Push `feat/stake-descent-ladder` to origin (local only today) so it survives
  this machine.
- Re-add `supabase/migrations/20260831_retire_atomic_seat_horse_the_dead_minting_path.sql`
  exactly as applied (recover from `git show 6eae5e2b90:supabase/migrations/...`).
  **Tests:** tsc + server suite.
  **Completion:** migration file in `main`; both feature branches on origin.
  **Commit:** `chore(migrations): restore the atomic_seat_horse retirement file reverted with #2143`

### Phase 2 — Re-land telemetry (visibility before behaviour)

**Objective:** make every bankroll refusal countable before adding more refusals.
**Inspect:** `git show ef1f656003:server/src/services/HorseBankrollTelemetry.ts`.
**Changes:** restore the module; wire `bankrollEvent` into the fleet manager's
existing refusal points and the `rollUnknown` counter; keep the gauge semantics
(`ladder_exhausted` last-value-wins, written unconditionally).
**Tests:** restore the telemetry pins from `HorseBankrollLoop.test.ts`; mutate
the gauge accumulation and the unconditional write.
**Completion:** a `[Bankroll]` line appears in engine logs within one seeding
cycle; floor unchanged after deploy.
**Risk:** low — counters only. **Checkpoint: watch the floor for 10 minutes.**

### Phase 3 — Re-land the tournament gate + freeroll routing

**Objective:** discipline on entry, and close the recovery loop.
**Inspect:** `TournamentRecurringService.ts` `registerHorses()`;
`git show 6eae5e2b90` for the original diff.
**Changes:** `canEnterTournament` + `tournamentBuyInsToEnter` in
`HorseBankroll.ts`; the club-scoped bankroll read and the pool filter; freeroll
"broke first" ordering measured against the cheapest **paid** event.
**Tests:** the tournament pins from `HorseBankrollLoop.test.ts`; mutate the gate
and the reorder.
**Completion:** tournaments still fill (they should — 100% of the fleet qualifies
at every scheduled tier); `tournament_refused_underrolled` visible only where
expected.
**Risk:** medium — could starve a big event. **Verify field sizes for one full
tournament cycle before proceeding.**

### Phase 4 — Re-land the rebuy decision

**Objective:** a busted horse decides whether and how much, not just "not twice yet".
**Inspect:** both engine sites; `HorseRebuyPolicy.ts` from `6eae5e2b90`.
**Critical:** keep the **lazy** `await import('./supabase/wallets.js')` — a
static import makes the module untestable without production secrets.
**Tests:** both wiring pins (`rebuyAmount > 0 && (await autoRebuyHorse(`) plus
the `rebuyDecision` unit tests with the **discriminating** roll of 2,000.
**Completion:** rebuys still happen at normal rates; no table stalls.
**Risk:** medium — touches the live hand loop. **Timing must not change**
(CLAUDE.md 10.5): the five-second window is upstream and must stay.

### Phase 5 — Re-land stake descent + the rotator exit

**Objective:** rescue the 48 `high` horses; make "move down as the roll shrinks" real.
**Inspect:** `HorseStakeDescent.ts` from `ef1f656003`. **Keep both self-found
bug fixes** — the `anyPriced` empty-ladder guard and the `here > home` merit
clamp.
**Changes:** replace the exact-match band filter; build `bandRef` per cycle;
**move** the two pins in `HorseStakeBands.test.ts` and `HorseBankrollWiring.test.ts`
again (section 7.4).
**Tests:** all 13 descent pins + 4 mutations.
**Completion:** query `table_seats` joined to band — **`seated_below_band > 0`**
is the behavioural proof descent is live (it was 0 of 129 before).
**Risk:** **HIGHEST of the re-lands** — this is the PR that was live when the
floor died (though it was not the cause). Deploy alone; watch for a full 20
minutes.

### Phase 6 — Re-land aggregate exposure + delete dead helpers

**Objective:** cap total chips on the felt; remove `isBroke` / `bestAffordableGame`.
**Critical:** `stack` must be in the seat select, and the exposure map must be
updated **immediately after** a successful seat.
**Tests:** the three aggregate pins + mutations.
**Risk:** low today (1–2 tables per horse); becomes real when micros open.

### Phase 7 — Production hardening

Run lint; verify the production build and client E2E that CI skipped; measure
`rollUnknown`; decide on the 261 horses; re-calibrate the ladder against the
actually-open micro stakes.

### Phase 8 — Deploy verification (every phase)

After each merge: confirm the deploy **ran** (`gh run list --workflow=auto-deploy-hetzner.yml`),
confirm a **restart dip** in per-minute `hand_history`, then confirm cash seats
recover. **Never** trust the health endpoint.

---

## 22. Exact first actions for the next agent

```text
1. cd /Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-fable
   (main is checked out at ~/Documents/club-arena — you CANNOT check out main here)

2. Read, in order:
     AGENT-PLAYBOOK.md
     CLAUDE.md                (sections 5, 10, 10.5, 10.6, 11.5, 12)
     .agent/handoffs/2026-08-31-horse-bankroll-and-cash-floor-incident.md   (this file)
     docs/changelog/2026-08-31-incident-the-bankroll-gate-emptied-the-cash-floor.md

3. git fetch origin main && git status --short --branch
   git log --oneline -5 origin/main
   git checkout -B <your-branch> origin/main

4. Confirm the floor is ALIVE (Supabase MCP):
     select
       (select count(*) from table_seats ts join tables t on t.id=ts.table_id
         where ts.left_at is null and t.tournament_id is null) as cash_seats,
       (select count(*) from table_seats ts join tables t on t.id=ts.table_id
         where t.tournament_id is null and ts.joined_at > now()-interval '5 minutes') as joins_5min,
       (select count(*) from fn_unaccounted_seat_exits()) as unaccounted;
   EXPECT cash_seats > 0, joins_5min > 0, unaccounted = 0.
   IF cash_seats = 0 -> STOP. Diagnose using section 7.5. Do not re-land anything.

5. Confirm the build is clean:
     npx tsc --noEmit -p server        # expect rc=0
     npx tsc --noEmit                  # expect rc=0
     cd server && npx vitest run --silent   # expect 3,078+ passing
     cd .. && npx vitest run tests/ --silent # expect 10,179+ passing

6. DO NOT:
     - edit AGENT-PLAYBOOK.md (byte-identical across 7 repos, hourly integrity check)
     - append to MIGRATION-CHANGELOG.md (frozen)
     - touch other agents' worktrees or kill their vite/tsc processes
     - re-introduce `for (const clubId of this.clubIds)` in the bankroll loader
     - change `if (roll === undefined)` back to `return false`
     - alter hand-history retention (Dan's ruling)
     - implement any treasury-rebuy change without Dan's word

7. RESUME AT: Phase 1 of section 21 — push feat/stake-descent-ladder to origin,
   then re-add the atomic_seat_horse migration file.
```

---

## 23. Acceptance criteria

The bankroll layer is **done** when all of the following are observably true.

**Functional**

- A horse never sits a game its policy cannot afford (`canSit`), and never above
  its earned band.
- A horse **moves down** a stake when its roll shrinks and **back up** only at
  the stricter bar; verified by `seated_below_band > 0` in the band query.
- A broke horse enters freerolls **ahead of** solvent horses.
- A horse refuses a tournament it cannot bankroll; a freeroll is **never** refused.
- A busted horse reloads only inside its stop-loss and only what the table and
  its share allow.
- Total chips on the felt per horse ≤ 3 single-table shares.

**Data / financial**

- `fn_unaccounted_seat_exits()` returns **0** at all times.
- `chip_ledger` / `chip_transactions` reconcile; no pool other than
  `club_members.chip_balance` is written by any live cash path.
- The repo's migrations, replayed from scratch, produce the production schema
  (i.e. the `atomic_seat_horse` retirement file is present).

**Operational**

- The cash floor holds a stable seat count across an engine restart
  (drain → refill within ~3 minutes).
- `[Bankroll]` telemetry prints a non-zero reason line only when something
  genuinely refused, and `ladder_exhausted` falls back to 0 once micros are open.

**Quality**

- `npx tsc --noEmit` and `npx tsc --noEmit -p server` both rc=0.
- Server and client suites fully green.
- **Every new pin has been mutated and seen to fail.**
- Lint passes (**currently unknown — must be established**).

**Process**

- Working tree clean; every change on `main` via PR; no direct pushes.
- A `docs/changelog/YYYY-MM-DD-<slug>.md` per change.
- Deploy verified through the database, never the health endpoint.

**Not applicable to this workstream:** visual fidelity, responsive behaviour,
accessibility, desktop/mobile preservation. No UI was touched.

---

## 24. Recommended commit strategy

One workstream per PR. Never mix.

| #   | Suggested message                                                                             | Includes                                                           | Tests required before commit                                      |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | `chore(migrations): restore the atomic_seat_horse retirement file reverted with #2143`        | the `.sql` file only                                               | tsc; note the DB change is already applied                        |
| 2   | `feat(horses): bankroll telemetry - say WHY a seat was refused`                               | `HorseBankrollTelemetry.ts`, fleet-manager call sites, pins        | server suite + gauge/unconditional-write mutations                |
| 3   | `feat(horses): tournaments are priced in buy-ins, and a broke horse leads the freeroll queue` | `canEnterTournament`, `TournamentRecurringService.ts`, pins        | server suite + gate/reorder mutations + one live tournament cycle |
| 4   | `feat(horses): the rebuy is a decision, not a reflex`                                         | `HorseRebuyPolicy.ts` (lazy import), both engine sites, pins       | server suite + both wiring mutations                              |
| 5   | `feat(horses): merit is a ceiling, the roll picks beneath it`                                 | `HorseStakeDescent.ts`, fleet-manager filter, **two moved pins**   | server suite + 13 pins + 4 mutations; deploy alone                |
| 6   | `feat(horses): cap what is on the felt at once, and delete the last unwired helpers`          | aggregate exposure wiring, `isBroke`/`bestAffordableGame` deletion | server suite + 3 mutations                                        |
| 7   | `docs(changelog): the bankroll loop, re-landed`                                               | changelog                                                          | none                                                              |

---

## 25. Final continuation summary

**Exact stopping point.** `origin/main` carries the working bankroll core (seating
gate with the club-derivation fix and fail-open behaviour, reload cap, session
exit) plus the incident fix and its 5 pins. Production is healthy: **47 horse
cash seats across 23 tables, 308 cash hands in 10 minutes, 0 unaccounted seat
exits**, verified 12:30 UTC. Both type checks are clean and both suites are
fully green on `main`. Six built-and-tested extensions are reverted and waiting
in `feat/bankroll-close-the-loop` and `feat/stake-descent-ladder`.

**Work on first.** Phase 0 (verify the floor), then Phase 1 (push the local-only
branch to origin; re-add the migration file), then Phase 2 (telemetry).

**Most important locked requirements.** Horses are players — never excluded,
never given different timing (10.5). Animations always play (10.6). Never
auto-change tables (10.6). Probe money paths only inside a rolled-back
transaction (11.5). Never rebase main (12). Never push a red test (5.8).

**Greatest technical risk.** Re-landing stake descent — it was live during the
outage (though not its cause), and it is the change that most alters who sits
where. Deploy it alone and watch a full 20 minutes.

**Greatest visual risk.** None. No UI was touched in this workstream.

**Greatest data-integrity risk.** The migration file missing from `main` while
the DB change is applied. A fresh environment rebuilt from migrations would
re-create a function that mints chips out of the frozen `public.wallets` pool.
Fix this in Phase 1.

**Decision that still requires Dan.** Whether a horse's own wallet should be
debited for cash rebuys. Today the club treasury funds them, so a horse cannot
truly go broke on cash and the freeroll-and-rakeback recovery loop he described
is unreachable there. It is a money path and a chip-conservation change; it is
not an agent's call.

**How to continue without restarting discovery.** Everything learned is in this
document: the two chip pools and which is real (6.1), the exact money-path table
(6.1), the merit-vs-bankroll split (6.2), live fleet numbers (6.3), the policy
table (6.4), the priced ladder (6.5), the full incident RCA with the three
interacting bugs (7.5), the test-infrastructure traps (6.12), the deploy
mechanics that shape incident response (6.13), and every failed approach (15).
Read sections 5, 6, 7.5, 15 and 22, run the Phase 0 checklist, and begin at
Phase 1. Do not re-audit the money paths — they are recorded here with the
function bodies they were read from.
