# A Degraded Engine Can Still Be Replaced

2026-09-11 · root-owned Hetzner engine release transaction

## Problem

The engine health endpoint intentionally returns the same structured body with HTTP 503 when an optional subsystem makes the engine non-routing-ready. The former deploy workflow used `curl -f` while reading the maintenance certificate, which discarded that body. A degraded engine could therefore present a complete, durable restart certificate and still prevent the release intended to replace it.

## Durable Fix

- `server/scripts/engine-release-transaction.sh` is the sole engine mutation owner.
- Its maintenance-certificate reader accepts only HTTP 200 or 503 after a successful transfer, then validates every certificate predicate from the JSON body.
- The certificate is checked before and again after the engine lock is acquired.
- Transport failures, unexpected status codes, invalid JSON, false predicates, unparked tables, and insufficient recovery time all fail closed before mutation.
- The already-sealed source and its rollback recovery accept only a fully transferred HTTP 200 or 503, then require exact SHA, running state, liveness, process identity, and local/public agreement. The transaction's pre-cutover rollback-readiness gate additionally requires an unchanged container generation and a fresh elected database leader. This lets a release replace the optional subsystem defect that made its source return 503 without treating an unknown or dead source as recoverable.
- Every new candidate, pre-commit check, and final local/public check explicitly requires HTTP 200 plus the exact identity predicates. The independent publication check also remains routing-ready and fail-closed. A 503 source can be replaced; a 503 candidate can never be certified or reported shipped.
- `.github/workflows/auto-deploy-hetzner.yml` delegates the transaction to the host and independently verifies the sealed exact-SHA result.

## Pinned By

- `tests/unit/engineReleaseMaintenanceCertificate.test.ts` executes the maintenance and source 200/503 matrices, the strict-200 identity boundary, and their transport, status, JSON, identity, and certificate failure classes.
- `tests/a-degraded-engine-can-still-be-replaced.law.test.ts` pins transaction ownership, lock ordering, degraded source/rollback ownership, the executable transaction-to-prepare path, and the strict candidate/publication boundary.
