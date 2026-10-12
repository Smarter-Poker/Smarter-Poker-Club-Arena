# Horse Brain Phase 13: five audit fixes, October 6, 2026

An audit of the merged Phase 13 (squash 886cc965) found five defects in the P13.2 assembler and the P13.3 authority and completion readers. Each was reproduced by a failing test on the unmodified source, fixed at its cause, and the test kept as the regression. Nothing selects: every `PHASE13_PROTECTED_RELEASE_SELECTIONS` entry stays null and every live joint decision stays shadow.

No file listed in `HORSE_PHASE13_POLICY_SOURCE_FILES`, and no file in the Phase 10, 11 or 12 policy digest lists, changed, so every policy digest is unchanged and the held-out matrices running against those bytes are unaffected. The strength contract (`JointStrengthContract.ts`) and its digest are unchanged.

## 1. The assembler's qualification could never be admitted (high)

Defect: `server/scripts/phase13-strength-assemble.mjs` wrote `qualification.packVersion = first.packVersion`, the response pack version `joint-action-response-round2-v1`. `admitHorsePhase13QualifiedAuthority` compares the file's `packVersion` with `HORSE_PHASE13_PACK_VERSION`, the joint domain version `joint-multiway-round1-v4`, and refused `continuation_mismatch`. The test fixture built qualifications with the domain version, so the assembler and admission were never run together.

Reproduction: a new test in `phase13StrengthAssemble.test.ts` assembles a contract-mode matrix (every shard a valid, equally covered, zero-variance positive result that the real verdict qualifies) with the real assembler, reads its real qualification and strength bytes through the real admission with a non-null selection of that file and a floor-clearing completion record. On the unmodified assembler: `AssertionError: expected 'continuation_mismatch' to be null`. The existing development-mode test, updated to expect the domain version, failed with the response version in the received object.

Fix: the qualification's `packVersion` is the contract's `domainVersion` (`JOINT_LIVE_DOMAIN.version`, which every counted manifest is already checked against). The response identity stays bound by the policy digest, which hashes the domain, range and response versions, and the strength record keeps the response version under `source.packVersion`. The new test is admitted, and the same file with the response version is refused `continuation_mismatch`.

## 2. Diamond NLH could be admitted and was counted in NLH (medium)

Defect: the P13.2 contract excludes Diamond NLH whole-unit cash from the qualified domain, but `horsePhase13AdmittedMode` gated only on cash and variant, so a usable NLH authority would have run a Diamond NLH decision as candidate; `horsePhase13CompletionOutcome` counted Diamond receipts (bound objective asset `diamonds`, `utilityOwner: 'cash'`) in the NLH cells.

Reproduction on the unmodified source: `horsePhase13AdmittedMode` with `asset: 'diamonds'` returned `candidate` (`expected 'candidate' to be 'shadow'`); the live worker with a usable NLH test authority ran a Diamond NLH cash decision as candidate (`workerRuntime.test.ts`, same message); a real Diamond NLH receipt counted as completed (`expected 'completed' to be 'excluded_diamond'`); the boundary validator accepted an applied candidate Diamond receipt with usable authority (`expected true to be false`).

Fix: admitted mode takes the decision's `asset` (absent or null is chips) and keeps anything but chips in shadow; the worker passes `gameState.asset`. The boundary validator (`horsePhase13SelectionIsValid`) refuses a candidate-mode receipt bound to a Diamond objective and an applied receipt without a bound chip objective. The completion counting returns `excluded_diamond` for an eligible Diamond receipt, counts it in no cell, and the record names the count in `excluded.diamond` (`horsePhase13CompletionExclusions`).

## 3. An empty window got no record (low to medium)

Defect: `server/src/scripts/phase13CompletionRecord.ts` refused an empty extract (`no_records`, exit 2), so a variant with zero window decisions had no record at all instead of a record that fails the floor.

Reproduction: `Error: no_records` for an empty extract and for an extract of blank lines.

Fix: the refusal is removed. An empty extract for a valid variant, window and release writes a record with zero eligible in every cell, which admission refuses as `completion_below_floor`. The pinned `no_records` refusal case was deliberately replaced by tests of the zero record, its admission refusal, and the command's exit 0 on empty input.

## 4. Analysis failures counted as completed (low)

Defect: `horsePhase13CompletionOutcome` never read `fired`, so an eligible full-sample receipt whose reason was an analysis failure (`joint_action_conservation`, `joint_analysis_unavailable`, `joint_pots_conservation`, `joint_scores_no_winner`, `joint_action_no_legal_candidates`, `proposal_outside_legal_menu`) counted as `completed`, and a response-model defect (`joint_response_branch_mass`, `joint_response_illegal_simulated_action`) counted as `responseBranchUnavailable`.

Reproduction: `expected 'completed' to be 'analysis_unavailable'` and `expected 'response_branch_unavailable' to be 'analysis_unavailable'`, on the fixture table and on forged reasons over real receipts of all nine variants.

Fix: a seventh named field, `analysisUnavailable`, takes every complete full-count decision whose proposal did not fire; `responseBranchUnavailable` keeps only `joint_response_branch_unavailable`, `joint_response_street_unavailable` and `joint_response_street_not_modeled`. The field is in the record, both tallies, the cell sum admission checks and the counting both readers use. The Wilson bound reads `completed` only.

## 5. Stage 1 and stage 2 could read different windows (low)

Defect: `server/scripts/phase13-completion-extract.py` `ms()` dropped fractional seconds and failed on a `+00:00` offset, while stage 2 uses `Date.parse`.

Reproduction: with bounds `2026-10-15T00:00:00.500+00:00` and `2026-10-15T00:00:01.2509Z`, stage 1 printed decisions at 0, 499 and 500 ms past the hour where `Date.parse` gives the window [500, 1250) ms (`expected [ 1792022400000, 1792022400499, ...(1) ] to deeply equal [ 1792022400500, 1792022401249 ]`).

Fix: stage 1 parses `YYYY-MM-DDTHH:MM[:SS[.fraction]]` with `Z` or a numeric offset exactly as `Date.parse` does (offset applied, fraction truncated to milliseconds), and refuses a bound without an offset or in another form. Stage 1 also names Diamond decisions in its summary (`diamond_records`).

## The completion definition

Items 2 to 4 change what a record counts, so `HORSE_PHASE13_COMPLETION_DEFINITION` is now `horse-phase13-completion-definition-v2`, the record carries `excluded`, and admission accepts only v2 records (a v1 record is refused `completion_evidence_mismatch`). The predeclared window in `docs/evidence/phase13/declaration-p13-3-completion.txt` names definition v1 and the readers at the squash commit; a record produced exactly as declared there is a v1 record and is refused by the current admission, so a v2 record needs its own predeclared window naming the readers at this change. The declaration file is evidence and is not edited.

Package record: `docs/horse-brain-phase13-3-authority-2026-10-06.md`, section "Audit fixes".
