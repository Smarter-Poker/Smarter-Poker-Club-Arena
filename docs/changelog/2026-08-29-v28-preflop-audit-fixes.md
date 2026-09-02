# 2026-08-29 — V28 part 1: the preflop line-by-line audit, and eleven bugs it proved

Dan: _"START WITH A FULL LINE BY LINE AUDIT OF THE ENTIRE PROCESS, CHECK FOR
ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE
AND EVERYWHERE ... ONCE YOU'VE FULLY BUILT, IMPROVED, ENHANCED AND OPTIMIZED
PREFLOP, MOVE ONTO FLOP, TURN AND MOST IMPORTANTLY RIVER."_

Four parallel line-by-line audits covered the input wiring
(`ServerTableEngineTurns`), the preflop engine (`HorsePreflop` + the glue),
the evaluator (`HorseEval`) and the opponent model (`HorseMind`) — every
finding below was **proved** with a code trace before anything was changed.
This PR is the preflop half plus the input wires; postflop ships separately.

## The headline: a short all-in made the whole table play imaginary 3-bets

An all-in that is not a full raise carried `isFullRaise: false/undefined` and
the router counted it as **neither** a raise **nor** a caller — yet it still
moved `currentBet`. `unopened` came out false with `raises === 0`, an
unhandled state that fell through `HorsePreflop`'s ladder into the **"facing
a 3-bet or bigger"** block: top-7% to raise, top-25% to call. A 1.5bb
open-shove was folded to by KJ, A9 and every pair below TT — **getting better
than 5:1** — on essentially every tournament short-stack under-shove.

Fixed at the counter: an all-in that moved the bet is a raise for routing
(HandController's flag semantics are the discriminator — `undefined` means a
call-off, which now counts as a caller). This also un-breaks the `limpers`/
`callers` counts, the squeeze detection, and the V27 chart gates that keyed
on those counters.

## The straddle fix only worked for one seat

V18's gate required `history.length === 0` — but the engine records **every**
action including folds, so only the first actor ever saw a straddled pot as
unopened. After one fold, 5 of 6 seats played "facing a 3-bet" thresholds
against dead money — the exact bug V18 was written to fix, still live for
everyone but UTG+1. The pot now stays unopened until someone actually raises
(any real raise over a 2bb straddle is ≥4bb, so the shape test still
separates the cases).

## The rest, in one line each

- **'middle' position was unreachable at 6-max** — early = first ceil(n/3),
  late = last two left the middle bucket empty. The hijack was 'early' (3-bet
  on the top-14% bar instead of top-20%), the V20/V25 middle reshove layers
  were dead code, and V27 could never select the MP chart. Thirteen tests
  injected 'middle' directly and stayed green while it was unreachable live.
- **"Folded to the BB" is not heads-up** — `oppsLeft === 1` fired the HU
  defense (call bar 0.30) against a full-ring **UTG** open. Now requires a
  two-handed table or a genuine SB-vs-BB spot.
- **A tight horse could never 4-bet kings** — tightness 1.12 pushed the 4-bet
  bar to clamp01(1.04) = 1.0; only jittered aces cleared it. Bars now cap at
  0.965.
- **The SB completed any two cards 70% of the time** — `|| position === 'sb'`
  bypassed the strength test entirely. Play-visible as "the small blind never
  folds". Now a real (wide, but real) completing range.
- **The bluff squeeze was sized bigger than the value squeeze** (4.0–5.5x vs
  3.0–4.2x) — a direct sizing tell. Bluffs now mirror value, a shade under.
- **The 169-hand ladder had domination inversions** — 72s outranked 43s (the
  rag bucket ignored gap), J8s < T8s, J9s > K9s. And **every wheel ace sat
  below the 3-bet bluff floor** (A5s 0.544 < 0.55), so the canonical
  ace-blocker bluff was unplayable while KTo bluffed instead. All reordered.
- **Short deck did not know its own wheel** — A6-A9 got no connectivity for
  the A-6-7-8-9 straight; A6s was scored exactly as in the full deck.
- **The PLO price-defense flag rescaled NLH arithmetic** — `ploPriceDefense`
  had no isOmaha guard, so ablating V24 moved every NLH cold-call threshold
  and no A/B of it measured what its name says.
- **Opens now ladder by depth and antes** — the open was a flat 2.2–3.0x at
  every depth; ante pots open ~2.1x, short stacks ~2.2x, deep cash bigger,
  late position the small end of its band.

## The input wires (what the brain receives)

- **The time-bank tank auto-folded once the bank ran dry.** The sentinel path
  scheduled the action past the turn clock with no check that a bank existed
  — after a horse's 2 uses, the clock expired, the seat auto-folded, and the
  real decision (weighted toward big river calls) was silently discarded. The
  burn now fires only when a full activation is genuinely available.
- **`is_sitting_out` was hardcoded false**, so a blinding-off seat counted as
  a live opponent everywhere — at a 3-handed final table with one player
  disconnected, the heads-up branches never fired. The DisconnectEngine's
  truth is now stamped onto the players array the brain reads.
- **The opponent model's whole-hand observation was gated on a successful DB
  insert** — during any database incident the fold-to-c-bet / fold-to-3-bet /
  sizing-tell reads went silently dark. The in-memory observation now runs
  regardless.
- **Profile dials are clamped at the read boundary** — a manual
  `horse_profile` edit of `tightness: 0` played every hand; now pulled into
  [0.6, 1.5] on read.
- **V27 chart depth includes the posted blind** (a 10bb BB read as 9bb and
  snapped one chart shallow), and **the open-jam chart is never consulted
  over a live all-in** — it prices fold equity that does not exist there.

## Verification

`npx tsc --noEmit` exit 0. **2,415 tests pass**, 16 new pins in
`HorseV28Audit.test.ts` — one per proved defect, each naming the production
consequence it prevents. One existing margin was consciously relaxed
(`HorseBoardRanges` conditioning delta 0.03 → 0.02) in the same commit that
recalibrated the ladder the band percentiles are defined over; the pin's
direction is unchanged.
