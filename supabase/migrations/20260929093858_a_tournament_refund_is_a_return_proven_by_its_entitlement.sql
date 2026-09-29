-- A satellite seat refunded by its target tournament is a proven return.
--
-- Midway's week of 2026-09-21 refused to close on one original flow: ledger
-- 63700b06, 50.00 prize_liability -> player_wallet, category refund, keyed
-- tourney:<target>:refund-entitlement:<entitlement>. The seat was won in a
-- satellite (the satellite pool moved it into the target as a liability to
-- liability transfer), so the target never wrote a tournament credit receipt
-- for it and fn_union_pnl_original_flow_evidence classified it unsupported.
--
-- Its proof is the refund entitlement the payout is keyed by: same tournament,
-- player, wallet club and gross, kind satellite_seat, and the seat's owning
-- club as resolved from its satellite registration. The new branch is last in
-- the classification, so no flow already proven changes kind or owner.
--
-- Applied to production as version 20260929093858. Preimage-guarded.
-- @live-proof: position('te.refund_ent_club' in pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
DO $mig$
DECLARE
 v_sig regprocedure := 'public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure;
 v_def text := pg_get_functiondef(v_sig);
 v_new text;
 n1 text := '   rf.refunds,rf.club refund_club,rf.player refund_user
';
 r1 text := '   rf.refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club
';
 n2 text := '  ) rf ON true
 ), projected AS (';
 r2 text := '  ) rf ON true
  -- A seat won in a satellite and later refunded by the target tournament
  -- (cancelled, or the seat released) pays the seat''s value back to the
  -- player''s wallet from the target''s prize liability. That seat was never a
  -- wallet-funded entry of the target, so no tournament credit receipt exists
  -- for it; its proof is the refund entitlement the payout is keyed by: same
  -- tournament, player, wallet club and gross, and the seat''s owning club as
  -- resolved from its satellite registration.
  LEFT JOIN LATERAL (
   SELECT t.id refund_ent,t.user_id refund_ent_user,t.refund_wallet_club_id refund_ent_club
   FROM public.tournament_refund_entitlements t
   WHERE q.tournament_id IS NOT NULL AND t.tournament_id=q.tournament_id
    AND q.l->>''idempotency_key''=''tourney:''||t.tournament_id::text||'':refund-entitlement:''||t.id::text
    AND t.entitlement_kind=''satellite_seat'' AND t.gross=(q.l->>''amount'')::numeric
    AND t.user_id::text=q.l->>''to_entity_id'' AND t.refund_wallet_club_id::text=q.l->>''club_id''
    AND q.l->>''from_type''=''prize_liability'' AND q.l->>''to_type''=''player_wallet'' AND q.l->>''category''=''refund''
    AND public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
  ) te ON true
 ), projected AS (';
 n3 text := 'WHEN credit_id IS NOT NULL THEN ''tournament_return'' ELSE ''unsupported'' END k,
   COALESCE(cash_club,CASE WHEN moved_club IS NULL THEN return_club ELSE moved_club END,entry_club,credit_club) owner_club,
   COALESCE(cash_user,CASE WHEN moved_club IS NULL THEN return_user ELSE moved_user END,entry_user,credit_user) owner_user';
 r3 text := 'WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN ''tournament_return'' ELSE ''unsupported'' END k,
   COALESCE(cash_club,CASE WHEN moved_club IS NULL THEN return_club ELSE moved_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(cash_user,CASE WHEN moved_club IS NULL THEN return_user ELSE moved_user END,entry_user,credit_user,refund_ent_user) owner_user';
 n4 text := 'WHEN ''tournament_return'' THEN credit_amount=(l->>''amount'')::numeric AND';
 r4 text := 'WHEN ''tournament_return'' THEN (credit_amount=(l->>''amount'')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND';
BEGIN
 IF md5(v_def) <> 'e242c70ffaa62bfe872f30cf7d0e1a5f' THEN RAISE EXCEPTION 'preimage mismatch %', md5(v_def); END IF;
 IF (length(v_def)-length(replace(v_def,n1,'')))/length(n1)<>1 OR (length(v_def)-length(replace(v_def,n2,'')))/length(n2)<>1
  OR (length(v_def)-length(replace(v_def,n3,'')))/length(n3)<>1 OR (length(v_def)-length(replace(v_def,n4,'')))/length(n4)<>1 THEN
  RAISE EXCEPTION 'needle count mismatch';
 END IF;
 v_new := replace(replace(replace(replace(v_def,n1,r1),n2,r2),n3,r3),n4,r4);
 EXECUTE v_new;
 IF pg_get_functiondef(v_sig) NOT LIKE '%te.refund_ent_club%' OR pg_get_functiondef(v_sig) NOT LIKE '%refund_ent IS NOT NULL)) AND%' THEN
  RAISE EXCEPTION 'postimage check failed';
 END IF;
END
$mig$;
