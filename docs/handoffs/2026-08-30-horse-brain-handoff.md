# HANDOFF — Club Arena horse brain, 2026-08-30 18:15 UTC

You are picking up the Club Arena **horse decision engine** (`server/src/engine/`).
Everything below was verified against production or the real `decide()`, not
recalled. Where something is unproven I say so explicitly.

---

## 0. READ FIRST, IN THIS ORDER

1. `AGENT-PLAYBOOK.md` (repo root) — how to ship. Worktree, commit author,
   PR, auto-merge. Byte-identical in all seven repos.
2. `.agents/rules/00-agent-playbook.md` — RULES 1-8 and the mandatory
   VERIFICATION PASS (Parts A-E). You will be asked to run it.
3. `CLAUDE.md` (repo root) — especially §10.5 HORSES ARE PLAYERS,
   §10.6 ANIMATION LAW, §11.5 NEVER SPEND REAL CHIPS TO TEST, §12 never
   rebase main.
4. These changelogs, newest first (all on `main`, `docs/changelog/`):
   - `2026-08-30-multiway-value-bars.md`
   - `2026-08-30-the-two-blocked-items-investigated.md`
   - `2026-08-30-v31-design-decided-by-measurement.md`
   - `2026-08-30-postflop-audit-and-v31-sizing.md`
   - `2026-08-30-variant-scale-parity.md`
   - `2026-08-30-plo-preflop-percentile.md`
   - `2026-08-30-v30-optimization-attempt-and-clobber.md`

---

## 1. IMMEDIATE — DO THIS BEFORE ANYTHING ELSE

**The V30 aggregation cursor may be stalled.** At 18:08:35 UTC it read
`rows_done = 1,292,050` and had not advanced 278 seconds later. That is
probably just an engine restart (a `spin-round18` deploy was in flight), but
it must be confirmed, not assumed.

```sql
select street, rows_done, done, extract(epoch from (now()-updated_at))::int as age_s
from public.gto_agg_progress order by street;
```

Healthy = `age_s` under ~120 and `rows_done` climbing between reads. If it is
stalled, diagnose in this exact order (each step is a real failure that has
already happened once):

**a) Call the RPC the way the ENGINE calls it, never via a privileged SQL
session.** This is how a PostgREST safe-update failure was found that a
`postgres`-role probe hid completely:

```bash
set -a; . ~/Documents/club-arena/.env >/dev/null 2>&1; set +a
curl -s -X POST "$VITE_SUPABASE_URL/rest/v1/rpc/fn_aggregate_gto_street_next" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_street":"turn","p_batch":100}' --max-time 60
```

`57014` = statement timeout (batch too big). `21000` = unqualified DELETE
(PostgREST refuses it).

**b) Check the batch clamp has not been raised again.** This regressed once:

```sql
select substring(prosrc from 'v_batch integer :=[^;]+;')
from pg_proc where proname='fn_aggregate_gto_street_next'
  and pronamespace='public'::regnamespace;
```

It MUST read `greatest(25, ...)`. Verified `greatest(25, least(5000, coalesce(p_batch, 1500)))`
at 18:10 UTC. The engine driver sends 100. **A floor above 100 silently
rounds every call back onto the 200-row timeout cliff.** If it is wrong,
patch ONLY the clamp by reading `prosrc` and replacing the text — see
`supabase/migrations/20260830055000_v30_restore_measured_batch_floor.sql`
for the exact idempotent pattern. **NEVER `CREATE OR REPLACE` the whole
function body from an older copy** — that is precisely what caused the
regression.

**c) Confirm the engine is running.** Check recent successful runs of
`.github/workflows/auto-deploy-hetzner.yml`. **Do NOT WebFetch
`https://engine.smarter.poker/health`** — it is CDN/fetch cached and lies
about deploys (CLAUDE.md §11).

---

## 2. CURRENT PRODUCTION STATE (verified 18:10 UTC)

