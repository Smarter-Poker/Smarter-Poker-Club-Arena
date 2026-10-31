-- A legacy interrupted hand may be voided only at its proven original principal.
-- Depends on recorded emergency03622 and the played-clock floor04521. This is
-- not a replay of either migration, a controller continuation, or a winner.
-- Add only the separately qualified branch; retain both owners' complete body.
-- Retained modern capsules remain fenced by their original permit/snapshot
-- disposition guards. Unknown source, custody or principal refuses atomically.
-- @live-proof: md5(pg_get_functiondef('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure)) = 'e416f1fa850c85d656ec55ddfae3386d'
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $patch$
DECLARE p record; candidate text; prior text; restored text;
 old_locals constant text := $old_locals$  v_misdeal_n integer := 0;$old_locals$;
 new_locals constant text := $new_locals$  v_misdeal_n integer := 0;
  v_original_roster jsonb;
  v_prior record;$new_locals$;
 old_admission constant text := $old_admission$    ELSIF n = 1 THEN
$old_admission$;
 new_admission constant text := $new_admission$    ELSIF n = 1 AND EXISTS (
      SELECT 1 FROM public.hand_state_snapshots s
       WHERE s.table_id=h.table_id AND s.hand_number=h.hand_number
         AND s.stage IN ('flop','turn','river') AND s.state_json->>'stage'=s.stage
    ) THEN
      -- An interrupted dealt hand is VOID, never accepted or never_started.
      -- Its incomplete snapshot is evidence, not an executable continuation.
      -- Original principals must still be the last fully accepted boundary.
      SELECT * INTO snap FROM public.hand_state_snapshots s
       WHERE s.table_id=h.table_id AND s.hand_number=h.hand_number FOR UPDATE;
      IF snap.is_complete IS DISTINCT FROM false OR v_dispatched OR v_break IS NOT NULL
         OR NOT COALESCE(snap.config_json->>'gameVariant' IN ('nlh','plo4','plo5','plo6'),false)
         OR snap.created_at IS NULL OR NOT isfinite(snap.created_at)
         OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
         OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10
         OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)
              <>jsonb_array_length(snap.state_json->'players')
         OR EXISTS (SELECT 1 FROM public.hand_discards d WHERE d.table_id=h.table_id AND d.hand_number=h.hand_number)
         OR EXISTS (SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
                     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE x->>'user_id'=c.user_id::text))
         OR v_cards<>jsonb_array_length(snap.state_json->'players') THEN
        RAISE EXCEPTION 'F06_INTERRUPTED_PRINCIPAL_UNPROVEN' USING ERRCODE='55000';
      END IF;
      -- No timestamp sorting or action reconstruction: retain the original row
      -- hash and preserve the recorded action array as historical evidence.
      SELECT jsonb_agg(r || jsonb_build_object('joined_at',s.joined_at) ORDER BY r->>'user_id')
        INTO v_original_roster FROM jsonb_array_elements(roster) r
        JOIN public.table_seats s ON s.id=(r->>'seat_id')::uuid
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE x->>'user_id'=r->>'user_id');
      IF jsonb_array_length(v_original_roster) IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_original_roster) x WHERE x->>'user_id'=r->>'user_id')
                       AND NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.id=(r->>'seat_id')::uuid AND s.joined_at>snap.created_at))
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
                     WHERE NOT COALESCE((CASE WHEN pg_input_is_valid(x->>'stack','numeric')
                       AND pg_input_is_valid(x->>'totalInvested','numeric')
                       AND pg_input_is_valid(x->>'seat','integer')
                       THEN (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
                         AND (x->>'stack')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
                         AND (x->>'totalInvested')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
                         AND COALESCE(x->>'returnedUncalled','0')='0'
                         AND COALESCE(x->>'deadInvested','0')='0'
                         AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_original_roster) r
                                      WHERE r->>'user_id'=x->>'user_id'
                                        AND (r->>'seat_number')::integer=(x->>'seat')::integer
                                        AND (r->>'joined_at')::timestamptz<=snap.created_at
                                        AND (r->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)
                       ELSE false END),false))
         OR NOT COALESCE(pg_input_is_valid(snap.state_json->>'pot','numeric'),false)
         OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
              (SELECT sum((x->>'totalInvested')::numeric) FROM jsonb_array_elements(snap.state_json->'players') x) THEN
        RAISE EXCEPTION 'F06_INTERRUPTED_PRINCIPAL_UNPROVEN' USING ERRCODE='55000';
      END IF;
      SELECT a.*,hh.players AS history_players INTO v_prior FROM public.hand_atomic_commits a
        JOIN public.hand_history hh ON hh.id=a.hand_id AND hh.table_id=a.table_id AND hh.hand_number=a.hand_number
       WHERE a.table_id=h.table_id AND a.hand_number<h.hand_number ORDER BY a.hand_number DESC LIMIT 1 FOR SHARE OF a,hh;
      IF NOT FOUND OR v_prior.committed_at IS NULL OR NOT isfinite(v_prior.committed_at)
         OR v_prior.post_commit_completed_at IS NULL
         OR v_prior.post_commit_completed_at<v_prior.committed_at
         OR NOT isfinite(v_prior.post_commit_completed_at)
         OR v_prior.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
         OR v_prior.post_commit_result->>'hand_id' IS DISTINCT FROM v_prior.hand_id::text
         OR v_prior.post_commit_result->>'hand_number' IS DISTINCT FROM v_prior.hand_number::text
         OR v_prior.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
         OR v_prior.stack_result->>'mode' IS DISTINCT FROM 'delta'
         OR v_prior.stack_result->'conservation_checked' IS DISTINCT FROM 'true'::jsonb
         OR v_prior.stack_result->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
         OR v_prior.stack_result->>'table_id' IS DISTINCT FROM h.table_id::text
         OR v_prior.stack_result->>'tournament_id' IS DISTINCT FROM t::text
         OR v_prior.stack_result->>'hand_number' IS DISTINCT FROM v_prior.hand_number::text
         OR jsonb_typeof(v_prior.history_players) IS DISTINCT FROM 'array'
         OR jsonb_typeof(v_prior.stack_result#>'{request,stacks}') IS DISTINCT FROM 'array'
         OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id
                     AND (a.hand_number>v_prior.hand_number OR a.committed_at>v_prior.committed_at))
         OR EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.table_id=h.table_id AND hh.hand_number>v_prior.hand_number)
         OR EXISTS (SELECT 1 FROM public.hand_private_state hp WHERE hp.table_id=h.table_id AND hp.hand_number>v_prior.hand_number)
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_original_roster) r
                     WHERE (v_prior.stack_result->'written'->>(r->>'user_id'))::numeric IS DISTINCT FROM (r->>'stack')::numeric
                       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_prior.history_players) x
                                       WHERE x->>'userId'=r->>'user_id' AND (x->>'stack')::numeric=(r->>'stack')::numeric)
                       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_prior.stack_result#>'{request,stacks}') x
                                       WHERE x->>'user_id'=r->>'user_id' AND x->>'seat_id'=r->>'seat_id'
                                         AND (x->>'seat_joined_at')::timestamptz=(r->>'joined_at')::timestamptz
                                         AND (x->>'stack')::numeric=(r->>'stack')::numeric)) THEN
        RAISE EXCEPTION 'F06_INTERRUPTED_PRIOR_BOUNDARY_UNPROVEN' USING ERRCODE='55000';
      END IF;
      hands:=hands || jsonb_build_array(jsonb_build_object(
        'permit',to_jsonb(h),'ruling','misdeal_voided','shape','interrupted_postflop_principal_preserved',
        'snapshot_id',snap.id,'snapshot_hash',md5(to_jsonb(snap)::text),
        'snapshot_created_at',snap.created_at,'interrupted_stage',snap.stage,
        'prior_hand_id',v_prior.hand_id,'prior_hand_number',v_prior.hand_number,
        'prior_atomic_hash',md5((to_jsonb(v_prior)-'history_players')::text),
        'roster',roster,'original_roster',v_original_roster,'busts_pending_elimination',v_busts,'break_id',NULL));
      v_abort_ids:=v_abort_ids || h.permit_id;
      v_snap_ids:=v_snap_ids || snap.id;
      v_misdeal_n:=v_misdeal_n+1;
    ELSIF n = 1 THEN
