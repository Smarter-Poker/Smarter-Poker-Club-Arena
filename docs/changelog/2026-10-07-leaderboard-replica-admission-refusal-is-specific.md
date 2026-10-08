# Replica Admission Refusal Retains Its Exact Safe Cause

Actual qualification run 37690338855 refused replica admission before export or
Auth testing. The generic message did not distinguish recovery, read-only,
feedback, version, and WAL replay conditions; cleanup erased the private inputs.

The existing verifier now emits fixed condition names before retaining the same
failure exit. No raw values, paths, credentials, or identifiers are disclosed.
Focused regressions independently exercise each refusal and confirm the original
admission checks still reject the same unsafe state. No guard, timeout, database
configuration, or financial behavior changes.

Actual source restoration, Auth and financial qualification remain unproven.
