# The phantom-reference allowlist goes to zero

2026-09-01. `scripts/ci/supabase-invariants.allowlist.json` held **30 entries**:
15 tables and 15 RPCs that code referenced but production does not have. Each
entry is a hole in the gate that stops a `.from()` or `.rpc()` reaching something
that is not there. It now holds **none**.

## How the 30 were sorted

Not by reading them. I emptied both lists and ran the checker:

```
[check-phantom-refs] phantoms: 5 tables, 0 rpcs
```

**Twenty-five entries were protecting nothing.** Thirteen subjects exist in
production today (11 RPCs, plus `arena_sessions` and `club_challenges`) and were
verified present in the schema manifest too, so the gate would have resolved them
on its own. The other twelve had no caller left in `src/` or `server/src/` at all.
Every one of the 15 RPC entries was in that group, which is why the RPC list is
now empty and commented to stay that way.

`execute_commission_payout` was among them, and its own entry said
`REMOVE THIS ENTRY when that lands`. It landed: `executePayout` is gone,
replaced by `claimCommission`, and the RPC was dropped by `20260902000001`.

## The five that were real, and what each turned out to be

### `gto_solutions`, `preflop_ranges`, `gto_solve_queue` -> `GTOQueryService.ts` DELETED

189 lines querying three tables that do not exist, exported from the services
barrel, and imported by **nothing**. The 2026-08-25 audit that removed the dead
GTO advisor from `TablePage` recorded this explicitly: _"GTOQueryService.ts itself
is untouched and still exported from the services barrel; only this page's import
of it is gone."_ It could not have worked had anything called it.

No GTO capability is lost. The live GTO data is in `gto_postflop_compact`,
`gto_scenarios` and `solved_spots_gold` - the last of which takes 1.1M index scans

- and none of it went through this service. Its unit test and its
  `discardedErrorReadRatchet` entry went with it.

### `hand_results` -> `HorseOrchestrator.trackHorsePerformance()` DELETED

A private method with **no caller anywhere** in `src/` or `server/src/`, whose
only effect would have been a `console.debug`. It also read `hand_results`, which
does not exist, so `recentHands` was always null and the win-rate block inside it
could never run even if something had called it. Nothing observable is lost.

### `clawback_audit_log` -> unreachable state in `AgentAnalyticsDashboard` DELETED

`clawbackLogs` was declared, populated from a query, and then **read by no JSX**.
Every agent-dashboard load paid for a round trip that errored and fed a value
nobody displayed. Same shape as the dead GTO advisor block.

**A wrong fix I nearly shipped:** production has `clawbot_audit_log`, one letter
away. It is not the same thing - its columns are `task_id`, `action`, `severity`,
`clawbot_version`: an automation bot's log, not agent chip clawbacks
(`recovered_amount`, `clawed_back_at`, `agent_user_id`). Renaming would have
pointed a money dashboard at a bot's audit trail and made a dead panel into a
lying one. Checked the columns before assuming the typo.

## What came free

The `discardedErrorReadRatchet` caught the removals and demanded its baselines be
tightened in the same commit, which is exactly what that ratchet is for:

| file                                               | was | now   |
| -------------------------------------------------- | --- | ----- |
| `src/services/HorseOrchestrator.ts`                | 11  | **8** |
| `src/components/agent/AgentAnalyticsDashboard.tsx` | 2   | **1** |

Four discarded-error reads went with the dead code, and the ratchet now holds the
lower number.

## Checked and deliberately left alone

- **`public.wallets`** (frozen, 732,591,994.33 chips stranded). No code path
  writes it - the single grep hit is a comment telling you not to. Clean.
- **`skip_animations`** (tombstoned by law 10.6). Still present in
  `useUserTableSettings` as a column round-trip, but nothing gates an animation on
  it, and `TablePage` actively CLEARS the durations so a stale cached `true`
  cannot leave a player with a permanently animation-free table. That is
  deliberate, and removing it would break the settings round-trip.
- **The auto-table-switch keys** (tombstoned by law 10.6). No references. The
  tombstones hold.

## Verification

`tsc --noEmit` exit 0. 805 test files, 11,146 tests, 11,145 pass; the one failure
is `check-title-case` timing out at 5s under a machine running three suites at
once - it completes in 1.7s standalone and the whole file passes in isolation
(22/22). Both phantom gates green against an empty allowlist.
