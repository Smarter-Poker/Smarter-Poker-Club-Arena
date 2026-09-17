# BBJ bank replay regression (PostgreSQL 17)

The existing accounting CI job invokes this maintained entry point using Python3 and the existing PostgreSQL tools:

```sh
python3 scripts/ci/test-bbj-bank-replay.py
```

Set PG_BIN to the existing PostgreSQL bin directory if needed. Otherwise the runner resolves postgres on PATH, then pg_config --bindir. It refuses other server majors and root execution, installs nothing, and never connects to a shared database. Optional --output selects a new evidence directory; the default is artifacts/bbj-bank-replay under the repository. Existing output directories are refused to preserve evidence. RESULTS.json and command logs retain actual outputs, expected gates, exit codes and cleanup status.

The runner creates an owned0700 temporary directory and private Unix socket, disables TCP, ignores inherited PG connection configuration, and stops/removes its cluster in finally (including normal interrupt handling). If stopping fails, it leaves that owned directory for diagnosis, records failure and exits unsuccessfully. Uncatchable process termination cannot run finally.

Before cluster allocation, the runner verifies the retained funded-source custody and explicitly runs all six `CustodyBoundaryTests`. Missing/zero cases, errors, failures, skips, expected failures or unexpected successes stop the existing invocation. `funded-source-custody.json`, its test log and the `fundedSourceCustody` section of `RESULTS.json` retain the exact stage and counts, including partial outcomes on catchable interruptions. This stage always reports runtime verification and financial execution authority false, with no executed funded cases. Actual execution of these newly wired checks remains pending.

The migration20260912070357_bbj_bank_move_replay_matches_payload.sql is the sole function source. Exact before/candidate dollar-quoted definitions are extracted and SHA256-verified; no third function copy is maintained. The installer, fixture and case bytes are pinned. Intentional future changes require reviewed hash updates rather than silent drift.

fixture.sql preserves the nine exact saved table/sequence/default/local-constraint blocks recovered from schema SHA256 d02010755997f961fb6f449d2436708daf398cbe2be77a3010238c12f0eeea9e. Its two pool rows and prior immutable receipt are isolated seeds. Both tables reject all mutation statements after seeding; reserve and ledger helper boundaries unconditionally raise. cases.sql is the exact19-case reviewed before/after harness.

Expected baseline: eight altered-payload cases incorrectly return the old identical replay receipt, while11 ordinary/legacy cases pass. Candidate: all19 pass. The runner additionally checks unchanged complete pool/receipt/sequence state, all eight table write tripwires, original-to-candidate installation, exact repeat, OID/owner/ACL/settings/security preservation and transactional refusal of body/ACL/settings drift. Unexpected errors do not count as expected baseline failures: each actual old receipt is checked.

This is replay/refusal and installation regression coverage only. The narrow saved schema slice and fail-fast helper boundaries do not prove canonical funding, new operations, native ledger/journal composition, authentication, concurrent financial behavior or production acceptance. Those remain separate delivery gates.

The recovered [funded fixture interface](FUNDED-INTERFACE.md) includes repository-relative exact source custody for the pending backup25 and pool-promo25 qualification. The original accepted narrow CI-classifier selection remains a separate composition input; the restored classifier is unchanged in this source successor. The portable successor calls the retained funded composition after the original replay cleanup, requiring current hosted accounting CI identity and exact PostgreSQL17.11, with source-owned aggregate execution/cleanup enforcement. A preceding token-scoped metadata step records the actual current Actions job start and900-second deadline; the BBJ step consumes only its identity-bound file. The finite300-second execution/90-second aggregate cleanup caps retain uncertain failure on exhaustion. All26 modeled identity/deadline/timing controls pass locally, but actual API/PG/funded checks remain pending. No manual invocation supplies financial authority. See the interface for exact workflow composition and evidence-retention requirements; the existing19 cases retain their original scope.
