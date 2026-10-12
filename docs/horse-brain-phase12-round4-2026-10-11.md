# Horse Brain Phase 12 Round 4 (October 11, 2026)

Status: implemented but unverified. Committed on branch
`agent/claude-horse-brain/p12-completion-20261011`; no held-out hand of contract v2 has been
dealt and no matrix has been dispatched. Nothing below is selected.

## 1. Why Round 4

After round 3 one Phase 12 pack was live and three were blocked:

| Pack            | Round-3 result                                                          | What blocked it                                                                        |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| FLH             | qualified, selected (#6611), live                                       | nothing                                                                                |
| Short Deck      | +0.74 [+0.19, +1.28] bb/100, no losing cell                             | trust check (Edgeworth coverage above 0.001) in 6max 40bb, 100bb, 200bb and 9max 100bb |
| Crazy Pineapple | +1.59 [+1.00, +2.17] bb/100 (1235b47a, run 38005375218), no losing cell | trust check in 6max 40bb, 100bb, 200bb; completion floor (sampler budget exhausted)    |
| FLO8            | +0.89 [+0.46, +1.31] bb/100, no losing cell                             | trust check in position big blind; completion floor                                    |

Two causes, each fixed at its source:

1. Completion floor. The live sampler stopped at `samplingDeadlineMs` (2.5 ms) before its 32nd
   sample on 450 of 1,111 Pineapple and 39 of 1,388 FLO8 postflop decisions (release f47ad93c,
   2026-10-11 19:05 to 19:45 UTC, predeclared diagnostic read). The Pineapple sampler chose a
   retained pair for every dealt seat, folded ones included, on every sample. Commit
   `c3d62c1696` replaces that work with exact kernels: every sample, receipt and decision is
   bit-identical, only the time changes (Pineapple with five dealt opponents 2.34 ms to
   0.12 ms, FLO8 0.48 ms to 0.20 ms on replayed host states). See
   `docs/changelog/2026-10-11-phase12-sampler-exact-kernels.md`.
2. Trust check. In Short Deck and Crazy Pineapple every failing cell is a full table where the
   round-3 pack changed fewer than 1 pair in 600 (Short Deck 0.01% to 0.15%, Pineapple 0% to
   0.14%): a handful of large paired differences among exact zeros, which is what the
   skewness check measures. Meeting it by pairs alone would need about 169 job-hours for Short
   Deck and about 956 for Pineapple (its 6max 200bb cell needs 210 times its pairs). FLO8
   changes 5% to 11% of pairs everywhere and failed only position big blind, which more pairs
   resolve at modest cost.

## 2. What Changed

- **Scoped no-limit packs** `short-deck-round4-v1` and `crazy-pineapple-round4-v1`: the round-3
  rules unchanged, with the big blind defence (the only round-3 rule that can fire at five or
  more dealt) capped at four dealt seats (`bigBlindDefendMaxDealt: 4`). Full tables now play
  the reference exactly; two and four dealt are unchanged. FLH and FLO8 rules are unchanged
  (`bigBlindDefendMaxDealt: null`).
- **One contract per pack.** Contract v1 was rebuilt at import from the live pack versions and
  had one digest for all four packs, so the scoped packs alone would have refused FLH
  `contract_digest_mismatch`. Now `remainingVariantStrengthContractFor(variant)` names each
  pack's contract and `PHASE12_RUNNING_CONTRACT_DIGESTS` holds each pack's digest:
  - FLH: contract v1, frozen byte for byte in
    `server/src/benchmark/RemainingVariantStrengthContractV1.ts`, digest
    `fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0` (unchanged; the module
    refuses to load if the bytes move). FLH's seeds (12401129, 12402257, 12403381), 42 shards,
    12,960 pairs per shard and margin are unchanged.
  - Short Deck, Crazy Pineapple, FLO8: contract v2,
    `remaining-variant-strength-contract-v2`, digest
    `6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f`.
- **The strength workflow and the assembler run each pack under its own contract**
  (`.github/workflows/horse-phase12-strength-league.yml`, `server/scripts/phase12-strength-assemble.mjs`,
  `remainingVariantStrengthEvaluate.ts`, `RemainingVariantStrengthLeague.ts`). A v1 shard is
  refused by name in a v2 pack's verdict, and a v2 shard in FLH's.
- **FLH selection set to null.** The kernels and the scoped packs change the bytes of the
  Phase 12 policy digest's files, so FLH's committed qualification (policy digest a55db7fe...)
  no longer matches the running digest and would be refused `policy_digest_mismatch`. The
  selection is removed in the same change; FLH plays shadow until it is re-measured and
  selected again at approval generation 2. Its generation-1 evidence stays committed in
  `docs/evidence/phase12/` and `server/release-evidence/`, and its selection record stays in
  `docs/horse-brain-phase12-round3-2026-10-08.md`.

## 3. Contract v2

| Pack            | Held-out seeds               | Shards per seed (2 dealt, 4 dealt, 40bb, 100bb, 200bb, ceiling, 1000bb) | Jobs |
| --------------- | ---------------------------- | ----------------------------------------------------------------------- | ---- |
| Short Deck      | 12611137, 12612269, 12613391 | 4, 5, 5, 6, 10, 10 (as v1)                                              | 120  |
| Crazy Pineapple | 12621143, 12622277, 12623399 | 7, 8, 6, 15, 14, 15 (as v1)                                             | 195  |
| FLO8            | 12631151, 12632281, 12633407 | 5, 26, 5, 16, 5, 10, 5 (v1: 3, 4, 5, 5, 5, 7, 5)                        | 216  |

The seeds were written into the contract before any run. On 2026-10-11 none occurred on
origin/main or at any of the 1,011 remote branch tips (re-checked before the commit for the tips
that appeared since). The v1 seeds of every pack stay held out (`isRemainingVariantHoldoutSeed`).

FLO8 sizing (`matrixRules.coveragePlanningRule`): the v1 matrix's own per-pair moments, each
profile's exact power sums scaled by its shard factor, project every gating cell at or under
0.0007 (big blind 0.00069, small blind 0.00059), a planning margin under the 0.001 gate
because the skewness of a cell with rare large paired differences is itself a noisy estimate.
The projection is in the agent evidence lane
`/Volumes/SmarterArchives/agent-evidence/horse-brain-select-20261009/p12-blockers/`
(`p12-trust-sizing.py`, `trust-sizing-flo8-0.0007.json`).

## 4. Development-Seed Proof Of The Scoped Packs

`docs/evidence/phase12/round4/development-proof-2026-10-11.json`: development seeds 12101101 and
12102203 only, every profile of both packs, 51,840 pairs, round 3 (commit `c3d62c1696`) against
round 4 on the same source:

- two and four dealt: every stratum's exact power sums, changed pairs, changed decisions and
  both arms' net chips identical to round 3 (Short Deck 221, 203, 3, 8 changed pairs; Pineapple
  286, 297, 8, 7);
