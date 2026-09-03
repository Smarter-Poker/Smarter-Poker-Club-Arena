# 2026-08-27 — Phase 5: HORSES ARE PLAYERS, swept estate-wide

Dan, 2026-08-27, binding (World Hub CLAUDE.md 10.5): "HORSES ARE NEVER EVER
DISCLUDED BY DESIGN ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE
PLAYERS!"

The law landed while phase 4 was shipping, along with a migration that fixed
three violations. This phase swept everything the law touches - 30 production
functions, every view, both client apps and the engine - to find what the
first pass missed.

## The headline: the law's own first fix was inert

`fn_nit_evictions` had its horse-only predicate removed on 2026-08-27, with a
comment reading "Same rules for everyone now; fn_nit_check's own sample floor
spares a short sample, horses included."

It could never bite. The rule is judged by `fn_nit_check`, which computes VPIP
**entirely from `ca_hand_facts`** - and the engine's `writeHandFacts` carried:

    if (!humanIds.has(uid)) continue; // humans only

`ca_hand_facts` held **0 horse rows against 544 human ones**. So a horse's
sample was not short, it was permanently EMPTY. Both branches of fn_nit_check
compare a sample count against a floor (`hands >= max(maintain_hands*10, 100)`),
and `0 >= 100` is false, so **every horse returned `within_limits` for ever**.

Proved against production inside a rolled-back transaction. NIT Game set to
demand a 99% VPIP - a threshold no player alive can meet:

|           | result                                                         |
| --------- | -------------------------------------------------------------- |
| **human** | `ok=false, reason=career_vpip, vpip=24.6, hands=544` - evicted |
| **horse** | `ok=true, reason=within_limits` - immune                       |

The horse was immune not because of any rule about horses, but because its
evidence was never written. A fix at one end of a rule, with an assumption
about the other end.

### The fix, and the proof it works

`writeHandFacts` now writes fact rows for horses **at NIT tables**, so the rule
and the evidence it is judged on cover exactly the same seats. `nit_game` is
threaded from `tableInfo` through `logHandHistory` rather than re-read per hand.

Same probe, rolled back, after writing the evidence the patched engine
produces:

    BEFORE  fn_nit_evictions includes the horse: false
    AFTER   fn_nit_check -> ok=false, maintain_vpip, vpip=0.0, hands=30
    AFTER   fn_nit_evictions includes the horse: TRUE

That is the whole chain: engine writes evidence, rule sees it, the eviction
list the dealing loop consults contains the horse, and it is stood up like
anybody else.

**Scoped to NIT tables on purpose.** Horses play ~221k hands a day and this
table carries one row per player per hand, so writing every horse hand
platform-wide is ~1.3M rows a day. That is a storage decision with a real
bill, and the law itself draws exactly this line for hand-history retention:
**the knob is Dan's, not an agent's.** Today zero tables have NIT Game
enabled, so the fix costs nothing and starts working the moment one does.

## What was swept, and what was clean

**Database (30 functions mentioning `is_horse`, every view):**

- All six `p_include_horses` report parameters **default to true**, as the law
  demands, and no caller anywhere passes `false`.
- `cash_tables_needing_engine` is already fixed - `human_count` is returned as
  data and the engine only logs it; any occupied table gets an engine.
- `club_member_daily_stats` (286,589 horse rows vs 60 human) and `player_stats`
  (1,727 vs 5) count horses in full, so the leaderboard, VIP basis and stats
  are compliant. `ca_club_top_players` returns `is_horse` as a column and
  filters nobody.
- `fn_seat_club_for_user` / `fn_tournament_club_for_user` use the flag to
  spread horses deterministically across a union's clubs - plumbing, denying
  nothing.
- `fn_club_union_join_blockers` leaves horses out of the blocker total, but
  reports `horse_wallets`, `horse_count` and `horses_block: false` explicitly.
  Leaving horses out of a RESTRICTION takes nothing from them, and it is Dan's
  own 2026-08-26 instruction ("horses keep all there chips"). Flagged for him
  since the newer law is stricter.
