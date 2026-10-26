# Private retained-hand corrective review

This offline entrypoint joins original journal decisions, acquired read frames, execution witnesses and accepted hands. A source-qualified, input-bound finite alternative-action vector can produce a finding, non-finding or explicit uncertainty result. Any proposed correction is inactive, limited to the exact original information set and capped at a five-percentage-point probability change. There is no database writer, policy activation, scheduler or action-clock integration here.

## Entry point

After the normal server build:

```text
node dist/scripts/horseCorrectiveReview.js \
  <absolute-private-journal-directory> \
  <SHA256-journal-hand-coordinate> \
  <absolute-private-input-json> \
  <new-absolute-private-output-json> \
  [absolute-private-signed-authority-json]
```

The input JSON is `{ "version": 1, "commitments": ..., "references": [...] }`. Exact source, reference and authority fields are defined in `contract.ts`. The output parent must already be an owner-private, real directory. Input files must be owner-private regular files with a single link; output publication is new-file-only, fsynced, mode 0600 and refuses existing paths and symlinks. The journal is opened through the existing store's read-only API. No `.env` is automatically loaded and no production path is selected.

Exit 0 means only that the retained hand's identified eligible decisions were reviewed against the declared qualified finite menu. Exit 2 means an incomplete report was written, exit 3 means the private operation was unavailable, and exit 64 means invalid invocation. Stdout contains only a compact status, review identity and explicit false GTO/activation fields. Private original cards and actor IDs are not copied into stdout or result candidates.

## Independent authority

The owner must separately configure `HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256`. Its value is SHA256 over the base64 representation of the Ed25519 public key's DER SPKI bytes. An authority envelope supplies that public key and a signature covering canonical JSON of `["horse-corrective-review-authority-v2", authority]`. The approved authority (version 2) binds the exact hand, accepted commitment export digest, reference digests, qualification ID, evidence class, a positive approval generation, an exact expiry instant and the variant/format/mode domains the signer reviewed. A version 1 envelope, or any authority signed under the v1 message, is refused rather than reinterpreted with defaults. The reviewer refuses by name an invalid generation (`authority_generation_invalid`), an expired authority (`authority_expired`), malformed signed domains (`authority_domains_invalid`) and mixed synthetic and reviewed evidence anywhere across references, authority and roster (`mixed_synthetic_and_reviewed_evidence`).

An envelope cannot approve itself by including its own trust-key digest. Successful verification returns a detached, frozen, runtime-branded authority object; a copied object is untrusted. A real signer must independently validate the accepted-source export and the numerical/causal/uncertainty quality of its approved reference. Cryptography proves byte binding, not poker correctness. This module does not create the production source exporter, trusted key, approval process or solver.

## Evidence and calculation rules

- Gross >10BB eligibility uses accepted net contributions plus returned-uncalled chips, not a sum of raise-to actions. It compares integer cents with BigInt and includes wins, losses, ties and all game/format values. A missing refund map is unknown; a missing actor key in an existing map is zero, matching the accepted transaction contract.
- The approved commitment export contains exact stored accepted transaction payload text and hash, committed hand identity, accepted journal record digest, complete accepted-actions digest, BB and horse actor roster. Source binding without independently trusted authority is insufficient.
- Every reference binds the original decision, execution, accepted hand, complete original input snapshot, acquired read frame and source release. Observational tags, future-card evaluations, source/input mismatch, missing identities, noncausal or incomplete vectors are refused.
- Every version 2 reference also carries its evidence class, its domain `{variant, format, mode}`, a sampling contract digest and a producer digest. The domain must equal the original decision's own domain (read from `gameVariant`, `format` and `gameMode`, never defaulted) and be one the authority signed; otherwise `reference_domain_mismatch` or `reference_domain_not_authorized`. A version 1 reference is `reference_version_unsupported`.
- Alternatives use the original canonical legal menu, call price and raise-to bounds. Only exact action/amount objects are accepted. Calls are incremental; bets, raises and all-in amounts are targets.
- Utility is net chip-BB for cash or net tournament utility bound to the original complete tournament context. Costs must be included. Simultaneous confidence intervals cover the declared finite menu; paired simulations require at least 100 independent samples, exact enumeration at least one, and family-wise confidence at least 0.95.
- A conservative gain above 0.01 proposes a bounded inactive candidate. Overlapping intervals remain insufficient evidence. A non-finding applies only to the declared menu, not all possible bet sizes or global optimality.
- Candidate/reference identities survive rejection. An unexpected final serialization failure revokes tentative success, clears partial findings, preserves their rejected candidate IDs and returns incomplete. Results do not retain mutable aliases to original private reference actions.
- Existing journal reconciliation is required before a finding. Its request-lifecycle result is carried through; any new lifecycle conflict makes the journal incomplete. A legacy retained join can support a conditional finite-menu finding with lifecycle false. Complete source population, replay, GTO and activation remain false in every result.

