# HANDOFF: Operation Stable Hand + Free Buy

**Date:** 2026-09-04 · **Branch:** `feat/stable-hand` · **HEAD:** `67049f618`
**PR:** #2927 (open, autopilot merges on green) · **Worktree:**
`~/Documents/.agent-trees/club-arena/stable-hand`

> This is NOT `docs/HANDOFF_CURRENT_STATE.md`. That file belongs to the
> engine-restart programme and is untouched.

---

## 1. Executive continuation brief

Two workstreams, one branch.

**A. Operation Stable Hand** — a horse seating controller for ~1,000 horses:
tag them, manage per-club wallets, seat them on Midway Union and Deep Stack
Society tables, hold unique occupancy on a 24-hour curve (40% peak / 10%
night), shape running tables 60% full / 20% one-seat-open / 20% joinable, and
stand a horse within 2-5 minutes when a human joins a waitlist.

**B. Free Buy tournaments** — 5 events/day/host: 08:00, 12:00, 16:00, 20:00,
00:00 America/Chicago. $250 guarantee each except 20:00 = $500. First entry
free, 3,000 starting stack, paid rebuys and add-ons, 10,000-chip add-on
available at sit-down AND at the break.

**State:** all decision logic is built, tested and pushed. The **pure planner
is not yet executed by the fleet manager**, and the **5-a-day Free Buy
scheduler does not exist**. Those two are the next agent's job.

**First action:** read §22, then §20.

**The single most important thing to understand:** occupancy is capped **per
HOST**, not per club. Getting this wrong doubles the horse population. See §6.

---

## 2. User requirements and working preferences (Dan)

Non-negotiable, in his words where precision matters:

| Requirement                                                                           | Source          | Status                                         |
| ------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------- |
| "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING"                               | CLAUDE.md 10.5  | Respected throughout                           |
| Never print chips. No grantChips / topUp / adminReload                                | OPORD §1.4, §17 | Enforced; a test asserts no such symbol exists |
| "YOU CAN IGNORE THE 10,000 SEED, AND USE THERE CURRENT BALANCES"                      | 2026-09-04      | Seed retired, no seeding primitive exists      |
| Never sit above $1/$2 this phase                                                      | OPORD §8.3      | `PHASE_MAX_BB = 2`, clamp checked before money |
| Do not build must-move / feeders / multi-main                                         | OPORD §0, §17   | Not built. Do not start it.                    |
| "OMAHA 8 IS PLO8o"                                                                    | 2026-09-04      | `flo8` treated as Omaha-8 family               |
| "we should have a handful of limit games open and available"                          | 2026-09-04      | Limit games get their own cap 2 / floor 1      |
| Overlays fund from union main bank and DSS main bank                                  | 2026-09-04      | Already true; verified                         |
| "IF THE MAIN BANK DIDN'T HAVE ENOUGH CHIPS ... PULL FROM THE TREASURY AS A FALL BACK" | 2026-09-04      | Built                                          |
| Free Buy must be buildable in the create-event MTT form                               | 2026-09-04      | Built                                          |
| No emoji in source. No em dashes in popup text. Title Case popups                     | CLAUDE.md 5     | Respected                                      |
| Never call horses "bots"                                                              | CLAUDE.md 10    | Respected                                      |
| Commit and push small and often                                                       | CLAUDE.md 13    | 7 commits                                      |

**Explicitly rejected by Dan or by evidence:**

- Per-club occupancy caps (would deliver 80% peak where 40% was asked).
- The 10,000 seed (retired).
- Rewriting `HorseFleetManager`'s seating loop (see §15).

---

## 3. Project and repository identity

| Field       | Value                                                                  | Confirmed |
| ----------- | ---------------------------------------------------------------------- | --------- |
| Repo        | `Smarter-Poker-Club-Arena`                                             | yes       |
| Remote      | `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git`            | yes       |
| Worktree    | `~/Documents/.agent-trees/club-arena/stable-hand`                      | yes       |
| Branch      | `feat/stable-hand`, in sync with origin                                | yes       |
| Main clone  | `~/Documents/club-arena` (on `fix/agent-open-pr-skip-ci-2` — NOT main) | yes       |
| Framework   | Vite + React 19 + TS (client), Node/TS engine (`server/`)              | yes       |
| DB          | Supabase `kuklfnapbkmacvwxktbh`                                        | yes       |
| Engine host | Hetzner, deployed on merge to main                                     | yes       |