| item                                | value                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| V30 turn aggregation                | 1,292,050 / 3,184,083 rows (**40.6%**)                              |
| V30 river aggregation               | 0 rows — starts automatically when turn completes                   |
| `gto_postflop_compact` flop cells   | 2,992                                                               |
| `gto_postflop_compact` turn cells   | 3,221                                                               |
| cells with `facing <> 'open'`       | **0** (must stay 0 forever — see §4)                                |
| SQL batch clamp                     | `greatest(25, ...)` — correct                                       |
| `v30_gto_turn_open` telemetry today | 3,299 fires — the layer is deciding real hands                      |
| Working tree                        | clean, branch `agent/cowork-fable/fix/multiway-value-bars` (merged) |

**Worktree:** `~/Documents/.agent-trees/club-arena/cowork-fable`
**NEVER** develop in the shared clone `~/Documents/club-arena`.
Commit author MUST be `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`
or Vercel refuses to build the commit (BLOCKED, no logs).

**Sandbox note:** the Linux sandbox mount **cannot unlink files**. `rm` fails
there and leaves stray files that will get committed. Delete scratch files
from the HOST (`counselors host_terminal`), always with
`export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`.

---

## 3. WHAT WAS SHIPPED TODAY (12 PRs, all MERGED)

| PR    | What                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- |
| #1810 | V30 turn/river solver aggregation; purged contaminated `facing` cells; removed the V29 facing consult |
| #1838 | V30 driver could not call its own RPC (PostgREST refused an unqualified DELETE)                       |
| #1848 | Labelled `gtoAggregationFinished` as a test seam (dead-export sweep)                                  |
| #1855 | Restored the measured batch floor a full-body replace clobbered + guard test                          |
| #1863 | Docs: what remained after V30; found `strategy_matrix_v2`                                             |
| #1873 | **PLO preflop scale bug** — raw Omaha score vs percentile thresholds                                  |
| #1876 | Quantile-match PLO onto the hold'em scale (the flat percentile overshot loose)                        |
| #1885 | **short_deck + pineapple** — same scale bug, opposite direction                                       |
| #1889 | Docs: postflop verified clean, no dead layers, V31 sizing                                             |
| #1890 | Docs: V31 builds 169x3 cells, not 1,326                                                               |
| #1896 | Docs: facing-a-bet is buildable; multiway was never blocked                                           |
| #1908 | **Multiway value bars** — horses c-bet 2% into four opponents                                         |

### THE ONE DEFECT CLASS BEHIND EVERY REAL BUG FOUND TODAY

> **A threshold calibrated on one distribution, applied to a different
> distribution. No error, no warning, no failing test — the bar just
> silently means something else.**

It shipped three times, on three different axes:

1. **Variant axis (preflop).** `decidePreflopV7`'s bars are
   percentile-intent, calibrated on `holdemPreflopScore`. PLO got the raw
   Omaha score (p99 0.64, max 0.85) so a 3-bet bar at 0.74 was unreachable:
   **plo4 opened 4% and 3-bet 0%**. short_deck (median 0.420) and pineapple
   (median 0.493) were inflated the other way: **opened 40%/51%, folded
   23%/15% to a pot raise**. Fixed by quantile-matching every variant onto
   the hold'em scale.
2. **Opponent-count axis (postflop).** Value bars are absolute equity
   (`equity >= 0.8 + mw`) calibrated heads-up, but `equity` is computed vs
   `min(oppCount,4)` opponents and that distribution collapses (median
   0.473 → 0.154). The bar meant "top 9%" HU and **nothing at all** 4-way,
   and `mw` pushed it UP on an already-collapsed distribution. **C-bet was
   2% into four opponents in every variant.** Fixed with
   `multiwayValueBar()`.
3. (Preflop, same as 1 — listed for completeness.)

**When you find a new axis, look for this pattern first.**

### The guards now in place (all on main)

- `server/src/engine/HorseOmahaPercentile.test.ts` (8) — PLO scale
- `server/src/engine/HorseVariantScaleParity.test.ts` (35) — all 7 variants x 5 stakes
- `server/src/engine/HorseMultiwayValueBar.test.ts` (5) — opponent-count scale
- `server/src/services/GtoAggregationDriver.test.ts` (6) — driver behaviour
- `server/src/services/GtoAggregationFloor.test.ts` (3) — batch-floor clobber guard
- `server/src/engine/GtoPostflop.test.ts` (40) — solver store, texture pins, facing refusal

