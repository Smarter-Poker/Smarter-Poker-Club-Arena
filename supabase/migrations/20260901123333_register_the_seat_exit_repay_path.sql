-- fn_repay_unaccounted_seat_exits has been writing club_members.chip_balance
-- since 20260830213636 and was never entered in ca_money_rpc_registry. The
-- first run of fn_ca_money_rpc_drift() since then found it (2026-09-01
-- 12:31 UTC) and raised rpc-drift:fn_repay_unaccounted_seat_exits.
--
-- Audited before registering, which is the order the incident text asks for:
--
--   * it repays stacks that fn_unaccounted_seat_exits() says left the felt
--     with no matching wallet credit - the repair path CLAUDE.md 11.5 exists
--     to make possible;
--   * it declares its counterparty first (app.ledger_counterparty=table_stack,
--     category=correction), so the autoledger records table_stack ->
--     player_wallet rather than dropping the movement into suspense;
--   * it is bounded: p_max_total defaults to 25000 and it raises on a
--     non-positive cap, so a bad call cannot empty anything;
--   * it writes wallet_transactions beside the balance, so the player sees
--     where the chips came from.
--
-- Registering records that a human-reviewable audit happened. It grants
-- nothing and changes no behaviour.

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_repay_unaccounted_seat_exits', 'approved',
        'Repays seat stacks that left the felt with no cash-out, from fn_unaccounted_seat_exits(). '
        'Declares counterparty table_stack / category correction before writing, so the movement is '
        'ledgered rather than suspended. Bounded by p_max_total (default 25000). Audited and registered '
        '2026-09-01 after fn_ca_money_rpc_drift() first flagged it; it had been unregistered since '
        'migration 20260830213636.')
ON CONFLICT (proname) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_ca_money_rpc_drift()) THEN
    RAISE EXCEPTION 'unregistered balance-writing functions remain';
  END IF;
END $$;