Bounds are 256 retained records, 128 references, 32 alternatives per reference, 3 MiB input, 64 KiB authority and 512 KiB output. The existing canonical journal serializer also enforces its per-value byte/depth limits. Unsupported oversized or non-JSON inputs remain refused and their original private files are not changed.

## Tests and remaining gates

`review.test.ts` exercises qualified synthetic finding/non-finding/uncertainty, source/reference corruption, trust and identity, >10BB refunds/boundaries/outcomes, seven variants, five formats, legality, private-field leakage, input ownership and failure paths. `cli.test.ts` exercises the real private SQLite reader and safe private output writer. Synthetic signed utility vectors test this reviewer; they are not certified poker EV or GTO evidence.

`candidateCatalog.ts` (Phase 14.4) builds an in-memory inactive catalog from reviewed outputs, with disjoint selection and holdout windows (`holdout_leakage`), a finite selection protocol declared before validation (`selection_window_reused_as_validation`), complete per-domain baseline distributions (`incomplete_policy_distribution`) and a catalog digest. Every entry is `proposed_inactive` with `activationAllowed: false`; `engine/HorsePhase14Authority.ts` holds the null per-domain release selections. The catalog does not apply anything.

`riverReference.ts` separates original-state prices from retrospective execution/accepted-hand binding. The calculator covers the declared fold/call menu on single-board heads-up cash rivers against an already all-in opponent, under all nine card rules. It enumerates at most 4,096 declared combinations with actual pot rights, uncalled refunds and cent-accurate deductions. The controller's full price remains distinct from a short stack's incremental call. Extra advertised raise/all-in actions are outside this two-action correction family and retain their baseline distribution; the tool does not claim those unenumerated wagers are optimal. Its exact intervals concern enumeration error conditional on the declared range. Synthetic evidence classification is preserved, and no signature or qualification is emitted.

`riverDecisionModel.ts` builds a fixed, versioned 32-combination finite prior from original public state and hero's own cards. It reads no observed opponent holes or retrospective supplied range and consumes none of the horse RNG. Its calibration is explicitly unqualified. `riverKernel.ts` shares the bounded five-percent proposal rule between this original-state model and retrospective finite-menu analysis. `riverModelHoldout.ts` rebuilds the actual fixed model before measurement, so a producer cannot substitute a favorable post-hoc range. Its result binds both model and policy versions.

`riverHoldout.ts` counts retained hands, rejects reused source and selection overlap, binds finite source/producer/windows and reports a one-sided Hoeffding bound with the predeclared family correction. Ordered per-hand commitments stream into its measurement digest, avoiding the unrelated single-journal-record ceiling on a population. Trusted source custody, oracle independence and range calibration remain separate. All measurement outputs report `qualified: false` and `activationAllowed: false`.

`riverIndependentReview.ts` cross-checks the entire declared range using the separately implemented benchmark card scorer and contribution layers, plus integer-rational residual-cent allocation. Its versioned result binds the exact reference digest. A producer returning a reproducibly wrong value is rejected by the independent answer. This numerical cross-check currently refuses shared-dead-money/individual-ante geometry and extra folded seats because its independent layer reference does not represent those rights. It neither authenticates source nor supplies a trusted signer.

Run `node --import tsx src/scripts/horseRiverReference.ts MODE INPUT OUTPUT` from `server/`. Modes are `produce`, `verify`, `model`, `holdout` and `model-holdout`. Both paths must be absolute; inputs must be private owner-only regular files, and output must be new in a private owner-only directory. Version 1 input contains `input` for reference generation, `input` plus `reference` for numerical verification, `original` for the original-state model, or `plan` plus `rows` for either holdout mode. The CLI reads at most 16 MiB, writes an atomic private artifact without overwriting an earlier result, and prints only status. A model artifact has a 1 MiB output ceiling; other results retain the 512 KiB ceiling. There is no default live path, signer, promotion or action-clock network call. The functional runtime wiring is described below; qualified live selection remains pending.

Production use still needs authenticated execution of the existing accepted-source export path, an independent trusted signer/key, an approved original source window, qualified alternative-action reference per covered game/format, complete live journal lifecycle and source-population reconciliation, independent holdout evaluation and explicit candidate promotion/rollback. A production daily job and its retention/retry/coverage proof are separate work. Passing these tests does not complete Phase 14, Phase 15, deployment or all 15 phases.

## Functional kernel admission and execution