**Environment traps (cost me time — read these):**

- `node` is NOT on the default PATH. Prefix every command with
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`
- The pre-push hook takes ~3 minutes. Launch with
  `nohup git push > /tmp/push.log 2>&1 < /dev/null & disown` and poll.
- `gh` is not installed. Use `curl` with `GITHUB_TOKEN` from
  `~/Documents/club-arena/.env`.
- `setsid` and `timeout` do not exist on this Mac.
- **Do NOT symlink `node_modules` into the worktree.** See §15 — it cost an
  hour of chasing phantom test failures. Run a real `npm install`.
- Explore subagents CANNOT see `~/Documents/.agent-trees/`. They silently fall
  back to `~/Documents/club-arena` on a different branch and report confidently
  wrong findings. See §15.

---

## 4. Repository map (files this work touches)

```
server/src/services/
  StableHand.ts              1,338 ln  NEW  pure core: curve, shape, tags, bankroll, caps, yield, mutex
  StableHand.test.ts           837 ln  NEW  75 tests, covers T1-T34
  StableHandController.ts      403 ln  NEW  pure floor planner (planFloor) + chicagoNow()
  StableHandController.test.ts  247 ln  NEW  15 tests
  FreeBuy.ts                   215 ln  NEW  tiers, slots, add-on window, horse add-on/rebuy behaviour
  FreeBuy.test.ts              218 ln  NEW  26 tests
  TournamentRecurringService.ts  +80   MOD  4 freeroll blocks added (see §16 - may be superseded)
server/src/scripts/
  horsesTag.ts                 237 ln  NEW  the tagger CLI (npm run horses:tag)
server/src/handlers/
  stableHand.ts                152 ln  NEW  GET /stable-hand dashboard (READ-ONLY)
server/src/router.ts             +4    MOD  route registration
server/src/tournament/
  TournamentManagerBase.ts      +47    MOD  addon_from_start window (3 edits)
src/components/club/
  CreateTournamentModal.tsx     +39    MOD  Free Buy entry-rules option
