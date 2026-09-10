DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$;
ALTER FUNCTION public.fn_project_hand_side_effects(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(uuid) OWNER TO postgres;
CREATE OR REPLACE FUNCTION public.trg_finish_hand_post_commit_obligations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_ca_process_hand_post_commit_obligations(OLD.hand_id);
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
     AND v_result->>'reason' <> 'legacy_no_obligations' THEN
    RAISE EXCEPTION 'hand post-commit obligations remain pending for %: %',
      OLD.hand_id, v_result;
  END IF;
  RETURN OLD;
END;
$function$
;
CREATE TRIGGER a0_finish_hand_post_commit_obligations BEFORE DELETE ON hand_projection_outbox
FOR EACH ROW EXECUTE FUNCTION trg_finish_hand_post_commit_obligations();
INSERT INTO engine_table_leases(table_id,instance_id,lease_generation,protocol_version)
VALUES('30000000-0000-0000-0000-000000000001','fixture-engine',
'70000000-0000-0000-0000-000000000001',2);
CREATE TABLE fixture_accepted_payload AS SELECT
 jsonb_agg(jsonb_build_object('user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,
 'stack_before',300,'stack',CASE WHEN seat_number=1 THEN 250 ELSE 350 END) ORDER BY user_id) stacks,
 jsonb_build_object('table_id','30000000-0000-0000-0000-000000000001','hand_number',1000002,
 'game_variant','nlh','pot_size',100,'small_blind',1,'big_blind',2,'rake_amount',0,'bbj_amount',0,
 'button_seat',1,'source','engine',
 'players',jsonb_agg(jsonb_build_object('userId',user_id,'seat',seat_number,'stack',
 CASE WHEN seat_number=1 THEN 250 ELSE 350 END) ORDER BY user_id),
 'winners',jsonb_build_array(jsonb_build_object('userId','10000000-0000-0000-0000-000000000002','amount',100)),
 'actions',jsonb_build_array(
 jsonb_build_object('userId','10000000-0000-0000-0000-000000000001','stage','preflop','action','raise','amount',50),
 jsonb_build_object('userId','10000000-0000-0000-0000-000000000002','stage','preflop','action','call','amount',48)),
 '_accepted_post_commit_facts',jsonb_build_object('contributions',
 jsonb_build_object('10000000-0000-0000-0000-000000000001',50,'10000000-0000-0000-0000-000000000002',50),
 'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb)) hand_row,
 jsonb_build_object('version',1,'time_banks',jsonb_agg(jsonb_build_object(
 'user_id',user_id,'seat_id',id,'seat_joined_at',joined_at,'uses_remaining',2,'seconds_remaining',20) ORDER BY user_id),
 'rake',null,'bbj_contribution',null,'insurance','[]'::jsonb,
 'promo_playthrough','[]'::jsonb,'pending_addons',null) obligations
 FROM table_seats;
CREATE FUNCTION fixture_accept(p_patch jsonb DEFAULT '{}'::jsonb,p_lease uuid DEFAULT '70000000-0000-0000-0000-000000000001') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE p fixture_accepted_payload%ROWTYPE;
BEGIN
 SELECT * INTO p FROM fixture_accepted_payload;
 RETURN fn_ca_commit_hand_settlement('30000000-0000-0000-0000-000000000001',1000002,
 COALESCE(p_patch->'stacks',p.stacks),0,0,null,0,COALESCE(p_patch->'hand_row',p.hand_row),COALESCE(p_patch->'units','[]'::jsonb),
 'fixture-engine',p_lease,COALESCE(p_patch->'obligations',p.obligations));
END $$;
CREATE FUNCTION fixture_accepted_state() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM table_seats s),
 (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM poker_diamond_custody c),
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM diamond_purchase_lots l),
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM hand_history h),
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY hand_id) FROM hand_atomic_commits h),
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY hand_id) FROM hand_projection_outbox h))
$$;
