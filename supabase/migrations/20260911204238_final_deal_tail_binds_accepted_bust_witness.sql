-- Final-table deals used recording order for the eliminated tail even after
-- ordinary settlement adopted accepted bust-hand ordering. Consent did not bind
-- that evidence. New deals now freeze the accepted witness and rank basis in
-- the immutable v2 batch; legacy batches retain their recording-order replay.
-- Active deal shares remain chip-ranked. No paid receipt is rewritten, no
-- elimination sequence is renumbered, and existing payout mismatch gates remain.
-- Requires the exact phase-three v2 terminal and versioned-consent contracts.
-- Apply AFTER their activation; update deployment source pins in the integrating
-- release before use. This migration does not activate phase three itself.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Drain actual accounting authorities before replacing their function bodies.
-- The existing consent guard also rejects pre-upgrade proposals on resumption.
SELECT public.fn_ca_lock_settlement_lane_global();
DO $preflight$
DECLARE r record; p pg_proc%ROWTYPE;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('public.fn_ca_tournament_deal_snapshot(uuid)','6eee1f2e33f6a62bbc0dd59086c98c1c','8d2859e2f97bab394a8e976393a9c9f7'),
  ('public.fn_settle_tournament_final_table_deal(uuid)','b1941b2e55dade307ecd74068ab3e500','90985f9be4b5bf29187e0d7e33170c16'),
  ('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)','260c94b41d7f2bb021a88a546a1714ac','61c144f02104b769fc3b8bc583df2950')
 ) v(identity,before_md5,after_md5) LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(r.identity);
  IF md5(p.prosrc) NOT IN (r.before_md5,r.after_md5) OR p.proowner<>'postgres'::regrole
    OR NOT p.prosecdef OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    OR p.prorettype<>'jsonb'::regtype
    OR p.proconfig IS DISTINCT FROM (CASE r.identity
      WHEN 'public.fn_ca_tournament_deal_snapshot(uuid)' THEN ARRAY['search_path=public, extensions, pg_temp','TimeZone=UTC']::text[]
      WHEN 'public.fn_settle_tournament_final_table_deal(uuid)' THEN ARRAY['search_path=public','statement_timeout=30s']::text[]
      ELSE ARRAY['search_path=public, pg_temp']::text[] END)
    OR p.proacl IS DISTINCT FROM (CASE r.identity
      WHEN 'public.fn_settle_tournament_final_table_deal(uuid)' THEN ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]
      ELSE ARRAY['postgres=X/postgres']::aclitem[] END)
    OR has_function_privilege('anon',p.oid,'EXECUTE') THEN
    RAISE EXCEPTION 'final deal bust witness prerequisite differs: %',r.identity;
  END IF;
 END LOOP;
 IF to_regprocedure('public.fn_ca_final_deal_bust_tail(uuid,integer)') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_final_deal_bust_tail(uuid,integer)')
   AND md5(prosrc)='fb5532b69509567df6bdd339594f95c2' AND proowner='postgres'::regrole
   AND NOT prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
   AND proacl=ARRAY['postgres=X/postgres']::aclitem[]) THEN
  RAISE EXCEPTION 'final deal bust witness prerequisite differs: rank helper';
 END IF;
END $preflight$;
ALTER TABLE public.tournament_final_table_deal_batches
  ADD COLUMN IF NOT EXISTS rank_basis text NOT NULL DEFAULT 'recording_sequence_v2',
  ADD COLUMN IF NOT EXISTS bust_tail_snapshot jsonb;
DO $shape$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_final_table_deal_batches'::regclass
   AND conname='final_deal_bust_rank_basis') THEN
  ALTER TABLE public.tournament_final_table_deal_batches ADD CONSTRAINT final_deal_bust_rank_basis CHECK (
    (rank_basis='recording_sequence_v2' AND bust_tail_snapshot IS NULL)
    OR (contract_version=2 AND rank_basis='accepted_bust_witness_v1'
      AND bust_tail_snapshot IS NOT NULL AND jsonb_typeof(bust_tail_snapshot)='array'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_final_table_deal_batches'::regclass
   AND conname='final_deal_bust_rank_basis' AND convalidated AND pg_get_constraintdef(oid)=
   $expected$CHECK ((((rank_basis = 'recording_sequence_v2'::text) AND (bust_tail_snapshot IS NULL)) OR ((contract_version = 2) AND (rank_basis = 'accepted_bust_witness_v1'::text) AND (bust_tail_snapshot IS NOT NULL) AND (jsonb_typeof(bust_tail_snapshot) = 'array'::text))))$expected$)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.tournament_final_table_deal_batches'::regclass AND a.attname='rank_basis'
    AND a.atttypid='text'::regtype AND a.attnotnull AND NOT a.attisdropped
    AND pg_get_expr(d.adbin,d.adrelid)=$default$'recording_sequence_v2'::text$default$)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.tournament_final_table_deal_batches'::regclass
    AND a.attname='bust_tail_snapshot' AND a.atttypid='jsonb'::regtype AND NOT a.attnotnull
    AND NOT a.attisdropped AND NOT a.atthasdef) THEN
  RAISE EXCEPTION 'final deal bust witness prerequisite differs: rank schema';
 END IF;