**Every one of these was proven to FAIL for the right reason** (by reverting
the fix or simulating the regression) before being shipped. Do the same for
anything you add — a guard you have not seen fail is theatre.

---

## 4. HARD CONSTRAINTS — DO NOT VIOLATE

1. **`facing` cells must never return.** Every solved tree in
   `solved_spots_gold` is an OPEN node (`node` is only `r:0` or `r:0:c`;
   action sets are only `bet_*/check`). The v1 `f` values are EV/regret
   magnitudes, NOT fold frequencies — proven inverted: AA `f`=447.8,
   72o `f`=191.3, and 72o folds more than AA in **0 of 40 rows**.
   `setGtoPostflop()` refuses `facing !== 'open'` rows and a test pins it.
   Rebuilding a facing cell from this warehouse reproduces the 2026-08-29
   over-folding defect that affected ~1,366 live flop decisions.
2. **Never `CREATE OR REPLACE` the aggregator from an older copy.** Read
   `prosrc` and patch surgically. See §1b.
3. **Never touch the CALLING side's raw equity.** `required = potOdds + ...`
   and `eq15 >= potOdds - 0.04` compare a probability to a probability.
   Normalising those misprices every call. Only VALUE-BET bars get scale
   transforms.
4. **Never run an unbounded query against `solved_spots_gold`** (79 GB,
   8.8M rows). A single `COUNT` starved the DB on 2026-08-15. Filtering on a
   non-indexed column (e.g. `strategy_matrix_v2->>'board' = '...'`) forces a
   full scan — I did this once and timed out. Use `TABLESAMPLE` + `LIMIT`.
5. **No `--no-verify`, ever.** No emoji in source. Popups use First Letter
   Capitalisation and no em dashes. Horses are players, never "bots", and
   are never excluded from anything a human gets.

---

## 5. WHAT IS LEFT — RANKED

### 5.1 Finish V30 (running, unattended)

Turn 40.6% → 100%, then river (5.59M rows) starts automatically.
`v30-aggregation-tail-watch` runs every 8 hours, diagnoses stalls, re-checks
the clamp, verifies data soundness, and **deletes itself** when both streets
report `done`. Nothing to do unless §1 shows a stall.

### 5.2 BUILD V31 — the next real feature (design already settled by measurement)

`solved_spots_gold.strategy_matrix_v2` holds **1,891,817 rows that nothing
reads** (populated 2026-07-24 → 2026-08-15). It is strictly better than the
v1 column V29/V30 use:

|             | v1 (in use)                | v2 (unused)                   |
| ----------- | -------------------------- | ----------------------------- |
| granularity | 169 hand classes           | **1,326 exact combos**        |
| frequencies | contaminated at depth      | clean `[0,1]`                 |
| bet sizing  | inferred from codes        | explicit `size_pct`           |
| stack       | `stack_depth`              | **`eff_stack_bb`** + `pot_bb` |
| quality     | none                       | `exploitability_pct`          |
| node        | inferred from `tree_lines` | explicit `node` path          |

