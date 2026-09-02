# 2026-08-29 — V28 part 2: flop, turn and (most importantly) the river

The second half of Dan's line-by-line audit order. Part 1 (PR #1752) fixed
preflop and the input wires; this fixes the postflop decision tree, the
evaluator, and the opponent model. Every item was proved with a code trace
before it was changed.

## The headline: pot odds priced money that could never change hands

`toCall` was the villain's **full wager** even when it dwarfed hero's stack.
Facing a 500 jam with 50 behind and 100 already in the middle, the truth is
"risk 50 to win 200" — 25% required equity. The code computed
`potOdds = 500/1100 = 45%`, added commit premiums on top, and **folded correct
calls against any opponent who covered** — worst on short stacks and
tournament bubbles, i.e. exactly where call-offs decide tournaments. Every
big-bet read misfired off the same inflated number (`potFrac = 5.0` read as a
5x-pot "tell"), and SPR collapsed _because_ the opponent overbet, declaring
hero committed on the wrong premise.

The preflop engine has done this correctly since V11 (`effCall`); postflop
simply never did. `toCall` is now capped by stack and the uncallable excess is
stripped from the pot before any ratio is computed. The legalizer still sees
the raw state.

## The river, specifically

- **The bluff side of the 500bb river wars found.** The blocker raise-bluff
  could **re-raise a river raise with air**: the V21 war gate ("once hero's
  river aggression is raised, only the effective nuts keeps raising") lives
  inside the value branch and never reached it. Hero's raised aggression now
  closes the bluff-raise too.
- **A dominated flush no longer overbets.** V21 nut discipline (which flush?
  whose boat?) was consulted only on the _calling_ side — `cat >= 6` was
  enough to fire a 1.3–1.6x pot river overbet with a nine-high flush on a
  four-flush board. The betting tree now consults `dominated21`: no overbet,
  and monster sizing capped at half pot.
- **Two bluff sites had no clamp.** The multiplier product (exploit × blocker
  × position × HU × river-read × spin × image × behind) reaches ~4.6; with
  the scare boost the roll probability exceeded 1 — a **deterministic** river
  bluff in the exact spot where the opponent's range is strongest. Clamped —
  with the clamp binding `bluffScale` alone so the V16 unblocker distinction
  survives (the first attempt clamped the product and erased it; its own pin
  caught that).
- **The block bet exists again.** `snapFraction`'s passthrough floor was
  0.25, so the 0.27–0.33 river block bet and the V10 small range-advantage
  c-bet both snapped into the 0.33 family — two deliberately distinct sizes
  unobservable in production, behind a green test pin. Floor raised to 0.31.
- **Rake drag was applied at ~60% of its true size** (`pot(1-r) + toCall`
  instead of `(pot+toCall)(1-r)`) — horses called marginally too wide in
  small raked cash pots, the opposite of the layer's intent.

## Commitment and plans

- A short all-in **call-off** was counted as a "serious all-in"
  (`isFullRaise !== false` matched the undefined flag HandController sets for
  exactly that case) — one priced-in short stack triggered the pressure caps,
  the commit premium and the scare cap, and the horse over-folded because
  somebody was _priced in_, not aggressive. Now strict.
- `raisedAfterAggr` was gated on `useV15`, silently disabling parts of V20,
  V21 and **all** of the V23 raise-response plans — every league ablation of
  "V15 discipline" measured four layers at once. Computed unconditionally now.
- The committed branch ran before every plan consult and could **jam over a
  `callOnce` plan**; and a `foldToRaise` plan could raise-FOLD a stack that
  had already committed 30% of itself this hand. Both now honor the postflop
  mirror of the V25 commitment law: invested money commits, and committed
  stacks don't raise-fold.

## The evaluator

- **`connectsBoard` returned the board's own hand on every fall-through** —
  32o on K-K-7 "connected" with the board's kings, so the V12/V16 aggressor
  conditioning was a no-op on every paired board (~17% of flops, every board
  once it pairs). This was the exact pre-V13 bug the guard's own comment
  claims was fixed; the guard covered only the early return.
- **The Omaha contact redraw escaped the read band** — uniform redraw, never
  re-tested, so a [0.4, 1] "open" read redrew into the bottom 40% of the
  combo space. The V13 collapse, still live on the Omaha side. Routed through
  `placeOmahaBandCombo`, the in-band sampler V16 built for precisely this.
- **Playing the board flush read as the NUT flush** — on a monotone five-card
  river a hero with zero suited cards skipped the flush block, left
  `higherFlushRanks` at 0, and every consumer read "nut flush" for a hand
  that can do no better than chop. Now reports the dominated truth.
- **Hi-lo got the fewest Monte Carlo iterations (140) with the widest
  per-iteration variance** — scoop/quarter frequencies were strategy triggers
  at ~4pp standard error. Raised to 220, and the variant ternary reordered so
  hi-lo is tested before the plo5/plo6 literals.

## The opponent model

- **`facedAggr` was not "faced aggression"** — every call incremented it (a
  limp counted as "faced aggression and did not fold") and raises-over were
  excluded from the denominator. A player who folded 5, called 3 and
  raised-over 10 read as a 62.5% folder and was classified a nit. Both
  directions fed `exploit()` and through `tableExploit` every postflop bluff
  decision on the platform. Now gated on genuinely facing a bet, with
  raises-over counted.
- **A two-street CALLER read as a checked/capped line** — and the sampler
  then discarded their trips-or-better at 79%, inflating hero's equity
  against the strongest passive range in poker and driving thin value and
  river bluffs into a range that is calling. A check is capped; a call is not.
- **The multiway bluff exploit was unreachable** — `tableExploit` seeded
  `bluffMod` at the neutral 1 and only ever min'd down: three 70% folders
  produced `min(1, 1.45, …) = 1`. Seeded properly; a table of folders now
  registers.
- **The V18 self-image had its sign inverted** — the denominator was
  bets+calls with checks counted nowhere, so the tightest horse read as 0.86
  "aggressive" and had its bluffs _throttled_, while a station's calls
  diluted it below 0.35 and earned a bluff _boost_. Checks now counted.
- **No 4-bet tier existed** — any raise-over-a-raise read as a 3-bet
  ([0.62, 1.0], top ~11%) when real 4-bet ranges are top 2-3%. The horse
  priced its hand against a range four times too wide in the biggest preflop
  pots on the site. Added [0.86, 1.0].
- **`hasBlocker` could not see the wheel or anything below a ten** — the ace
  on a 2-3-4 board (the single best blocker) was invisible, and a nine
  blocking 9-8 on 5-6-7 was rejected by rank. Both fixed.
- **Plans were wiped mid-hand** — `notePlan`/`noteRaisePlan` did a wholesale
  `.clear()` at the cap, the exact failure the V12.3 doctrine forbids,
  reverting raise responses to independent dice rolls. Now `evictOldest`.
- **A hydrate destroyed live unpersisted counters** — `importStats` replaced
  the whole object, zeroing the V23 river reads and the recency window. Now
  keeps the larger of live and incoming per unpersisted field.
- **`valueThinMod` becomes two-sided** — a nit's thin-value bar now moves
  down as well as a station's moving up, waking the dead half of V18 exploit
  sizing.

## Verification

`npx tsc --noEmit` exit 0. Full suite green (2,426 tests), 11 new pins in
`HorseV28Postflop.test.ts` including the headline effective-stack call-off,
the paired-board no-contact rule on both the flop and river shortcuts, the
board-flush domination, and the opponent-model semantics. One in-progress
regression was caught by an existing pin (the V16 unblocker distinction) and
fixed before commit — which is those pins doing their job.
