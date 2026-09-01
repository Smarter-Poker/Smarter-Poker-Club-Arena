-- fn_agent_wallet_self_stake appeared today and writes agents.agent_wallet_balance
-- without being in ca_money_rpc_registry, so fn_ca_money_rpc_drift raised
-- rpc-drift:fn_agent_wallet_self_stake. It is another agent's work; audited
-- before registering, which is the order the incident asks for.
--
-- What it does: an agent wallet holder moves their own agent-wallet chips into
-- their own player seat. What makes it safe to register:
--
--   * refuses an unauthenticated caller (auth.uid() is null -> error);
--   * refuses without p_op_id, and a replay of the same key returns the
--     original result rather than moving chips again - and a key reused with a
--     DIFFERENT amount is refused outright;
--   * validates the amount: positive, <= 1e9, and exactly two decimal places;
--   * takes an advisory lock per (club, actor, op_id) and another on the club's
--     cashier hierarchy, so two concurrent sends cannot interleave;
--   * locks the club and the membership row before reading balances;
--   * refuses unless fn_club_bank_role says the caller is a super_agent, agent
--     or sub_agent - a player cannot call it, and no one can move anyone
--     else's wallet.
--
-- Registering records that a human-reviewable audit happened. It grants
-- nothing, changes no behaviour, and nothing was called.

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_agent_wallet_self_stake', 'approved',
        'An agent wallet holder stakes their own seat from their own agent wallet. '
        'Authenticated, role-checked via fn_club_bank_role, idempotent on a required '
        'p_op_id (mismatched amount on a reused key is refused), amount validated to '
        'two decimals and capped, advisory-locked per actor and per club cashier '
        'hierarchy. Audited and registered 2026-09-01 on the first run of '
        'fn_ca_money_rpc_drift that saw it.')
ON CONFLICT (proname) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_ca_money_rpc_drift()) THEN
    RAISE EXCEPTION 'unregistered balance-writing functions remain';
  END IF;
END $$;