END $shape$;
CREATE OR REPLACE FUNCTION public.fn_ca_final_deal_bust_tail(p_tournament_id uuid, p_live_count integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO public,pg_temp AS $tail$
DECLARE v_tail jsonb;
BEGIN
  IF p_live_count<2 THEN RAISE EXCEPTION 'final deal live count invalid'; END IF;
  WITH witnessed AS (
    SELECT tp.id,tp.user_id,tp.club_id,tp.elimination_sequence,tp.eliminated_at,
      c.id candidate_id,c.table_id,c.hand_id,c.hand_number,c.stack_before,
      a.committed_at,g.first_candidate_at,s.same_hand_rank,
      COALESCE(COALESCE(a.committed_at,g.first_candidate_at)
        + s.same_hand_rank::integer * interval '1 microsecond',tp.eliminated_at) bust_at
    FROM public.tournament_players tp
    LEFT JOIN LATERAL (
      SELECT k.* FROM public.tournament_knockout_candidates k
      WHERE k.tournament_id=tp.tournament_id AND k.eliminated_user_id=tp.user_id
        AND k.state='eliminated' ORDER BY k.hand_number DESC,k.id DESC LIMIT 1
    ) c ON true
    LEFT JOIN public.hand_atomic_commits a ON a.table_id=c.table_id
      AND a.hand_number=c.hand_number AND a.hand_id=c.hand_id
    LEFT JOIN LATERAL (
      SELECT min(k.created_at) first_candidate_at FROM public.tournament_knockout_candidates k
      WHERE k.tournament_id=c.tournament_id AND k.table_id=c.table_id
        AND k.hand_number=c.hand_number AND k.hand_id=c.hand_id
    ) g ON true
    LEFT JOIN LATERAL (
      SELECT count(*) same_hand_rank FROM public.tournament_knockout_candidates k
      WHERE k.tournament_id=c.tournament_id AND k.table_id=c.table_id
        AND k.hand_number=c.hand_number AND k.hand_id=c.hand_id
        AND (k.stack_before,k.eliminated_user_id)<(c.stack_before,c.eliminated_user_id)
    ) s ON true
    WHERE tp.tournament_id=p_tournament_id AND tp.status::text='eliminated'
  ), ranked AS (
    SELECT *,p_live_count+row_number() OVER(ORDER BY bust_at DESC,elimination_sequence DESC,id ASC) position
    FROM witnessed
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',id,'user_id',user_id,'club_id',club_id,'position',position,
    'elimination_sequence',elimination_sequence,'eliminated_at',extract(epoch FROM eliminated_at),
    'candidate_id',candidate_id,'table_id',table_id,'hand_id',hand_id,'hand_number',hand_number,
    'stack_before',stack_before,'committed_at',extract(epoch FROM committed_at),
    'first_candidate_at',extract(epoch FROM first_candidate_at),'same_hand_rank',same_hand_rank,
    'bust_at',extract(epoch FROM bust_at)) ORDER BY position),'[]'::jsonb)
  INTO v_tail FROM ranked;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_tail) x WHERE x->>'bust_at' IS NULL
      OR x->>'bust_at' IN ('Infinity','-Infinity','NaN')) THEN
    RAISE EXCEPTION 'final deal eliminated tail has no finite bust witness';
  END IF;
  RETURN v_tail;