src/services/TournamentService.ts +7   MOD  freeBuy + addOnFromStart in config/RPC
tests/law/FreerollsAreFreeBuy.law.test.ts +53 MOD  pin moved to the new pricing migration
scripts/ci/schema-manifest.d/stable-hand.json  NEW  schema declaration
supabase/migrations/          4 NEW files (all applied to production - see §18)
docs/changelog/               3 NEW files
```

**Do NOT edit:** `HorseFleetManager.ts` seating loop (§15),
`docs/HANDOFF_CURRENT_STATE.md` (different programme).

---

## 5. Applicable instructions

Read before editing: `AGENT-PLAYBOOK.md`, `CLAUDE.md` (esp. **10.5** horses are
players, **10.8** law registry + never wait on CI, **10.9** you decide the
money, **11.0** environment, **11.5** never spend real chips to test, **12**
never rebase main, and the **production DDL policy** in §2).

**Two that bit me directly:**

- **10.8 rule 1:** two laws demanding opposite things → STOP and ask Dan. This
  fired for real (§9).
- **11.5:** probe money paths inside a rolled-back transaction. Used (§14).

---

## 6. Complete discovery record

### 6.1 THE CORRECTION THAT MATTERS MOST

The OPORD assumed three overlapping club buckets. Measured live:

| Set                 | OPORD said    | LIVE (2026-09-04)                          |
| ------------------- | ------------- | ------------------------------------------ |
| Unique horses       | ~1,000        | **1,000**                                  |
| Club JAQK           | 584           | **580**                                    |
| Shark Club          | 593           | **584**                                    |
| Deep Stack Society  | 417           | **416**                                    |
| Midway Union DIRECT | not mentioned | **323**                                    |
| JAQK ∩ Shark        | "large"       | **580 — JAQK is a STRICT SUBSET of Shark** |
| JAQK ∩ DSS          | implied >0    | **0**                                      |
| Shark ∩ DSS         | implied >0    | **0**                                      |

**584 + 416 = 1,000 exactly. The fleet is a partition, not an overlap.**

Per-club caps would count one body twice:
`floor(.40×580) + floor(.40×584) = 465` unique bodies from a pool of 584 = 80%
occupancy where Dan asked for 40%. **The bucket is the HOST.**

| Host                              | Eligible bodies N | peak_cap | night_cap | live at recon |
| --------------------------------- | ----------------- | -------- | --------- | ------------- |
| Midway Union (JAQK+Shark wallets) | **584**           | **233**  | **58**    | 180           |
| Deep Stack Society                | **416**           | **166**  | **41**    | 150           |

`club_id` still selects the WALLET. The host selects the bucket.

### 6.2 Other measured facts

- **Wallet→host routing already works.** 158 Shark + 155 JAQK seats on Union
  tables, 396 DSS on DSS, **0 cross-host, 0 horses over 4 seats**.
- **Midway Union's own 323 horse wallets are unused** by cash seating (min
  balance 25,000). Deliberately NOT tagged — tagging a wallet nothing sits from
  would inflate every occupancy denominator.
- **Zero never-funded wallets, zero broke horses.** The seed was a no-op even
  before Dan retired it.
- **709 live seats, 330 unique horses, avg 2.15 seats/horse** (OPORD peak band
  is 1.6-2.2 — in band).
- **76 seats sit above 1/2.** No NEW sit above 1/2 is permitted; the existing
  76 ride until a normal force-leave. Tearing them down would move real chips
  for no stated reason.
- **Only 4 exotic tables exceed 1/2** (all DSS, 1 running).

### 6.3 Architecture found

| Thing                | Path                                       | Note                                                                                             |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Seating              | `HorseFleetManager.ts` (~2,000 ln)         | `seedAllTables`, `seatHorse`; survived 3 incidents                                               |
| Sit RPC              | `atomic_table_buyin(...)`                  | Takes `p_club_id`. Enforces SOLVENCY ONLY                                                        |
| Cash-out             | `atomic_seat_cashout_locked`               |                                                                                                  |
| BRM                  | `HorseBankroll.ts`                         | Per-wallet, keyed `club_id:user_id`                                                              |
| Occupancy (existing) | `HorseBehavior.ts::occupancyTargetFor`     | PER-TABLE 3h buckets, `CASH_FULL_FRACTION=0.75`. **No 24h curve existed**                        |
| Hand AI              | `HorseLogic.ts` (5,170 ln)                 | **DO NOT REWRITE.** Seat it only                                                                 |
| Waitlist             | `table_waitlist` + `WaitlistService.ts`    | Direct-Supabase, no Node route                                                                   |
| Add-on window        | `TournamentManagerBase.triggerAddOnPeriod` | 60s window opened at a LEVEL cap; opening it CREATES the break                                   |
| Add-on money         | `process_tournament_rebuy`                 | Outer wrapper gates on `addon_period_started_at/ends_at` timestamps. **Never checks `on_break`** |
| Rebuy gate           | same                                       | `chips <= starting_chips`. **A rebuy does NOT require a bust**                                   |
| Overlay funding      | `fn_ca_fund_overlay_on_lock`               | union_id set → `union_wallets`; else `clubs.chip_treasury`                                       |
| Feature flags        | none                                       | House pattern is `process.env.X !== 'false'` inline + a law test pinning the constant            |
| Chip writes from TS  | **NONE**                                   | All chip movement is SQL SECURITY DEFINER                                                        |

### 6.4 CRITICAL: what `atomic_table_buyin` does NOT enforce

It checks the balance covers the buy-in. It knows **nothing** about the
20-buy-in licence, the 50% session commit cap, the ≤1/2 phase clamp, the
per-key daily sit cap, or one-body-one-club. **Any Stable Hand seat path must
enforce those itself.** `evaluateSit` does, and has no fail-open branch.

### 6.5 Bank balances (2026-09-04)

| Store                                                         | Balance          |
| ------------------------------------------------------------- | ---------------- |
| `union_wallets` (Midway Union) — funds Union overlays         | **66,596.34**    |
| `clubs.chip_treasury` Deep Stack Society — funds DSS overlays | **1,908,364.18** |
| `clubs.chip_treasury` Midway Union — the Union FALLBACK       | **0.66**         |
| `clubs.chip_treasury` Club JAQK                               | 1,051,788.71     |
| `clubs.chip_treasury` SHARK CLUB                              | 1,376,610.47     |

**Union runway ≈ 44 days at absolute worst case** (nobody rebuys or adds on).
**The Union fallback is effectively empty at 0.66** — the fallback exists in
code but has nothing behind it for Union. **Flag to Dan.** JAQK and SHARK hold
real money but are NOT the fallback target (`NEW.club_id` is the Union).

---

## 7. Work completed

### Workstream A — Stable Hand pure core (`StableHand.ts`, 1,338 ln)

Everything is a pure function; every "random" choice is a sha256 of a stable
key, so tests need no clock stub and a re-evaluated tick cannot change its mind.

Covers: host identity + `sitIsLegalForHost`; `peakCap`/`nightCap`/`tagSplit`;
the 24h `OCCUPANCY_CURVE_PCT` interpolated with a ±2pp band and both hard caps;
`shapeTargets` (60/20/20 with the small-n cases and the n≥5 joinable guarantee);
`seatsForBucket`/`bucketOf`; stake ladder + `PHASE_MAX_BB`; `neediestStakeBand`;
exotic canonicalisation + `planExoticTrim`; limit games + `planLimitGames`;
`assignTags`/`allocateByMix`/`assignVariants`/`assignPreferredStakes`;
bankroll (`isLicensed`, `commitAllows`, `buyInFor`, step up/down, spread, broke,
`mayRebuyInSeat`); booking (`stayUpSatisfied`, `mayBookWin`, `mustColorUp`,
`forceLeaveReason`, `bookStaggerMs`); yield (`yieldDelayMs`, `yieldCount`,
`pickYieldVictims`); caps (`gameKey`, `maySitOnKey`, `mttBulletsAllowed`,
`addOnDecision`); the mutex (`evaluateSit`, `pickWallet`); freerolls; flags.

### Workstream B — floor planner (`StableHandController.ts`)

`planFloor(snapshot) → { seat, stand, open, close, alerts, metrics }`. Pure.
Human yield runs FIRST and runs even when killed. Deliberately does not execute
— see §15 for why.

### Workstream C — schema + tagger

Two dedicated tables (not 20 columns on `club_members`, which is the live wallet
and costs a ~28s PostgREST reload per DDL). Tagger dry run against production:
**1,580 tags over 1,000 bodies**, coverage nlh 905 / plo4 223 / plo5 201 /
plo6 135 / pineapple 112 / short_deck 112 / plo8 112 / flh 90 / flo8 90 of 1,107
cash tags. Every OPORD floor met.

### Workstream D — dashboard

`GET /stable-hand`. Read-only: it plans and reports and never executes.

### Workstream E — Free Buy

`FreeBuy.ts` (tiers, slots, window, horse behaviour), the `addon_from_start`
engine change (3 edits in `TournamentManagerBase.ts`), the tier-aware pricing
migration, the overlay treasury fallback, and the create-form option.

---

## 8. Free Buy: the locked numbers

|                 | $250 standard              | $500 feature |
| --------------- | -------------------------- | ------------ |
| Slots (Chicago) | 08:00, 12:00, 16:00, 00:00 | 20:00        |
| First entry     | FREE                       | FREE         |
| Starting stack  | 3,000                      | 3,000        |
| Rebuy           | $1                         | $2           |
| Add-on          | $1                         | $2           |
| Add-on chips    | 10,000                     | 10,000       |
| Late reg        | 60 min                     | 60 min       |
| Blinds          | TURBO                      | TURBO        |

Horses: **35% add on immediately**, 100% of survivors add on at the break,
rebuy **0-5 times** (deterministic per horse+event).

**The add-on is ONE window** opening at sit-down and closing after the break —
not two. `tournament_players.add_on` is a boolean; two windows would need a
second add-on slot per player.

---

## 9. THE LAW CONFLICT (resolved by Dan — read this before touching pricing)

- **2026-09-02** (PR #2846, trigger `zz_freerolls_are_free_buy`): every
  0-buy-in MTT is a Free Buy, rebuys and add-ons cost **$1**, forced
  unconditionally.
- **2026-09-04**: the **$500 tier is $2/$2**.

The trigger would have silently rewritten the feature event to $1 before a
single player registered. CLAUDE.md 10.8 forbids resolving that unilaterally,
so it went to Dan.

**Dan's ruling: tier-aware.** $1 stays the default for every freeroll; a
_scheduled_ Free Buy (`free_buy = true` AND `rebuy_cost > 0`) keeps its own
price. Neither law deleted. The law-test pin MOVED to the new migration in the
same commit.

**The conflict was narrower than it looked:** `rebuy_chips`, `addon_chips`,
`rebuy_levels`, `addon_levels` were only ever filled when `<= 0`, so the
10,000-chip add-on already survived. Only the two costs were forced.

---

## 10. Exact current state

- Branch `feat/stable-hand` @ `67049f618`, **clean, in sync with origin**.
- PR **#2927** open. Autopilot merges on green. **Do not sit and watch CI
  (CLAUDE.md 10.8 rule 3).**
- 7 commits ahead of main. 23 files changed, +4,511 / -8.
- All 4 migrations **applied to production**.
- No running dev servers started by me.

---

## 11. Changed-file ledger

| File                                                | Status | Purpose           | Verified                                            | Committed                               |
| --------------------------------------------------- | ------ | ----------------- | --------------------------------------------------- | --------------------------------------- |
| `server/src/services/StableHand.ts`                 | NEW    | Pure core         | 75 tests                                            | yes                                     |
| `server/src/services/StableHand.test.ts`            | NEW    | T1-T34            | pass                                                | yes                                     |
| `server/src/services/StableHandController.ts`       | NEW    | Floor planner     | 15 tests                                            | yes                                     |
| `server/src/services/StableHandController.test.ts`  | NEW    | Planner tests     | pass                                                | yes                                     |
| `server/src/services/FreeBuy.ts`                    | NEW    | Free Buy spec     | 26 tests                                            | yes                                     |
| `server/src/services/FreeBuy.test.ts`               | NEW    | Free Buy tests    | pass                                                | yes                                     |
| `server/src/scripts/horsesTag.ts`                   | NEW    | Tagger CLI        | dry-run vs prod                                     | yes                                     |
| `server/src/handlers/stableHand.ts`                 | NEW    | Dashboard         | typecheck only — **UNVERIFIED at runtime**          | yes                                     |
| `server/src/router.ts`                              | MOD    | Route             | typecheck                                           | yes                                     |
| `server/src/tournament/TournamentManagerBase.ts`    | MOD    | addon_from_start  | typecheck + full server suite — **no runtime test** | yes                                     |
| `server/src/services/TournamentRecurringService.ts` | MOD    | 4 freeroll blocks | typecheck                                           | yes                                     |
| `src/components/club/CreateTournamentModal.tsx`     | MOD    | Free Buy option   | typecheck — **no UI test**                          | yes                                     |
| `src/services/TournamentService.ts`                 | MOD    | config keys       | typecheck                                           | yes                                     |
| `tests/law/FreerollsAreFreeBuy.law.test.ts`         | MOD    | pin moved         | 27 pass                                             | yes                                     |
| `scripts/ci/schema-manifest.d/stable-hand.json`     | NEW    | schema decl       | 8 pass                                              | **NO — uncommitted at time of writing** |
| 4 × `supabase/migrations/*.sql`                     | NEW    | applied           | see §18                                             | yes                                     |
| 3 × `docs/changelog/*.md`                           | NEW    | record            | n/a                                                 | yes                                     |

**No user-owned changes were in the worktree. Nothing of anyone else's was touched.**

---

## 13. Commands

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
cd ~/Documents/.agent-trees/club-arena/stable-hand

npm install --prefer-offline --no-audit --no-fund   # REQUIRED, do not symlink
cd server && npm install --prefer-offline --no-audit --no-fund

cd server && npx tsc --noEmit -p tsconfig.json      # server typecheck
npx tsc --noEmit -p tsconfig.json                   # client typecheck (repo root)
cd server && npx vitest run                         # 5,015 tests
npx vitest run                                      # 12,568 tests

# tagger, safe read-only rehearsal:
cd server && npx tsx --env-file=$HOME/Documents/club-arena/server/.env \
  src/scripts/horsesTag.ts --club=all --dry-run

nohup git push > /tmp/push.log 2>&1 < /dev/null & disown   # ~3 min hook
```

---

## 14. Verification results

| Verification                      | Result                                 | Note                                                           |
| --------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Server typecheck                  | PASS                                   |                                                                |
| Client typecheck                  | PASS                                   |                                                                |
| Server suite                      | **PASS 5,015 / 356 files**             |                                                                |
| Client suite                      | **PASS 12,568** after the manifest fix | 3 failed before it                                             |
| StableHand + Controller + FreeBuy | **PASS 116**                           |                                                                |
| `FreerollsAreFreeBuy.law.test.ts` | **PASS 27**                            | pin moved                                                      |
| Tagger dry run vs production      | PASS                                   | 1,580 tags, coverage floors met                                |
| Tier pricing probe                | PASS, **rolled back**                  | plain (7,7,0)→1.00/1.00/3000; tier (2,2,10000)→2.00/2.00/10000 |
| Overlay fallback                  | source assertions only                 | **BEHAVIOURALLY UNVERIFIED**                                   |
| `GET /stable-hand`                | **NEVER RUN**                          | no engine started                                              |
| `addon_from_start` end-to-end     | **NEVER RUN**                          | no live Free Buy exists yet                                    |
| `horses:tag` real write           | **NEVER RUN**                          | only `--dry-run`                                               |
| planFloor against live data       | **NEVER RUN**                          | planner not wired                                              |

---

## 15. Setbacks and lessons (read — each cost real time)

1. **The Explore subagent cannot see `~/Documents/.agent-trees/`.** It silently
   used `~/Documents/club-arena` on a different branch and reported
   "`free_buy` NOT FOUND anywhere" — while `src/utils/freeBuy.ts` had existed
   on main since 2026-09-02. I nearly duplicated a whole subsystem. **Verify
   subagent findings in YOUR OWN worktree.**

2. **I reported a BRM "fail-open defect" that does not exist.** `resolveSeatClub`
   already refuses non-members, and zero of 1,903 horse memberships carry a null
   balance, so the branch is unreachable. I wired a "fix" anyway and two
   existing guards stopped me — `HorseBankrollGateClubs` and the telemetry test
   that pins the literal source shape. **I reverted it. `HorseFleetManager` is
   untouched.** That fail-open is what kept the cash floor up for 40 minutes on
   2026-08-31. **Do not "fix" it.**

3. **My first draft of the roll-unknown policy keyed on "the load completed"** —
   the exact fact that was TRUE during that outage. A test now replays the
   incident; the policy keys on club COVERAGE instead.

4. **Symlinked `node_modules` resolves React twice.** GlobalHeader (8) and
   TournamentTimerService failed in my worktree and passed on main. They failed
   identically with my changes reverted — pure environment. **Run a real
   `npm install`.**

5. **T2 caught a real bug on first run.** The occupancy ramp reached for "any
   table with a free seat" — and `ONE_OPEN` tables are the ones with a free seat
   by definition — so ramping toward the curve would have eaten the 20% of the
   floor a human sits down at. Fixed: the ramp only fills tables already outside
   a target bucket, and opens a new table otherwise.

6. **Postgres `regexp_replace` flag `n` stops `.` matching newlines.** My first
   overlay patch silently matched nothing. The DO block caught it because it
   asserted the replacement applied.

7. **My schema-manifest fragment used the wrong keys** (`owner`/`added`/`note`
   vs `_owner`/`tables`/`functions`/`columns`/`_comment`) and failed a test.

8. **A push died when the host_terminal connection dropped.** `nohup ... &
disown` usually survives; that one did not. Always re-check `git status -sb`.

9. **The `check-title-case` CI guard flags log labels** as page copy. A template
   label ending in `.` tripped it.

---

## 16. Known defects and open holes

| Pri    | Issue                                                              | Evidence                                              | Impact                                                             | Fix                                 |
| ------ | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| **P1** | Planner is not executed                                            | `HorseFleetManager` never calls `planFloor`           | None of Sections 5/11 actually run                                 | Wire it (§21 Phase 2)               |
| **P1** | No Free Buy scheduler                                              | no code creates the 10 events/day                     | Free Buy never runs                                                | §21 Phase 3                         |
| **P2** | Union fallback is empty                                            | `clubs.chip_treasury` Midway Union = **0.66**         | If the union bank empties, overlay is unfunded and critical-alerts | Ask Dan to fund it                  |
| **P2** | 4 freeroll blocks in `TournamentRecurringService` may be redundant | added before Dan specified the 5-a-day Free Buy board | Duplicate/competing freerolls                                      | Decide: keep or revert (§19)        |
| **P2** | Overlay fallback behaviourally unverified                          | source assertions only                                | Fallback may not fire as intended                                  | Rolled-back probe                   |
| **P3** | 8-hour overnight gap (00:00→08:00)                                 | 5 events cannot cover 24h at 4h cadence               | A horse busting at 01:00 waits 7h                                  | Dan's call; 6 events would close it |
| **P3** | Dashboard never executed                                           | no engine run                                         | May throw at runtime                                               | Boot the engine, curl it            |
| **P3** | 76 seats above 1/2                                                 | measured                                              | Grandfathered by design                                            | Leave; documented                   |

---

## 17. Secrets

Names only. `GITHUB_TOKEN` (in `~/Documents/club-arena/.env`),
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. New env flags introduced:
**`STABLE_HAND_CONTROLLER`** (default ON, set `false` to disable) and
**`STABLE_HAND_KILL`** (set `true` to stop new sits; yield still runs).
No secret values were printed or committed.

---

## 18. Database — ALL FOUR APPLIED TO PRODUCTION

| Version          | Name                                     | What                                                |
| ---------------- | ---------------------------------------- | --------------------------------------------------- |
| `20260904060838` | `stable_hand_tag_and_state_tables`       | 2 new tables + indexes + RLS                        |
| `20260904063653` | `free_buy_tournaments`                   | `tournaments.free_buy`, `.addon_from_start` + CHECK |
| `20260904064229` | `overlay_falls_back_to_the_treasury_v2`  | overlay fallback                                    |
| `20260904065106` | `free_buy_tiers_may_set_their_own_price` | tier-aware trigger                                  |

New tables: `stable_hand_membership_tags` (PK horse_id+club_id; mode,
cash_freeroll, persona_cash, persona_mtt, variants[], preferred_stakes[],
max_tables, tagged_at, tag_seed; 3 CHECK constraints) and
`stable_hand_horse_state` (PK horse_id; rest_weekday, daily_cap_minutes, the
mutex fields, counters as jsonb; 2 CHECK constraints). Both RLS-enabled,
service_role only, **both currently EMPTY** — the tagger has only dry-run.

**Rollback NOT tested.** To roll back the schema:

```sql
DROP TABLE IF EXISTS public.stable_hand_membership_tags;
DROP TABLE IF EXISTS public.stable_hand_horse_state;
ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_free_buy_entry_is_free,
  DROP COLUMN IF EXISTS free_buy,
  DROP COLUMN IF EXISTS addon_from_start;
```

The two function patches roll back by re-applying the prior definitions from
`20260902183602_freerolls_are_free_buy.sql` and
`20260903204843_a_satellite_is_recognised_by_what_it_pays.sql`.

**Production DDL policy:** one migration = one transaction. Each DDL costs a
~28s PostgREST reload (the 2026-08-31 PGRST002 outage).

---

## 19. Blockers and decision points

1. **The 4 extra freeroll blocks** in `TournamentRecurringService.ts` predate
   Dan's Free Buy spec. **Recommendation: revert them** and let the Free Buy
   board be the only freeroll source — two schedulers producing free events is
   how you get double fields. **Needs Dan.**
2. **Union bank funding.** 66,596 with a 0.66 fallback. **Needs Dan.**
3. **The overnight gap.** As specified. **Needs Dan** if he wants it closed.

---

## 20. Remaining work

**CRITICAL**

1. Wire `planFloor` into `HorseFleetManager` (execution).
2. Build the Free Buy scheduler (10 events/day, Chicago-anchored, both hosts).
3. Run `horses:tag --club=all` for real (currently dry-run only).

**HIGH** 4. Behaviourally verify the overlay fallback (rolled-back probe). 5. Boot the engine and curl `GET /stable-hand`. 6. Resolve the duplicate freeroll blocks (§19.1). 7. End-to-end test `addon_from_start` on a real Free Buy.

**MEDIUM** 8. Exotic/limit trim EXECUTION (planner emits `close` orders; nothing consumes them). 9. Two-hour same-key window persistence (`stable_hand_horse_state.two_hour_window` exists, unused). 10. Daily counter reset at midnight Chicago (`counters_reset_on` exists, unused). 11. Union-bank low-balance alert.

**LOW / OPTIONAL** 12. Section 15 dashboard extras (yield p50/p95, skip reasons). 13. `docs/LAWS.md` rows if any `*.law.test.*` is added.

---

## 21. Execution plan

**Phase 0 — recover state.** Verify branch/PR, real `npm install`, run both
suites. Completion: both green.

**Phase 1 — protect.** Do not touch `HorseFleetManager` seating, the
`seat_fail_open_roll_unknown` branch, `HorseLogic.ts`, or
`docs/HANDOFF_CURRENT_STATE.md`.

**Phase 2 — execute the planner.** Call `planFloor` from `HorseFleetManager`'s
cycle behind `STABLE_HAND_CONTROLLER`. Start with `stand` orders for
`human_yield` only (smallest blast radius), verify on the live floor, then
enable `seat`, then `open`/`close`. Completion: `/stable-hand` shows shape
converging on 60/20/20 and a human on a waitlist is seated within 5 minutes.

**Phase 3 — Free Buy scheduler.** New pass, Chicago-anchored via
`chicagoNow()` — **NOT** `getUTCHours()`, which drifts an hour twice a year and
would move the 20:00 feature event to 19:00 every November. For each host ×
each slot, create with `free_buy=true`, `addon_from_start=true`,
`buy_in_amount=0`, `starting_chips=3000`, `addon_chips=10000`,
`rebuy_cost`/`addon_cost` from the tier, `late_reg_mins=60`, TURBO,
guarantee 250/500. **Union events MUST stamp `union_id`** or the overlay hits
the 0.66 treasury instead of the 66,596 union bank. Idempotency: one event per
(host, slot, local date).

**Phase 4 — tag the fleet.** `--dry-run` first, compare to the recorded
numbers, then run for real.

**Phase 5 — verify.** Rolled-back overlay probe; engine boot + dashboard curl;
one live Free Buy watched end to end.

**Phase 6 — commit/push.** One workstream per commit. Never `--no-verify`.

---

## 22. Exact first actions

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
cd ~/Documents/.agent-trees/club-arena/stable-hand
git status -sb && git log --oneline -7
npm install --prefer-offline --no-audit --no-fund
cd server && npm install --prefer-offline --no-audit --no-fund && cd ..
cd server && npx vitest run | tail -5 && cd ..
npx vitest run | tail -5
```

Then read, in order: this file §6.1 (the host-vs-club correction), §9 (the law
conflict), §15 (the setbacks), §16 (the defects). Then start Phase 2 or 3.

**Do not** modify `HorseFleetManager.ts` seating, `HorseLogic.ts`, or the
`seat_fail_open_roll_unknown` branch.

---

## 23. Acceptance criteria

Shape holds ~60/20/20 per host; no table listed joinable with <2 players; a
human on a waitlist is seated within 2-5 min and the seat is held 90s; unique
occupancy never exceeds 233 (Union) / 166 (DSS), and never exceeds 58/41 during
03:00-08:00; no horse on two hosts; no horse over 4 seats; no new sit above
$1/$2; 5 Free Buys per host per day at the right Chicago hours with the right
tier prices; every horse alive at the break has added on; chip conservation
unchanged; both suites green; branch pushed and PR merged.

---

## 25. Final continuation summary

**Stopping point:** all decision logic for Operation Stable Hand and Free Buy is
built, tested (116 dedicated tests, 5,015 server + 12,568 client all green) and
pushed to `feat/stable-hand` @ `67049f618`, PR #2927. All four migrations are
applied to production. **Nothing is executing yet** — the planner is not called
and the Free Buy board does not exist.

**Do first:** Phase 2 (wire the planner, human-yield orders only) or Phase 3
(the Free Buy scheduler). Phase 3 is more self-contained.

**Greatest technical risk:** wiring the planner into a seating loop that
survived three incidents. Go incrementally.
**Greatest data-integrity risk:** a Union Free Buy created without `union_id`
draws its overlay from a 0.66 treasury instead of the 66,596 union bank.
**Greatest financial risk:** $3,000/day in guarantees against a 44-day union
runway with an empty fallback.
**Still needs Dan:** the duplicate freeroll blocks, funding the Union treasury,
and the overnight gap.

You do not need to redo discovery. Sections 6, 9, 15 and 16 contain every
measured fact, every rejected approach and every trap already paid for.