- six and nine dealt: round 3 changed 24 pairs across the 16 full-table runs; round 4 changed
  0, and every stratum is exactly zero: the candidate arm is the reference.

## 5. Policy Digests After Round 4

| Pack            | Phase 12 policy digest (`horsePhase12PolicyDigest`)              |
| --------------- | ---------------------------------------------------------------- |
| Short Deck      | 87db1f17b03e4a8b8f4325f9389f66b0200228fbf6b42df891baef341b1fd340 |
| Crazy Pineapple | ee16b3cf1e05969d6fcccb23b774b295e6a3ffb829d5ab9374b2245f50ffc005 |
| FLH             | d1c536a9f1b6889478da2ad4c5d5d985a130a47fb794169ddf6f420a6ccde8fb |
| FLO8            | 663a3ae7bca1729cdbcaf8b170646f4c0815fc69cb5739a47249023678d18a98 |

The same files are hashed by the Phase 13 policy digest, so every Phase 13 digest moves too;
Phase 10 and Phase 11 digests do not.

### 5.1 Final Digests On The Integrated Source (October 11, 2026)

Round 4 is integrated, unpushed, with the Phase 13 live-work change on branch
`agent/claude-horse-brain/p13-work-budget-20261011`, rebased onto `origin/main` `e5303503`.
Computed on that tree (`horsePhase10PolicyDigest`, `horsePhase11PolicyDigest`,
`horsePhase12PolicyDigest`, `horsePhase13PolicyDigest`, and each phase's running contract
digest). Phase 10 and Phase 11 equal `origin/main` (recomputed from its files); the Phase 12
policy digests equal the round 4 values above.

