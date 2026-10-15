-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure))='0af98f5b0e305b8c68f7ba8657ec66bf')
-- 20261015011723_a_code_defect_never_spends_a_hands_one_settlement_claim.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The 100 Chip Guarantee Freeroll 6:00 AM (a38b88a9) has sat RUNNING with 58
-- seated players and no hand since 2026-10-13 13:14:51 UTC. Each of its 8 tables
-- holds one finished hand whose settlement request was retained. The successor
-- generation took the hand's ONE financial claim, and the settlement rolled back
-- on a code defect, record "new" has no field "metadata" (a trigger reading a
-- column its table did not have; fixed by 20261013133012). fn_ca_resume_hand_submission
-- recorded that rollback as the hand's financial refusal, so every later admission
-- reads successor_financial_claim_spent and the table can never deal again.
-- The same defect stranded 217 hands; launch_typed209_source_correction_proof
-- rescued 209 through a frozen list. These 8 were outside the list.
--
-- 1. ROOT: a code defect is not the hand's financial attempt.
--    fn_ca_settle_hand_stacks_absolute now returns the SQLSTATE of the error that
--    rolled it back, and fn_ca_resume_hand_submission treats a rollback of class
--    42, 0A or XX (undefined column/function, internal error) like a lease or lock
--    refusal: it raises, so the claim, handoff and dispatch roll back and the next
--    admission settles the hand once the defect is fixed. A genuine financial
--    refusal (conservation, a rule) still spends the claim exactly as before.
--    original_hand_correction_sources_match moves its pin on the settlement with it.
-- 2. RECOVERY THROUGH THE EXISTING DOOR: metadata_defect_source_correction_proof
--    proves the same cause from a hand's own rows with every launch_typed209
--    condition read live (intact request, handoff from the original generation,
--    rollback exactly this defect, failed key and settlement with nothing recorded,
--    no claim/disposal/commit/history/later permit/outbox, event and table RUNNING,
--    the fix migration installed by exact digest, and no trigger anywhere still
--    reading NEW.metadata on a table without it). Row digests are returned in the
--    proof, so the resume's re-proof refuses any row that moves before the claim.
--    The proof dispatcher falls back to it after the three existing proofs.
-- 3. The 8 hands are certified through certify_original_hand_source_correction,
--    the operator-only door every earlier correction used. It credits nothing:
--    the engine's own resume then settles each retained hand once, through
--    fn_ca_commit_hand_settlement with its original request.
--
-- Proved first in production by self-aborting single-transaction trials on
-- 2026-10-15 (successor built only in pg_temp): exactly these 8 submissions, one
-- tournament, qualify (0 overlap with the 209 already claimed or any correction);
-- each passes the resume's state checks (seats, stacks, nothing dealt since); the
-- real fn_ca_commit_hand_settlement on one of them returned success, atomic commit
-- and conservation checked, rolled back; every post-image round-trips exactly.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='90s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'defect_claim_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'defect_claim_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'defect_claim_freeze_refused';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015011723') THEN RAISE EXCEPTION 'defect_claim_history_replay';END IF;
 IF to_regprocedure('smarter_private.metadata_defect_source_correction_proof(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'defect_claim_proof_exists';END IF;
END $guard$;

CREATE OR REPLACE FUNCTION smarter_private.metadata_defect_source_correction_proof(e uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE s smarter_private.hand_submissions;h smarter_private.hand_submission_handoffs;z smarter_private.hand_submission_handoff_results;
 p smarter_private.f06_hand_permits;k public.settlement_idempotency_keys;c public.ca_settlements;tb public.tables;stack_hand uuid;
BEGIN
 -- THE SAME DEFECT, PROVED FROM THE HAND'S OWN ROWS (2026-10-15). launch_typed209
 -- proves exactly this cause for a frozen list of 209 hands. A hand the same
 -- defect stranded outside that list (Freeroll a38b88a9: 8 tables, 35 hours) has
 -- the same rows and the same proof; only the list was missing. Every condition
 -- below is launch_typed209's, read live; the row digests it pinned in its list
 -- are returned here instead, so the resume's re-proof refuses any row that
 -- changes between certification and the one correction claim.
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=e;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO h FROM smarter_private.hand_submission_handoffs WHERE submission_id=e;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO z FROM smarter_private.hand_submission_handoff_results WHERE submission_id=e;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO p FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO tb FROM public.tables WHERE id=s.table_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 stack_hand:=md5('ca-hand:'||s.table_id::text||':'||s.hand_number::text||CASE WHEN coalesce(s.request->>'p_ref','')='' THEN '' ELSE ':'||(s.request->>'p_ref') END)::uuid;
 SELECT * INTO k FROM public.settlement_idempotency_keys WHERE table_id=s.table_id AND hand_id=stack_hand;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM public.ca_settlements WHERE settlement_type='hand_stacks' AND external_ref=s.table_id::text||':'||stack_hand::text;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF encode(sha256(convert_to(s.request::text,'UTF8')),'hex') IS DISTINCT FROM s.request_hash
 OR h.original_generation IS DISTINCT FROM s.lease_generation OR h.request_hash IS DISTINCT FROM s.request_hash
 OR z.result->>'reason' IS DISTINCT FROM 'rolled_back' OR z.result->>'error' IS DISTINCT FROM 'record "new" has no field "metadata"'
 OR z.result->'success' IS DISTINCT FROM 'false'::jsonb OR z.result->'atomic_hand_commit' IS DISTINCT FROM 'false'::jsonb
 OR p.state IS DISTINCT FROM 'reserved' OR p.generation IS DISTINCT FROM s.lease_generation OR p.tournament_id IS NULL
 OR (s.request#>>'{p_hand_row,tournament_id}') IS DISTINCT FROM p.tournament_id::text
 OR tb.tournament_id IS DISTINCT FROM p.tournament_id OR COALESCE(tb.is_deleted,false) OR lower(COALESCE(tb.status,'')) NOT IN ('running','waiting')
 OR NOT EXISTS(SELECT FROM public.tournaments t WHERE t.id=p.tournament_id AND upper(t.status)='RUNNING')
 OR k.status IS DISTINCT FROM 'failed' OR k.attempt_count IS NULL OR k.attempt_count<1 OR k.completed_at IS NOT NULL OR k.result IS NOT NULL
 OR k.error IS DISTINCT FROM 'record "new" has no field "metadata"'
 OR c.table_id IS DISTINCT FROM s.table_id OR c.hand_id IS DISTINCT FROM stack_hand
 OR c.idempotency_key IS DISTINCT FROM 'hand:'||s.table_id::text||':'||stack_hand::text OR c.state IS DISTINCT FROM 'failed'
 OR c.totals IS DISTINCT FROM '{}'::jsonb OR c.error_detail IS DISTINCT FROM 'record "new" has no field "metadata"'
 OR EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims WHERE submission_id=e)
 OR EXISTS(SELECT FROM smarter_private.hand_submission_disposals WHERE submission_id=e)
 OR EXISTS(SELECT FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number)
 OR EXISTS(SELECT FROM public.hand_projection_outbox WHERE hand_id=e)
 -- The defect's own fix is installed, exactly as launch_typed209 requires.
 OR NOT EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261013133012'
  AND name='scoped_launch_operator_accepts_authoritative_json_claims' AND cardinality(statements)=1
  AND encode(sha256(convert_to(statements[1],'UTF8')),'hex')='89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3')
 -- And the defect class is not live anywhere: no trigger reading NEW.metadata
 -- is attached to a relation without that column.
 OR EXISTS(SELECT FROM pg_trigger tg JOIN pg_proc tf ON tf.oid=tg.tgfoid
  WHERE NOT tg.tgisinternal AND tf.prosrc ~* 'NEW\.metadata'
   AND NOT EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=tg.tgrelid AND a.attname='metadata' AND NOT a.attisdropped))
 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('submission_id',e,'table_id',s.table_id,'hand_number',s.hand_number,'request_hash',s.request_hash,
 'submission_md5',md5(to_jsonb(s)::text),'request_md5',md5(s.request::text),'handoff_md5',md5(to_jsonb(h)::text),
 'result_md5',md5(to_jsonb(z)::text),'permit_md5',md5(to_jsonb(p)::text),'key_md5',md5(to_jsonb(k)::text),
 'settlement_md5',md5(to_jsonb(c)::text),'original_generation',s.lease_generation,'permit_id',p.permit_id,
 'tournament_id',p.tournament_id,'source_cause','row_metadata_defect','source_version','20261013133012',
 'source_sha256','89b1671cf9aa507248b7620f734855fa03cdf586d133a1caa9890530fbd04df3',
 'proof_version','20261015011723','scope','tournament');
