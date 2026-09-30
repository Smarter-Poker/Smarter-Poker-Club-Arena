-- 20260927155651_held_tournament_fees_are_recognized_on_the_owner_host_club_b.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Eighteen completed tournaments (741.86 chips on 2026-09-27) hold their entry
-- fee in tournament_escrow with accounting_state 'fee_custody_unresolved'. Every
-- player is final and paid; only the house fee is held. The fee could not be
-- recognized because the existing capture authority prices each contributor
-- through fn_accounting_earning_contract at the CHARGE instant, and every one
-- of those charges predates the recorded agreement history (club membership
-- baseline 2026-09-14 12:09:27Z, union baseline 2026-09-18 00:41:16Z). The
-- contract refuses with accounting_terms_not_observed or
-- cash_commission_earning_club_not_observed and the fee stays in custody.
--
-- OWNER DECISION (Dan, 2026-09-27: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE
-- ALL OF THESE" and "i don't have options or decisions, you always decide what's
-- best and what to do"; CLAUDE.md 10.9): a tournament entry fee is the house fee
-- of the club that HOSTED the event. It flows onward exactly as that club's
-- cash rake does, through the union/club agreement and agent hierarchy in effect
-- at the event's COMPLETION if one is recorded. No code-default rate is used as
-- if it were an agreement.
--
-- This migration adds exactly that as an explicit, owner-authorized basis kind:
--
--  1. accounting_tournament_fee_owner_operations / _owner_bases: append-only
--     records of the single-use operation and of each event's basis (hosting
--     club, union, completion instant, amount, reason text, owner instruction,
--     authorization date, operation id).
--  2. fn_ca_capture_tournament_fee_from_recorded_evidence: unchanged evidence
--     checks. Only when the original charge-time contract refuses because the
--     terms were never observed, AND this same transaction recorded an owner
--     basis for the event, is the contributor priced by the SAME contract at the
--     event's completion instant. The contract names that basis
--     (contract.owner_basis). If terms are missing at completion as well, the
--     completion-time refusal propagates and the event stays held: the weekly
--     readers cannot verify a contributor source without a recorded membership,
--     so a guessed allocation is refused rather than invented.
--  3. fn_accounting_tournament_source_terms_at: the one rule every weekly
--     reader uses for a tournament source's agreement instant: its charge
--     instant, or the recorded owner-basis completion instant when the source's
--     contract names that exact recorded basis. The weekly quality gate, the
--     union earned plan and the rakeback period calculator use it where they
--     previously required terms_at = charged_at. With no owner basis row they
--     compute exactly what they computed before.
--  4. smarter_private.spin_original_standings_witness: the five Sept-8 Spin
--     witnesses compared the accepted hand's live hand_history and
--     hand_atomic_commits rows with the retained snapshot. The owner's horse
--     hand-history retention (8 days, 2026-09-17) has since removed those horse
--     rows, so every terminal receipt for those events raised
--     SPIN_ORIGINAL_STANDINGS_CHANGED. A hand now counts as retired, not changed,
--     only when BOTH rows are absent, the snapshot is that exact hand, it had no
--     human, and it is older than the recorded horse retention. A present row
--     that differs still refuses.
--  4b. fn_ca_legacy_fee_resolution_write_is_exact admitted the union rake-bank
--     journal leg only for the Sept-8 Spins, and only club-less. It now also
--     admits it for an owner-basis event recorded in the same transaction, and
--     accepts the leg naming the event's own club, which the tournament rake
--     payer has declared since 2026-09-21 (20260921065613).
--  5. fn_ca_recognize_held_tournament_fees_by_owner_basis(operation, events):
--     the single-use operation. It takes the settlement lane, requires the exact
--     listed held events and amounts, records each basis and settles each fee
--     through the existing fn_settle_tournament_rake -> custody resolution ->
--     bank -> fn_recognize_accounting_tournament_fees path, then proves escrow
--     out = bank in = recognized credit to the cent, prizes untouched and the
--     settlement_suspense journal unchanged. It runs once; a replay of the same
--     operation returns its recorded result and moves nothing.
--
-- Installation moves no chips. The operation is run separately, once.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: (SELECT to_regprocedure('public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)') IS NOT NULL AND to_regclass('public.accounting_tournament_fee_owner_bases') IS NOT NULL)
-- @live-proof: (SELECT position('accounting_tournament_fee_owner_bases' in pg_get_functiondef('public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('fn_accounting_tournament_source_terms_at' in pg_get_functiondef('public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('horse_retention_days' in pg_get_functiondef('smarter_private.spin_original_standings_witness(uuid,uuid)'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';

CREATE TABLE public.accounting_tournament_fee_owner_operations(
 operation_id uuid PRIMARY KEY,
 basis_kind text NOT NULL CHECK(basis_kind='owner_authorized_host_club_fee'),
 reason text NOT NULL CHECK(length(reason)>0),
 owner_instruction text NOT NULL CHECK(length(owner_instruction)>0),
 authorized_on date NOT NULL,
 events jsonb NOT NULL CHECK(jsonb_typeof(events)='array' AND jsonb_array_length(events)>0),
 event_count integer NOT NULL CHECK(event_count>0),
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 executed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current()
);
CREATE TABLE public.accounting_tournament_fee_owner_bases(
 tournament_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES public.accounting_tournament_fee_owner_operations(operation_id),
 basis_kind text NOT NULL CHECK(basis_kind='owner_authorized_host_club_fee'),
 hosting_club_id uuid NOT NULL,
 union_id uuid,
 completed_at timestamptz NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2)),
 obligation_id uuid NOT NULL,
 source_fingerprint text NOT NULL,
 reason text NOT NULL CHECK(length(reason)>0),
 owner_instruction text NOT NULL CHECK(length(owner_instruction)>0),
 authorized_on date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current()
);
CREATE INDEX accounting_tournament_fee_owner_bases_operation ON public.accounting_tournament_fee_owner_bases(operation_id);
CREATE FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 RAISE EXCEPTION 'owner-authorized tournament fee basis is append-only' USING ERRCODE='P0404';
END $$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER owner_fee_operation_is_append_only BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_owner_operations
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only();
CREATE TRIGGER owner_fee_operation_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_owner_operations
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only();
CREATE TRIGGER owner_fee_basis_is_append_only BEFORE UPDATE OR DELETE ON public.accounting_tournament_fee_owner_bases
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only();
CREATE TRIGGER owner_fee_basis_refuses_truncate BEFORE TRUNCATE ON public.accounting_tournament_fee_owner_bases
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_tournament_fee_owner_basis_is_append_only();
ALTER TABLE public.accounting_tournament_fee_owner_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_tournament_fee_owner_bases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_tournament_fee_owner_operations,public.accounting_tournament_fee_owner_bases FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_tournament_fee_owner_operations,public.accounting_tournament_fee_owner_bases TO service_role;

-- The one agreement-instant rule for a recognized tournament source. The outer
-- rule is plain STABLE SQL with no sub-select and no SET clause, so the planner
-- inlines it into each weekly reader as a keyed CASE: a source whose contract
-- names no owner basis costs one jsonb key test and returns its charge instant
-- exactly as before. Only an owner-basis source reads its recorded basis row.
CREATE FUNCTION public.fn_accounting_tournament_owner_basis_terms_at(p_tournament_id uuid,p_charged_at timestamptz,p_contract jsonb)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT COALESCE((SELECT b.completed_at FROM public.accounting_tournament_fee_owner_bases b
   WHERE b.tournament_id=p_tournament_id
    AND b.operation_id::text=p_contract->'owner_basis'->>'operation_id'
    AND b.basis_kind=p_contract->'owner_basis'->>'basis_kind'
    AND (p_contract->'owner_basis'->>'terms_at')::timestamptz=b.completed_at
    AND (p_contract->'owner_basis'->>'original_terms_at')::timestamptz=p_charged_at
    AND b.completed_at>=p_charged_at),p_charged_at)
$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_owner_basis_terms_at(uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_accounting_tournament_source_terms_at(p_tournament_id uuid,p_charged_at timestamptz,p_contract jsonb)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p_contract ? 'owner_basis'
  THEN public.fn_accounting_tournament_owner_basis_terms_at(p_tournament_id,p_charged_at,p_contract)
  ELSE p_charged_at END
$$;
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_source_terms_at(uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $owner_basis$
DECLARE source text;changed text;
 PROCEDURE_GUARD CONSTANT text:='held tournament fee owner basis predecessor changed: ';
 f record;
BEGIN
 FOR f IN SELECT * FROM (VALUES
  ('public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)',ARRAY['b7e0c1cae9d65b9a0b3560dc3280991a'],'{postgres=X/postgres,service_role=X/postgres}'),
  ('public.fn_accounting_tournament_week_quality(uuid,timestamp with time zone,timestamp with time zone)',ARRAY['15496db2b1026a92fedee86502028b95'],'{postgres=X/postgres}'),
  ('public.fn_accounting_union_earned_plan(uuid,timestamp with time zone,timestamp with time zone)',ARRAY['409eade1f18decea288db84784f127b2'],'{postgres=X/postgres}'),
  ('public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)',ARRAY['e16d7ddd96e4d349d15973bb71a19036'],'{postgres=X/postgres}'),
  ('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])',ARRAY['2fffb5add208db1eb1e6b66c9df15220'],'{postgres=X/postgres}'),
  ('public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)',ARRAY['54ca630d2363a5ac17041d79931e301c'],'{postgres=X/postgres}'),
  ('smarter_private.spin_original_standings_witness(uuid,uuid)',ARRAY['f291f307d5357cac11a4d57d1757cf72'],'{postgres=X/postgres}')
 ) v(identity,md5s,acl) LOOP
  IF to_regprocedure(f.identity) IS NULL
   OR NOT (md5(pg_get_functiondef(to_regprocedure(f.identity)))=ANY(f.md5s))
   OR (SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure(f.identity)) IS DISTINCT FROM f.acl
   OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=to_regprocedure(f.identity)) IS DISTINCT FROM 'postgres'
  THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||f.identity USING ERRCODE='55000'; END IF;
 END LOOP;

 -- 2. Capture: owner basis only after the original charge-time refusal.
 source:=pg_get_functiondef('public.fn_ca_capture_tournament_fee_from_recorded_evidence(uuid)'::regprocedure);
 changed:=replace(source,$old$  entitlement_id uuid; charged_at timestamptz; weight numeric;
BEGIN$old$,$new$  entitlement_id uuid; charged_at timestamptz; weight numeric;
  refusal text; refusal_state text; owner_basis public.accounting_tournament_fee_owner_bases%ROWTYPE;
BEGIN$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'capture declarations' USING ERRCODE='55000'; END IF;
 source:=changed;
 changed:=replace(source,$old$    contract := public.fn_accounting_earning_contract((item->>'club_id')::uuid,
      (item->>'player_id')::uuid, credit, actual_union, (item->>'charged_at')::timestamptz);
    IF contract->>'player_id' IS DISTINCT FROM item->>'player_id'
     OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
     OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
     OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
     OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM (item->>'charged_at')::timestamptz
    THEN$old$,$new$    BEGIN
      contract := public.fn_accounting_earning_contract((item->>'club_id')::uuid,
        (item->>'player_id')::uuid, credit, actual_union, (item->>'charged_at')::timestamptz);
    EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '23514' THEN
      -- 2026-09-27 OWNER-AUTHORIZED BASIS. Only the refusal that says the
      -- agreement was never observed at the charge instant, and only inside
      -- the transaction that recorded this event's owner basis, prices the
      -- contributor through the SAME contract at the event's completion. A
      -- missing agreement at completion still refuses; nothing is guessed.
      GET STACKED DIAGNOSTICS refusal = MESSAGE_TEXT, refusal_state = RETURNED_SQLSTATE;
      SELECT * INTO owner_basis FROM public.accounting_tournament_fee_owner_bases b
       WHERE b.tournament_id = r.tournament_id AND b.transaction_id = txid_current();
      IF owner_basis.tournament_id IS NULL
       OR refusal NOT IN ('accounting_terms_not_observed','cash_commission_earning_club_not_observed') THEN
        RAISE EXCEPTION USING MESSAGE = refusal, ERRCODE = refusal_state; END IF;
      contract := public.fn_accounting_earning_contract((item->>'club_id')::uuid,
        (item->>'player_id')::uuid, credit, actual_union, owner_basis.completed_at)
        || jsonb_build_object('owner_basis', jsonb_build_object(
          'operation_id', owner_basis.operation_id, 'basis_kind', owner_basis.basis_kind,
          'terms_at', owner_basis.completed_at, 'original_terms_at', (item->>'charged_at')::timestamptz,
          'original_refusal', refusal, 'hosting_club_id', owner_basis.hosting_club_id));
    END;
    IF contract->>'player_id' IS DISTINCT FROM item->>'player_id'
     OR contract->>'club_id' IS DISTINCT FROM item->>'club_id'
     OR (contract->>'rake_credit')::numeric IS DISTINCT FROM credit
     OR NULLIF(contract->>'union_id','')::uuid IS DISTINCT FROM actual_union
     OR (contract->>'terms_at')::timestamptz IS DISTINCT FROM
        public.fn_accounting_tournament_source_terms_at(r.tournament_id,(item->>'charged_at')::timestamptz,contract)
    THEN$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'capture contract' USING ERRCODE='55000'; END IF;
 EXECUTE changed;

 -- 3a. Weekly tournament quality: both terms_at comparisons.
 source:=pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 IF (length(source)-length(replace(source,$old$(s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at$old$,'')))
    <>2*length($old$(s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at$old$) THEN
  RAISE EXCEPTION '%', PROCEDURE_GUARD||'week quality terms' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,$old$(s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at$old$,
  $new$(s.contract->>'terms_at')::timestamptz IS DISTINCT FROM public.fn_accounting_tournament_source_terms_at(s.tournament_id,s.charged_at,s.contract)$new$);

 -- 3b. Union earned plan. The September 28 close optimization moved the
 -- unchanged verifier into _v3. Extend that verifier and preserve the
 -- transaction-scoped memo wrapper byte-for-byte; both predecessors are pinned.
 source:=pg_get_functiondef('public.fn_accounting_union_earned_plan_v3(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 changed:=replace(source,$old$WHERE f.id=s.source_id AND f.charged_at=s.terms_at))$old$,
  $new$WHERE f.id=s.source_id AND public.fn_accounting_tournament_source_terms_at(f.tournament_id,f.charged_at,f.contract)=s.terms_at))$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'union earned plan terms' USING ERRCODE='55000'; END IF;
 EXECUTE changed;

 -- 3c. Rakeback period agreement instant.
 source:=pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure);
 changed:=replace(source,$old$CASE WHEN s.source_type='tournament_fee_accrual' THEN fee.charged_at ELSE s.earned_at END AS agreement_at,$old$,
  $new$CASE WHEN s.source_type='tournament_fee_accrual' THEN public.fn_accounting_tournament_source_terms_at(fee.tournament_id,fee.charged_at,fee.contract) ELSE s.earned_at END AS agreement_at,$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'rakeback agreement instant' USING ERRCODE='55000'; END IF;
 EXECUTE changed;

 -- 3d. The exact resolution-write guard admits the union rake-bank journal
 -- leg of an owner-basis event exactly as it admits a Sept-8 Spin's, and
 -- accepts that leg naming the event's own club, which fn_settle_tournament_rake
 -- has declared on app.ledger_autoledger_club_id since 2026-09-21.
 source:=pg_get_functiondef('public.fn_ca_legacy_fee_resolution_write_is_exact(text,text,jsonb,jsonb)'::regprocedure);
 changed:=replace(source,$old$  AND public.fn_ca_sep8_spin_original_fee_proof(NULLIF(p_new->>'from_entity_id','')::uuid) IS NOT NULL THEN
  t:=NULLIF(p_new->>'from_entity_id','')::uuid;$old$,$new$  AND (public.fn_ca_sep8_spin_original_fee_proof(NULLIF(p_new->>'from_entity_id','')::uuid) IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_owner_bases ob
    WHERE ob.tournament_id=NULLIF(p_new->>'from_entity_id','')::uuid AND ob.transaction_id=txid_current())) THEN
  t:=NULLIF(p_new->>'from_entity_id','')::uuid;$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'resolution write source' USING ERRCODE='55000'; END IF;
 source:=changed;
 changed:=replace(source,$old$  IF p_operation='INSERT' AND r.original_plan->>'union_id' IS NOT NULL
   AND public.fn_ca_sep8_spin_original_fee_proof(t) IS NOT NULL THEN$old$,$new$  IF p_operation='INSERT' AND r.original_plan->>'union_id' IS NOT NULL
   AND (public.fn_ca_sep8_spin_original_fee_proof(t) IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_owner_bases ob WHERE ob.tournament_id=t
     AND ob.transaction_id=txid_current() AND ob.union_id=(r.original_plan->>'union_id')::uuid)) THEN$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'resolution write union branch' USING ERRCODE='55000'; END IF;
 source:=changed;
 changed:=replace(source,$old$    AND p_new->>'from_label' IS NULL AND p_new->>'club_id' IS NULL$old$,
  $new$    AND p_new->>'from_label' IS NULL
    AND (p_new->>'club_id' IS NULL OR p_new->>'club_id'=(SELECT x.club_id::text FROM public.tournaments x WHERE x.id=t))$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'resolution write club' USING ERRCODE='55000'; END IF;
 EXECUTE changed;

 -- 4. Spin standings witness: a horse hand retired by the owner's retention
 -- is not a changed hand.
 source:=pg_get_functiondef('smarter_private.spin_original_standings_witness(uuid,uuid)'::regprocedure);
 changed:=replace(source,$old$ OR (SELECT to_jsonb(a) FROM public.hand_atomic_commits a WHERE hand_id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'atomic'->0
 OR (SELECT to_jsonb(h) FROM public.hand_history h WHERE id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'history'->0 THEN$old$,
 $new$ OR (CASE WHEN NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=(candidate->>'hand_id')::uuid)
    AND NOT EXISTS(SELECT 1 FROM public.hand_history h WHERE h.id=(candidate->>'hand_id')::uuid)
    AND jsonb_array_length(original->'atomic')=1 AND jsonb_array_length(original->'history')=1
    AND original->'atomic'->0->>'hand_id' IS NOT DISTINCT FROM candidate->>'hand_id'
    AND original->'history'->0->>'id' IS NOT DISTINCT FROM candidate->>'hand_id'
    AND original->'history'->0->'has_human'='false'::jsonb
    AND (original->'history'->0->>'created_at')::timestamptz
        <= now()-make_interval(days=>(SELECT p.horse_retention_days FROM public.hand_history_retention_policy p WHERE p.id))
  -- Both rows retired by the owner's horse retention: the retained snapshot,
  -- already bound by expected_hash above, remains the witness.
  THEN false
  ELSE (SELECT to_jsonb(a) FROM public.hand_atomic_commits a WHERE hand_id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'atomic'->0
   OR (SELECT to_jsonb(h) FROM public.hand_history h WHERE id=(candidate->>'hand_id')::uuid) IS DISTINCT FROM original->'history'->0
  END) THEN$new$);
 IF changed=source THEN RAISE EXCEPTION '%', PROCEDURE_GUARD||'spin witness hand comparison' USING ERRCODE='55000'; END IF;
 EXECUTE changed;
END $owner_basis$;

-- 5. The single-use owner-authorized operation.
CREATE FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(p_operation_id uuid,p_events jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp SET statement_timeout='120s' SET lock_timeout='5s' AS $$
DECLARE
 c_reason CONSTANT text:='Owner-authorized recognition basis: a tournament entry fee is the house fee of the club that hosted the event. '
  ||'It flows onward exactly as that club''s cash rake does, through the union/club agreement and agent hierarchy recorded at the event''s completion '
  ||'(fn_accounting_earning_contract at completed_at), because no agreement was recorded at the original charge instant. '
  ||'Players were final and paid before this operation; only the held house fee moves. No code-default rate is used as an agreement.';
 c_instruction CONSTANT text:='Dan, 2026-09-27: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE AND MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS. YOU DECIDE THE BUILD ORDER." '
  ||'including "Held tournament fees: 741.86 across 18 events can''t be paid out because there''s no commercial agreement on record saying who they belong to."; '
  ||'standing instruction "i don''t have options or decisions, you always decide what''s best and what to do"; CLAUDE.md 10.9.';
 c_date CONSTANT date:='2026-09-27';
 prior public.accounting_tournament_fee_owner_operations%ROWTYPE;
 ev record;t record;h record;o record;e record;res jsonb;receipt jsonb;
 total numeric:=0;n integer:=0;results jsonb:='[]';
 suspense_before numeric;suspense_after numeric;prizes_before jsonb;prizes_after jsonb;
 escrow_out numeric;escrow_out_before numeric:=0;bank_in numeric;credited numeric;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_events IS NULL OR jsonb_typeof(p_events)<>'array' OR jsonb_array_length(p_events)=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) x WHERE jsonb_typeof(x)<>'object'
   OR NOT (x ? 'tournament_id') OR NOT (x ? 'amount'))
  OR (SELECT count(*)<>count(DISTINCT x->>'tournament_id') FROM jsonb_array_elements(p_events) x)
 THEN RAISE EXCEPTION 'owner_fee_operation_invalid' USING ERRCODE='22023'; END IF;
 PERFORM public.fn_ca_lock_settlement_lane_global();
 PERFORM pg_advisory_xact_lock(hashtextextended('ca:owner-fee-operation:'||p_operation_id::text,0));
 SELECT * INTO prior FROM public.accounting_tournament_fee_owner_operations WHERE operation_id=p_operation_id;
 IF FOUND THEN
  IF prior.events IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('tournament_id',(x->>'tournament_id')::uuid,'amount',(x->>'amount')::numeric)
     ORDER BY (x->>'tournament_id')::uuid) FROM jsonb_array_elements(p_events) x) THEN
   RAISE EXCEPTION 'owner_fee_operation_replayed_with_different_events' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'replayed',true,'operation_id',p_operation_id,'executed_at',prior.executed_at,
   'event_count',prior.event_count,'amount',prior.amount,
   'events',(SELECT jsonb_agg(jsonb_build_object('tournament_id',b.tournament_id,'amount',b.amount,
     'receipt',public.fn_ca_tournament_fee_custody_receipt(b.tournament_id)) ORDER BY b.tournament_id)
     FROM public.accounting_tournament_fee_owner_bases b WHERE b.operation_id=p_operation_id));
 END IF;
 SELECT COALESCE(round(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),2),0) INTO suspense_before
  FROM public.chip_ledger WHERE from_type='settlement_suspense' OR to_type='settlement_suspense';
 SELECT COALESCE(jsonb_agg(jsonb_build_object('t',p.tournament_id,'payouts',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.tournament_payouts x WHERE x.tournament_id=p.tournament_id),
   'players',(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.id),'[]') FROM public.tournament_players y WHERE y.tournament_id=p.tournament_id),
   'header',(SELECT to_jsonb(z) FROM public.tournament_terminal_settlements z WHERE z.tournament_id=p.tournament_id),
   'escrow',(SELECT to_jsonb(w)-ARRAY['fee_out','fee_balance','updated_at'] FROM public.tournament_escrow w WHERE w.tournament_id=p.tournament_id))
   ORDER BY p.tournament_id),'[]') INTO prizes_before
  FROM (SELECT DISTINCT (x->>'tournament_id')::uuid tournament_id FROM jsonb_array_elements(p_events) x) p;
 INSERT INTO public.accounting_tournament_fee_owner_operations(operation_id,basis_kind,reason,owner_instruction,authorized_on,events,event_count,amount)
 SELECT p_operation_id,'owner_authorized_host_club_fee',c_reason,c_instruction,c_date,
  jsonb_agg(jsonb_build_object('tournament_id',(x->>'tournament_id')::uuid,'amount',(x->>'amount')::numeric) ORDER BY (x->>'tournament_id')::uuid),
  count(*),sum((x->>'amount')::numeric) FROM jsonb_array_elements(p_events) x;
 FOR ev IN SELECT (x->>'tournament_id')::uuid tournament_id,(x->>'amount')::numeric amount
   FROM jsonb_array_elements(p_events) x ORDER BY (x->>'tournament_id')::uuid LOOP
  SELECT id,club_id,union_id,is_private,status INTO t FROM public.tournaments WHERE id=ev.tournament_id;
  SELECT * INTO h FROM public.tournament_terminal_settlements WHERE tournament_id=ev.tournament_id;
  SELECT * INTO o FROM public.accounting_tournament_fee_custody_obligations WHERE tournament_id=ev.tournament_id;
  SELECT * INTO e FROM public.tournament_escrow WHERE tournament_id=ev.tournament_id;
  IF t.id IS NULL OR t.club_id IS NULL OR h.tournament_id IS NULL OR o.id IS NULL OR e.tournament_id IS NULL
   OR h.accounting_state IS DISTINCT FROM 'fee_custody_unresolved' OR h.receipt_version IS DISTINCT FROM 3
   OR h.escrow_closed_at IS NOT NULL OR h.rake_amount IS DISTINCT FROM ev.amount OR o.amount IS DISTINCT FROM ev.amount
   OR e.fee_balance IS DISTINCT FROM ev.amount OR e.prize_balance IS DISTINCT FROM 0::numeric OR e.bounty_balance IS DISTINCT FROM 0::numeric
   OR e.closed_at IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions x WHERE x.tournament_id=ev.tournament_id)
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions x WHERE x.tournament_id=ev.tournament_id)
   OR EXISTS(SELECT 1 FROM public.tournament_rake_settlements x WHERE x.tournament_id=ev.tournament_id)
  THEN RAISE EXCEPTION 'owner_fee_event_is_not_exactly_held: %',ev.tournament_id USING ERRCODE='P0404'; END IF;
  INSERT INTO public.accounting_tournament_fee_owner_bases(tournament_id,operation_id,basis_kind,hosting_club_id,union_id,completed_at,
   amount,obligation_id,source_fingerprint,reason,owner_instruction,authorized_on)
  VALUES(ev.tournament_id,p_operation_id,'owner_authorized_host_club_fee',t.club_id,CASE WHEN t.is_private THEN NULL ELSE t.union_id END,
   h.completed_at,ev.amount,o.id,o.source_fingerprint,c_reason,c_instruction,c_date);
  res:=public.fn_settle_tournament_rake(ev.tournament_id,'owner-basis:'||p_operation_id::text);
  receipt:=public.fn_ca_tournament_fee_custody_receipt(ev.tournament_id);
  IF res->>'ok' IS DISTINCT FROM 'true' OR (res->>'amount')::numeric IS DISTINCT FROM ev.amount
   OR receipt->>'accounting_complete' IS DISTINCT FROM 'true' OR (receipt->>'current_held_amount')::numeric IS DISTINCT FROM 0::numeric
   OR receipt->'resolution'->>'status' IS DISTINCT FROM 'recognized'
   OR (receipt->'resolution'->>'bank_amount')::numeric IS DISTINCT FROM ev.amount
   OR (SELECT fee_balance FROM public.tournament_escrow WHERE tournament_id=ev.tournament_id) IS DISTINCT FROM 0::numeric
   OR (SELECT fee_out FROM public.tournament_escrow WHERE tournament_id=ev.tournament_id) IS DISTINCT FROM e.fee_out+ev.amount
  THEN RAISE EXCEPTION 'owner_fee_event_not_resolved: %',ev.tournament_id USING ERRCODE='P0404'; END IF;
  total:=total+ev.amount;n:=n+1;escrow_out_before:=escrow_out_before+e.fee_out;
  results:=results||jsonb_build_array(jsonb_build_object('tournament_id',ev.tournament_id,'amount',ev.amount,
   'hosting_club_id',t.club_id,'union_id',CASE WHEN t.is_private THEN NULL ELSE t.union_id END,'completed_at',h.completed_at,
   'destination',res->>'destination','attributed_users',res->'attributed_users',
   'bank_receipt_kind',receipt->'resolution'->>'bank_receipt_kind','bank_receipt_id',receipt->'resolution'->>'bank_receipt_id'));
 END LOOP;
 -- Conservation to the cent: escrow out = bank in = recognized credit.
 SELECT COALESCE(sum(w.fee_out),0)-escrow_out_before INTO escrow_out FROM public.tournament_escrow w
  WHERE w.tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id);
 SELECT COALESCE(sum(amount),0) INTO bank_in FROM (
  SELECT u.amount FROM public.accounting_tournament_fee_recognitions q JOIN public.union_wallet_transactions u ON u.id=q.union_wallet_transaction_id
   WHERE q.tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id)
  UNION ALL
  SELECT l.amount FROM public.accounting_tournament_fee_recognitions q JOIN public.chip_ledger l ON l.id=q.bank_journal_id
   WHERE q.tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id)) z;
 SELECT COALESCE(sum(rake_credit),0) INTO credited FROM public.accounting_tournament_recognized_sources
  WHERE disposition='earned' AND tournament_id IN(SELECT tournament_id FROM public.accounting_tournament_fee_owner_bases WHERE operation_id=p_operation_id);
 SELECT COALESCE(round(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),2),0) INTO suspense_after
  FROM public.chip_ledger WHERE from_type='settlement_suspense' OR to_type='settlement_suspense';
 SELECT COALESCE(jsonb_agg(jsonb_build_object('t',p.tournament_id,'payouts',(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM public.tournament_payouts x WHERE x.tournament_id=p.tournament_id),
   'players',(SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.id),'[]') FROM public.tournament_players y WHERE y.tournament_id=p.tournament_id),
   'header',(SELECT to_jsonb(z) FROM public.tournament_terminal_settlements z WHERE z.tournament_id=p.tournament_id),
   'escrow',(SELECT to_jsonb(w)-ARRAY['fee_out','fee_balance','updated_at'] FROM public.tournament_escrow w WHERE w.tournament_id=p.tournament_id))
   ORDER BY p.tournament_id),'[]') INTO prizes_after
  FROM (SELECT DISTINCT (x->>'tournament_id')::uuid tournament_id FROM jsonb_array_elements(p_events) x) p;
 IF n<>jsonb_array_length(p_events) OR total IS DISTINCT FROM (SELECT amount FROM public.accounting_tournament_fee_owner_operations WHERE operation_id=p_operation_id)
  OR escrow_out IS DISTINCT FROM total OR bank_in IS DISTINCT FROM total OR credited IS DISTINCT FROM total
  OR suspense_after IS DISTINCT FROM suspense_before OR prizes_after IS DISTINCT FROM prizes_before THEN
  RAISE EXCEPTION 'owner_fee_operation_not_conserved: total=% escrow_out=% bank_in=% credited=% suspense % -> % prizes_unchanged=%',
   total,escrow_out,bank_in,credited,suspense_before,suspense_after,prizes_after IS NOT DISTINCT FROM prizes_before USING ERRCODE='P0404';
 END IF;
 RETURN jsonb_build_object('ok',true,'replayed',false,'operation_id',p_operation_id,'executed_at',transaction_timestamp(),
  'basis_kind','owner_authorized_host_club_fee','event_count',n,'amount',total,'escrow_out',escrow_out,'bank_in',bank_in,
  'recognized_credit',credited,'settlement_suspense_net',suspense_after,'prizes_unchanged',true,'events',results);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) TO service_role;
COMMENT ON FUNCTION public.fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb) IS
 'Single-use owner-authorized recognition of exactly listed held tournament fees (2026-09-27). Settles through fn_settle_tournament_rake; no scheduler calls it.';

COMMIT;