| Phase | Pack or variant  | Digest                                     | Value                                                            |
| ----- | ---------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| 10    | PLO4             | policy (equals main)                       | 7f7968b11afd353646de507a381c188f131f241191ad1eb6fb33f563fb0ceadb |
| 10    | PLO4             | contract                                   | 83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838 |
| 11    | PLO5             | policy (equals main)                       | 9d5b1ed11d1ec000ae84ceb3cd1c0ff6df36d573e7371e8d9b74a0f151cda5ba |
| 11    | PLO6             | policy (equals main)                       | 2f3c66713a7d3d237d9fe7e4e0461da9d36d0bd3a8f51078ed1271099c139df0 |
| 11    | PLO8             | policy (equals main)                       | db899eb1b9fb64061f55816f31c82cb282b10d14eae0e669d6bd16320eefa62f |
| 11    | PLO5, PLO6, PLO8 | contract                                   | 5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc |
| 12    | Short Deck       | policy                                     | 87db1f17b03e4a8b8f4325f9389f66b0200228fbf6b42df891baef341b1fd340 |
| 12    | Short Deck       | contract                                   | 6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f |
| 12    | Crazy Pineapple  | policy                                     | ee16b3cf1e05969d6fcccb23b774b295e6a3ffb829d5ab9374b2245f50ffc005 |
| 12    | Crazy Pineapple  | contract                                   | 6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f |
| 12    | FLH              | policy                                     | d1c536a9f1b6889478da2ad4c5d5d985a130a47fb794169ddf6f420a6ccde8fb |
| 12    | FLH              | contract                                   | fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0 |
| 12    | FLO8             | policy                                     | 663a3ae7bca1729cdbcaf8b170646f4c0815fc69cb5739a47249023678d18a98 |
| 12    | FLO8             | contract                                   | 6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f |
| 13    | NLH              | policy                                     | 1a6a831343bb4ca7f60aca2067df02090df5c68d39fc493cbb521b066dc3d87d |
| 13    | PLO4             | policy                                     | 9c6afc09f81d400b913f63e663ad35bcf65661a441a04fbfcf3fe2305853aefa |
| 13    | PLO5             | policy                                     | af2b49e8c364a80089327e8a39ff7bbc318038c9a9b54794239200d0895ad837 |
| 13    | PLO6             | policy                                     | 95ba3d1afed28e0fb62acc839f54238b18543f352b2c6ca82b33aacdf2c32d05 |
| 13    | PLO8             | policy                                     | ca120931043d80031982abae93276023e59947e280792246c8de7ea83ba0fc26 |
| 13    | FLO8             | policy                                     | d2dbd6590ddbb1648843c2461161ea2d21f37f24d25ff8e1d0941cde2a53f11a |
| 13    | FLH              | policy                                     | 4d9cb504bbc30d70a033e4385c1f35efcecccea1796252624d5ac044cbfe6904 |
| 13    | Crazy Pineapple  | policy                                     | 769e86b32e41f97e543098bc5e246fd6d65056f82ff61f8fee01b9fee1bb3cb1 |
| 13    | Short Deck       | policy                                     | 0a8205ec01ad65538107da2f9835f50caabbed8078b4d027531024f9abaaa555 |
| 13    | all nine         | contract (PHASE13_RUNNING_CONTRACT_DIGEST) | 0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8 |

## 6. Plan

1. Merge this change with no large matrix queued (the engine release shares the runner queue).
2. On the merge commit, one matrix at a time:
   - FLH under contract v1 (42 jobs, about 3.5 job-hours). Because the kernels leave every
     decision bit-identical and the matrix runs on a fixed clock with full samples, every shard's
     pair digest must equal run 37969578926's; any difference is a defect to stop on.
   - FLO8 under v2 (216 jobs, about 18.4 job-hours).
   - Short Deck under v2 (120 jobs, about 11 job-hours).
   - Crazy Pineapple under v2 (195 jobs, about 18.6 job-hours).
