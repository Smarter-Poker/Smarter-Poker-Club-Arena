# tests/the-other-currencies-get-their-guards.law.test.ts

Phase 8 of the chip-accounting programme, roadmap 9.7. VIP points and agent
commissions had journals whose identities held by luck (no guard on the ledger,
none on the balance, an award writer that rewrote its own leg, no meter);
rakeback had three sources with three totals. `vip_points_ledger`,
`agent_commissions` and `rakeback_period_payouts` now carry the chip journals'
append-only guard with each table's one legitimate movement stated (a payout's
compensating delete is allowed and recorded); `vip_points` moves only through a
writer that declares itself in the same transaction, never negative, lifetime
never shrinking; `fn_award_vip_credit` writes the leg once, final;
`ca_currency_meter` / `fn_ca_currency_meter()` record outstanding, journal
total and drift per currency nightly on the replay job, critical where a guard
enforces the identity and a warning with the numbers where it does not.
