# Recover an auth initialization refused before native lock acquisition

The natural mobile observer exposed a shared-auth startup defect: one native
lock acquisition aborted before entering the SDK initializer, and auth-js kept
that rejected promise for the client lifetime. Later calls never requested the
lock again, leaving authenticated reads unavailable.

A version-bound auth-js 2.90.1 archive repairs that owning initializer and its
public admission paths. The first failure still rejects. A later explicit API
request can initialize single-flight under the original native exclusive lock;
an entered initializer is never replayed. Bootstrap failures report sanitized
error names. Refresh behavior, lock budgets and cross-tab ownership remain
unchanged. Normal lockfile installation enforces the archive with scripts
disabled; its readable patch and deterministic integrity-checked generator are
retained alongside the dependency.

Actual CommonJS/ES-module regressions and a local native WebKit contention
fixture qualify acquisition recovery, concurrent callers, retained subscribers
and refusal to replay entered callbacks or token failures. Production mobile
certification remains separate from these local checks.
