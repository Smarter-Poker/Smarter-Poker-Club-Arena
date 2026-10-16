# Horses read each opponent at the table and exploit them (2026-10-16)

Dan, verbatim: "HORSES are not table aware of how their opponents are playing
against them. I'm raising and potting at a 100% VPIP and raise frequency and
the horses are not adjusting to that or taking this into account for their
decision making process."

## Why they did not adjust (read from the code and production)

- The only read at decision time was HorseMind's LIFETIME counters. VPIP, PFR
  and 3-bet never decay, and below 40 scoped hands the pooled bucket (every
  game, cash and tournament) answers. Dan's stored row (user 47965354): 761
  pooled hands, VPIP 39.8, PFR 29.8, fold-to-aggression 65%, AF 1.18. In his
  short-handed Omaha scope (28 hands) that pooled row answered: bluffMod 1.45
  (bluff him MORE), no call-down adjustment.
- Preflop facing an open, the call and 3-bet bars depended on the raiser's
  SEAT only. Nothing widened against a wide opener.
- The postflop bluff read mixed preflop folds into fold-to-aggression, so a
  tight-preflop history got a postflop maniac bluffed more. Multiway, the
  call-down read was the table AVERAGE.
- Last five days of cash, horses facing a single open: NLH vs Dan
  fold/call/3-bet 88.2/9.8/2.0 (n=51) vs horses 73.7/22.1/4.2 (n=190);
  Omaha vs Dan 75.3/23.5/1.2 (n=81) vs horses 59.8/31.8/8.3 (n=132).

## What changed

`server/src/engine/HorseOpponentExploit.ts` (new, pure) reads each opponent
from DECAYED counters (half-life 30 completed hands, per read scope, memory
only, carried in the decision read frame so the second look sees the same
read): VPIP, PFR, raise-first-in, 3-bet, fold-to-3-bet, bet when checked to,
POSTFLOP fold to a bet, river call. Every statistic is a Beta posterior shrunk
to the horse-population mean (prior strength 6). It engages only when its
one-sided 90% credible bound clears the measured horse envelope plus 0.03,
and only on the side that matters (looser / more aggressive / stickier, plus
the over-folder). A fresh 100% raiser is read within 8 hands in every variant
at 3+ seats (`HorseOpponentExploit.test.ts`), on top of Dan's real stored
761-hand row too.

When an opponent is engaged:

- Facing their open: value 3-bet the top 40% (Omaha 30%) of what THEY open,
  flat the top 70% (big blind 85%); no bluff 3-bets or squeezes into a player
  who does not fold to them; 4-bet and call wider against an over-re-raiser;
  isolate a loose limper wider.
- Range reads (`bandFor`) use their measured width, and an over-aggressor's
  barrels narrow the read less.
- Bluffs are priced from POSTFLOP-ONLY fold-to-bet (x0.3 to x0.75 into a
  station, up to x1.5 into an over-folder); value bets are thinner and bigger
  into a station; strong hands trap more against an aggressor; the CURRENT
  bettor's own read prices the call (up to ~4 equity points), not the table
  average; tournament fold multipliers pick the same read up.
- The PLO4, PLO5/6/8 and remaining-variant pack deviations (wagers into an
  opponent-blind horse field) stay out against a station; the reference,
  which carries the read, decides.

Applies to NLH, PLO4/5/6/8, FLH, FLO8, Short Deck and Pineapple, cash and
tournaments. The Phase 13 joint path is shadow live (no selection), so it
decides no live action; its tournament fold multipliers read the same layer.

## The population envelope (measured, not guessed)

Production, SELECT only, every hand logged 2026-10-15T17:30Z..16:30Z:
1,186,859 hands, 3,187,553 horse seat-hands, 1,000 horses, read from
`hand_history.actions` with the query recorded in the module and run through
the exact live counting code. Per (game, table size): pooled horse mean;
band = P1-P99 of per-horse rates (horses with 40+ opportunities, when 30+
qualify), else a method-of-moments beta-binomial spread (+/- 2.33 sd,
floored at 0.08), else +/- 0.20 for games few horses play. Version
`horse-population-2026-10-16`.