$new_admission$;
BEGIN
 SELECT proowner,proacl,proconfig,prosecdef,pg_get_functiondef(oid) AS definition INTO p
 FROM pg_proc WHERE oid='public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure;
 IF md5(p.definition) IS DISTINCT FROM '52e7b71547751e500fa10b59185bd456'
 OR p.proowner IS DISTINCT FROM 'postgres'::regrole
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
 OR p.prosecdef IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'INTERRUPTED_POSTFLOP_PREIMAGE_DRIFT';
 END IF;
 -- The floor alone is not continuation authority. Require the exact private
 -- assertion and BOTH original enabled trigger consumers before allowing void.
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.assert_hand_continuation_disposition(uuid,bigint)')
     AND md5(prosrc)='f2e3f2fafc943a88344a328fb98c0d69'
     AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
     AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog'])
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_retained_submission_guard()')
     AND md5(prosrc)='fa19e52c7125723d01af8f5cf5244d68'
     AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
     AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog'])
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.hand_submission_snapshot_guard()')
     AND md5(prosrc)='9fa0857dd8cbfb3b27bc0e1951bdb1c7'
     AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
     AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog'])
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_hand_permits'::regclass
     AND tgname='f06_retained_submission_guard' AND NOT tgisinternal AND tgenabled='O'
     AND tgfoid=to_regprocedure('smarter_private.f06_retained_submission_guard()')
     AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass
     AND tgname='hand_submission_snapshot_guard' AND NOT tgisinternal AND tgenabled='O'
     AND tgfoid=to_regprocedure('smarter_private.hand_submission_snapshot_guard()')
     AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_snapshot_guard AFTER INSERT OR UPDATE OF is_complete ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard()') THEN
  RAISE EXCEPTION 'INTERRUPTED_POSTFLOP_CONTINUATION_CONTRACT_UNPROVEN';
 END IF;
 prior:=p.definition;
 IF length(prior)-length(replace(prior,old_locals,''))<>length(old_locals)
 OR length(prior)-length(replace(prior,old_admission,''))<>length(old_admission) THEN
  RAISE EXCEPTION 'INTERRUPTED_POSTFLOP_ANCHOR_DRIFT';
 END IF;
 candidate:=replace(replace(prior,old_locals,new_locals),old_admission,new_admission);
 restored:=replace(replace(candidate,new_locals,old_locals),new_admission,old_admission);
 IF restored IS DISTINCT FROM prior OR md5(candidate)<>'e416f1fa850c85d656ec55ddfae3386d' THEN
  RAISE EXCEPTION 'INTERRUPTED_POSTFLOP_COMPOSITION_DRIFT';
 END IF;
 EXECUTE candidate;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure
 AND md5(pg_get_functiondef(oid))='e416f1fa850c85d656ec55ddfae3386d'
 AND proowner=p.proowner AND proacl IS NOT DISTINCT FROM p.proacl
 AND proconfig IS NOT DISTINCT FROM p.proconfig AND prosecdef=p.prosecdef) THEN
  RAISE EXCEPTION 'INTERRUPTED_POSTFLOP_POSTIMAGE_DRIFT';
 END IF;
END $patch$;
REVOKE ALL ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean) TO service_role;
COMMIT;
