# 2026-08-31 — MTT deep dive: what is left to build, fix and tune

Scope: the whole MTT subsystem — server engine, client SPA, scheduling, live
production data over 7 days (579 completed MTTs, 23,988 entries, 9,985
hands/hour at time of writing). Follows the three fixes shipped in PRs #2004,
#2019 and #2039.

**Headline.** The MTT plumbing is in good shape: tournaments start, seat,
balance (measured gap ≤ 1 across live multi-table events), eliminate, and pay
out — 0 unpaid events in 7 days, rebuys and add-ons are genuinely being bought
(7,199 and 5,450). What is NOT in good shape is the **poker**: the blind
structures are far too short for the length of these events, and the overflow
rule doubles blinds every level past the end. **38% of MTTs finish with every
chip in the tournament worth less than 3 big blinds.** That is the single most
valuable thing on this list.

---

## TIER 1 — the endgame is not poker

### 1.1 Blind structures are ~8 levels; events run to level 14–52
Measured over 579 completed MTTs:

| metric | value |
| --- | --- |
| avg levels DEFINED in `blind_structure` | 8.1 |
| avg level actually REACHED | 14.0 |
| max level reached | 124 |
| events that ran past their own structure | **554 / 579 = 95.7%** |

`blindEscalation.ts` synthesizes levels past the end at
`2^(index - persistedLength + 1)` — **the blinds double every level**. The
module itself is correct, restart-safe and well-tested; the *policy* it
implements is the problem. Real MTT structures grow ~30–50% per level.

### 1.2 Consequence: the blinds outgrow the tournament
| metric | value |
| --- | --- |
| events ending with peak BB ≥ the `DECIMAL(10,2)` ceiling (10,000,000) | 41 (7.1%) |
| events where peak BB > *every chip in the event* | 72 (12.4%) |
| events ending with total chips in play < 3 BB | **221 (38.1%)** |
| events ending in a healthy > 20 BB state | **18 (3.1%)** |

Seven of the eight largest fields in the window (486–500 entrants, 12k–30k
starting stacks) ended pinned at BB = 10,000,000 — a big blind larger than the
sum of all chips ever issued in the event. The last hour of those tournaments
is a forced all-in lottery, not poker.

**Fix direction** (three independent, each shippable alone):
1. Extend the preset ladders in `ScheduledTournamentService.SCHEDULE_BLIND_PRESETS`
   from 5–12 levels to 25–40 real levels.
2. Change the overflow growth factor from `2^n` to ~1.4^n, and derive it from
   the structure's own late-level slope rather than hardcoding doubling.
3. Add a chips-in-play ceiling: BB may never exceed `total_chips / N` (N ≈ 20).
   This is the guard that makes 1.1 and 1.2 unable to recur regardless of how
   long an event runs. Pin it with a law test.

### 1.3 Payout depth does not scale with field
Average places paid by field size:

| field | events | avg places paid |
| --- | --- | --- |
| < 10 | 14 | 5.1 |
| 10–29 | 393 | 5.8 |
| 30–59 | 113 | 7.1 |
| 60–99 | 31 | 6.8 |
| **100+ (avg 334)** | **28** | **8.9** |

A 334-runner event paying 9 places is 2.7% of the field. Industry norm is
10–15%. The `SCHEDULE_PAYOUT_PRESETS` map tops out at `NINE`. Needs
field-proportional structures (e.g. 15% paid, generated) rather than three
fixed presets.

---

## TIER 2 — features that exist as data but not as behaviour

| item | state | evidence |
| --- | --- | --- |
| **Chip race / colour-up** | `ChipRaceEngine.ts` (187 lines) is fully written and **unreachable** — `const CHIP_RACE_ENABLED = false` at `TournamentManagerBase.ts:3873` | needs denomination schedule + table-scoped write-back + conservation assertion |
| **Multi-day / flighted MTT** | unbuilt; DB trigger deliberately refuses the flag. `parent_tournament_id`, `flight_number`, `day_number`, `flight_end_chips_snapshot`, `survivors_advance_to` have **zero** server reads | `20260826_multi_day_mtt_refuses_to_be_set_until_it_is_built.sql` |
| **Final-table seat redraw** | absent — `TableBalancer.breakTable()` places by blind-hops, deterministically. No random FT draw for seats or button | competitive-parity gap |
| **`max_reentries`** | written by the scheduler, **never read**. Re-entry caps ride on `max_rebuys`, so `is_reentry + max_reentries:3 + max_rebuys:1` silently caps at 1 | `ScheduledTournamentService.ts:1003,1114` |
| **Per-structure breaks** | `isBreak` rows in `blind_structure` are **skipped with zero time cost**; only the platform-wide `:55` break exists | `TournamentManagerBase.ts:667,3755` |
| **Final-table deal** | even chip-chop only, unanimity only, **no deal timeout**. No ICM despite ICM math existing for horse decisions | `TournamentManagerEliminations.ts:2851` |
| **`is_xmtt`** | label only — no cross-club seating or union prize behaviour differs | polish |

---

## TIER 3 — client gaps a real MTT player will notice

**Shipping-blocking for a human-facing launch:**

1. **Break screen shows Level 0, Prize Pool 0, no chip leaders — every break,
   every tournament.** `TableModalsLayer.tsx:1243,1253-1254` passes hardcoded
   `currentLevel={0}`, `topPlayers={[]}`, `prizePool={0}` into a component that
   renders all three correctly. The real level is one field away on
   `useTableTournament.ts:31`. **One-line fix, highest visibility on the list.**