- No view excludes horses. `is_bot`, the second horse-identifying flag, appears
  in only two functions, both already classified.

**Client and engine:** nine sites where the flag changes behaviour, all now in
the gate's register with a written justification - see below.

## The gate: `scripts/ci/check-horses-are-players.mjs`

The law is one day old and its first fix was already inert, which is the
argument for making it mechanical rather than trusting the next reader.

The gate finds every place the horse flag changes behaviour and holds it
against a **register** in which each entry is a claim, in writing, that the
difference is one of the two things the law still allows: IDENTIFICATION, or
EQUAL OUTCOME by another road. A new exclusion anywhere fails the build until
somebody writes down which it is.

It deliberately does **not** guess which way a negation cuts:
`if (!seated?.is_horse) continue` excludes horses in `handFacts` and SELECTS
them in `ServerTableEngineRunout`. A script that guessed would eventually guess
wrong about a rule that decides whether a player is thrown out of a game. It
caught three horse-only sites my own manual grep had missed, which is the point.

Wired into `ci.yml` beside the other copy gates and into `all-gates.sh`.

### The register as it stands

| File                             | Kind           | Why                                                                                                      |
| -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `clubDashboard.ts`               | IDENTIFICATION | Player toggle, defaults to SHOWING horses                                                                |
| `ServerTableEngineBase.ts`       | EQUAL OUTCOME  | Deploy drain gate; chips preserved either way, and counting horses would mean no deploy could ever drain |
| `ServerTableEngineDealing.ts`    | EQUAL OUTCOME  | Rebuy pause - the law's own worked example; horses get it via `autoRebuyHorse`                           |
| `ServerTableEngineSettlement.ts` | IDENTIFICATION | Horse cash-out plumbing                                                                                  |
| `ServerTableEngineRunout.ts`     | IDENTIFICATION | Horse-ONLY: pineapple discard and insurance response - grants, not denials                               |
| `HorseHandReview.ts`             | IDENTIFICATION | Horse-ONLY leak reviews; horses get more here, not less                                                  |
| `faultInjection.ts`              | EQUAL OUTCOME  | Refuses a chaos drill where a human sits; declining to inflict damage is not a benefit withheld          |
| `handHistory.ts`                 | IDENTIFICATION | `has_human` for the retention purge - Dan's open knob                                                    |
| `handFacts.ts`                   | EQUAL OUTCOME  | Horses get fact rows at NIT tables, so rule and evidence match                                           |

## Raised for Dan, not decided by an agent

1. **Full hand facts for horses everywhere** (~1.3M rows/day). Today the fix is
   scoped to NIT tables. Turning it on platform-wide would also give horses a
   career VPIP history built from all tables, as humans have; the residual
   asymmetry is that a horse's career sample only accrues at NIT tables.
   Same shape as the retention knob the law already reserved to Dan.
2. **Trivia PvP horses are not economic participants.** A horse opponent is
   synthesised with `charged: false`, and when it wins, the payout is skipped.
   Nothing is taken from the horse, so it is not a violation as it stands -
   but paying it while it never pays in would MINT diamonds. Making horses true
   participants means charging them a stake as well; that is a design call.
3. **`fn_club_union_join_blockers`** - see above.
4. **Language:** a comment in `ServerTableEngineRunout` still reads "horse chips
   are house chips anyway". Functionally harmless, but it is precisely the
   mental model the law overturns and the next reader will act on it.
5. **Pre-existing, unrelated:** `npx tsc --noEmit` in `server/` is red on main -
   vitest `MockInstance` typing in `HorseFleetNoDuplicateTables.test.ts` and
   `errorReporter.ts`. Verified identical on a tree with no server changes.

## Verification

`bash scripts/ci/all-gates.sh` - tsc clean, all ten house gates OK (including
the new one), full vitest suite OK. Server typecheck shows only the
pre-existing failures above, none in the files this phase touched.
