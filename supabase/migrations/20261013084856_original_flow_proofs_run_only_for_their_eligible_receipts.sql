-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))='09745f78c6cc2ae57f403419020fd1ab')
-- Only eligible original inputs enter the existing financial evidence proofs.
BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.sub',true),'') IS NOT NULL THEN RAISE EXCEPTION 'flow_eligibility_operator_refused' USING ERRCODE='42501';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'flow_eligibility_freeze_refused' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'flow_eligibility_reader_owned' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261013084856') THEN RAISE EXCEPTION 'flow_eligibility_history_replay' USING ERRCODE='55000';END IF;
 IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261013063142')<>1 OR NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261013063142' AND cardinality(statements)=1 AND octet_length(statements[1])=21799 AND md5(statements[1])='d7010f7cfcbcfa87f50833fda3769c84') THEN RAISE EXCEPTION 'flow_eligibility_parent_history_refused' USING ERRCODE='55000';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'flow_eligibility_source40_refused' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM(VALUES
 ('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','5477b968656e1179aa25d7ec9bc527ca',true,ARRAY['search_path=public, pg_temp']),
 ('smarter_private.original_inventory_proof_sources_match()','c3f9e47f7694c6a8ba57fc43bc5a648a',false,ARRAY['search_path=pg_catalog']),
 ('public.fn_union_pnl_prove_late_settlement(uuid)','0ff6de5baff6a5939003718e6f6a5d90',true,ARRAY['search_path=public, pg_temp','TimeZone=UTC']),
 ('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','bb74ae7693dc40b812fce685cfc3c294',true,ARRAY['search_path=public, pg_temp','TimeZone=UTC'])
 )v(signature,hash,secdef,config) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature)
 WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM v.hash OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM v.secdef OR p.provolatile<>'s' OR p.proconfig IS DISTINCT FROM v.config OR p.proacl::text IS DISTINCT FROM CASE WHEN v.signature='public.fn_union_pnl_prove_late_settlement(uuid)' THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END) THEN RAISE EXCEPTION 'flow_eligibility_preimage_refused' USING ERRCODE='55000';END IF;
