# Accepted legacy release reconciliation

The accepted v1 generation `bc525463996c65be3a89a7fe0cb35cd601a0d5e3` requires full `health.releaseSha` even when the sealed desired image predates that health field. Recovery and rollback readiness therefore reject the still-serving legacy engine before any candidate begins. The ordinary compatibility repair belongs in a new compatible control generation. Installing it cannot rewrite an already accepted request's generation pin.

`server/scripts/reconcile-legacy-sealed-release-v1.py` is an additive, bounded recovery-only entrypoint for the original failed request. It never invokes a container mutator, candidate transaction, seal prepare/authorize/commit, mutable current pointer, or another release request. It does not activate on-demand maintenance or change the existing :55 cutover rule.

The operator stages both reviewed Python files as root-owned mode0755 regular files and a fresh root-owned mode0600 manifest. Keep the original generation and its seal/database-proof/transaction files. Install without executing the recovery operation:

```text
install-legacy-sealed-reconciliation-v1.py --source /absolute/staged/reconcile-legacy-sealed-release-v1.py --manifest /absolute/immutable/manifest.json --manifest-sha256 EXACT_SHA256
```

The installer verifies the supplied bytes, takes the existing engine mutation lock, and writes a separate digest-addressed entrypoint under `/usr/local/lib/club-arena/engine-legacy-reconciliation-v1/`, a digest-addressed authorization, and one exact per-run native unit. It refuses conflicting immutable files or unit bytes. It performs native systemd verification before unit installation, reloads definitions, checks loaded command/properties/dropins/inactive state and installed bytes, then persists an `installed_inactive` receipt under `/var/lib/club-arena/engine-release-legacy-installations/MANIFEST_SHA256/`. It never enables or starts a unit. A local fixture test is not this installed receipt.

After the sole production owner has reviewed that actual installation receipt, start only the exact `club-arena-engine-legacy-reconciliation-v1@RUN_ID-RUN_ATTEMPT.service`. Its immutable command is:

```text
reconcile-legacy-sealed-release-v1.py --manifest /absolute/immutable/manifest.json --manifest-sha256 EXACT_SHA256
```

The installed unit uses `Type=oneshot`, `Restart=no`, `TimeoutStartSec=300`, `TimeoutStopSec=10`, `KillMode=control-group`, and no shell wrapper between systemd and the executable. The executable verifies its PID and `INVOCATION_ID` against that exact unit. No environment-based path or identity override is accepted by either executable; tests replace internal dependencies only in their process.

The exact JSON manifest fields are:

| Field                                                               | Binding                                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                                            | `1`                                                                                                                           |
| `run_id`                                                            | Original accepted run-attempt                                                                                                 |
| `target_sha`, `control_sha`                                         | Original full target and control commits                                                                                      |
| `invocation_id`                                                     | Original v1 unit's observed invocation; not relabeled as successful or permanently failed                                     |
| `desired_sha`, `desired_image_id`, `desired_generation`             | Already sealed source, immutable Docker image ID, and seal generation                                                         |
| `desired_legacy_unlabelled`                                         | Exact sealed boolean. The observed accepted engine is `false`; its image and container require full matching revision labels. |
| `initial_seal_sha256`                                               | Exact durable seal JSON fingerprint before first reconciliation, checked under the native mutation lock                       |
| `request_sha256`, `intent_sha256`, `pin_sha256`                     | Exact original durable bytes                                                                                                  |
| `seal_helper_sha256`, `database_proof_sha256`, `transaction_sha256` | Original generation's immutable executable helper bytes; these are not the durable seal fingerprint                           |
| `entrypoint_sha256`                                                 | Reviewed additive recovery executable                                                                                         |
| `expires_at`                                                        | Unix seconds, at most30minutes in the future; each invocation has a300second execution bound                                  |
| `reason`                                                            | `accepted_v1_legacy_health_identity_failure`                                                                                  |

The original unit must be inactive with no process or queued job and retain its exact observed invocation. The existing engine mutation lock must be free. Any pending seal mutation, committed original run, changed durable record, wrong image or source, malformed health, changed container/process, or stale database leader refuses retirement. The old image must have exactly one full `GIT_COMMIT_SHA`. With the observed sealed marker `false`, both image OCI revision and container revision must equal the full sealed SHA. Only a separately authorized, matching sealed `true` marker admits absent labels; conflicting labels always fail. A missing health field does not imply an unlabelled image.

The initial raw seal fingerprint is admission evidence. After receipt creation, proofs revalidate the desired source, image, explicit label policy, generation, no pending mutation and original-never-committed invariants. They do not require every future journal byte to equal the initial snapshot. Historical completion readback relies on the immutable exact terminal receipt and its audit rather than claiming the old image still serves forever.

After proving the unchanged old image locally, publicly, and through the existing bounded database-leader helper, the entrypoint extracts only the pure health parser from the hash-bound original transaction and actually executes it against bounded captured health. Only an absent `releaseSha` field with the expected old version and a real parser exit1 demonstrates this defect. Null, empty, wrong, and already-correct identities do not create a failure.

The seal's existing failure format records this new reconciliation transaction's real diagnostic exit1 and native reconciliation invocation. An immutable sidecar links that diagnostic to the original invocation, request, intent, pin and generation. The original wrapper's exit75 is never relabeled1. Existing seal checks prevent replacing a committed or conflicting outcome. Exact failure and terminal attestation repair the audit before any original record is retired.

Retirement preserves v1 ordering: pin, image lease, break deadline, intent, request last, then disable only the original release unit's boot edge. No image retention or source cleanup occurs. Before/diagnostic/failure-intent/terminal/complete evidence is retained under `/var/lib/club-arena/engine-release-legacy-reconciliations/RUN_ID-RUN_ATTEMPT/`. Lost write responses require exact attestation. An absent receipt may retry only the seal's same idempotent write under fresh proof and unexpired authority. Existing terminal cleanup may resume after authorization expiry. Completed historical readback does not require that old image to remain serving, but still requires retained original seal helper bytes for audit attestation.

The native Python suite uses the actual accepted seal, filesystem, locks, durable writes and extracted Python parser. It fixtures Docker, systemd, health and the database-leader transport; it is not a production installation or served-state receipt. `tests/engine-legacy-sealed-reconciliation.native.test.ts` runs it through the existing required Vitest CI shard path.
