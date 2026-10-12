# tests/a-diamond-own-data-rpc-refuses-a-stranger.law.test.ts

All four diamond own-data RPCs (fn_diamond_wallet_summary, fn_diamond_flow_by_kind,
fn_diamond_arena_reconciliation, fn_diamond_lifetime_totals) refuse a caller who is
neither the subject nor service_role, by their own name and with SQLSTATE 42501,
rather than answering a zero they cannot stand behind.
