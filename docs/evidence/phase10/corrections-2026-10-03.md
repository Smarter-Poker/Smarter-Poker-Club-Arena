# Phase 10 evidence corrections, 2026-10-03

Horse Brain only. This file corrects how the machine-written Phase 10 artifacts in this directory are labelled. It does not edit any artifact: each one stays byte for byte as committed, and its recorded sha256 still holds. The prose records carry the same corrections.

## P10.1 natural evidence: the C7 label

Artifact: [`phase10-1-natural-evidence-2026-10-03-46bb9cf6.json`](phase10-1-natural-evidence-2026-10-03-46bb9cf6.json), sha256 `e866c71a92181f1a93941d4b52ba92d79de97b780500d0d8b89d2fb8663bc5e3`.

- **What the artifact says.** `checks.C7` records `evaluated 54718, passed 54718, failed 0, verdict pass`.
- **What was declared.** [`declaration-p10-1.txt`](declaration-p10-1.txt), C7: "no PLO4 proposal is applied (shadow only in this release); the accepted action is the reference/baseline action on every record".
- **Why the label is wrong.** The scanner (`p10-1-journal-observe.py`) fails a C7 record only when the PLO4 proposal is applied, the `variant_policy` transition changed the action, or the accepted action equals the PLO4 proposal with no later node responsible. That is the operational reading: no PLO4 proposal had authority. It counts a change made by a later owner as a pass, so `checks.C7` does not score the declared second clause literally.
- **The literal clause failed once.** `literalReadings.C7.clauseAcceptedEqualsBaselineLiteral` in the same artifact gives 53,150 executed decisions with an accepted record, 53,149 equal to the baseline, `differs: 1` (1,568 not executed). The exception is eventId `a6f00bd9a2b1c72c0bfeb2f022fe2edab58ae7e5d0f96ee7c4e33a451c65b9bf`, a tournament turn decision. The baseline was fold, and the PLO4 shadow proposal was call 5 (not applied; `variant_policy` unchanged). Phase 7 `tournament_utility` then changed fold to all-in, and the controller accepted all-in 5. `supplementary.C7_acceptedDiffersFromBaselineBy` names it `later_node:tournament_utility`.
- **Why it happened.** Phase 7 owns tournament objectives and acts after the PLO4 step. In the declaration, "baseline" meant the reference action before the PLO4 step, not the final accepted action, so a Phase 7 change is not a PLO4 authority breach.
- **Correct reading.** C7 clause 1 (no PLO4 proposal applied): pass, 54,718 of 54,718. C7 clause 2 read literally: fails on 1 of 53,150 executed decisions, attributable to Phase 7. The commit message of #5989 ("C1-C7 pass") carries the same label.

## P10.2 frozen labels

[`strength-2026-10-03/strength.json`](strength-2026-10-03/strength.json) and the contract object it embeds call the reference "the deployed reference proposal" (`contract.reference.owner`) and the opponents "the production Horse population" (`contract.population.opponents`). These strings are part of the contract digest `ebdbdbb4…6384` and cannot change without a new contract. Read them as the Horse policy with the pack off and `HorseLogic.decide` opponent seats with the pack off, under the harness conditions in the [contract record](../../horse-brain-phase10-2-strength-contract-2026-10-03.md#harness-versus-live-disclosed-2026-10-03), not under live conditions.

The `policyDigest` in [`phase10-qualification-2026-10-03.json`](phase10-qualification-2026-10-03.json) and `strength.json` (`a3d92445…c221`) is the sha256 of four files at `ac4ecfb1` (`Plo4PolicyPack.ts`, `Plo4LivePolicy.ts`, `Plo4PolicyLeague.ts`, `Plo4StrengthContract.ts`). It identifies the run. It does not cover `HorseLogic.ts` or the rest of the candidate path, and on `ac4ecfb1` the running engine never compares it with its own code. A fix is in flight on branch `agent/codex-horse-brain/phase10-authority-binding-20261003`.
