# Satellite unregister cash correction

Run `python3 scripts/dev/probe-satellite-refund-pg17.py`. The runner creates and stops its own local PostgreSQL 17 cluster. Set POKER_AUDIT_PG_BIN only to a local PostgreSQL 17 bin directory. It accepts no remote database connection.

The fixture captures 23 installed table definitions and 19 unchanged functions. Actual wallet, journal, idempotency, exact escrow refund, rake, roster and immutable-receipt triggers run during the refund. Starting entries are synthetic funded records. Foreign keys, unrelated membership/product triggers, production data and complete entry-admission behavior are outside this fixture. Empty hand/launch read tables support only the reserved migration compatibility case. These checks are not a full production financial certificate.

The installed baseline creates a 200-chip ticket, leaves the wallet at 100, and drains 200 from target escrow. The correction credits that exact source wallet to 300, creates one cash receipt and no new ticket, and drains the same escrow and original fee recipient. The separate wallet-funded and redeemed-ticket cases retain their actual funding provenance. Historical ticket receipts keep their committed outcome; their value cannot fund a second cash payment.

The runner also observes a real blocked competing refund, injects a late receipt failure to verify complete rollback, and executes the actual updated definitions from the still-unapplied start-authority migration followed by the new migration twice. Eight scenario groups passed on 2026-09-09. The original function body hashes were: unregister bd4f6eaca09f6a160984d88d36fcce2e; receipt ca544b52ef9afdb43a63e1e80aa6444e; exact payer c1ae92c6e99b1b7be109a91d951de1cd.
