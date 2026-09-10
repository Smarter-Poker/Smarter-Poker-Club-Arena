# Installed satellite award funding fixture

This selected financial subgraph combines the existing registration fixture with 13 captured satellite functions and seven selected actual triggers. Real source registrations debit the fixture club wallet and write the actual entitlement, journal and operation receipts. Auth identity, external lifecycle and three empty terminal-receipt table shapes remain explicitly synthetic boundaries.

The original `satellite_award_funding_cases.py` is byte-identical to df72341a360bbf9126a0603c1eb12dadfeb0d00b. The closeout runner loads the current ticket-inflow reader before the award overlay, pins all 16 source bodies, and restores the five candidate function authority envelopes. Local postgres relation grants allow those actual owners to execute in this selected fixture; this does not certify production relation permissions.

Run against an already-owned local PostgreSQL 17 Unix socket:

```bash
python3 scripts/dev/probe-satellite-award-closeout-pg17.py \
  --socket /tmp/codex-satellite-cohort-pg17/socket --port 55387 --user smarter.poker
```

The runner creates unique `satellite_award_closeout_sep10_*` databases. It never stops the existing cluster, drops a database, accepts a network database URL or touches another lane's database. The database and evidence paths are recorded in its result JSON.

The candidate is `20260910160106_satellite_seats_count_once_and_keep_the_funded_prize.sql`. It preserves current reader 52c3b25b ticket-redemption inflow. The original migration 20260910043237 must not be used against the newer live reader.

The additional closeout module adds actual SQL-role execution, current baseline reproduction, ticket-inflow reader parity, fully observed late receipt rollback, and exact callable/trigger drift refusals. See `docs/audits/2026-09-10-satellite-funded-current-closeout.md` and its JSON evidence for scope and limits.