False engagement, replaying every horse's own real sequence through the
decayed counters and the gate: 2,023 of 3,187,553 seat-hands (0.063%). NLH
0.085%, PLO4 0.024%, PLO5 0.059%, PLO6 0.004%, PLO8 0.27%, FLH 0%, FLO8
0.008%, Short Deck 0%, Pineapple 0.017%. Simulated horse styles across every
band: under 1% (`HorseOpponentExploit.test.ts`).

Dan's own 248 logged hands since 2026-10-09, replayed: the read engages at
his 9th hold'em full-ring hand and his 17th Omaha full-ring hand.

## Proof that horse-versus-horse play did not change

`HorseOpponentExploitNeutrality.law.test.ts` replays a corpus RECORDED FROM
MAIN 8b7d96f9 BEFORE the layer existed: 74,915 decisions, all nine variants,
cash and tournament, every seat a horse, one HorseMind learning over 600
hands per run. Action, amount and the random-stream position after every
decision are chain-hashed every 50 decisions. While no opponent is engaged
the replay must be identical link for link. On this branch no opponent read
engages anywhere in the corpus, and the full replay is identical on all 18
runs (HORSE_NEUTRALITY_FULL=1).

The locked strength matrices are inert to the layer by construction (a fresh
HorseMind sandbox per hand). Shard 0 of each locked contract was rerun in
contract mode on main 8b7d96f9 and on this branch before the river-probe
patch (4d2350e3), and every result field but the wall-clock duration is
identical, pair digest included:

| matrix   | shard                                   | pairs  | decisions | pair digest |
| -------- | --------------------------------------- | ------ | --------- | ----------- |
| P10 PLO4 | p10c-6max-2dealt-100bb-10201109-s0      | 23,040 | 150,923   | 6a5ee401... |
| P11 PLO5 | p11c-plo5-6max-2dealt-100bb-11201117-s0 | 9,792  | 70,935    | e9b1aece... |
| P12 FLH  | p12c-flh-6max-2dealt-100bb-12401129-s0  | 12,960 | 114,209   | 6acd4e29... |
| P13 NLH  | p13c-nlh-3dealt-100bb-13211143-s0       | 45,360 | 416,152   | 8e25db51... |

The river-probe patch (below) deliberately changes river play for every
horse, so the requalification runs on the final commit measure it too.

## Measured against an always-pot-raise seat (paired, same state, same random position)

`HorseOpponentExploitBehavior.test.ts` (the test plays 100 hands per run; this table is a 300-hand run of the same harness), layer on vs off:

| run             | fold to its open | value 3-bet  | river call   |
| --------------- | ---------------- | ------------ | ------------ |
| NLH cash        | 0.78 -> 0.36     | 0.08 -> 0.33 | 0.57 -> 0.86 |
| PLO4 cash       | 0.62 -> 0.51     | 0.04 -> 0.15 | 0.50 -> 0.50 |
| PLO5 cash       | 0.61 -> 0.49     | 0.06 -> 0.24 | 0.57 -> 0.57 |
| PLO6 cash       | 0.53 -> 0.46     | 0.08 -> 0.23 | 0.67 -> 0.67 |
| PLO8 cash       | 0.65 -> 0.55     | 0.03 -> 0.12 | 0.45 -> 0.55 |
| FLH cash        | 0.68 -> 0.33     | 0.09 -> 0.33 | 0.61 -> 0.89 |
| FLO8 cash       | 0.51 -> 0.48     | 0.03 -> 0.13 | 0.74 -> 0.85 |
| Short Deck cash | 0.74 -> 0.29     | 0.07 -> 0.36 | 0.46 -> 0.54 |
| Pineapple cash  | 0.76 -> 0.29     | 0.08 -> 0.37 | 0.08 -> 0.54 |
| NLH tournament  | 0.79 -> 0.40     | 0.08 -> 0.31 | 0.20 -> 0.60 |
| PLO5 tournament | 0.60 -> 0.47     | 0.05 -> 0.22 | 0.57 -> 0.57 |
| FLH tournament  | 0.68 -> 0.37     | 0.08 -> 0.30 | 0.65 -> 0.90 |

