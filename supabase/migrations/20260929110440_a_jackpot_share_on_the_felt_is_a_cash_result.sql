-- A jackpot share credited to a seat is part of that player's cash result.
--
-- Midway's week of 2026-09-21 refused to close with
-- accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries. The
-- per-player gap (cash flows + closing cash seats - opening cash seats - hand
-- deltas) was positive for 35 players across Club JAQK (3,550.00) and
-- a41434bb (1,475.00): 5,025.00 in all, exactly the eight mini Bad Beat
-- Jackpot payouts on Midway tables that week (425, 950, 425, 700, 425, 700,
-- 700, 700), share for share.
--
-- fn_bbj_mini_payout (and fn_bbj_payout) credit each seated recipient's
-- table_seats.stack in their own transaction after the hand has committed, so
-- the share is in no hand's observed_stack_delta and is not an original
-- wallet flow (its ledger leg is bbj_pool -> table_stack). The chips then
-- leave through the player's ordinary cash-out, so the week's money movement
-- counted them while the hand results did not.
--
-- The share is a cash-table result of that player: the BBJ drop that funds
-- it is already a loss inside the hands' observed deltas. fn_union_pnl_week_
-- bbj_stack_awards reads each share credited to the felt (a recipient row
-- with no wallet-credit key), in the week it was credited, on a hand of this
-- Union, attributed to the recipient's earning club in that hand's certified
-- evidence. The evidence report adds those shares to the hand results, so
-- the cash reconciliation, cash_player_pnl and the tournament residual are
-- each correct. A share whose recipient is not a participant of its hand is
-- dropped and the reconciliation keeps refusing, as it should.
--
-- @live-proof: position('fn_union_pnl_week_bbj_stack_awards' in pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- Applied to production as version 20260929110440. Preimage-guarded.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_bbj_stack_awards(p_union_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE(club_id uuid, user_id uuid, amount numeric, payout_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
 SELECT (pp.p->>'earning_club_id')::uuid, r.user_id, r.amount, r.payout_id
 FROM public.bbj_payout_recipients r
 JOIN public.bbj_payouts b ON b.id=r.payout_id
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=b.table_id AND o.hand_number=b.hand_number
 CROSS JOIN LATERAL (SELECT p FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p
  WHERE p->>'user_id'=r.user_id::text LIMIT 1) pp
 WHERE r.created_at>=p_start AND r.created_at<p_end AND r.amount>0
  AND o.game_scope->>'game_union_id'=p_union_id::text
  -- a share paid to the wallet of a departed recipient never reached the felt
  AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w
   WHERE w.key='bbj:'||r.payout_id::text||':'||r.user_id::text)
$f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DO $mig$
DECLARE
 v_sig regprocedure := 'public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure;
 v_def text := pg_get_functiondef(v_sig);
 n1 text := ' ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1), opening AS';
 r1 text := ' ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1
  -- JACKPOT SHARES ON THE FELT (20260929): a Bad Beat Jackpot share credited
  -- to a seat after its hand committed is that player''s cash result too.
  UNION ALL SELECT a.club_id,a.user_id,a.amount FROM public.fn_union_pnl_week_bbj_stack_awards(p_union_id,p_start,p_end) a), opening AS';
BEGIN
 IF md5(v_def) <> 'e56b7e668d49ae06191cdfeca5933b86' THEN RAISE EXCEPTION 'preimage mismatch %', md5(v_def); END IF;
 IF (length(v_def)-length(replace(v_def,n1,'')))/length(n1)<>1 THEN RAISE EXCEPTION 'needle count mismatch'; END IF;
 EXECUTE replace(v_def,n1,r1);
 IF position('fn_union_pnl_week_bbj_stack_awards' in pg_get_functiondef(v_sig))=0 THEN RAISE EXCEPTION 'postimage check failed'; END IF;
END
$mig$;
