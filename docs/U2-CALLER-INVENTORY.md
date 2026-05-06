# U2.1 — `src/engine/` Caller Inventory

**Date:** 2026-04-23
**Phase:** U2.1 of `~/Documents/Smarter-Poker-World-Hub/CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md`
**Purpose:** Enumerate every caller of the 33 client-side engine files before the deletion pass (U2.3).

## Executive summary

The platform plan (2026-04-21) estimated **~50 caller sites**. Actual state today: **8 import sites across 6 files**, and **6 of the 8 are `import type`** (erased at build time, zero runtime cost). The hazard is much smaller than the plan assumed — STEP 1 has progressed significantly since the plan was written.

**25 of the 33 engine files have zero external callers** and are pure dead code sitting in the repo.

## All 8 import sites

| #   | File                                     | Line | Source                                              | Kind      |
| --- | ---------------------------------------- | ---- | --------------------------------------------------- | --------- |
| 1   | `src/components/table/SpinItWheel.tsx`   | 14   | `SpinItEngine` → `SpinPrizeConfig, SpinMultiplier`  | TYPE      |
| 2   | `src/components/replay/HandReplay3D.tsx` | 22   | `HandReplayEngine` → `ReplaySnapshot, ReplaySpeed`  | TYPE      |
| 3   | `src/pages/admin/EngineDashboard.tsx`    | 3    | `CashGameOrchestrator` → `cashGameOrchestrator`     | **VALUE** |
| 4   | `src/pages/admin/EngineDashboard.tsx`    | 4    | `TournamentOrchestrator` → `tournamentOrchestrator` | **VALUE** |
| 5   | `src/services/HandPersistenceService.ts` | 19   | `HandController` → `HandController, HandEvent`      | TYPE      |
| 6   | `src/services/BBJService.ts`             | 19   | `PokerEngine` → `EvaluatedHand`                     | TYPE      |
| 7   | `src/services/HydraService.ts`           | 101  | `HorseLogic` → `HorseDecision`                      | TYPE      |
| 8   | `src/services/HydraService.ts`           | 103  | `HorseLogic` → re-export `HorseDecision`            | TYPE      |

## Per-engine-file caller count

| Count | Engine file                                                                                                                                                                                                                                                                                                                                                                                                                                               | Notes                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0     | AtomicStackService, ChipRaceEngine, CryptoRandom, DisconnectEngine, EngineTelemetry, FlashPoolEngine, HeadlessTableEngine, HorseBrainAdapter, InsuranceEngine, MixedGameEngine, MonteCarloEquity, OFCDealingOrchestrator, OFCPineappleEngine, PreActionEngine, PreciseActionTimer, RakebackEngine, RunItTwiceEngine, ServerActionValidator, StateVerifier, StraddleEngine, TableBalancer, TableBreakEngine, TimeBankEngine, TournamentEngine, demo, index | **25 dead files** — zero external callers |
| 1     | CashGameOrchestrator                                                                                                                                                                                                                                                                                                                                                                                                                                      | Admin only (EngineDashboard)              |
| 1     | HandController                                                                                                                                                                                                                                                                                                                                                                                                                                            | Type-only                                 |
| 1     | HandReplayEngine                                                                                                                                                                                                                                                                                                                                                                                                                                          | Type-only                                 |
| 1     | PokerEngine                                                                                                                                                                                                                                                                                                                                                                                                                                               | Type-only (`EvaluatedHand`)               |
| 1     | SpinItEngine                                                                                                                                                                                                                                                                                                                                                                                                                                              | Type-only                                 |
| 1     | TournamentOrchestrator                                                                                                                                                                                                                                                                                                                                                                                                                                    | Admin only (EngineDashboard)              |
| 2     | HorseLogic                                                                                                                                                                                                                                                                                                                                                                                                                                                | Type-only (+ re-export)                   |

## Internal coupling