Heads-up spot tests: strictly more traps against the maniac, strictly fewer
bluffs into a calling station, and the second look decoded from the read
frame makes the same decision.

## Also in this change

- The digest hole is closed: HorseLogic's own decision modules (HorsePreflop,
  HorseEvEngine, the solver charts and consults, the tournament preflop atlas
  and Phase 8 owner, HorseVariantProfile, HorsePersona, IcmModel, ...,
  HorseOpponentExploit) enter the Phase 10 (v3), 11 (v5), 12 (v2) and 13 (v2)
  digests; `HorseReferenceDecisionSources.test.ts` keeps the list equal to
  HorseLogic's real imports.
- The default persona follows the solver line (gtoAdherence 1; G4).
- The held v17 river-probe patch (default off) is applied; its audit migration
  is re-reserved as 20261016182539.

## Added to the same requalification (second pass, 2026-10-16)

Each of these touches a hashed file (`HorseLogic.ts`, `HorseMind.ts`,
`HorseOpponentExploit.ts`, `GtoPostflopV31.ts`), so they ride this one
requalification rather than voiding the next.

- **The read crosses worker shards.** `observeExploitRow` (decay-and-add onto
  a bounded store) and `mergeExploitRows` (a sandbox's rows merged into a live
  store) in `HorseOpponentExploit.ts`; `HorseMind.observeExploitHand` now uses
  the same routine, and `HorseMind.sandboxExploitRows(sandbox)` /
  `HorseMind.mergeSandboxExploit(sandbox)` are the entry points the worker
  mirror (`horseDecision/mindMirror.ts`, `mergeSandboxIntoLiveMind`, branch
  `claude/horse-realtime-phase15-20261016`, its "FOLLOW-UP" section) calls
  after a mirrored hand. A sandbox starts empty, so each row it holds is
  exactly one hand's increments: merging it decays and adds onto the live row,
  or inserts a copy. `HorseOpponentExploit.test.ts` proves a merged one-hand
  sandbox leaves exactly the counters and the read that observing the hand
  live leaves (decay included, a new player included, over a 40-hand
  sequence too). The mirror itself is not changed here (it is not a hashed
  file); it must call `HorseMind.mergeSandboxExploit(sandbox)` and count
  `HorseMind.sandboxExploitRows(sandbox).size` in its nothing-to-learn check.
- **Exploit rows are evicted least recently used.** The store (16,000
  `scope|player` rows) evicted the first-INSERTED rows, so a regular who had
  played every hand since the restart was the first to go. An updated row now
  moves to the most-recently-used end; eviction (to three quarters of the cap)
  takes the stalest.
- **`aSelectedPackShipsItsEvidence.law.test.ts` is whole again.** The first
  pass let a committed selection pass when refused for
  `policy_digest_mismatch`. A non-null, unwithdrawn selection must be
  admitted; the moved digests are handled by null selections, which the law
  skips.
- **Two layers the league measured losing are default OFF** (the v17 river
  probe precedent, commit 8cc137070e8):
  - `shortdeck_v23`, -0.36 +/- 0.14 bb/100 over 44 runs. Only the short-deck
    half of `v23Variants` (one-pair thin value shrinks, draws earn +0.02
    implied credit) moves behind the new opt-in `v23ShortDeck`; the plo8
    low-only draw half (`plo8_v23_lowdraw` +1.63 +/- 0.18) stays on, the way
    V46 was split on 2026-10-05.
  - `v32_facing_defense` (heads-up NLH), -0.31 +/- 0.15 over 41 runs:
    `v32FacingDefense` is opt-in. It fired live (2026-10-16: 28,461 calls,
    10,671 folds, 8,456 strong passes, 44,304 no-range misses), so heads-up
    NLH facing-bet decisions change: the heuristic call line decides them.
  - League matchups keep their names and signs (arm A turns the layer on);
    `full_vs_v2_legacy` lists `v23ShortDeck: false`. Ledger flags record the
    defaults; the `v32_*` receipt floor is removed.