3. After the release containing this change cuts over, predeclare a natural completion window
   (shadow receipts count; the policy code is the candidate's) and read FLH, FLO8, Pineapple and
   Short Deck from it.
4. Select FLH at approval generation 2 and every other pack that qualifies on (a) and meets the
   floor, in one change; ship; verify natural accepted use on the serving release.

## 7. Time-Gated Checks

- FLH natural accepted use after its generation-2 selection ships (it is shadow until then).
- The completion window above, on the first release that contains this change.

## 8. FLH Re-Selection On 9d567463 (October 12, 2026)

Status: implemented but unverified. FLH is selected again in the committed selection at approval
generation 2; it stays unverified until its natural accepted use is read, in a predeclared window,
on the first serving release that contains this selection.

### 8.1 Held-Out Matrix

- Run 38206776185 on 9d5674639f2bd091f2386c75cbd87bec419c5dcd under contract v1
  (`remaining-variant-strength-contract-v1`, digest
  fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0): 42 of 42 shards, 544,320
  pairs, cash after rake against the horse population +1.11 [+0.70, +1.52] bb/100, every cell
  trusted, qualified on condition (a) with no reasons.
- It reproduced run 37969578926 (1235b47a) bit for bit: all 42 shards (pairs, changed pairs,
  eligible, decisions and pair digest) and all 21 cells (mean, standard error, 99% interval,
  skewness, coverage, trust) are identical, as section 6 required of the exact sampler kernels.
- The qualification's policyDigest d1c536a9f1b6889478da2ad4c5d5d985a130a47fb794169ddf6f420a6ccde8fb
  and contractDigest fafbba8d... equal what origin/main computes for FLH (recomputed on
  a426015d445c64fba1daa9f999cd0b1d54655ecc, the base of this change). Its evidenceSha256
  3fee1237faead2ce95cd296ad7aae17e6673a1e7d3a2eac9f1b938f932c80482 is the sha256 of the strength
  record it names.
- Files: `docs/evidence/phase12/9d567463/strength-2026-10-12-flh/` (strength record and runs) and
  `docs/evidence/phase12/9d567463/phase12-qualification-2026-10-12-flh.json`.

### 8.2 Natural Completion Window

Predeclared in `docs/evidence/phase12/declaration-completion-round4-2026-10-12.txt` (written
2026-10-12T04:21:54Z, sha256 536f9663f9ef1b4da035ee09cec57fc98e2436d923a06ccbaf271336552c939a)
before any window opened. Release 9d5674639f2bd091f2386c75cbd87bec419c5dcd (StartedAt
2026-10-12T04:55:45Z) served unchanged through the window 2026-10-12T05:02:00.000Z to
2026-10-12T05:50:00.000Z, read before and after. Record:
`docs/evidence/phase12/9d567463/phase12-completion-2026-10-12-flh.json` (policyDigest d1c536a9...).
Floor: Wilson lower bound at z = 2.5758293035489 of at least 0.95 with at least 127 eligible per
street.

| Street  | Completed / Eligible | Not Completed | Wilson Lower Bound | Floor |
| ------- | -------------------- | ------------- | ------------------ | ----- |
| Preflop | 504 / 505            | 1 work budget | 0.9834             | met   |
| Flop    | 238 / 239            | 1 work budget | 0.9653             | met   |
| Turn    | 178 / 178            | none          | 0.9641             | met   |
| River   | 130 / 130            | none          | 0.9514             | met   |

No decision was governor-reduced, sampler budget exhausted or sample unavailable.

### 8.3 Selection

`PHASE12_PROTECTED_RELEASE_SELECTIONS.flh` in `server/src/engine/HorsePhase12Authority.ts`:

| Field               | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| schema              | horse-qualified-authority-selection-v1                                   |
| sourceSha           | 9d5674639f2bd091f2386c75cbd87bec419c5dcd                                 |
| packVersion         | fixed-limit-holdem-round3-v1                                             |
| contractVersion     | remaining-variant-strength-contract-v1                                   |
| contractDigest      | fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0         |
| domain              | flh-cash-single-board-after-rake-horse-population                        |
| qualificationPath   | docs/evidence/phase12/9d567463/phase12-qualification-2026-10-12-flh.json |
| qualificationSha256 | 01e91eb38a73dadc9fa2aff7ee4980f64b8b8d8c07a44ec18f50d6bfbccf3f8f         |
| completionPath      | docs/evidence/phase12/9d567463/phase12-completion-2026-10-12-flh.json    |
| completionSha256    | b42fb264780ea75bcc89b6d2f700d875fd68b49bf3600329f85f2a624499fbdf         |
| approvalGeneration  | 2                                                                        |
| issuedAt            | 2026-10-12T11:00:00.000Z                                                 |
| expiresAt           | null                                                                     |
| withdrawn           | null                                                                     |

- Approval generation 2, not 1: an approval generation is strictly increasing across renewals,
  and a holder that has withdrawn a generation admits nothing at or below it
  (`HorseQualifiedAuthorityHolder.apply`). Generation 1 (#6611, sourceSha 1235b47a) was set to
  null by #6700, never withdrawn; generation 2 is a distinct approval on different evidence, so a
  withdrawal of generation 1 can never block it or be confused with it.
- issuedAt is after the completion window end (05:50Z) and after every evidence file was written
  (matrix assembled 05:35Z, completion record written 06:06Z); the authority refuses a completion
  window that ends after issuedAt.
- The qualification, the strength record it names and the completion record are committed
  byte-identical under `server/release-evidence/` (law aSelectedPackShipsItsEvidence); the
  strength runs stay under docs/ only, as in #6611.
- Short Deck, Crazy Pineapple and FLO8 stay null. The generation-1 FLH evidence files stay
  committed; their policy digest (a55db7fe...) no longer runs, so no admission accepts them.

### 8.4 Time-Gated Check

- FLH natural accepted use on the first serving release that contains this selection: a
  predeclared journal window plus horse_brain_telemetry (phase12_selection_selected,
  phase12_applied, phase12_selection_controller_accepted), cash FLH candidate with usable
  authority, tournament FLH shadow.
