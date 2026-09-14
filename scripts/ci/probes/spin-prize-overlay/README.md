# Funded Spin correction audit fixture

The captured function is the production definition read on September 14, 2026, MD5 `cc459efa33bc115e6c662b644290a014`. The native runner installs that body and the committed guarded migration in an isolated PostgreSQL 17 cluster with no production credentials or network listener.

The fixture supplies the exact columns, numeric types, identity keys and posted-status distinction read by the audit. It also installs the existing partial overlay index. It does not model payout writers, game settlement, delivery triggers or the complete accounting schema. UUIDs are generated synthetic identities. The baseline reproduces a 1.40 funded correction reported as excess; the live incident identity and customer ledger rows are kept in the private operational evidence, not this fixture.

Tests cover matched house funding, escrow/journal mismatch, wrong event and recipient, unposted records, non-finite values, reflected pools, genuine excess, existing historical acknowledgments, completed-event windows, real concurrent commit visibility, service permissions, read-only execution, migration replay and unknown-preimage refusal.

Run `python3 scripts/ci/test-spin-prize-overlay.py --output <new-directory>`. Set `PG_BIN` to PostgreSQL 17 binaries. The runner removes its private cluster and never connects to production.
