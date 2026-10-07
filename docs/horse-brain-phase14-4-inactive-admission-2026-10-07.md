# Horse Brain Phase 14.4 (P14-D, inactive slice): bound corrective references, an inactive candidate catalog and null per-domain admission, October 7, 2026

Horse Brain only. This record covers the inactive slice of package P14-D in the [maintained completion plan](horse-brain-phases6-15-completion-plan-2026-09-17.md) (P14-D, S4, and Execution order steps 4 and 5). It hardens the existing corrective review contract, adds an in-memory inactive candidate catalog, and adds Phase 14 S4 admission on the Phase 8 authority classes with every selection null. Nothing becomes active. It uses the maintained gate vocabulary (verified now / implemented but unverified / unavailable external input / not applicable with reason).

## Why nothing can become active

Every Phase 8 to 13 qualification file in the repository is `qualified: false`. There is no reference producer that emits `reviewed_reference` alternative-action references, no independently held signer or key, no policy distribution owner and no decision-time corrective applier. Generating a key or emitting `reviewed_reference` evidence from this repository would be self-qualification, so none of that was done. Every candidate stays `proposed_inactive` with `activationAllowed: false`, and every Phase 14 release selection is null.

## Delivery and exact source

Worktree `/home/claude/wt-p14d`, based on `origin/main` at `8e6fe3b4`. Not committed, pushed, merged or released. No database or migration change.

## What changed

### 1. Contract and authority hardening (`server/src/services/horseCorrectiveReview/`)

- `domain.ts` (new): the corrective domain `{variant, format, mode}`. Mode follows from format (cash is cash, every other format is tournament). A decision's domain is read from its original snapshot's `gameVariant`, `format` and `gameMode`. A missing or inconsistent field gives no domain. The module never fills in a default. 9 variants by 5 formats gives 45 domains.
- `AlternativeActionReference` is now version 2. It adds `evidenceClass`, `domain`, `samplingContractDigest` and `producerDigest`. A version 1 reference is refused as `reference_version_unsupported`.
- `CorrectiveReviewAuthority` is now version 2. It adds the signed fields `approvalGeneration`, `expiresAt` and `domains[]`. The signed message is `horse-corrective-review-authority-v2`. A version 1 envelope, and a version 2 authority signed under the v1 message, both fail verification; they are never reinterpreted with defaults. Trust still comes only from the independently configured key digest. Extra envelope fields such as a trust digest or `activationAllowed` are ignored and never copied into the verified authority.
- `review.ts` refuses each of these by name:
  - `reference_domain_mismatch`: the reference domain does not match the decision.
  - `reference_domain_not_authorized`: the authority does not cover the reference domain.
  - `reference_domain_invalid`, `reference_provenance_missing`, `reference_evidence_class_invalid`.
  - `authority_expired` and `authority_expiry_invalid`.
  - `authority_generation_invalid`: zero, negative or fractional.
  - `authority_domains_invalid`: empty, malformed or duplicated domains.
  - `mixed_synthetic_and_reviewed_evidence`: synthetic and reviewed evidence appear together anywhere across the references (matched or not), the authority and the roster. A mixed result never claims a reviewed class.
  - A finding's inactive candidate now carries its domain, binding, complete menu, sampling and producer digests, qualification id and evidence class, so a catalog can key it. It carries digests only, no cards and no actor ids.
  - `CorrectiveHandReview` now carries the `handKey` it was asked about. The review takes an optional `nowMs` (default `Date.now()`).
- Minimal updates: `fixture.test-support.ts` builds version 2 references and authorities. The fixture authority covers all 45 synthetic domains, expires in 2099 and is generation 1. The fixture's ephemeral private key is returned only so tests can prove the v1 refusal. `integration.candidate.test.ts` passed unchanged after the roster-mismatch reason was kept as before. README updated.

### 2. Inactive candidate catalog (`candidateCatalog.ts`, new, pure and in memory)

- Each candidate is keyed by a stable id: a digest of its domain, its full binding and its from/to actions. The id does not include the measured gain, so the same proposal keeps the same id.
- The selection window and the holdout window are explicit hand sets, each hand named by committed hand id and journal hand key. `holdout_leakage` is refused when any holdout hand id (case-insensitive) or hand key appears in the selection window, or in any supplied selection review. Incomplete reviews count too.
- The selection protocol (`horse-corrective-selection-protocol-v1`) is finite. It has a candidate cap of at most 1024 and a minimum conservative gain of at least 0.01. It must be declared before the holdout window opens, otherwise `selection_protocol_declared_after_validation`. It names the holdout as its validation window. Naming the selection window, giving an identical window, or giving windows that overlap in time is `selection_window_reused_as_validation`. More eligible candidates than the cap is `selection_protocol_exceeded`; the catalog never truncates by order.
- Distribution completeness is checked per domain and information set. The supplied baseline distribution must give a probability for every action of the reference's complete legal menu and nothing outside it. Each probability must be finite and in [0, 1], and the sum must be 1 within 1e-9. Otherwise `incomplete_policy_distribution`.
- Each entry records the baseline and the proposed distribution, moved by at most 0.05 from `from` to `to`. The proposed distribution is never applied. Incomplete reviews and unselected candidates are listed with reasons, never dropped. The catalog digest covers everything except itself, including the holdout digest.
- `holdoutEvaluated` and `activationAllowed` are false in every result.

### 3. Phase 14 S4 admission (`server/src/engine/HorsePhase14Authority.ts`, new)

