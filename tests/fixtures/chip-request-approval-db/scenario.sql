-- A chip request answered by two approvers (migration 20261010003544).
-- Run by scripts/ci/test-chip-request-approval-db-postgres.py once on
-- production's live fn_respond_chip_request (where it must FAIL) and once
-- after the migration (where every assertion must PASS).
--
-- u(1) owns club u(100); u(10) is an agent with no float; u(20) is a player.
-- u(20) asks u(10) for 50 chips. u(10) tries to approve and is refused (no
-- float). The owner then approves: the request must not stay bound to u(10).
RESET ROLE;
INSERT INTO public.chip_requests(id, club_id, requester_id, approver_id, amount, status)
VALUES (public.u(7001), public.u(100), public.u(20), public.u(10), 50, 'pending');

CREATE FUNCTION pg_temp.respond(actor int, request int, action text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(actor);
  SET LOCAL ROLE authenticated;
  r := public.fn_respond_chip_request(public.u(request), action);
  RESET ROLE;
  RETURN r;
END $$;

SELECT assert_true(pg_temp.respond(10, 7001, 'approve') @> '{"success":false}'
               AND (SELECT status FROM public.chip_requests WHERE id = public.u(7001)) = 'pending',
  'the agent with no float is refused and the request stays pending');
SELECT assert_true(pg_temp.respond(1, 7001, 'approve') @> '{"success":true,"status":"approved"}',
  'the owner can still approve the request the agent could not pay');
SELECT assert_true((SELECT count(*) FROM public.chip_transactions WHERE to_user_id = public.u(20) AND transaction_type = 'agent_wallet_send') = 1
               AND (SELECT agent_wallet_balance FROM public.agents WHERE user_id = public.u(1)) = 925
               AND (SELECT agent_wallet_balance FROM public.agents WHERE user_id = public.u(10)) = 0,
  'the chips move once, from the approver who approved (1,000 less the earlier 25 and this 50)');
SELECT assert_true(pg_temp.respond(1, 7001, 'approve') @> '{"success":true,"status":"approved","replayed":true}'
               AND (SELECT count(*) FROM public.chip_transactions WHERE to_user_id = public.u(20) AND transaction_type = 'agent_wallet_send') = 1,
  'the owner''s retry after a lost response replays the same send');
SELECT assert_true(pg_temp.respond(10, 7001, 'approve') @> '{"success":false,"error":"request already approved"}'
               AND (SELECT count(*) FROM public.chip_transactions WHERE to_user_id = public.u(20)) = 1,
  'the agent''s retry after the owner approved moves nothing');
RESET ROLE;
