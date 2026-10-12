# Original departed-seat cash flow

This isolated PostgreSQL 17 probe runs the exact maintained migration. It loads
31 original ledger flows, their 30 canonical atomic hands and signed requests,
original outcomes, funding/application receipts, wallet idempotency receipts,
transaction frames and 52 original table-move receipts. Raw `.jsonb` files retain
original numeric representation for signed request hashes.

The existing exact reader rejects all 31 as unsupported. The candidate proves
125.70 of wallet debits and 339.89 of wallet credits, net +214.19, using the
actual existing outcome consumer, strict cents converter and original funding
lineage reader. Wrong table/seat/occupancy binds fail through this same lineage,
including legitimate table moves. No current membership or current seat is read.

Twenty-three original-input negative cases cover original ledger/wallet amount and NULL,
claim/final settlement/postcommit/conservation, duplicate departed participant,
signed request hash, NULL/string/subcent original stack, funding owner/amount/
balance/ledger/union/table/seat/occupancy, and scope. Each mutation rolls back
before the next case. All 31 original proofs must still pass afterward.

Installation tests use the actual captured maintenance-freeze functions, the
original scheduler advisory key with a controlled owning transaction, exact
reader body/owner/ACL preimages, rolled-back installation and replay refusal.
Original reader ACLs remain postgres-only; the new proof denies anon and
authenticated and permits service_role. The migration verifies exact postimages.

The currently installed retained-request bridge and original settlement-key
verifier remain authoritative. Separate payload and postprune certificate shapes
exercise their raw/compact request and key readers with the actual compaction
functions. Missing live atomic rows require exact immutable original key/result/
request/accounting-evidence digests and completed original timing. Missing,
mismatched, NULL and raw-key bypass controls refuse. These local certificates
are explicit reader fixtures; they do not qualify the separately owned retention
issuer, pruning authority, eight-day boundary or its deployment.

The arithmetic probe extracts the actual installed report's monetary CTEs. An
independent synthetic two-player journal starts with wallets 1000 each, buy-ins
100 each, first-player cash-out 100 followed by signed late credit 5, second
player felt 95. Wallets 1005/900 plus felt 95 conserve 2000. Before the additive
cash-flow kind the report refuses cash reconciliation; after it reconciles,
with winnings/losses 5 once and tournament P&L/net zero. Ordinary cash-buyin and
cash-return subtotals remain 200/100.

Run `bash scripts/dev/probe-late-seat-flow-pg17.sh`; use `PGBIN` for an explicit
PostgreSQL 17 provider and `LATE_FLOW_EVIDENCE_DIR` for retained provider logs.
On macOS the disposable cluster is on the mounted external SSD; CI uses its
runner scratch. The cluster listens only on its private Unix socket, stops on
either result and accepts no remote database URL.

The reused minimal schema contains unrelated empty boundary/ECO stubs from its
older accepted-cash fixture. These functions are not invoked in this probe.
The actual report monetary CTEs have explicit synthetic original-boundary inputs.
This qualifies the cash-flow class and arithmetic, not a complete closed-week
financial certificate, original inventory chain, invoices or production state.
The fourth pending-add-on case is a separate proof class and remains excluded.
