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

The owner must separately configure `HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256`. Its value is SHA256 over the base64 representation of the Ed25519 public key's DER SPKI bytes. An authority envelope supplies that public key and a signature covering canonical JSON of `["horse-corrective-review-authority-v1", authority]`. The approved authority binds the exact hand, accepted commitment export digest, reference digests, qualification ID and evidence class.

An envelope cannot approve itself by including its own trust-key digest. Successful verification returns a detached, frozen, runtime-branded authority object; a copied object is untrusted. A real signer must independently validate the accepted-source export and the numerical/causal/uncertainty quality of its approved reference. Cryptography proves byte binding, not poker correctness. This module does not create the production source exporter, trusted key, approval process or solver.

## Evidence and calculation rules

- Gross >10BB eligibility uses accepted net contributions plus returned-uncalled chips, not a sum of raise-to actions. It compares integer cents with BigInt and includes wins, losses, ties and all game/format values. A missing refund map is unknown; a missing actor key in an existing map is zero, matching the accepted transaction contract.
- The approved commitment export contains exact stored accepted transaction payload text and hash, committed hand identity, accepted journal record digest, complete accepted-actions digest, BB and horse actor roster. Source binding without independently trusted authority is insufficient.
- Every reference binds the original decision, execution, accepted hand, complete original input snapshot, acquired read frame and source release. Observational tags, future-card evaluations, source/input mismatch, missing identities, noncausal or incomplete vectors are refused.
- Alternatives use the original canonical legal menu, call price and raise-to bounds. Only exact action/amount objects are accepted. Calls are incremental; bets, raises and all-in amounts are targets.
- Utility is net chip-BB for cash or net tournament utility bound to the original complete tournament context. Costs must be included. Simultaneous confidence intervals cover the declared finite menu; paired simulations require at least 100 independent samples, exact enumeration at least one, and family-wise confidence at least 0.95.
- A conservative gain above 0.01 proposes a bounded inactive candidate. Overlapping intervals remain insufficient evidence. A non-finding applies only to the declared menu, not all possible bet sizes or global optimality.
- Candidate/reference identities survive rejection. An unexpected final serialization failure revokes tentative success, clears partial findings, preserves their rejected candidate IDs and returns incomplete. Results do not retain mutable aliases to original private reference actions.
- Existing journal reconciliation is required before a finding. Its request-lifecycle result is carried through; any new lifecycle conflict makes the journal incomplete. A legacy retained join can support a conditional finite-menu finding with lifecycle false. Complete source population, replay, GTO and activation remain false in every result.

Bounds are 256 retained records, 128 references, 32 alternatives per reference, 3 MiB input, 64 KiB authority and 512 KiB output. The existing canonical journal serializer also enforces its per-value byte/depth limits. Unsupported oversized or non-JSON inputs remain refused and their original private files are not changed.

## Tests and remaining gates

`review.test.ts` exercises qualified synthetic finding/non-finding/uncertainty, source/reference corruption, trust and identity, >10BB refunds/boundaries/outcomes, seven variants, five formats, legality, private-field leakage, input ownership and failure paths. `cli.test.ts` exercises the real private SQLite reader and safe private output writer. Synthetic signed utility vectors test this reviewer; they are not certified poker EV or GTO evidence.

Production use still needs an accepted-source export producer, independent trusted signer/key, approved original source window, qualified alternative-action reference per covered game/format, complete live journal lifecycle and source-population reconciliation, independent holdout evaluation and explicit candidate promotion/rollback. A production daily job and its retention/retry/coverage proof are separate work. Passing these tests does not complete Phase 14, Phase 15, deployment or all 15 phases.
