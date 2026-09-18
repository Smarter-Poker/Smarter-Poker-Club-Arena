# Original Spin evidence uses its existing indexes

A single original Spin evidence read exceeded the production five-second query
budget. Its history predicate combined direct tournament identity and membership
in that tournament's tables with OR/IN. Production EXPLAIN showed a global
primary-key scan estimating 1,044,552 history rows, cost 840561.89.

The additive successor changes only that private reader's history query. Two
disjoint UNION ALL branches use the existing tournament and table/hand indexes;
the measured production plan estimates 67 rows, cost 346.49. Both branches retain
the original inclusive hand boundary, full row content and final ID ordering.
The table branch uses IS DISTINCT FROM so NULL and conflicting tournament IDs
remain covered while rows matching both branches appear exactly once. No index,
timeout, payer, historical capture, installed migration or business row changes.

The existing Sep8 native phase executes the old and successor reader against
exact captured rows, explicit overlap/NULL/conflict/boundary controls and 30,000
unrelated fixture histories. It requires the original unscoped plan to fail the
access-path assertion and the successor to use scoped indexes, verifies installer
drift rollback and unchanged owner/access/configuration, then completes the same
five real financial transactions, concurrent/replay controls and native receipt
decoder. Qualification and production installation/readback remain separate.
