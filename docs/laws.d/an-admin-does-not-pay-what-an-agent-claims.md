# tests/an-admin-does-not-pay-what-an-agent-claims.law.test.ts

The admin settlements tab must never write to `agent_commissions` from the
browser, and must never offer a control that claims to mark a commission paid.
RLS grants writes on that table to `service_role` only, so a browser DELETE
matched nothing and reported success; deleting a ledger row is not a payment;
and an admin does not pay an agent's commission at all - the agent claims it
through `fn_agent_claim_commission`, which takes no `p_user_id` on purpose.
Pins that the tab is read-only, that the pay / pay_all actions are gone, and
that it shows `settled_at` and the club bank balance instead.
