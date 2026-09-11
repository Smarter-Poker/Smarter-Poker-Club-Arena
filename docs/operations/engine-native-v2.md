# Journal-owned engine operation v2

This is executable source for the existing Club Arena controller's native actuator. It is not installed or activated by this change. Frozen v1 request, wrapper, unit, result and CLI bytes are unchanged. The v2 actuator holds the existing `/var/lock/club-arena-engine-up.lock`, uses the existing canonical `engine-up.sh` and seal, and never creates a separate release coordinator.

## Installed artifacts and admission

The ordinary `build-bundle.mjs` output includes the native entrypoints and the two unit templates. Its immutable directory basename is the SHA256 of `bundle-manifest.json`. The native installer verifies the complete inventory, policy digest, existing private credential reference and retained authority configuration before publishing a configuration. Its router is installed at `/usr/local/lib/club-arena-release-controller/engine-intake-v2.py`, the path used by `engineTransport(..., 2)`. The router itself is create-if-absent and byte-equal on replay; incompatible routing requires a separately versioned successor.

`install-engine-native-v2.py --configuration <root-owned-json> --sha256 <exact-bytes-digest> --expected-current-digest <prior-digest-or-none>` validates native unit syntax, installs the router, and changes the default configuration with a compare-and-swap under the existing engine lock. The result is `INSTALLED_INACTIVE`. It never starts or enables a service, grants a role, creates an identity, or supplies an activation receipt. An interrupted pointer publication can complete against the same immutable install intent.

The configuration retains the existing engine-boundary fields (`trusted_control_sha`, exact `control_files`, recovery evidence) and adds:

```json
{
  "protocol": 2,
  "policy_digest": "1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda",
  "bundle_path": "/usr/local/lib/club-arena-release-controller/versions/<bundle-digest>",
  "bundle_digest": "<bundle-digest>",
  "actuator_credential_name": "<existing-systemd-credential-name>",
  "actuator_credential_path": "<existing-private-root-owned-file>",
  "authority_config_path": "/etc/club-arena-release-controller/host-authority/<authority-config-digest>/configuration.json",
  "authority_config_digest": "<authority-config-digest>"
}
```

The separately retained authority configuration contains `engine_actuator.database_credential_name`, `database_ca_path` and `database_principal`. These are references; no credential value belongs in a request, candidate environment, receipt, repository, or unit command. The actuator's Node helper checks TLS peer verification and the existing LOGIN role's constrained actuator membership before using the database API. Missing identity or membership is an activation blocker, not permission to create one.

For each provider operation UUID, intake creates immutable intent/configuration/installation records under `/var/lib/club-arena/engine-operation-v2/<uuid>/`. It installs byte-pinned per-operation `.service` and `.path` units, verifies loaded commands and properties, enables their boot edges, and arms the path unit before atomically publishing `acceptance.json`. Only then can intake return `accepted: true`. Loss before publication is not proof of acceptance; exact prepare can resume partial installation. Loss after publication cannot erase the native event or boot edge. Provider INTENT/UNKNOWN continues to own the global barrier until terminal readback.

If observe finds an exact installation pin interrupted before acceptance, the real provider reconciliation path invokes v2 `resume-acceptance`. This continuation refuses an absent, changed, accepted, executed or terminal pin, retains the original configuration, rechecks preflight and has twelve persisted attempts. It does not create another request or grant candidate authority. A lost resume response is followed by observe, which cannot rearm an already accepted operation.

The fixed router selects an accepted operation's original bundle even after a later default upgrade. On execution, the unit claims the native event durably and removes `acceptance.json`, so the path does not retrigger it indefinitely. The service retains the boot recovery edge until terminal proof and retirement. Twelve persisted native invocation receipts bound retries independently of systemd's secondary rate limit. Every invocation verifies its loaded unit PID and InvocationID; a shell environment is not execution authority.

## Mutation, interruption and terminal proof

