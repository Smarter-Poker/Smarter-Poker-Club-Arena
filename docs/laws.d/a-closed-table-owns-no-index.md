# tests/a-closed-table-owns-no-index.law.test.ts

A cluster table that closes or is deleted releases its `main_index`, and no cluster may exceed its declared table ceiling - the two facts whose absence let `fn_cash_cluster_tick` R3 open 2,994 tables in 2.5 hours on 2026-09-05.