51 intra-`src/engine/` imports exist. `HeadlessTableEngine.ts` (82 KB) is the central hub — it pulls in 10+ other engines. `PokerEngine.ts` (28 KB) and `CryptoRandom.ts` (4 KB) are leaf utilities. The whole graph is self-contained — nothing depends on it externally that a surgical extraction can't solve.

## Migration plan (supersedes U2.2 table in platform plan)

### Stage A — extract type-only imports (6 sites, low risk)

Create pure-type modules in `src/types/engine/` that contain only the interfaces/enums the callers reference, then point the 6 TYPE imports at the new modules:

| New module                           | Types to extract                             | Sites updated             |
| ------------------------------------ | -------------------------------------------- | ------------------------- |
| `src/types/engine/spinIt.ts`         | `SpinPrizeConfig`, `SpinMultiplier`          | SpinItWheel.tsx           |
| `src/types/engine/handReplay.ts`     | `ReplaySnapshot`, `ReplaySpeed`              | HandReplay3D.tsx          |
| `src/types/engine/handController.ts` | `HandController` (as interface), `HandEvent` | HandPersistenceService.ts |
| `src/types/engine/poker.ts`          | `EvaluatedHand`                              | BBJService.ts             |
| `src/types/engine/horse.ts`          | `HorseDecision`                              | HydraService.ts           |

After Stage A, zero TYPE-only imports remain pointing at `src/engine/`.

**Note on `HandController`:** it is a class in `src/engine/HandController.ts`. The TYPE import in `HandPersistenceService.ts` references it as a type. Need to convert to an `interface HandController` in the new type module that captures only the public API members the service touches.

### Stage B — migrate EngineDashboard admin page (2 sites, medium risk)

`src/pages/admin/EngineDashboard.tsx` uses `cashGameOrchestrator` and `tournamentOrchestrator` singletons. These are the last two VALUE imports from `src/engine/`.

Options to evaluate:

1. Read table/tournament state from Supabase tables (`tables`, `tournaments`, `table_seats`) — simplest, RLS-gated admin queries.
2. Add Hetzner admin HTTP endpoints (`GET /admin/tables`, `GET /admin/tournaments`) and drive the dashboard off them.
3. Combination — reads from Supabase, mutations (pause/resume) via existing `POST /admin/pause` + `POST /admin/resume`.

Recommend option 3. It matches the "single source of game truth is Hetzner" architecture principle in platform plan §2.1.

### Stage C — delete `src/engine/` wholesale (1 commit, zero risk)

After Stages A and B, all 8 import sites are neutralized. Delete:

- All 33 files in `src/engine/` (584 KB)
- `src/engine/index.ts` barrel
- `src/engine/demo.ts` (imports `./index`, only used as dev smoke test)

### Stage D — ESLint guard (U2.4 from platform plan)

Add ESLint rule forbidding any import path matching `.*/engine/` to prevent regressions. Rule fires on CI.

## Gate

All 8 current imports resolve. `npm run build` green. `npm run lint` green. No `.eslintrc` rules blocking. After Stage C, `find src/engine` returns empty and no import errors surface in tsc or Vite build.

## Reversibility

Each stage is a separate commit (or commit group):

- Stage A: 5 extract-type commits, each independently revertible.
- Stage B: 1 commit that rewrites EngineDashboard. Revertible to restore the two orchestrator imports.
- Stage C: 1 commit that deletes `src/engine/`. Revertible by `git revert` — files come back because they were tracked.

## Estimated work

- Stage A: ~1 session, 5 commits, ~200 lines of type definitions + 6 import-site edits
- Stage B: ~1 session, 1 commit, ~100 lines in EngineDashboard + any Hetzner endpoint additions
- Stage C: ~5 minutes, 1 commit, +0/-584KB

Total: closing the "dual-engine hazard" is ~2 sessions of work, not the open-ended re-architecture the platform plan suggested.
