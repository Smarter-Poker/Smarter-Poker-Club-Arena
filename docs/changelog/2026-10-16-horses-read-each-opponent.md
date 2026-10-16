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
| 10    | PLO4                | policy   | 413bc42984185a3ec1547858ec7116fa44bd0e3c1c33b1fd05d8f6fa6fc62378 |
| 10    | PLO4                | contract | 83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838 |
| 11    | PLO5                | policy   | c2ca1d89c2655f05c5f33c5dd8ac388005f1bb41e659f3165becf480d77ebc49 |
| 11    | PLO6                | policy   | a5017462c7c169bc3d74d51d477b20f18a44403b23e1d8325aff25e85f4e2cc0 |
| 11    | PLO8                | policy   | 6aef492dcb1d30236a28efca6b1b94ce625c064869aca712796781292b03193b |
| 11    | PLO5, PLO6, PLO8    | contract | 0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05 |
| 12    | Short Deck          | policy   | 8c067dda57d9a063fa70ea836c3dd6c964918cebb3f4a71b746797f9567d9faf |
| 12    | Crazy Pineapple     | policy   | e27d69f1517fe011cd5259be9c8c9ee8e40d8cb5a494512b9865f13f4c66929c |
| 12    | FLH                 | policy   | 95b99b8c792eb83ac00e9e368fae5e2dcec983e2a86415c16eb3b72b936031c6 |
| 12    | FLO8                | policy   | 7c16066271f626b6c8dc564c74dbf8e79eb7c0b9ffcfd61eaf02196ed15c7033 |
| 12    | Short Deck          | contract | 0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2 |
| 12    | Crazy Pineapple     | contract | 0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2 |
| 12    | FLH                 | contract | fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0 |
| 12    | FLO8                | contract | 0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2 |
| 13    | nlh                 | policy   | 36e279bae7bcba1eaba3682564cbafae1af749814ebd58540d466e9cbe603df0 |
| 13    | short_deck          | policy   | 04c6b48b4139299baee7ad8d71757674494bcd27649605a5bb928fc5d7ac1820 |
| 13    | flh                 | policy   | 2ac7a5c4f011e9d65ef032d5724e7d34ddbd3192e328b957289dfa0d9024fb2b |
| 13    | pineapple           | policy   | fa896bb8aec065c926607d8bbb43957801d945ff19f639535481d2d43a965e7f |
| 13    | plo4                | policy   | 35333017625c422fc31e9fa9914a28059ab9366492a275e45f491bcce8423adb |
| 13    | plo5                | policy   | aa866142a97a355f1009c9cab2b985c307ebdcbc5a4ed9bc528d63dbe657a7f6 |
| 13    | plo6                | policy   | 8057b1729af8642e55cf82c83ab159c89c1924c81affaa8b09e3111cdf5833fd |
| 13    | plo8                | policy   | 4ef3da0b48e4ba67681c49f3bd3457dfa39d62979e4fc9458e3da72259202276 |
| 13    | flo8                | policy   | 9d7885c8839c4b84f31eceecf8295d06df6d9e7f67a22cc866d84b15eba95782 |
| 13    | all                 | contract | 0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8 |

Phase 8 has no strength-contract digest (its league contract is checked key by
key by `phase8-strength-assemble.mjs`). The Phase 13 contract is unchanged.
FLH keeps the frozen Phase 12 contract v1; Short Deck, Crazy Pineapple and FLO8
are on Phase 12 contract v2. No selection is set: every pack above is shadow
until the requalification measures exactly these digests.

Combined-tree tests (after the main merge): server engine suite
(`src/engine src/services src/benchmark`) 866 files passed, 1 skipped; 15,778
tests passed, 168 skipped. The neutrality law with `HORSE_NEUTRALITY_FULL=1`
(all 600 hands of every run): 20 of 20. `tsc --noEmit -p server` clean. Root
law-registry and migration laws: 9 files, 1,028 tests passed. Migration
20261016182539 is unique against main, all 823 remote branches and every local
worktree.
