# 2026-08-29 — V29: the flop plays from the solver, and the wiring exposed a heads-up inversion

The next phase Dan ordered. Three deliverables: Stage 2 of the solver
integration (the 8.8M postflop CFR solutions reaching live decisions), the
deferred ICM-feed truncation fix from the V28 audit, and one brand-new
critical find the new wiring itself exposed.

## The aggregation: 79 GB → 12 MB, without touching the hot path

`solved_spots_gold` cannot be read live (the 2026-08-15 incident: a cron that
merely _counted_ its rows starved the platform). So the flop layer was
aggregated **offline, in 24 index-driven batches of ≤6k rows each**
(`fn_aggregate_gto_flop`, one game_type per call — one 7-batch attempt hit
the statement timeout, rolled back cleanly, and was rerun singly).

Every flop row in the warehouse — **66,416 solutions** — folded into
`gto_postflop_compact`: **5,556 cells, ~12 MB**, keyed by (game family,
position, depth bucket, **texture class**, facing). The texture class is the
honest core: solved boards are a canonical subset a live flop never
exact-matches, so boards are classed by high card / suit distribution /
pairing / connectivity (48 classes) and the cell is the **class-mean** of the
solver's answers. Stated plainly in the code: it replaces hand-tuned
literals with solver-derived frequencies; it does not claim to be an exact
solve of the live board. The SQL classifier and the TS mirror are pinned
against **shared examples classified by the production function itself**.

Sanity check from the first batch, before anything was wired: AKs on a dry
K-high board c-bets ~90% in position and checks 73% as the OOP small blind —
the shape a solver actually produces.

## What the horse now plays from it (heads-up hold'em flops)

- **With the betting lead, checked to:** the check / bet-small (~⅓ pot) /
  bet-big (~¾ pot) mix, rolled at the solver's frequencies.
- **Facing the first bet:** fold / call / raise-small / raise-big, same way.
- **Two guards:** a solver _fold_ is vetoed when live MC equity is
  overwhelming (≥ 0.72 — the cell is a class mean and this exact board can be
  far better for hero), and the V11 price-in rule still forbids folding at a
  price any two cards beat. The valve only ever prevents folds.
- Tournament spots prefer the ICM aggregate and fall back to chip-EV — never
  the reverse (ICM advice in a chip-EV spot over-folds). Texture is **never**
  substituted: a rainbow cell does not answer a monotone board.
- Raised pots keep the V23 plan / V21 war-gate machinery — the cells only
  describe the first bet. Donk-lead spots keep the V11 initiative gate.
- Empty store → null → yesterday's heuristics, pinned by ablation equality
  exactly like V27. Telemetry: `v29_gto_flop_open`, `v29_gto_flop_defend`.

## The find: heads-up positions have been inverted since V13

The V29 wiring test asked for the dealer's chart and missed — because
`classifyPosition` handed the **dealer** the 'bb' label. The clockwise walk
labels the first seat after the button 'sb', which is correct in a ring and
**backwards heads-up**, where the dealer posts the small blind. The old
line's own comment said "heads-up: dealer is SB" while the code did the
opposite.

Consequences at every two-handed table — HU cash, HU SNGs, and **the end of
every tournament**: the blind-vs-blind widened open fired for the wrong
seat, the V27 push/fold charts were consulted with positions swapped, and
V29 would have missed or answered from the wrong side. Fixed to
`heroSeat === dealerSeat ? 'sb' : 'bb'`, with a source pin and a behavioral
pin. Notably, **zero existing tests broke** — nothing had ever pinned
heads-up position identity, which is how it survived four months.

## The ICM feed truncations (V28 audit H3, now fixed)

- **The payout curve was sliced to 9 places and the rest discarded** — a
  1,200-runner event paying 150 was modelled as a 9-paid tournament, and
  telemetry called the path 'real'. The 9th bucket now carries the sum of
  every remaining paid place: total paid mass is preserved.
- **Stacks were the top 200 only, zero-chip players excluded** — hero's chip
  share was computed against only the big stacks in any field past 200. Now
  a **quantile sample** of the whole sorted field: shape, mean and hero's
  relative standing survive; only resolution is lost.
- **The context cache dropped every tournament at once** when full
  (`cache.clear()`) — every horse in every event on the flat premium
  simultaneously. Now evicts the stalest quarter.

## Verification

`npx tsc --noEmit` exit 0; full suite green with 24 new pins (texture-class
contract against the production SQL, lookup semantics including
absent-hand-is-fold on facing nodes and silence on open nodes, the safety
valve, ablation equality, the HU inversion, bvb reaching the true SB).
Aggregation applied to production and verified cell by cell before any code
consulted it.
