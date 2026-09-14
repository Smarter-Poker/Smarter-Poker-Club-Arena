# FWP01 native role matrix

Run from any directory with Python3 and existing PostgreSQL17 tools:

    python3 scripts/dev/probe-agent-downline-rake-scope-pg17.py

Use PGBIN to select existing PostgreSQL17 tools. Discovery otherwise follows the existing accounting probes: Homebrew PostgreSQL17, then /usr/lib/postgresql/17/bin. No installation or external database URL is accepted. The runner resolves source paths from its own repository location; the default evidence directory is artifacts/fwp01-rake-scope/<unique-id>. --evidence-dir may select a NEW output directory.

A unique private /tmp directory holds a socket-only PostgreSQL cluster. The runner clears inherited PG connection/options variables, explicitly supplies database/user/socket/port, sets UTF8/UTC, validates major version17 and source hashes, and stops/removes the exact cluster on success or failure. Logs, query results, failure detail and cleanup status survive in the separate evidence directory. Cleanup failure returns nonzero and identifies retained private runtime rather than deleting a running cluster. Python optimized mode refuses.

The same25 request/role cases run on the pinned original and after the reserved migration, applied twice. Together with immutable data, authority metadata, two drift refusals, exact seven helper definitions and nine baseline scope differences,37 checks must pass. Failure exits nonzero. Candidate.sql is expected-result/drift-test evidence, not the migration installation path. The migration alone changes the target via exact current-definition replacements. The source manifest binds bootstrap, baseline, expected candidate, current helper catalog extract and reserved migration bytes.

The bootstrap contains a synthetic reduced schema and synthetic claims/user/club/rake rows. SET LOCAL ROLE and request.jwt.claims reuse the existing native authorization pattern. Real captured authorization, rake attribution/allocation/week and exact current arena-name helper definitions execute; authorization is not replaced by booleans or role stubs. This is not GoTrue/session revocation, full-schema, real-funded or deployed proof. Suspended/revoked cases exercise the existing helper's membership-status branch only. Existing ancestor/union_admin helper policy is preserved. No package dependencies beyond Python standard library and existing PG17 are required.

Independent SQL review, protected integration, current installed fingerprints and real funded Auth/rake-reader/nonmutation proof remain separate. Do not treat this author packaging proposal as their acceptance.