**The design decision is MADE, do not re-litigate it.** Measured: grouping
1,326 combos into 169 classes loses an average within-class spread of
**0.238**; adding ONE dimension (count of the board's flush suit) recovers
**67%** of it (worst row 39%, best 89%, n=83 informative rows). Combo level
costs ~110 MB resident (9x today's ~12 MB); `169 x 3` costs ~31 MB.

**So: build `169 x flush-suit-count(0/1/2)` cells. NOT 1,326.**

Combo decoding (verified): `card = rank*4 + suit`, `combo = b*(b-1)/2 + a`,
`2c2d = 0 .. AhAs = 1325`. Suit index **2 = hearts** (the method identified
this itself by testing all four indices on a two-heart board).

Build it BESIDE V30, prove equivalence-or-better with `EXCEPT` in both
directions before switching any consult, and agree a memory budget first.

### 5.3 Facing-a-bet play — buildable, NOT blocked (I was wrong earlier)

A facing LOOKUP is impossible (§4.1). But the open-node data contains **the
opponent's exact betting range**: `frequencies[bet_code]` is a 1,326-vector
at a known `size_pct`. Today the horse facing a bet computes MC equity vs a
behavioural HorseMind band; it could instead compute equity vs **the range
the solver actually bets there**, against the pot odds that size implies.
Storage cost ~zero — the bet vector IS the range, and V31 already aggregates
it. Do this as a follow-on to V31.

### 5.4 OPEN QUESTION — bomb pots (a real signal I could NOT convict)

Facing a bet, raise frequency falls **11% → 6% → 2%** (nlh) and
**13% → 5% → 2%** (plo4) as boards go 1 → 2 → 3, while calling balloons to
93%. Mechanism is real and measured: averaging equity across boards
compresses the distribution (p90 0.796 → 0.672; %≥0.80 falls 10% → 2%).

**I extended `multiwayValueBar` with a board dimension and it changed
NOTHING** (raise stayed 2%/1%). So the raise-facing path is gated somewhere
else. **I reverted that change** rather than ship untested surface area.

Two possibilities, both open:

- It is a genuine defect in whatever gates the raise-facing branch — find it.
- It is CORRECT poker: in a triple-board bomb pot you must win multiple
  boards, so raising far less is defensible. Unlike the multiway 2% c-bet,
  I could not prove this one wrong.

**Do not "fix" it without first proving it is broken.**

### 5.5 Lower priority / noted

- `(street, id)` composite index on `solved_spots_gold` would reclaim ~530ms
  per aggregation call (341 of 541 rows read are discarded). **Deliberately
  not done** — building an index on a 79 GB table is the operation class
  behind the 2026-08-15 incident. Only when the fleet is idle.
- ~56% of v1 turn rows carry no `tree_lines`/`frequencies` and contribute
  nothing. V31 sidesteps this entirely by reading v2.
- `v26_prize_read` fires only 52 times in 7 days; `icm_warming` 14. Both
  explained, neither proven defective. Worth a look someday.
- **~10 stale open PRs** on the repo, several duplicates of the same
  tournament money-path work (#1592/#1594/#1599/#1600, plus #1742, #1669,
  #1648, #1644, #1637, #1629, #1600). Not mine; someone should triage.

---

## 6. AXES ALREADY SWEPT — DO NOT REDO, EXTEND

| axis                  | coverage                                            | result                               |
| --------------------- | --------------------------------------------------- | ------------------------------------ |
| Variant               | all 7 live (nlh, plo4/5/6/8, short_deck, pineapple) | 3 broken, **fixed**                  |
| Stakes                | bb = 0.10, 0.50, 2, 100, 10,000                     | clean (<15pt drift, no lost mass)    |
| Street                | flop / turn / river, lead + facing                  | clean, no stuck valves               |
| Opponent count        | 1 / 2 / 4                                           | **broken, fixed** (#1908)            |
| Stack depth (SPR)     | 0.5 → 100                                           | clean (c-bet 69-76% flat)            |
| ICM / tournament      | bubble, 10 left 9 paid                              | clean (~12pt tightening, sensible)   |
| Board count           | 1 / 2 / 3 (bomb pots)                               | **open — see §5.4**                  |
| Dead code             | every `noteFire` label vs telemetry                 | clean, all fire                      |
| Postflop equity scale | all 7 variants                                      | clean (equity is a true probability) |

**Axes NOT yet swept** (candidates for you): hi-lo scoop/quarter logic
(plo8-specific), straddle pots, all-in/push-fold preflop short stacks,
short-handed vs 9-max preflop position mapping, and the `Math.min(oppCount,4)`
equity cap behaviour at 5+ opponents.

---

## 7. METHODOLOGY — THIS IS THE MOST IMPORTANT SECTION

**Five of the anomalies I found today were my own harness bugs, not engine
bugs.** Every one looked alarming. Every one was caught the same way: by
checking the MECHANISM before believing the number.

1. `gameVariant: 'plo'` — not in `OMAHA_VARIANTS`, so `isOmaha` was false and
   strength fell through to a constant `0.3`. Showed "the best hand in the
   game refuses to raise". **Production uses `plo4/5/6/8`; no table uses
   `'plo'`.**
2. `userId: 'h'` in synthetic history vs seat player `'h'+i` — `readInitiative`
   could not match, returned `'opp'`, correctly triggering the anti-donk gate.
   Showed **"0% c-bet in every variant including hold'em"**.
3. "The multiway model is 5x off" — equity is ALREADY computed vs N
   opponents. Would have double-counted dilution. (The real bug was adjacent
   but different — see §3.2.)
4. `tournamentId`/`tournamentContext` instead of `gameMode`/`gs.tournament` —
   ICM silently returned 0, so my "tournament" column was actually cash.
5. Short-deck measured with a 52-card deck instead of its 36-card deck.

**Rules that follow:**

- A measurement is a **question**, not a verdict. Explain the mechanism
  before you believe the number or act on it.
- **The comparison between variants/counts in an IDENTICAL state is the
  trustworthy signal. The absolute frequency from a synthetic harness is
  not.** Always include a known-good reference column (nlh, or oppCount=1).
- Match the engine's invariants exactly: `userId` must match the seat
  player, the deck must match the variant, tournament needs `gameMode` or
  `gs.tournament`, positions must be a real seat/dealer arrangement.
- **An optimization is proven by the throughput of the thing it was meant to
  speed up, never by a plan node.** I shipped a rewrite that was faster in
  `EXPLAIN` and slower in production; the cursor froze for 93 seconds.
- If a change is a **measured no-op, revert it.** Untested surface area in a
  live path is a cost with no benefit.

---

## 8. HOW TO SHIP (condensed)

```bash
cd ~/Documents/.agent-trees/club-arena/cowork-fable
git fetch origin --quiet && git checkout -B agent/<name>/<slug> origin/main
# ... work ...
cd server && npx tsc --noEmit && npx vitest run --reporter=dot src/engine src/benchmark
git add <explicit paths>
git -c user.name="Smarter-Poker" -c user.email="254329056+Smarter-Poker@users.noreply.github.com" \
    commit -m "..."
git push -u origin agent/<name>/<slug>
gh pr create --title "..." --body-file /tmp/body.md
gh pr merge <n> --squash --auto
# then POLL until MERGED and verify the deploy contains it
```

The full suite takes ~170s for `src/engine src/benchmark` (125 files / 1,364
tests) and ~102s for the rest (111 files / 1,290 tests). **Full green as of
this handoff: 236 files, 2,654 tests.** The sandbox bash tool times out
around 178s, so run the suite in those two halves.

CI required checks: TypeScript Check, Client Unit Tests, Server Engine,
Production Build, CSS Beat E2E, Silent Revert Guard. `gh pr checks` and the
check-runs API are **403 for this token** — poll `gh pr view <n> --json
state,mergedAt` and the `actions/runs?head_sha=...` jobs endpoint instead.

The engine deploy defers behind a drain gate and a **45-minute staleness
cap**, so your commit often lands via a LATER deploy run that contains it.
Verify with `git merge-base --is-ancestor <your-sha> <deployed-sha>`.

---

## 9. YOUR FIRST FIVE ACTIONS

1. Run §1 and confirm the V30 cursor is advancing (or fix it).
2. Read the four changelogs in §0.4 (multiway, blocked-items, v31-design,
   variant-scale-parity).
3. Run the guard suites to confirm a clean baseline:
   `npx vitest run src/engine/HorseMultiwayValueBar.test.ts src/engine/HorseVariantScaleParity.test.ts src/engine/HorseOmahaPercentile.test.ts src/engine/GtoPostflop.test.ts`
   (expect 88 passing).
4. Pick ONE: build V31 (§5.2), or convict/clear the bomb-pot signal (§5.4),
   or sweep a new axis from §6.
5. Whatever you pick — measure first, explain the mechanism, and only then
   change code.