- **An empty V31 store is skipped before the consult.** V31 is parked (the
  PioSOLVER hosts are off) and its store has no cells, so every eligible
  heads-up hold'em postflop decision did the consult's work and recorded
  `v31_certified_miss_empty_store` plus two miss-axis counters (306,763 misses
  on 2026-10-16). `gtoV31StoreIsEmpty(datasetChecksum)` is checked first; an
  empty store records one `v31_certified_skip_empty_store` and decides exactly
  as the miss did (`GtoPostflopV31.test.ts`: identical to the consult switched
  off over 80 spots, no miss counters; a stocked store is still consulted).
- **The audit knows** (migration 20261016182539, extended in its one
  transaction; every body rebuilt from the installed one, md5(prosrc) checked
  against production: `fn_audit_layer_silence` 3c8ce9e8...,
  `fn_audit_league_pooled_findings` 542d0d69..., `fn_audit_layer_drift`
  8e70a9a5... = 20261005190000):
  `fn_audit_league_pooled_findings` treats a significant negative
  `shortdeck_v23` / `v32_facing_defense` as confirming the default and a
  significant positive as the flag earning its default back;
  `fn_audit_layer_drift` section 1 skips layers the silence check already
  called `layer_default_off` (v17*river_probe would otherwise also have been a
  `layer_went_silent` warn), notes the `v32_defend*\*`counters as`layer*default_off`, and reports an outcome counter (`\_reason*`,
`unavailable`, `_skip_`, `_miss_`, `v44*declined*`; section 2 already never
judged them as layers) as info `outcome_counter_went_quiet` instead of a
  warn. Applied to a scratch Postgres 17 with stub tables and exercised: the
  three functions create, and the findings are the ones above.
- **Neutrality.** The corpus was recorded on main, which played the short-deck
  V23 half and V32 by default, so the replay pins `v23ShortDeck: true` and
  `v32FacingDefense: true` explicitly, as it pins `v17RiverProbe: true`.

## What this costs, and what is not verified

- The PLO4 (Phase 10), PLO5/6/8 (Phase 11) and FLH (Phase 12) live
  selections no longer match the running policy digest. Combined with the
  declared-work change (below), their committed selections are null (the
  #6777 / #6886 precedent) and they run shadow until their locked matrices
  requalify this source. The retired generations are kept in
  `HorsePreviousSelections.test-support.ts` (`RETIRED_2026_10_16_*`) and
  pinned as refused. Nothing re-points a digest.
- The decayed counters are memory only (no migration). Each worker learns
  the tables it serves and forgets at restart (the hourly break); the read
  re-forms within about 8 hands.
- Heads-up, horses themselves open very wide (PLO HU raise-first-in up to
  99%), so a 100% raiser is distinguishable there from PFR and VPIP only,
  later than at 3+ seats.
- Not measured: bb/100 of the exploit against a live human field; the A/B
  above is decision frequencies, not results.

## Combined digests (this change with the declared pack work)

This branch carries both this change and
[the packs do their declared work](2026-10-16-packs-do-declared-work.md)
(fixed declared work instead of the 4 ms wall-clock budgets; FLO8 round 4).
The digest table in that changelog was computed on its branch alone and is
**superseded** by this one. Recomputed on the combined tree (after merging
main at 0fb6ae5b2e5; nothing main added is inside a hashed boundary) with the
repo's own digest functions (`horsePhase8PolicyDigest`,
`horsePhase10PolicyDigest`, `horsePhase11PolicyDigest`,
`horsePhase12PolicyDigest`, `horsePhase13PolicyDigest` and the
`PHASE10/11/12/13_RUNNING_CONTRACT_DIGEST(S)` constants). Definitions: Phase 10
v3, Phase 11 v5, Phase 12 v2, Phase 13 v2.