END$guard$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
 ), rf_original_keys AS MATERIALIZED (
  SELECT DISTINCT q.transaction_id,(q.l->>'table_id')::uuid table_id,
   (q.l->>'club_id')::uuid club_id,(q.l->>'to_entity_id')::uuid user_id,(q.l->>'amount')::numeric amount
  FROM originals q
  WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
   AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
 ), rf_original_matches AS MATERIALIZED (
  SELECT k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount,count(*) refunds,
   min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
  FROM rf_original_keys k
  JOIN public.cash_funding_application_receipts a ON a.transaction_id=k.transaction_id
   AND a.refunded>0 AND a.refunded=k.amount
  JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
  WHERE a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
   AND o.table_id=k.table_id AND o.account_type='player_wallet' AND o.account_entity_id=k.user_id
   AND o.funding_club_id=k.club_id AND o.user_id=k.user_id
  GROUP BY k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount
 ), matched AS (
  SELECT q.*,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta
  FROM originals q
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p
  ) late ON true
  -- One-time filter (20261001): a probe only for the flows that can match.
  LEFT JOIN LATERAL (SELECT f.* FROM public.cash_participant_funding_receipts f
   WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true
  LEFT JOIN LATERAL (SELECT e.* FROM public.tournament_participant_funding_receipts e
   WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true
  -- fn_union_pnl_tournament_returns(q.tournament_id,NULL,p_start,p_end) for
  -- this flow's ledger only: its two branches verbatim, keyed by the ledger.
  LEFT JOIN LATERAL (
   SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount
   FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
   UNION ALL
   SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now
   FROM public.tournament_refund_tranches t
   JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
   WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
    AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c2 WHERE c2.ledger_id=t.credit_ledger_id)
  ) c ON true
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND r.operation_kind='buyin'
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
  -- A seat cashed out after it arrived by a table move holds chips whose
  -- original buy-in is on the source occupancy, not this one. The occupancy
  -- the cash-out vacated (its seat row in the same original transaction,
  -- carrying exactly the cashed-out stack) is traced through its move receipts
  -- by fn_cash_original_funding_lineage, the proof the boundaries and hands
  -- already use; the owner is its one original buy-in's club and player.
  LEFT JOIN LATERAL (
   SELECT CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.club END moved_club,
    CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.player END moved_user
   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
      AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id AND i.source_name='table_seats' AND i.before_row->>'table_id'=q.l->>'table_id'
      AND i.before_row->>'user_id'=q.l->>'to_entity_id' AND i.before_row->'left_at'='null'::jsonb
      AND i.after_row->>'left_at' IS NOT NULL) s
   CROSS JOIN LATERAL (SELECT public.fn_cash_original_funding_lineage((s.seat->>'user_id')::uuid,(s.seat->>'table_id')::uuid,(s.seat->>'id')::uuid,
     (s.seat->>'occupancy_id')::uuid,(s.seat->>'joined_at')::timestamptz,q.recognized_at,false) v) lin
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE r.operation_kind='buyin') buyins,count(DISTINCT r.funding_club_id) clubs,
     count(DISTINCT r.user_id) users,min(r.funding_club_id::text)::uuid club,min(r.user_id::text)::uuid player
    FROM jsonb_array_elements(lin.v->'funding_receipts') ref JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) own
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet' AND ret.owners IS DISTINCT FROM 1
    AND s.n=1 AND public.fn_pnl_evidence_cents(s.seat->'stack') IS NOT DISTINCT FROM (q.l->>'amount')::numeric
  ) mv ON true
  -- A pending add-on returned unapplied is a refund of this player's own
  -- escrowed chips. Its wallet credit can carry no refund category: it runs
  -- inside the hand's post-commit obligations, after atomic_distribute_rake
  -- has declared that transaction's ledger context, so the audit labels it
  -- player_funding under the rake settlement. The application receipt
  -- written in the same transaction proves it: exactly one refund of this
  -- amount from a funding receipt of this player, club and table.
  LEFT JOIN LATERAL (
   SELECT r.refunds,r.club,r.player FROM rf_original_matches r
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
    AND r.transaction_id=q.transaction_id AND r.table_id=(q.l->>'table_id')::uuid
    AND r.club_id=(q.l->>'club_id')::uuid AND r.user_id=(q.l->>'to_entity_id')::uuid
    AND r.amount=(q.l->>'amount')::numeric
  ) rf ON true
  -- A seat won in a satellite and later refunded by the target tournament
  -- (cancelled, or the seat released) pays the seat's value back to the
  -- player's wallet from the target's prize liability. That seat was never a
  -- wallet-funded entry of the target, so no tournament credit receipt exists
  -- for it; its proof is the refund entitlement the payout is keyed by: same
  -- tournament, player, wallet club and gross, and the seat's owning club as
  -- resolved from its satellite registration.
  LEFT JOIN LATERAL (
   SELECT t.id refund_ent,t.user_id refund_ent_user,t.refund_wallet_club_id refund_ent_club
   FROM public.tournament_refund_entitlements t
   WHERE q.tournament_id IS NOT NULL AND t.tournament_id=q.tournament_id
    AND q.l->>'idempotency_key'='tourney:'||t.tournament_id::text||':refund-entitlement:'||t.id::text
    AND t.entitlement_kind IN('satellite_seat','wallet_charge') AND t.gross=(q.l->>'amount')::numeric
    AND t.user_id::text=q.l->>'to_entity_id' AND t.refund_wallet_club_id::text=q.l->>'club_id'
    AND q.l->>'from_type'='prize_liability' AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='refund'
    AND CASE t.entitlement_kind
     WHEN 'satellite_seat' THEN public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
     -- A pre-capture wallet entry refunded by cancellation (20261006154000):
     -- its entitlement's source ledger is the entry proven at the opening
     -- boundary of the refund's own week, for this exact registration, club
     -- and gross.
     WHEN 'wallet_charge' THEN t.source_ledger_id IS NOT NULL AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=public.fn_union_week_start(q.recognized_at) AND r.union_id=p_union_id AND r.tournament_id=t.tournament_id AND r.user_id=t.user_id
        AND r.owning_club_id=t.refund_wallet_club_id AND r.entries=1 AND r.entry_amount=t.gross AND r.returned=0
        AND r.proof_md5=md5(r.proof::text)
        AND r.proof->'entry_ledger' @> jsonb_build_array(jsonb_build_object('ledger_id',t.source_ledger_id::text)))=1
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN late_count=1 THEN 'cash_late_settlement' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(late_club,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(late_user,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND owner_club::text=l->>'club_id' AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN cash_amount=(l->>'amount')::numeric AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected
 UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end)
 UNION ALL SELECT * FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end);
