# Inert accounting fixture source

This directory contains preserved accounting source and a pure insurance projection check invoked by the existing isolated PostgreSQL probe. It supplies no application caller, migration registration, production installation, funded settlement authority or S7 activation. The projection helper continues to return `accepted=false`.

## Current verification path

The existing pull-request job `TypeScript compilation and repository checks` in `.github/workflows/ci.yml` runs `scripts/ci/probes/chip-journal-atomicity/run-isolated.sh` on `ubuntu-latest`. That script creates its disposable PostgreSQL 17 cluster and invokes `test_atomicity.py fixed --bootstrap`, which calls `test_insurance.verify_insurance(run)`. The projection check runs first within that existing insurance function; the original insurance bank, replay and journal checks follow unchanged. No new job, workflow, runner or platform is required.

The probe's `run` function invokes `postgres-runtime/query.mjs`. Each invocation opens one `pg.Client`, sends the supplied SQL, retains the database error code/message on failure and closes the client in `finally`. Verification must use this existing hosted route and its applicable required checks. Historical handoffs do not authorize an alternative execution or publication route.

## Preserved source and custody

`SOURCE-CUSTODY.json` maps every original PR4702 member to its preserved location and original SHA256. It is derived custody metadata, not a replacement for an original seal or proof that any SQL ran.

- `insurance0145/` is the complete original eight-member packet plus its unchanged `SEAL.json` (`80b0a8df4019ed8ca4da04ef48391b05ffe0308fc8c94b7503fbc73136ddecb3`). Its original `HANDOFF.md` is retained byte-for-byte because the seal includes it. All instructions, execution restrictions and status statements in that handoff describe the historical packet only. Current execution follows the maintained provider route above and current owner policy.
- `s7-0143/` preserves its original four members and unchanged seal (`b4bc39d9067c88c4ff9ceae084fc9483ef6c8d251d436dc93f47c2bf3b4e867f`). It is historical, inert source; the pure projection path does not load or execute S7.
- `predecessor0141/` contains only the original rejected helper definition and original seal. The seal references other members that are intentionally absent here. This is an explicitly incomplete predecessor packet, sufficient only as retained input to the existing predecessor regression. Do not represent its seal as a complete local packet or install its helper in application paths.
- `historical/PR4702-README.md` is the exact prior guidance, retained as evidence rather than current instructions. Its former provider restrictions and unrun status do not establish present authority or results.
- `historical/PR4702-test_insurance.py.txt` preserves the original PR4702 Python member. The active loader has the disclosed syntax correction below; the custody map keeps the original member's hash and location distinct from maintained executable source.

The four immutable SQL hashes in `test_insurance.py`, all 49 structural vectors and assertions, the predecessor counterexample, three guard SQL files and nine controls are unchanged from PR4702 head `a3e3f8340132798103370698bf516e31330ae1fb`. No immutable seal has been repinned. After verifying those hashes, the active loader requires exactly one original `IS DISTINCT FROM CASE ... END THEN` predecessor comparison and parenthesizes its CASE expression. PostgreSQL otherwise parses the inner `THEN` as the PL/pgSQL IF boundary and rejects the definition with `42601`. Only the executable copy receives these two parentheses; the sealed predecessor file is unchanged. Exact function-body readback is derived from that corrected executable copy before both refusal and positive checks.

## Existing guard and regression boundary

The install guard requires PostgreSQL 17, a local socket, database `postgres`, the isolated `journal_test` superuser connection, absent owned schema/role names, and the expected inert fixture roles with no relevant role memberships or creating-role default privileges. It refuses unexpected preimages. A savepoint contains the private schema, nonsuperuser owner/revoke-target roles and hash-pinned definitions. Readback checks exact function bodies, signatures, ownership, attributes, search path, schema access and effective function permissions. The accepted cases and predecessor regression execute as the nonsuperuser fixture owner. Rollback must restore the complete captured role, membership and default-ACL state and remove owned objects.

The nine retained controls cover the actual baseline constructor's execution role, schema collision, membership, default ACL, changed function body, unlisted-role function grant, schema access, rollback contamination and an unexpected post-install error. Each requires its exact database code/message, followed where applicable by a fresh client checking the original preimage after the failed client closes. The test-only baseline refuses collisions and is removed after the controls. Unexpected errors or successful negative controls stop the positive case dispatch. These are disposable fixture checks, not production preimage evidence.

## Evidence limits

Source preparation and preserved test files are not execution evidence. The original full PR4702 CI run was cancelled. Restored hosted run `35185512588`, job `105086612528`, passed the connection, schema, membership and default-ACL refusal controls, then stopped with `42601` while compiling the predecessor for the function-body control. The error was reproduced in a disposable PostgreSQL 17.11 fixture. The corrected candidate still requires its actual final-revision hosted check; no success is asserted here for all 49 cases, all nine controls, the predecessor or the complete rollback path. The existing shared runner suppresses cluster-stop errors during cleanup; retained source alone does not certify cleanup.

The corrected executable definitions passed a bounded local PostgreSQL 17.11 compilation diagnostic with the existing exact catalog readback and rollback guard. Its private socket cluster was stopped, observed inactive and removed. This diagnostic did not run the projection vectors, refusal suite or financial checks and does not replace the required hosted result.

Full FWP04/S7 remains unqualified. Its original full fixture, canonical table/club and winner-amount captures, complete producer records, capacity authority, immutable producer joins, funded behavior and financial reconciliation remain separate requirements. Passing this pure JSON projection cannot satisfy them. Missing inputs must remain explicit; do not reconstruct authority, weaken refusals or substitute synthetic production transactions.