END $function$
;
REVOKE ALL ON FUNCTION smarter_private.metadata_defect_source_correction_proof(uuid) FROM PUBLIC;

DO $install$
DECLARE
 o_d text:=$anchor$ RETURN smarter_private.launch_typed209_source_correction_proof(e);
$anchor$;
 n_d text:=$anchor$ proof:=smarter_private.launch_typed209_source_correction_proof(e);
 IF proof IS NOT NULL THEN RETURN proof;END IF;
 -- Any later hand stranded by the same defect, proved from its own rows (2026-10-15).
 RETURN smarter_private.metadata_defect_source_correction_proof(e);
$anchor$;
 o_s text:=$anchor$    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number, 'ref', p_ref);$anchor$;
 n_s text:=$anchor$    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'sqlstate', SQLSTATE,
                              'table_id', p_table_id, 'hand_number', p_hand_number, 'ref', p_ref);$anchor$;
 o_r text:=$anchor$    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
$anchor$;
 n_r text:=$anchor$    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    -- A CODE DEFECT IS NOT THE HAND'S ONE FINANCIAL ATTEMPT (2026-10-15). A
    -- settlement that rolled back on a programming or internal error (class 42,
    -- 0A or XX: an undefined column, a missing function, an internal failure)
    -- says nothing about the hand. Spending the claim on it stranded 217 hands
    -- (record "new" has no field "metadata"), 8 of them freezing Freeroll
    -- a38b88a9 for 35 hours. Raise, so the claim, handoff and dispatch roll back
    -- and the next admission settles the hand once the defect is fixed.
    OR (r->>'reason'='rolled_back' AND left(COALESCE(r->>'sqlstate',''),2) IN ('42','0A','XX'))