$function$;
CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT count(*)=40 AND bool_and(p.oid IS NOT NULL AND p.proowner='postgres'::regrole AND md5(pg_get_functiondef(p.oid)) IS NOT DISTINCT FROM x.body_md5)
 FROM(VALUES ('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)','06bf76e3f1a3dccc6faa8dbace9b40ba'),('public.fn_union_pnl_inventory_population(timestamptz,timestamptz)','449f6f13feefe0d7e26e767a3465bc67'),('public.fn_union_pnl_inventory_as_of(timestamptz)','85513ff85d2b37ad04b79f89e125f1aa'),('smarter_private.original_retirement_boundary_proof(jsonb,timestamptz,timestamptz)','56457798f46f7c06a32b0e52915740a0'),('smarter_private.original_paired_seat_restoration_proof(jsonb,jsonb,timestamptz,timestamptz)','ada80c7f667ca7dad36cf223c80c3a6a'),('smarter_private.original_closed_tournament_rails_proof(jsonb,timestamptz)','a9319182a566e9917353765c414a1aa1'),('smarter_private.original_closed_player_proof(jsonb,timestamptz,timestamptz)','a441c3abe887cc4528268e347916d236'),('smarter_private.original_continued_chair_proof(jsonb,timestamptz,timestamptz)','8876018a8370a99f4012696cb264c740'),('smarter_private.original_returned_cash_base_proof(jsonb,timestamptz,timestamptz)','7ed06b6ccded0d6eb2bc3357742e360d'),('smarter_private.original_erased_cash_base_proof(jsonb,timestamptz)','a2d5ac28a5f07929ed99d6e871dddfa2'),('smarter_private.original_inventory_source_ref_md5(jsonb)','1411d22a7ad914a80922aeed8bfcf7e6'),('smarter_private.original_inventory_finite_witness(bigint)','0ef0a8a5b9e85633cf4bf8b0cd15c8d7'),('smarter_private.original_inventory_finite_family_proof(text,jsonb,timestamptz,timestamptz)','dd7861e20f4c90567a704cb2625962b8'),('smarter_private.original_erased_cash_base_request(bigint,text)','1467e44cc7f7871b34eff07f7038019d'),('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)','9f0aff5616730556aa600d1027920433'),('public.fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc'),('public.fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0'),('smarter_private.original_inventory_case_insert_guard()','d9bcabf711efa4c81c0ae7567897b722'),('smarter_private.original_inventory_certificate_insert_guard()','d4956b2b4c0a58bb5dc57b35e3e884ce'),('smarter_private.original_inventory_restoration_immutable()','6c939d278f5fad857bd97437dfaa5f4d'),('smarter_private.certify_original_inventory_restoration(bigint,timestamptz)','f5db14badd4a6b07c0f4b82e2ec5cb1e'),('smarter_private.inventory_restoration_issue_accepted(jsonb,timestamptz)','fdba882b3557f6ffd1cc29129773ff04'),('public.fn_union_pnl_boundary(uuid,timestamptz)','f3fc54538eb2c19a049c79ce77bfb705'),('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','09745f78c6cc2ae57f403419020fd1ab'),('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','edecfc5273ee4c96b608baa0ea863578'),('smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz)','058d499ade9d0609f83cc07d551b7f35'),('smarter_private.inventory_basis_cache_write(text,text,uuid,timestamptz,timestamptz,jsonb)','2c3f0af276c29f33d09cdb7ecd86df6a'),('smarter_private.original_inventory_basis_generation()','dbf5a3a18da9339ba60083cb2d3aea4c'),('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)','7b4a5f4572a45db069b6058899614021'),('public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)','9667c8b8c5aa74bf2ad2c57fbfa3991d'),('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)','58501728a93f9f4534dbf26d26aba63f'),('public.fn_union_pnl_inventory_as_of_admitted(timestamptz)','d65a33c20fb224c1dc2cc1ecb8168940'),('smarter_private.original_erased_cash_base_expected_hash(bigint)','afe5941dd7c4bbcccbfadc5d65a4f447'),('smarter_private.original_erased_cash_base_discharge_receipt(bigint,text)','f2c22efcfd9231094732ca82edff9101'),('smarter_private.original_erased_cash_base_discharge_evidence_valid(bigint,text,jsonb)','d4bc8b8d57c9037805a735bc1bb2be21'),('smarter_private.original_erased_cash_base_discharge(bigint,text)','92624d180575de6759e928278e9c2c6b'),('smarter_private.original_erased_cash_receivables(uuid,timestamptz)','0c53bd1f7fd7d22117af340ee02769d6'),('smarter_private.original_erased_cash_discharge_returns(uuid,timestamptz,timestamptz)','2a41fe7ccedc2947cf3ab84cead2493c'),('smarter_private.original_restoration_cash_returns(uuid,timestamptz,timestamptz)','e7cecf308d34108e12c0006029c1a3fa'),('public.fn_union_week_start(timestamptz)','103f192a228084dad0e4268c36c82c4b'))x(signature,body_md5) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature);
$function$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.original_inventory_proof_sources_match() FROM PUBLIC,anon,authenticated,service_role;
DO $post$BEGIN
 IF EXISTS(SELECT 1 FROM(VALUES
 ('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','09745f78c6cc2ae57f403419020fd1ab',true,ARRAY['search_path=public, pg_temp']),
 ('smarter_private.original_inventory_proof_sources_match()','2f0091a1c85eb9f4ffadce1142ba31a4',false,ARRAY['search_path=pg_catalog']),
 ('public.fn_union_pnl_prove_late_settlement(uuid)','0ff6de5baff6a5939003718e6f6a5d90',true,ARRAY['search_path=public, pg_temp','TimeZone=UTC']),
 ('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','bb74ae7693dc40b812fce685cfc3c294',true,ARRAY['search_path=public, pg_temp','TimeZone=UTC'])
 )v(signature,hash,secdef,config) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature)
 WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM v.hash OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM v.secdef OR p.provolatile<>'s' OR p.proconfig IS DISTINCT FROM v.config OR p.proacl::text IS DISTINCT FROM CASE WHEN v.signature='public.fn_union_pnl_prove_late_settlement(uuid)' THEN '{postgres=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres}' END) THEN RAISE EXCEPTION 'flow_eligibility_postimage_refused' USING ERRCODE='55000';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'flow_eligibility_source40_postimage_refused' USING ERRCODE='55000';END IF;
END$post$;
COMMIT;