The versioned functional attachment is separate from legacy inactive literal catalogs. `kernelApproval.ts` verifies an independently pinned Ed25519 aggregate approval and recomputes its positive family-wise lower bound. It refuses synthetic evidence in production. `kernelAdmission.ts` atomically validates the protected selection, exact file hash, domain/source/generation/expiry, catalog, running policy and baseline-selection commitments through the existing Phase 14 S4 identity. The protected per-domain entries live in `HorsePhase14ReleaseSelections.ts`; every entry remains null until real qualification exists.

`liveKernel.ts` consumes only a runtime-branded catalog and worker-local capability. The graph v3 corrective node runs before final wager rules and timing; v1/v2 retained records remain readable. FAST captures original reads after one observation and outside intent capture; DEEP reuses that FAST snapshot/read frame. The client binds both original hashes, mirrors/stamps authority and forgets it on worker termination. Physical and Lightning action doors share acceptance-time authority/composition checks, and the existing execution witness records the controller's actual action. A coerced or fallback candidate withdraws its local authority. Fold/call corrections author no reference wager plans, and all ordinary effect admission gates remain enforced.

`kernelEligibility.ts` is shared with full-model holdout: catastrophe-protected folds, already-applied prior candidates and stack-sized calls requiring an all-in alias remain unchanged. Full-model holdout requires the complete baseline decision and counts these exclusions in its denominator; an action-only row cannot certify the runtime composition. The policy version was advanced for this behavior. Selected baseline owners must remain usable and enabled at execution and acceptance. Replay state v3 records corrective admission and catalog identity while retaining v2 readability; replay authority comes from current protected source, never recorded flags.

Native regressions cover the actual worker, client transport, FAST/DEEP, withdrawal, original hash substitution and a complete HandController hand with exact accepted call and chip conservation. These local tests neither supply real-source custody, an independent signing key/service, a positive untouched production holdout, protected release selection nor live fleet proof. Those remain explicit qualification and delivery requirements.

`kernelReviewInput.ts` reconstructs the existing unsigned accepted-source export from exact stored PostgreSQL text and retained journal records, returning only a custody commitment. `riverAcceptedOracle.ts` is an explicit offline, bounded, exact-coordinate read-only PostgreSQL adapter using verified TLS and the configured canonical database connection. It binds original decision/execution/accepted records and independently prices terminal utility with the benchmark card/pot owner. Hidden accepted holdings enter only this oracle, never the public-state policy model. Missing or mucked holdings are unavailable and cannot be silently dropped from a claimed complete holdout. Neither module signs, qualifies, provisions credentials or activates anything.

For a finite independent numerical batch, use `horseRiverReference verify-batch INPUT OUTPUT` with version 1 `{inputs: RiverReferenceInput[]}`. The reviewer rebuilds the fixed original model for every case, checks every generated reference against the independent scorer, rejects duplicate accepted-hand/decision identities and streams a bounded ordered commitment. It does not authenticate acquisition or issue approval.

Run `node --import tsx src/scripts/horseRiverAcceptedOracle.ts INPUT OUTPUT` from `server/` only in the authorized offline environment with its configured canonical `DATABASE_URL`. Version 1 input is `{records, handKey, input}` plus `version: 1`; both paths must be absolute and private, and output must be new. The operation reads at most 16 MiB and atomically writes at most 512 KiB. Exit 0 is a read-only accepted-source oracle result, 2 is a written unavailable result, 3 is a private operation failure and 64 is invalid invocation. Stdout contains status and explicit false qualification/population/activation fields only. There is no environment-file loading, credential output, source query on import, network strategy work or automatic promotion.

Run `node --import tsx src/scripts/horseCorrectiveKernelReview.ts INPUT OUTPUT`
from `server/` in the authorized offline source/runtime environment. Version 1
input is `{version: 1, predeclaration: {commitSha, path, contentSha256}, requests:
RiverAcceptedOracleRequest[]}`. The safe plan path is under
`docs/evidence/phase14/plans/`. The operator authenticates exact plan bytes and
provider PR merge time through configured authenticated GitHub reads, proving
that the plan commit is on protected main and merged before holdout start.
Git authored time and caller `declaredAt` alone grant no custody. A separate
documentation plan commit may name the installed engine component source.

The protected plan explicitly names
`populationBasis: 'accepted-commit-and-immutable-played-v1'`: membership is the
intersection of its accepted-commit interval and immutable played-at interval,
using the same canonical millisecond bounds. It does not claim the population
of every hand played inside those bounds. The complete accepted-commit census,
its exclusions/gaps, and a late-transaction finality fence remain separate
requirements; a supplied request list is not that census.