$anchor$;
 sig_d constant regprocedure:='smarter_private.original_hand_source_correction_proof(uuid)'::regprocedure;
 sig_s constant regprocedure:='public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure;
 sig_r constant regprocedure:='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure;
 sig_m constant regprocedure:='smarter_private.original_hand_correction_sources_match()'::regprocedure;
 d text; s text; r text; m text; before jsonb;
BEGIN
 d:=pg_get_functiondef(sig_d); s:=pg_get_functiondef(sig_s); r:=pg_get_functiondef(sig_r); m:=pg_get_functiondef(sig_m);
 IF md5(d)<>'f604ff7504222829d1b5b85d299af242' OR md5(s)<>'7c81a81de14275cf79ec2bc947f42884' OR md5(r)<>'951110d34bda83ed99b49256e42f05e3' OR md5(m)<>'52a667146a924fe2c924aae5e70cb2eb' THEN RAISE EXCEPTION 'defect_claim_preimage_refused';END IF;
 IF (length(d)-length(replace(d,o_d,'')))/length(o_d)<>1 OR (length(s)-length(replace(s,o_s,'')))/length(o_s)<>1 OR (length(r)-length(replace(r,o_r,'')))/length(o_r)<>1
 OR (length(m)-length(replace(m,'7c81a81de14275cf79ec2bc947f42884','')))/32<>1 OR (length(m)-length(replace(m,'b546f2132413ca1db68bcfd5b3f473d1','')))/32<>1 THEN RAISE EXCEPTION 'defect_claim_anchor_refused';END IF;
 IF md5(pg_get_functiondef('smarter_private.metadata_defect_source_correction_proof(uuid)'::regprocedure))<>'52562ec4b4097f3e5d19e0626766ea64' THEN RAISE EXCEPTION 'defect_claim_proof_postimage_refused';END IF;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proacl::text,p.proconfig)) INTO before FROM pg_proc p WHERE p.oid IN(sig_d,sig_s,sig_r,sig_m);
 EXECUTE replace(s,o_s,n_s);
 IF md5(pg_get_functiondef(sig_s))<>'ff16a5b791b4e2d01b7ab4ee62a85c0e' OR md5((SELECT prosrc FROM pg_proc WHERE oid=sig_s))<>'9d0abf53683ad943b18eb8a173fb0556' THEN RAISE EXCEPTION 'defect_claim_settle_postimage_refused';END IF;
 EXECUTE replace(r,o_r,n_r);
 IF md5(pg_get_functiondef(sig_r))<>'0af98f5b0e305b8c68f7ba8657ec66bf' THEN RAISE EXCEPTION 'defect_claim_resume_postimage_refused';END IF;
 EXECUTE replace(d,o_d,n_d);
 IF md5(pg_get_functiondef(sig_d))<>'4f8a0958e5785cb557ddf413d3d9b015' THEN RAISE EXCEPTION 'defect_claim_dispatcher_postimage_refused';END IF;
 EXECUTE replace(replace(m,'7c81a81de14275cf79ec2bc947f42884','ff16a5b791b4e2d01b7ab4ee62a85c0e'),'b546f2132413ca1db68bcfd5b3f473d1','9d0abf53683ad943b18eb8a173fb0556');
 IF md5(pg_get_functiondef(sig_m))<>'b235c4e928096546f3cae16732a1bb34' THEN RAISE EXCEPTION 'defect_claim_sources_postimage_refused';END IF;
 IF (SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(pg_get_userbyid(p.proowner),p.prosecdef,p.provolatile,p.proacl::text,p.proconfig)) FROM pg_proc p WHERE p.oid IN(sig_d,sig_s,sig_r,sig_m)) IS DISTINCT FROM before THEN RAISE EXCEPTION 'defect_claim_security_refused';END IF;
 IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'defect_claim_sources_refused';END IF;
