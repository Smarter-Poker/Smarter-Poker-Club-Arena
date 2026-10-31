-- Retain the original club/variant inside every successful Main/Mini credit.
-- Existing wallet credits use their exact posted idempotency key, not today's membership.
-- Known display-only seeded hands are excluded from actual Win/Loss.
-- No financial rows are repaired or repaid; no engine replacement is needed.
-- @live-proof: to_regclass('public.bbj_recipient_reporting_owners') IS NOT NULL
-- @live-proof: position('bbj_recipient_reporting_owners' IN pg_get_functiondef('public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.bbj_recipient_reporting_owners (
 payout_id uuid NOT NULL,user_id uuid NOT NULL,club_id uuid NOT NULL,
 game_variant text,source text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(payout_id,user_id)
);
-- Reporting provenance has no FK to active money/hand tables and survives retention.
ALTER TABLE public.bbj_recipient_reporting_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bbj_recipient_reporting_owners FROM PUBLIC,anon,authenticated,service_role;
CREATE VIEW public.ca_paid_jackpot_reporting AS
 SELECT r.payout_id,r.user_id,r.amount,r.created_at,earned.club_id,
   lower(coalesce(saved.game_variant,f.game_variant,h.game_variant,b.metadata->>'variant')) game_variant,
   coalesce(h.source='seed',false) display_only
  FROM public.bbj_payout_recipients r
  JOIN public.bbj_payouts b ON b.id=r.payout_id
  LEFT JOIN public.ca_hand_facts f ON f.hand_id=b.hand_id AND f.user_id=r.user_id
  LEFT JOIN public.union_pnl_cash_outcomes o ON o.table_id=b.table_id AND o.hand_number=b.hand_number
  LEFT JOIN LATERAL (SELECT hh.* FROM public.hand_history hh
    WHERE hh.id=b.hand_id OR (b.hand_id IS NULL AND hh.table_id=b.table_id AND hh.hand_number=b.hand_number)
    ORDER BY (hh.id=b.hand_id) DESC NULLS LAST LIMIT 1) h ON true
  LEFT JOIN public.bbj_recipient_reporting_owners saved ON saved.payout_id=r.payout_id AND saved.user_id=r.user_id
  CROSS JOIN LATERAL (
    SELECT coalesce(saved.club_id,
      (SELECT l.club_id FROM public.chip_ledger l
       WHERE l.idempotency_key='bbj:'||r.payout_id::text||':'||r.user_id::text
         AND l.category='bbj_payout' AND l.status='posted'
         AND l.to_type='player_wallet' AND l.to_entity_id=r.user_id AND l.amount=r.amount),
      (SELECT (p->>'earning_club_id')::uuid
       FROM jsonb_array_elements(coalesce(o.evidence->'participants','[]')) p
       WHERE p->>'user_id'=r.user_id::text AND p->>'ownership_certified'='true' LIMIT 1),
      CASE WHEN f.hand_id IS NOT NULL THEN public.fn_member_record_fact_club(f) END,
      -- Some retained hands have no derived fact/outcome participant yet.
      -- Resolve the original occupancy exactly as the funded fact reader does.
      (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
       WHERE x.operation_kind='buyin' AND x.table_id=b.table_id
         AND x.account_entity_id=r.user_id AND x.seat_joined_at<=h.started_at
       ORDER BY x.seat_joined_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1),
      (SELECT a.club_id FROM public.rake_attributions a WHERE a.hand_id=b.hand_id AND a.player_id=r.user_id)
    ) AS club_id
  ) earned
;
REVOKE ALL ON public.ca_paid_jackpot_reporting FROM PUBLIC,anon,authenticated,service_role;
-- Freeze only ownership that original durable evidence actually proves.
INSERT INTO public.bbj_recipient_reporting_owners(payout_id,user_id,club_id,game_variant,source)
 SELECT payout_id,user_id,club_id,game_variant,'original_paid_evidence'
 FROM public.ca_paid_jackpot_reporting WHERE club_id IS NOT NULL AND NOT display_only;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text)'::regprocedure))<>'91cae197b9f2d35c76162ab43c96bf6d'
 THEN RAISE EXCEPTION 'Jackpot reporting reader preimage changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.ca_club_member_jackpot_money(
 p_club_id uuid,p_user_id uuid,p_from timestamptz,p_to timestamptz,p_variant text DEFAULT NULL
) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $jackpot$
DECLARE v_amount numeric; v_unknown bigint;
BEGIN
 SELECT coalesce(sum(r.amount) FILTER(WHERE r.club_id=p_club_id),0),count(*) FILTER(WHERE r.club_id IS NULL)
 INTO v_amount,v_unknown FROM public.ca_paid_jackpot_reporting r
 WHERE r.user_id=p_user_id AND r.amount>0 AND NOT r.display_only
   AND (r.club_id=p_club_id OR r.club_id IS NULL)
   AND (p_from IS NULL OR r.created_at>=p_from) AND (p_to IS NULL OR r.created_at<p_to)
   AND public.fn_ca_launch_accounting_accepts(p_club_id,r.created_at)
   AND (p_variant IS NULL OR p_variant='all' OR r.game_variant=p_variant);
 IF v_unknown>0 THEN RAISE EXCEPTION 'Paid jackpot ownership evidence is unavailable' USING ERRCODE='55000'; END IF;
 RETURN v_amount;
END $jackpot$;
DO $patch$
DECLARE d text:=pg_get_functiondef('public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean)'::regprocedure);
BEGIN
 IF md5(d)<>'7c3e02eb8f003844c16e08ff569d0bfc' THEN RAISE EXCEPTION 'Jackpot credit preimage changed'; END IF;
 d:=replace(d,'WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;',
 'WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL RETURNING club_id INTO v_club;');
 d:=replace(d,'  PERFORM public.fn_publish_member_record_user(p_user_id);',$capture$
  -- The same transaction owns credit, immutable reporting attribution and signal.
  -- Snapshot the actual receiving seat/wallet club, never a later home-club guess.
  IF v_club IS NULL THEN
    SELECT x.funding_club_id INTO v_club FROM public.cash_participant_funding_receipts x
    WHERE x.operation_kind='buyin' AND x.table_id=p_table_id AND x.account_entity_id=p_user_id
      AND x.seat_joined_at<=now() ORDER BY x.seat_joined_at DESC,x.recorded_at DESC,x.id DESC LIMIT 1;
  END IF;
  IF v_club IS NULL THEN RAISE EXCEPTION 'Paid jackpot reporting requires its receiving club'; END IF;
  INSERT INTO public.bbj_recipient_reporting_owners(payout_id,user_id,club_id,game_variant,source)
  SELECT b.id,p_user_id,v_club,lower(coalesce(b.metadata->>'variant',h.game_variant,t.game_variant,t.game_type)),
    CASE WHEN v_on_felt THEN 'committed_seat_credit' ELSE 'committed_wallet_credit' END
  FROM public.bbj_payouts b LEFT JOIN public.hand_history h ON h.id=b.hand_id
  LEFT JOIN public.tables t ON t.id=p_table_id WHERE b.id=p_payout_id;
  PERFORM public.fn_publish_member_record_user(p_user_id);$capture$);
 EXECUTE d;
END $patch$;
DO $activate$
DECLARE recipient uuid;
BEGIN
 FOR recipient IN SELECT DISTINCT user_id FROM public.bbj_payout_recipients LOOP
  PERFORM public.fn_publish_member_record_user(recipient);
 END LOOP;
END $activate$;
COMMIT;