The live controller must already have committed the exact provider INTENT and submission. Under the engine lock, the actuator reads `engine_maintenance_actuator_context`, validates exact policy/activation/request/artifact/owner/epoch/step/current readiness and time budget, then atomically calls `consume_engine_maintenance_step`. The database rejects missing live ownership, changed selected receipts, wrong installed host bundle, stale/expired steps and duplicate consumption. The returned authority, not candidate labels or environment variables, admits the single trial. The canonical policy's 24-hour qualification is a later uninterrupted major-engine observation requirement; it is not a CI or unit deadline.

The claim-attempt record includes the validated absolute database recovery deadline before consume, and returned consumption precedes any trial. A lost consume COMMIT response cannot start a second candidate: restart enters sealed recovery only within that original deadline. A delayed restart cannot create a later recovery window. Existing desired recovery remains restricted to the exact prior sealed image; successful commit readback finalizes only the exact candidate commit. Timeouts of native mutation commands retain UNKNOWN even when a subsequent health read succeeds.

The native lock opener recognizes only the trusted root-owned `/var/lock` alias to `/run/lock`; every other parent remains subject to strict ownership and no-symlink checks. It preserves the existing regular lock file and compares its device/inode with the opened descriptor before and after locking. A root-owned sticky shared `/run/lock` is supported without allowing writable or foreign lock files. No existing lock is replaced, unlinked, or chmodded. Existing-source and sealed recovery witnesses accept complete HTTP 200 or 503 responses with exact full revision, image, running/liveness, stable local/public instance and fresh database leader proof. Candidate trial, finalization and successful publication readback still require HTTP 200. Missing or null revision fields are refused.

After a durable exact terminal result, retirement disables only this operation's service/path boot edges. A lost disable response can resume terminal cleanup after the invocation budget is exhausted; it never grants another trial. Observe requires the result digest, installation digest, inactive process state, disabled boot edges, exact native seal/health/database proof and no uncertain-command marker before returning terminal. Retain the pinned bundle, staged control helpers and receipts for audit readback. Uncertain native command outcomes still need an explicitly owned reconciliation decision; they are not silently relabeled failed.

## Verification and remaining activation work

`tests/operations/engine-native-v2.native.test.ts` runs the Python authority and wiring suites through the required client unit-test gate. The wiring suite uses actual local files, fsync, flock and an external native-manager fixture process; it covers every acceptance interruption, immutable replay/conflict, loaded-unit drift, native attempt limits, recovery expiry, lost terminal cleanup response, router upgrades and import without service credentials or bytecode writes. These are not Linux PID1 or production Docker installation receipts.

`tests/operations/actuator-maintenance-composition.mjs` runs through the maintenance agent's socket-only PG17 fixture runner. It executes the production `actuatorAuthority` and `maintenanceCall` implementations against the real journal/provider/maintenance migrations, then the native transaction with fixture container/seal actions. Success, lost consume response, disconnected owner, stale epoch, wrong host bundle and expired step are tested. The composed test found and required the explicit, read-only version-function grants for `release_journal_actuator`; it does not grant controller table access.

Systemd property expectations were checked against the [v255 systemctl source](https://github.com/systemd/systemd/blob/v255/src/systemctl/systemctl-show.c), including Paths and exit-status rendering. Per-operation install requires actual `systemd-analyze verify`, loaded fragment/no-drop-in/no-pending-reload readback and exact command/timeout/restart properties. The lead operator's read-only host check confirmed the fixed `/var/lock` alias and that both paths reach the same existing inode; no current Linux v2 installation has been tested by this source-only task.

Activation remains blocked until separately proven existing actuator/controller/verifier identities, forced-command SSH isolation, TLS route, six exact compatibility receipts, trusted unprivileged candidate build isolation and actual host unit/artifact installation are available. The new pipeline also still needs trusted source-object transfer into the host repository before seal ancestry validation. The broader provider slice does not yet implement CA static or World Hub build/publication orchestration. Existing publishers and legacy `:55` maintenance remain authoritative until their coordinated replacement is verified.