END $install$;

DO $certify$
DECLARE expected constant uuid[]:=ARRAY['25a3999b-9c4c-464b-9397-31f7688f1dfb'::uuid,'63c84328-1ffc-4740-a08d-37c71686729a'::uuid,'7ddcf4e3-d7ec-4431-8df4-b999dd22ce31'::uuid,'8961b638-fcfc-48b6-bc9b-928ad0d5f7e8'::uuid,'91b7c015-658a-4f65-b224-efaadc1a0d86'::uuid,'9e8833d2-3442-4e71-8000-74f60f1ef38a'::uuid,'aee96357-bcf5-4ef8-ba92-307e42ca651b'::uuid,'b1d9067d-227b-4890-8928-e02bd7eda5bb'::uuid]; eligible uuid[]; e uuid; c jsonb;
BEGIN
 SELECT array_agg(z.submission_id ORDER BY z.submission_id) INTO eligible FROM smarter_private.hand_submission_handoff_results z
  WHERE smarter_private.metadata_defect_source_correction_proof(z.submission_id) IS NOT NULL;
 IF eligible IS DISTINCT FROM expected THEN RAISE EXCEPTION 'defect_claim_cohort_moved: %',eligible;END IF;
 FOREACH e IN ARRAY expected LOOP
  c:=smarter_private.certify_original_hand_source_correction(e);
  IF c->>'certified' IS DISTINCT FROM 'true' OR c->>'financial_payment' IS DISTINCT FROM 'false'
  OR c->'proof'->>'source_cause' IS DISTINCT FROM 'row_metadata_defect' THEN RAISE EXCEPTION 'defect_claim_certify_refused: %',c;END IF;
 END LOOP;
 IF (SELECT count(*) FROM smarter_private.hand_submission_source_corrections WHERE submission_id=ANY(expected))<>8 THEN RAISE EXCEPTION 'defect_claim_certified_count';END IF;
 IF EXISTS(SELECT FROM smarter_private.hand_submission_correction_claims WHERE submission_id=ANY(expected)) THEN RAISE EXCEPTION 'defect_claim_claimed_early';END IF;
END $certify$;

COMMIT;
