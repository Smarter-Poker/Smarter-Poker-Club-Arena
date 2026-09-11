# Mystery bust-phase rehearsal

Run `scripts/dev/probe-mystery-bust-phase-pg17.sh`. It starts its own PostgreSQL 17
cluster on a Unix socket, accepts no database URL, and deletes the cluster on exit.

- `schema.sql`: production table shapes (columns, defaults, CHECK/UNIQUE constraints,
  the foreign keys among these tables, indexes) captured read-only on 2026-09-11. No rows.
- `functions.sql`: the installed bodies of the claim door, collect, seed, activation
  receipt/guard triggers, marker, lane lock and ledger triggers, byte-for-byte from
  `pg_get_functiondef`, captured BEFORE the migration so its anchors are proven against
  the live text. Two stubs are marked as such: the seat-count projection and the wallet
  payer (a pool-bounded stand-in for `fn_settle_tournament_obligation`).
- `scenarios_before.sql` reproduces the three defects on the live bodies;
  `scenarios_after.sql` proves each is fixed and that every refusal the migration keeps
  still refuses.

Scope: wallet payment, escrow journals, reserve/reveal/pay of chests, RLS and the
remaining tournament triggers are not instantiated here.
