# The solver cannot answer 800 blinds, and now says so (2026-09-01)

## Three problems, one area

### 1. The depth ceiling did not exist

`DEPTH_BUCKETS` stops at 150 and `snapDepthBucket` returns 150 for **any**
stack over 110. A 400bb hero and an 800bb hero were both answered with 150bb
strategy -- silently. `gto_depth_fallback` could not catch it, because it only
fires when the cell comes from a NON-primary bucket, and for an 800bb stack
150 _is_ the primary.

`depthCandidates` already refuses the mirror image of this and says why:
answering a 150bb hero from the 10 cell is "the one substitution more dangerous
than the texture substitution these files explicitly refuse to make, because a
10bb solver jams and stacks off exactly where a 150bb player must not."
Serving 150bb strategy eight hundred blinds deep is the same error with the
sign flipped, and it had no guard at all.

`GTO_MAX_DEPTH_BB` is twice the deepest bucket. That is not a round number:
the buckets are geometric, so `log(300/150)` is exactly `log(20/10)` -- the
widest substitution the depth fallback already makes. Past it the consult
declines and the heuristic layers, which scale continuously with depth, play
the spot. `gto_skip_too_deep` records it.

Related evidence from the same audit: 4 of the day's 10 largest losses were
deep tournament stackoffs (JJ in for 40,788, AKs for 40,000, TT for 21,693)
and `gto_depth_fallback` fired 874 times. Those specific hands were **preflop**
and these layers are postflop, so this ceiling is not claimed as their fix --
it removes the extrapolation that made deep spots read like 150bb spots.

### 2. The misses had no address

V32 recorded `v32_defend_no_range` 9,693 times against 7,202 usable answers --
a 57% miss. V31 answered 165 consults against `gto_miss_no_cell` 12,193, a 1.3%
hit rate. The counters proved a hole existed and could not say where, so the
only available responses were to guess at the export or widen the gate.

Misses are now recorded against two axes: `v31_miss_depth_*` / `v32_miss_depth_*`
(five bands) and `v31_miss_street_*` / `v32_miss_street_*` (four streets).
Deliberately not the full street x family x position x depth product -- that is
~432 rows a day and unreadable.

A skip for depth is **not** counted as a miss. If it were, the coverage figure
would move with the fleet's stack depth rather than with the warehouse's
contents, which is the one number this work exists to produce.

### 3. The solver stack had no ablation matchup at all

V29 through V32 shipped between 08-29 and 08-30. They short-circuit the mature
V15-V23 layers on every spot they answer -- normalised per 1k decides,
`v18_self_image` fell 213 to 31 and `v17_pos_behind` 210 to 87 in one day --
and nothing on the league card could say whether that trade was positive.

Five matchups added: `v29_gto_flop`, `v30_gto_turn_river`,
`v31_gto_suit_aware`, `v32_facing_defense`, `v33_depth_ceiling_400bb`. All at
`seats: 2`, because the gates require heads-up hold'em with the betting lead.

The depth-ceiling matchup is dealt at 400bb on purpose: at the standard 100bb
the flag changes no decision, so it would report `0.00 +/- 0.00` forever --
exactly the inert-matchup shape the daily audit now flags.

## Status of the claim

The ceiling ships default-on as a **correctness** fix, argued from the
principle this file already states, not as a claimed improvement. It is
flag-gated and now has a matchup. If `v33_depth_ceiling_400bb` comes back
significantly negative, the hypothesis is wrong and it should be ablated --
that is what the matchup is for.

None of these numbers can be read until the league runs again; see
`2026-09-01-a-lost-nightly-job-is-loud.md`, which fixes the runner that lost
three days in four.

## Verification

`GtoDepthCeiling.test.ts`, 11 tests. Full server suite after the change: 306
files, 3420 tests, 0 failures. `npx tsc --noEmit` clean.