- `PHASE14_PROTECTED_RELEASE_SELECTIONS` has one entry for each of the 45 domains. All are null and the object is frozen.
- `admitHorsePhase14QualifiedAuthority` follows the shared admission laws. A null selection returns `unselected` before any file read. It requires a committed `docs/evidence/phase14/` qualification (`horse-phase14-qualification-v1`, exactly eight keys) with `qualified: true` and no reasons. The selection's catalog digest and holdout digest must match the file. Refusals: `catalog_digest_mismatch`, `holdout_digest_mismatch`, `not_qualified`, `source_mismatch`, `continuation_mismatch`, `expired`, `hash_mismatch`, `missing_evidence`, `unreadable_evidence` (transient) and `withdrawn`. Two refusal names were added to the shared `HorseAuthorityRefusal` union, and `phase14` plus the two digests were added to `HorseQualifiedAuthority`. Both changes are additive.
- There is one holder and one main gate per domain, using the existing `HorseQualifiedAuthorityHolder` and `HorsePhase8AuthorityGate` classes. Each is bound to `horse-corrective-candidate-catalog-v1/<domain>`.
- `horsePhase14CorrectiveMode`: the caller can only turn the corrective path off. Usable authority for the deciding domain is reported as `corrective_applier_unavailable` and the mode stays `shadow`. No input yields an active mode.
- Deliberately not wired: the worker holders, `protocol.ts` receipts, the client stamp and forget, the acceptance-time recheck, and the witness binding. Each of those gates an applier's output, and no applier exists. Wiring them would put always-unselected receipts on every live decision and add a recheck with nothing to check. The module header says so and names the three unavailable inputs. A test pins that no non-test source imports the module.

## Gate ledger for P14-D (inactive slice)

| Gate                       | Status                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | verified now (source tests): references, authorities, candidates and admissions are bound to one of 45 `{variant, format, mode}` domains. The domain is read only from the original decision. A mismatched, uncovered or unknown domain is refused by name. Natural coverage per domain: unavailable external input, because no qualified reference producer exists.                                    |
| G2 Inputs                  | verified now (source tests): references bind the decision, execution, accepted hand, input, read frame, source release, sampling contract and producer. The authority signs the generation, expiry and domains. v1 shapes are refused. Admission reads only the committed selection and repository files, and nothing while unselected.                                                                 |
| G3 Calculation             | verified now for catalog arithmetic: distribution completeness and tolerance, the bounded 0.05 move, and the conservative-gain threshold. Not applicable for strategy strength: this slice computes no strategy, and reference values come from the (unavailable) producer.                                                                                                                             |
| G4 Authority               | verified now (local): one authority path, using Phase 8's holder and gate per domain. Null means unselected and shadow. A stale generation is refused. Withdrawal is sticky and is never re-admitted from a cached admission. A rollback at a higher generation naming the earlier catalog renews. A refresh failure is not a withdrawal. Expiry is enforced. A caller cannot supply candidate control. |
| G5 Actual use              | unavailable external input: a qualified reference producer, an independent signer and key, a held-out evaluation committed as a Phase 14 qualification, and a decision-time corrective applier. None exists.                                                                                                                                                                                            |
| G6 Outcomes                | verified now (local): every review, catalog and admission refusal is a distinct name. Excluded reviews and unselected candidates are listed with reasons.                                                                                                                                                                                                                                               |
| G7 Correctness             | verified now: the suites below pass and `tsc --noEmit` is clean.                                                                                                                                                                                                                                                                                                                                        |
| Holdout independence       | implemented but unverified: leakage and window disjointness are enforced on declared hand sets. Whether a real holdout population is complete and independent depends on the accepted-roster producer (P14-A), which is an unavailable external input.                                                                                                                                                  |
| Rollback qualification     | implemented but unverified: the higher-generation rollback law is tested on the holder. A real rollback needs a committed earlier qualification.                                                                                                                                                                                                                                                        |
| Persistent effects (P15-A) | not applicable with reason: no corrective applier exists, so there is no strategy effect to make durable.                                                                                                                                                                                                                                                                                               |

## Tests

From `server/`:

- `src/services/horseCorrectiveReview/review.test.ts`: 100 tests. This includes 38 new Phase 14.4 cases: domain match, coverage and parsing; expiry, generation and domain refusals; mixed evidence across reference and authority, across references, and with a reviewed-labelled authority; refusal of v1 envelopes and the v1 message; signature coverage of each new field; and trust kept out of the envelope.
- `src/services/horseCorrectiveReview/candidateCatalog.test.ts` (new): 45 tests.
- `src/engine/HorsePhase14Authority.test.ts` (new): 51 tests.
- Combined run: `npx vitest run src/services/horseCorrectiveReview src/services/horseDailyCorrectiveReview src/testing/horseRegression/daily src/testing/horseRegression/merged src/engine/HorseQualifiedAuthority.test.ts src/engine/HorsePhase13Authority.test.ts src/engine/HorsePhase14Authority.test.ts` gives 22 files and 1058 tests passed. The pre-change baseline of the same set without the two new files was 20 files and 924 tests.
- `HorsePhase10/11/12Authority.test.ts` and `horseDecisionJournal/lifecycleVersion.test.ts`: 4 files, 273 tests passed.
- `npx tsc --noEmit -p .`: clean.

## Limits stated plainly

No real reference, signer, holdout evaluation, qualification or applier exists, and none was created. Synthetic fixtures prove the binding and refusal logic only. They are not poker EV, GTO or holdout evidence.