END;
$tail$;
REVOKE ALL ON FUNCTION public.fn_ca_final_deal_bust_tail(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
DO $patch0$
DECLARE v_oid oid:=to_regprocedure('public.fn_ca_tournament_deal_snapshot(uuid)'); v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO v_definition,v_before FROM pg_proc p WHERE oid=v_oid;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)='6eee1f2e33f6a62bbc0dd59086c98c1c' THEN
  IF (length(v_definition)-length(replace(v_definition,$old0_0$'shares',v_shares,'ladder',v_ladder,'roster',v_roster,'seats',v_seats,'hands',v_hands,$old0_0$,'')))<>length($old0_0$'shares',v_shares,'ladder',v_ladder,'roster',v_roster,'seats',v_seats,'hands',v_hands,$old0_0$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 0/0 differs'; END IF;
  v_definition:=replace(v_definition,$old0_0$'shares',v_shares,'ladder',v_ladder,'roster',v_roster,'seats',v_seats,'hands',v_hands,$old0_0$,$new0_0$'rank_basis','accepted_bust_witness_v1',
    'bust_tail',public.fn_ca_final_deal_bust_tail(p_tournament_id,v_live),
    'shares',v_shares,'ladder',v_ladder,'roster',v_roster,'seats',v_seats,'hands',v_hands,$new0_0$);
  EXECUTE v_definition;
 END IF;
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE oid=v_oid;
 IF v_before IS DISTINCT FROM v_after OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'8d2859e2f97bab394a8e976393a9c9f7' THEN
  RAISE EXCEPTION 'final deal bust witness source or metadata postcondition differs: public.fn_ca_tournament_deal_snapshot(uuid)'; END IF;
END $patch0$;
DO $patch1$
DECLARE v_oid oid:=to_regprocedure('public.fn_settle_tournament_final_table_deal(uuid)'); v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO v_definition,v_before FROM pg_proc p WHERE oid=v_oid;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)='b1941b2e55dade307ecd74068ab3e500' THEN
  IF (length(v_definition)-length(replace(v_definition,$old1_0$  v_modern_batch public.tournament_final_table_deal_batches%ROWTYPE;$old1_0$,'')))<>length($old1_0$  v_modern_batch public.tournament_final_table_deal_batches%ROWTYPE;$old1_0$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 1/0 differs'; END IF;
  v_definition:=replace(v_definition,$old1_0$  v_modern_batch public.tournament_final_table_deal_batches%ROWTYPE;$old1_0$,$new1_0$  v_witness_tail jsonb;
  v_modern_batch public.tournament_final_table_deal_batches%ROWTYPE;$new1_0$);
  IF (length(v_definition)-length(replace(v_definition,$old1_1$    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id$old1_1$,'')))<>length($old1_1$    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id$old1_1$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 1/1 differs'; END IF;
  v_definition:=replace(v_definition,$old1_1$    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id$old1_1$,$new1_1$    v_witness_tail:=public.fn_ca_final_deal_bust_tail(p_tournament_id,v_live_count);
    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id$new1_1$);
  IF (length(v_definition)-length(replace(v_definition,$old1_2$    WITH ranked AS (
      SELECT tp.id,
             (v_live_count + row_number() OVER (
               ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
               AS normalized_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
    )
    UPDATE public.tournament_players tp
       SET position = ranked.normalized_position
      FROM ranked
     WHERE tp.id = ranked.id;
$old1_2$,'')))<>length($old1_2$    WITH ranked AS (
      SELECT tp.id,
             (v_live_count + row_number() OVER (
               ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
               AS normalized_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
    )
    UPDATE public.tournament_players tp
       SET position = ranked.normalized_position
      FROM ranked
     WHERE tp.id = ranked.id;
$old1_2$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 1/2 differs'; END IF;
  v_definition:=replace(v_definition,$old1_2$    WITH ranked AS (
      SELECT tp.id,
             (v_live_count + row_number() OVER (
               ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
               AS normalized_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
    )
    UPDATE public.tournament_players tp
       SET position = ranked.normalized_position
      FROM ranked
     WHERE tp.id = ranked.id;
$old1_2$,$new1_2$    WITH ranked AS (
      SELECT (x->>'id')::uuid id,(x->>'position')::integer normalized_position
      FROM jsonb_array_elements(v_witness_tail) x
    )
    UPDATE public.tournament_players tp
       SET position = ranked.normalized_position
      FROM ranked WHERE tp.id=ranked.id;
$new1_2$);
  IF (length(v_definition)-length(replace(v_definition,$old1_3$                    ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                    AS expected_position$old1_3$,'')))<>length($old1_3$                    ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                    AS expected_position$old1_3$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 1/3 differs'; END IF;
  v_definition:=replace(v_definition,$old1_3$                    ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                    AS expected_position$old1_3$,$new1_3$                    ORDER BY (SELECT (x->>'position')::integer
                      FROM jsonb_array_elements(v_witness_tail) x WHERE x->>'id'=tp.id::text)
                      ASC NULLS FIRST,tp.chips DESC,tp.registered_at ASC NULLS LAST,tp.user_id ASC))::integer
                    AS expected_position$new1_3$);
  IF (length(v_definition)-length(replace(v_definition,$old1_4$source,settled_at,contract_version)
  VALUES$old1_4$,'')))<>length($old1_4$source,settled_at,contract_version)
  VALUES$old1_4$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 1/4 differs'; END IF;
  v_definition:=replace(v_definition,$old1_4$source,settled_at,contract_version)
  VALUES$old1_4$,$new1_4$source,settled_at,contract_version,rank_basis,bust_tail_snapshot)
  VALUES$new1_4$);
  IF (length(v_definition)-length(replace(v_definition,$old1_5$'engine.fn_settle_tournament_final_table_deal',transaction_timestamp(),2);$old1_5$,'')))<>length($old1_5$'engine.fn_settle_tournament_final_table_deal',transaction_timestamp(),2);$old1_5$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 1/5 differs'; END IF;
  v_definition:=replace(v_definition,$old1_5$'engine.fn_settle_tournament_final_table_deal',transaction_timestamp(),2);$old1_5$,$new1_5$'engine.fn_settle_tournament_final_table_deal',transaction_timestamp(),2,
    'accepted_bust_witness_v1',v_witness_tail);$new1_5$);
  EXECUTE v_definition;
 END IF;
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE oid=v_oid;
 IF v_before IS DISTINCT FROM v_after OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'90985f9be4b5bf29187e0d7e33170c16' THEN
  RAISE EXCEPTION 'final deal bust witness source or metadata postcondition differs: public.fn_settle_tournament_final_table_deal(uuid)'; END IF;
END $patch1$;
DO $patch2$
DECLARE v_oid oid:=to_regprocedure('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'); v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO v_definition,v_before FROM pg_proc p WHERE oid=v_oid;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)='260c94b41d7f2bb021a88a546a1714ac' THEN
  IF (length(v_definition)-length(replace(v_definition,$old2_0$   row_number() OVER(ORDER BY elimination_sequence DESC,id)+1 expected
   FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)$old2_0$,'')))<>length($old2_0$   row_number() OVER(ORDER BY elimination_sequence DESC,id)+1 expected
   FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)$old2_0$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 2/0 differs'; END IF;
  v_definition:=replace(v_definition,$old2_0$   row_number() OVER(ORDER BY elimination_sequence DESC,id)+1 expected
   FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)$old2_0$,$new2_0$   row_number() OVER(ORDER BY
     CASE WHEN v_b.rank_basis='recording_sequence_v2' THEN elimination_sequence END DESC,
     CASE WHEN v_b.rank_basis='recording_sequence_v2' THEN id END ASC,
     CASE WHEN v_b.rank_basis='accepted_bust_witness_v1' THEN
       (SELECT (x->>'position')::integer FROM jsonb_array_elements(v_b.bust_tail_snapshot) x
        WHERE x->>'id'=tp.id::text) END ASC NULLS FIRST,
     chips DESC,registered_at ASC NULLS LAST,user_id ASC)+1 expected
   FROM public.tournament_players tp WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)$new2_0$);
  IF (length(v_definition)-length(replace(v_definition,$old2_1$ SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,$old2_1$,'')))<>length($old2_1$ SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,$old2_1$) THEN
    RAISE EXCEPTION 'final deal bust exact fragment 2/1 differs'; END IF;
  v_definition:=replace(v_definition,$old2_1$ SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,$old2_1$,$new2_1$ IF v_b.rank_basis='accepted_bust_witness_v1' AND (
    jsonb_array_length(v_b.bust_tail_snapshot)<>v_b.field_count-v_b.live_count
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_b.bust_tail_snapshot) x
      WHERE x->>'bust_at' IS NULL OR x->>'bust_at' IN ('Infinity','-Infinity','NaN')
       OR NOT EXISTS(SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id=p_tournament_id AND tp.position>v_b.live_count
         AND tp.id=(x->>'id')::uuid AND tp.user_id=(x->>'user_id')::uuid
         AND tp.club_id IS NOT DISTINCT FROM (x->>'club_id')::uuid
         AND tp.position=(x->>'position')::integer
         AND tp.elimination_sequence=(x->>'elimination_sequence')::bigint
         AND extract(epoch FROM tp.eliminated_at)=(x->>'eliminated_at')::numeric))
    OR EXISTS(SELECT 1 FROM (SELECT (x->>'position')::integer position,
       v_b.live_count+row_number() OVER(ORDER BY (x->>'bust_at')::numeric DESC,
         (x->>'elimination_sequence')::bigint DESC,(x->>'id')::uuid ASC) expected
       FROM jsonb_array_elements(v_b.bust_tail_snapshot) x) q WHERE position<>expected)
 ) THEN RAISE EXCEPTION 'canonical final deal accepted bust witness differs'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,$new2_1$);
  EXECUTE v_definition;
 END IF;
 SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE oid=v_oid;
 IF v_before IS DISTINCT FROM v_after OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid)<>'61c144f02104b769fc3b8bc583df2950' THEN
  RAISE EXCEPTION 'final deal bust witness source or metadata postcondition differs: public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)'; END IF;
END $patch2$;
COMMIT;
