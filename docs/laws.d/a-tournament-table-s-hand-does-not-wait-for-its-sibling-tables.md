# tests/a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.law.test.ts

The tables of one tournament deal in parallel. The per-table F06 hand calls
(`fn_f06_hand_number_state`, and through it `fn_f06_allocate_hand_number` and
`fn_f06_table_state`; `fn_f06_begin_hand`; `fn_f06_finish_hand` for an accepted
hand) take `fn_ca_f06_share_table_lane`: the lease fence before and after, G and
the tournament lane T(id) shared, the tournament row `FOR SHARE`, then this
table's row and seats `FOR UPDATE`. They used to take `f06_prefix` (T(id)
exclusive, tournament row `FOR UPDATE`), so a 40-table MTT dealt one table at a
time. Calls on one table still serialize on its row; every tournament-wide
authority keeps T(id) exclusive; a `never_started` finish keeps `f06_prefix`
because proving that nothing started needs the exclusive lane. The law pins
the helper's lock shape and order, exactly which calls move, that a non-accepted
finish keeps the exclusive lane, that `f06_prefix` is untouched, and the
substitution's pins and checks. The CI harness runs the shipped migration on the
exact md5-pinned live definitions and proves siblings no longer wait, one table
still serializes, exclusive authorities and table calls still exclude each
other, the permit rules and lease fence are unchanged, and eight tables dealing
beside a tournament-wide authority neither deadlock nor fail.