The operator independently resolves its module-root Git HEAD, requires clean
tracked bytes and refuses untracked source files. That source must equal the
plan and every record's source. Each baseline must replay on its original
JavaScript runtime. Both paths must be explicit, absolute and private, and
output must be new. The CLI reads at most 256 MiB, accepts 2–10,000 requests of
at most 256 validated records each, and atomically writes at most 512 KiB. It
calls the configured read-only oracle directly, binds both authenticated clock
values, reconstructs the fixed model, independently checks numerics and measures
the full original policy. It accepts no caller oracle, replay result or
qualification flag.

Exit 0 means `reviewed_unsigned`; exit 2 preserves a written unavailable result,
3 is a private operation failure, and 64 is invalid invocation. Stdout contains
status and false qualification/population/activation fields only. Every result
retains `qualified: false`, `completePopulation: false` and
`activationAllowed: false`. A genuine protected plan removes only the
`authenticated_predeclaration` gate. Complete source-window census, qualified
rollback and the independently held signer remain required before issuance.
There is no signing key, environment-file loading, import-time query,
scheduler, publisher or promotion side effect.

The separate accepted-key page command is `npx tsx src/scripts/horseAcceptedWindow.ts /absolute/private/window.json /absolute/private/new-page.json` from `server/`. Its owner-only input is `{version:1,request:{startsAt,endsAt,after}}`. The page requires the installed `horse_accepted_window_time` index and a clear, visible transaction-finality fence. It keeps coordinates, gaps and the exact next cursor only in the private output. Exit 0 means a page was written; exit 2 writes an explicit unavailable result. Page exhaustion grants no full-window, eligible-decision, qualification or activation claim.

## Independent qualification issuer and credential identity

The explicit operator is `node --import tsx src/scripts/horseCorrectiveKernelIssue.ts MODE INPUT OUTPUT` from `server/`. All paths are absolute, owner-private and explicit; output must be new. Input/output are capped at 512 KiB and published atomically. There are no operator-supplied source overrides, case lists, catalogs, qualified flags, signing challenges or private-key paths.

`context` takes `{version:1,predeclaration:{commitSha,path,contentSha256}}`, authenticates the protected plan and reads only canonical image/runtime metadata through the pinned SSH route. `produce` takes that same input and reconstructs the complete private source population; its safe receipt contains only source, counts and ordered request commitment. It never reads the signing key. `issue` takes that input plus `scratchRoot` and `producerRequestsDigest`. It independently reacquires the source, requires branded predeclaration/census provenance, exact original runtime replay, independent fixed-model numerics, the predeclared positive untouched holdout, current source/baseline bindings and executed rollback proof. Only then does it load the purpose-only canonical credential, match the committed public pin, sign, and verify through the unchanged approval/catalog consumer. The output on success is the bare qualification file, ready for a separate protected evidence/selection change; issuing never activates anything.

The public plan must declare a valid cash `domain` and `populationBasis: 'accepted-commit-and-immutable-played-v1'`. `correctiveKernelProducerIdentity()` reports the independently resolved clean source, policy and producer fingerprint for preparing the future plan; its result is never qualification. The actual producer fingerprint binds source/policy/model/kernel versions and must match the committed plan.

`identity` takes only `{version:1}`. It verifies configured credential possession against the committed public pin by signing and verifying the fixed non-approval message `horse-corrective-signer-identity-v1`. It returns public key digest and identity status with `qualified:false` and `activationAllowed:false`. It accepts no caller challenge, emits no signature/approval/catalog and invokes no DB, journal or child tool. This operation verifies canonical-store configuration before a positive holdout exists.

The manually dispatched `horse-phase14-qualification.yml` derives source/runtime from the authenticated plan and canonical image, separates the unsigned producer from `HorseCorrectiveQualification`, and gives only the issuer step its purpose key. The identity-only choice uses that isolated environment without plan/DB/journal access. There is no schedule, release dispatch, publisher or deployment permission. Because the repository is public, artifacts contain only bounded public receipts, signer identity or the signed qualification file; no raw journal, card, connection or credential files are uploaded.

Exit 0 is the selected mode's actual successful operation, 2 is a written unavailable/nonqualifying receipt, 3 is private-operation failure and 64 is invalid invocation. Negative measured holdouts retain their bounded measurement in the unavailable receipt. All promotion, generation, expiry, withdrawal, protected merge, engine installation and natural accepted use remain their existing independent gates. A credential identity check does not satisfy any policy qualification gate.

The protected generation ledger pins monotonically increasing published generations, their authority digests and withdrawal tombstones; its publication guard runs in the required TypeScript CI job. Runtime admission uses the shipped ledger. The issuer reads current protected-main generation/control bytes before review and again before signing, so an old checkout cannot revive withdrawn generations or use an outdated privileged verifier. This preserves the existing next-protected-engine-release withdrawal boundary; it adds no per-decision network authority.