2. **Re-entry has no UI at all.** `TournamentService.processReentry()`
   (`:2181`) has **zero callers**. The format is configurable, badged in the
   lobby, and detected retroactively — but a busted player has no button.
3. **Hand-for-hand is invisible at the table.** `TablePage.tsx:555-556` holds
   `handForHand`/`bubbleInfo` as write-only state; the player gets a 4-second
   overlay and nothing persistent. `HandForHandBanner.tsx` exists and is mounted
   only on the lobby page.
4. **No next-payout-jump figure anywhere** (`nextPayout|payout_jump` → zero
   hits). The most-consulted number on an MTT ladder.
5. **Deal-making asks for a yes/no with no numbers shown** —
   `DetailOverviewTab.tsx:219-299`. Zero deals have ever been voted on in 7
   days, which is consistent with "nobody can evaluate it".

**Dead code that will trap the next agent** (delete or wire, do not leave):
`components/tournament/RebuyModal.tsx` and `AddOnModal.tsx` are unimported
duplicates of the live `components/table/` versions **that still call the real
money RPCs**; `EliminationOverlay.tsx` is imported by `TournamentPage.tsx:16`
and never rendered; `PayoutStructure.tsx` / `BlindStructure.tsx` have zero
importers (and their absence is why `BlindsTab` cannot show the full ladder);
six `TournamentService` lifecycle methods including `finalizeTournament` are
unwired but reachable — a double-processing hazard.

**Missing standard furniture:** my stack in BB on the felt (only on the break
screen), total entrants at the table ("12 left" vs "12 left of 340"), ON BREAK
badge in the lobby list, player search on a 300-entrant list, lifetime
ITM%/ROI/cashes roll-up, satellite seat-won celebration moment, break-ending
warning.

---

## TIER 4 — operations and scale

1. **Deploy starvation under the current merge rate.** Observed directly today:
   3 of the last 6 `auto-deploy-hetzner` runs were `cancelled` by newer pushes,
   and a merged server fix (PR #2039) sat undeployed for 40+ minutes because
   `cancel-in-progress` combines with the restart-spacing coalescer. Neither
   guard is wrong alone; together they can starve a commit. Wants a
   deploy queue or a "commit N has been on main and undeployed for > X minutes"
   alarm.
2. **Multi-node MTT does not exist.** `scale/CrossNodeBus.ts` advertises
   tournament coordination and has **zero imports**. Hand-for-hand, balancing
   and break sync are all single-process (`this.tableEngines`). Fine today at 76
   live MTT tables; a hard ceiling later.
3. **Hand-for-hand re-pause is a 500 ms wall-clock race**
   (`TournamentManagerBase.ts:1013-1050`), not a confirmed-deal gate. A slow
   table runs an extra hand out of sync — precisely what hand-for-hand exists to
   prevent.
4. **Spin draw row-write failure has no repair path** — a game whose multiplier
   was drawn but whose row read NULL runs on the *smallest* placeholder tier and
   nothing scans for it (`TournamentManagerBase.ts:1746`).
5. **Same-hand double-bust ordering** is an admitted follow-up
   (`TournamentManagerEliminations.ts:536`) — totals are right, but who takes
   4th vs 5th on the bubble is arbitrary.
6. **`satellite_seats` overlay is unbounded** — an advertised seat guarantee the
   field did not fund logs an overlay and proceeds, with no club-treasury check
   (`TournamentManager.ts:678`).

### Storage (checked, mostly fine)
`solved_spots_gold` 80 GB dominates the 106 GB database and is solver data, not
tournament data. `hand_state_snapshots` (6.1 GB) **is** pruned — oldest row
2026-08-04 — so the earlier concern about it outgrowing `hand_history`
unchecked does not hold. `data_audit_log` is 3 GB across 24k rows with zero dead
tuples: large JSONB payloads, not bloat. No vacuum problem anywhere
(all hot tables < 2% dead).

---

## What is measurably healthy — do not "fix" these

- **Payout integrity**: 0 unpaid across 579 completed MTTs in 7 days; the one
  141% overpay found today is fixed at source in PR #2039.
- **Table balancing**: live multi-table events measured at gap ≤ 1, which is the
  target.
- **Elimination and finishing**: 0 stalled, 0 phantoms, 0 stuck in COMPLETING
  after the PR #2004 fix.
- **Rebuy / add-on money path**: 12,649 purchases in 7 days, all landing.
- **Mobile tournament CSS**: genuinely 375px-clean across 6 surfaces with
  documented prior fixes; the only phone gap is `TournamentHUD` having no CSS
  file and no priority order when it wraps.

---

## Suggested order

1. Blind structure depth + overflow growth factor + chips-in-play BB ceiling (1.1–1.2)
2. Break screen real values — one line (3.1)
3. Field-proportional payout depth (1.3)
4. Re-entry UI + `max_reentries` read (3.2, Tier 2)
5. Delete/wire the five dead client components (3, "dead code")
6. Hand-for-hand: persistent table indicator + deal-gated re-pause (3.3, 4.3)
7. Next-payout-jump + BB on felt + entrants count (3.4, "furniture")
8. Final-table redraw, then chip race, then ICM deals (Tier 2)
9. Multi-day / flights (Tier 2) — largest single build, gated shut today
