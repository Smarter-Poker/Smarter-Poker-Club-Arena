# Union ticket scope regression fixture

Run `python3 scripts/dev/probe-union-ticket-scope-pg17.py`. It requires existing PostgreSQL 17 binaries, creates its own socket-only cluster, and stops/removes that cluster on completion. An optional POKER_AUDIT_PG_BIN selects local PostgreSQL 17 binaries; no database URL or production connection is accepted.

The capture contains the actual September 14, 11:41 UTC definitions of five functions and the actual names/types of 510 columns across 16 tables. Ticket selector, horse hints, beneficiary admission, club resolver and entry split execute their complete captured bodies. Synthetic direct and returned award receipts match the actual evidence queries. Function ownership, ACL and execution metadata reproduce the captured contract.

Six desired outcomes fail on the unchanged installed source: member-club and host-club selector, hint and admission paths. The migration passes 24 groups covering those paths, standalone compatibility, returned tickets, unrelated/inactive club refusal, corrupt issue proof, exact direct target, closed/finalized/full/duplicate entry, approval/VIP/value restrictions, maintenance, private privileges, stable replay and transactional refusal of both source and authorization drift.

This is a scope fixture. Unrelated table defaults, constraints and triggers are omitted. Settlement-lane locking, freeze/late/cap reads and admin checks use explicit local stand-ins. The actual admission function stops at a deliberate financial-prelock sentinel after its real scope, issue-proof and entry-policy checks. No funded ticket consumption, full production trigger graph, late seat, role/provider journey or destination hand is certified by this fixture.
