# A slow database call can no longer wedge every post-deploy certificate (2026-09-29)

## What happened

Club Create Certification run 36452298238 (2026-09-28 16:36Z) created two
fixture clubs ("Crest Cert ..." and "Preset Crest Cert ...") for a reserved
identity in the `ca-customization-cert-postdeploy-` namespace. In its `finally`
block it retired them through `fn_ca_retire_certification_club`. The first
retirement succeeded. The second failed with `canceling statement due to
statement timeout`: `service_role` has an 8 second cap and the database was
under load. The script logged the error and moved on, and
`cleanup_reserved_certification_account` then refused the identity
(`CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY`, SQLSTATE 55000) because
it still owned a club.

From then on every Post-Deploy E2E run failed at "Provision an isolated
production E2E account": `createProductionE2EAccount` ->
`cleanupStaleProductionE2EAccounts` -> `cleanupProductionE2EAccount` on the
leaked identity -> the same refusal -> throw (for example run 36484020317, the
engine certificate for fa480b9b). One leaked fixture blocked the engine
certificate for about ten hours. It was cleared by retiring the club through the
same sanctioned door by hand.

## The cause, at two levels

1. `certify-club-create.mjs` treated a transient database failure in its
   cleanup as final. The door is a single idempotent transaction (a club that is
   already gone answers `{success: true, already_gone: true}`, read from
   `prosrc` in production), so a timeout rolled it back and a replay is safe, but
   nothing replayed it.
2. Stale-account recovery could not recover the exact situation it exists for.
   `cleanupStaleProductionE2EAccounts` swept the identity directly, and the guarded
   sweep correctly refuses an identity that owns a club. Correct refusal, wrong
   consequence: the refusal sat at the front of every later certificate.

## The fix

- `scripts/ci/transient-retry.mjs` (new): a bounded retry, 2 s / 4 s / 8 s / 16 s
  (five attempts, 30 s of waiting), for failures that say only that the database
  was busy: `57014`, `55P03`, `40001`, `40P01`, `53300`, `PGRST000-003`, HTTP
  408/429/502/503/504, a dropped connection. A bare HTTP 500 is NOT transient:
  PostgREST returns 500 for the guard's own `RAISE` (55000 was exactly that), and
  a `success: false` body, a permission error or any application SQLSTATE is
  definitive and never retried. Exhausting the attempts throws the last failure;
  a retry never converts a failure into a pass.
- `certify-club-create.mjs`: each fixture retirement, and the read that proves
  the clubs are gone, run inside that retry. The leak check also no longer reads
  an unreadable answer as an empty one.
- `production-e2e-account.mjs`:
  - `retireProductionCreateClubFixtures` takes an explicit `record` (and a
    `reason`), keeps every guard (reserved namespace, owner match, exact
    `Crest Cert ` / `Preset Crest Cert ` prefixes, the door's own refusals),
    validates every owned club BEFORE retiring any, and retires through the same
    bounded retry (`retireCertificationClubWithRetry`).
  - `cleanupStaleProductionE2EAccounts` retires the clubs a stale identity owns
    before sweeping the identity. A stale identity that owns any club outside the
    fixture prefixes still refuses loudly and retires nothing.
  - `serviceRequest` errors now carry `status`, `code` and `body`, so callers
    classify by code and never by parsing a message.

## Pinned by

`tests/unit/productionE2EAccount.test.ts` (a model of production in which the
account sweep refuses while a club is owned): a stale identity owning a fixture
club is recovered, retiring before sweeping; both fixture clubs; a non-prefixed
club refuses without retiring anything (including a recognized sibling);
a statement timeout is retried with the documented backoff and then succeeds;
exhaustion fails loudly; a `success: false` refusal and a 55000 500 are not
retried; a replay answering `already_gone` passes.
`tests/unit/transientRetry.test.ts` pins the classification and the bounds, and
that `certify-club-create.mjs` routes its retirement through the retry.

## Not changed

No engine, database, workflow or money-path change. The retire door, the
account sweep and the stale inventory function are untouched.