| Phase | Pack                | Kind     | Digest                                                           |
| ----- | ------------------- | -------- | ---------------------------------------------------------------- |
| 8     | tournament postflop | policy   | 3eaf56053395fb046c8bce310e4175c0504d6399b04958900c5fd00e7661fd3a |
| 10    | PLO4                | policy   | 99028825a6cd1e009958a665ca2661e8a0bd895731e8917ed9e1e9e3874e87a5 |
| 10    | PLO4                | contract | 83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838 |
| 11    | PLO5                | policy   | 5a8705169d087f24fb73007ef0df0a832996dacd898846c366779f42348b0390 |
| 11    | PLO6                | policy   | 160000216a405526b567ff6a8729e9a1780d5dd3e7b7196bef0308111ed56686 |
| 11    | PLO8                | policy   | d4f5111ab937985524516a48221348743bbf275380dd4195756216bb58bce742 |
| 11    | PLO5, PLO6, PLO8    | contract | 0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05 |
| 12    | Short Deck          | policy   | c3265d5a910bc85dfb13b27f0950f270f92c16012a68b13d92e8926fd1d25961 |
| 12    | Crazy Pineapple     | policy   | 5324f9c8e60db4355fa58c4f14abbb907a04896678f732807c3202089774c2bd |
| 12    | FLH                 | policy   | d3d1b293842bcdecfd01f8491f5c3f4b42e41c95c862868fc84df910c499e36f |
| 12    | FLO8                | policy   | 39e27a78acabb3b6ef07e3e4421be944c35cc2a7d19ad88988fdceee1d05a757 |
| 12    | Short Deck          | contract | 0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2 |
| 12    | Crazy Pineapple     | contract | 0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2 |
| 12    | FLH                 | contract | fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0 |
| 12    | FLO8                | contract | 0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2 |
| 13    | nlh                 | policy   | 07904a4cc84f0648e2784b4179d58f58cde86f535aa30451aa502a1ae3dd5fb5 |
| 13    | short_deck          | policy   | 42c75987e0bcedf1195f35c8f35881517629e49c8ebd2ef6c832c47bd63c2401 |
| 13    | flh                 | policy   | f90f2177384f4ec5096fd0bdaab6104f59486ec154560ef2d34d5b3fc1da0224 |
| 13    | pineapple           | policy   | 0c0db8305fc3986c082a38e3d47def03432147c69ecd1454f6dfae37d5f4d6a0 |
| 13    | plo4                | policy   | 10907789e6bf904a3ff59bb56674f740a6098836c458d3595640570ccfa3d545 |
| 13    | plo5                | policy   | 49ab93c168ed38a8684cf736c415101ce981e8536490843bd668a0089a64dede |
| 13    | plo6                | policy   | bdac2f924d29e6e8f0e0f48a3beaecb1a794349fde2f8dae8d2bb88ccf983eaf |
| 13    | plo8                | policy   | 3fe6cbd6ea349d8229d68ad8377cae783a90a8d8586d10d20efac35b59584ba7 |
| 13    | flo8                | policy   | 33d7d93610c8801bfaf435e99bf9c2ee68540587cdb288885fcc8127231f4066 |
| 13    | all                 | contract | 0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8 |

Phase 8 has no strength-contract digest (its league contract is checked key by
key by `phase8-strength-assemble.mjs`). The Phase 13 contract is unchanged.
FLH keeps the frozen Phase 12 contract v1; Short Deck, Crazy Pineapple and FLO8
are on Phase 12 contract v2. No selection is set: every pack above is shadow
until the requalification measures exactly these digests.

Recomputed after the second pass (commit c7be84974e1; the commits after it
change only tests and docs). Every Phase 10, 11, 12 and 13 policy digest moved
again (`HorseLogic.ts`, `HorseOpponentExploit.ts`, `GtoPostflopV31.ts` are in
all four boundaries, `HorseMind.ts` in 10, 11 and 12); Phase 8 and every
contract digest are unchanged.

Combined-tree tests (second pass, final commit): the FULL server suite
(`cd server && npx vitest run`, src/scripts included, `TMPDIR` under
/Volumes/SmarterWork/agent-work as the hook runs it) 1,313 files passed, 1
skipped; 22,584 tests passed, 168 skipped. The neutrality law with
`HORSE_NEUTRALITY_FULL=1` (all 600 hands of every run): 20 of 20.
`tsc --noEmit` clean at the root and in server. Root law-registry, migration,
definer and audit laws touched by the migration: 19 files, 1,259 tests passed.
Migration 20261016182539 keeps its reserved version (unique against main,
all 823 remote branches and every local worktree when it was reserved); its
three functions were created and exercised on a scratch Postgres 17.
