-- R46 preparation: immutable parent-format launch protocol.
-- No active ABI change. Existing receipt, lease, roster, seat, money and replay
-- authorities remain; old signatures cannot silently start a newly authored MTT.
-- mtt-v1 retains its recorded funded minimum, including an accepted minimum two.
-- Historical already-played recovery remains governed by its existing receipts.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $requires$ BEGIN
 IF to_regprocedure('public.fn_ca_tournament_is_unlimited(uuid)') IS NULL
    OR (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)
       IS DISTINCT FROM 'legacy-capacity-v1' THEN
  RAISE EXCEPTION 'MTT_LAUNCH_REQUIRES_LEGACY_PREPARATION';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments
   WHERE status IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING') AND format_contract IS NULL) THEN
  RAISE EXCEPTION 'MTT_LAUNCH_REQUIRES_COMPLETE_ACTIVE_FORMAT_QUALIFICATION';
 END IF;
END $requires$;
DO $collision$ BEGIN IF to_regprocedure('public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'MTT_FORMAT_LAUNCH_SIGNATURE_COLLISION'; END IF; END $collision$;
DO $collision$ BEGIN IF to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'MTT_FORMAT_LAUNCH_SIGNATURE_COLLISION'; END IF; END $collision$;
DO $launch_format$
DECLARE targets jsonb:=$targets$[
  {
    "signature": "public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone)",
    "pre_source_md5": "0db85bdca3cea07627408f27e6c563a5",
    "pre_definition_md5": "3214b4fe0037e6b08963dd8676d593a8",
    "post_source_md5": "b39e2b44e63be4c4fb4c65f3644429df",
    "post_definition_md5": "0f362f2b4a55f82d627dddccd1da481e",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "DECLARE\n",
        "new": "DECLARE\n  v_format text;\n"
      },
      {
        "old": "PERFORM pg_advisory_xact_lock_shared(530090, 1);",
        "new": "PERFORM pg_advisory_xact_lock_shared(530090, 1);\n  PERFORM public.fn_ca_lock_mtt_admission_contract();"
      },
      {
        "old": "  RETURN public.fn_begin_tournament_launch_before_lease_generation(",
        "new": "  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);\n  IF v_format='mtt-v2' THEN\n    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);\n  END IF;\n\n  RETURN public.fn_begin_tournament_launch_before_lease_generation("
      },
      {
        "old": "  RETURN public.fn_begin_tournament_launch_before_lease_generation(",
        "new": "  RETURN (public.fn_begin_tournament_launch_before_lease_generation("
      },
      {
        "old": "    p_started_at\n  );",
        "new": "    p_started_at\n  )) || jsonb_build_object('format_contract',v_format);"
      }
    ]
  },
  {
    "signature": "public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid)",
    "pre_source_md5": "2ae3184bbea06198a00b8409cf808083",
    "pre_definition_md5": "80e5567b44bf2711979444432ce4e979",
    "post_source_md5": "bbd6404236a72d2fc8df1b42ca14295f",
    "post_definition_md5": "acbb83c13660c3eda2d9f52fec0c7bd5",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "DECLARE\n",
        "new": "DECLARE\n  v_format text;\n"
      },
      {
        "old": "PERFORM pg_advisory_xact_lock_shared(530090, 1);",
        "new": "PERFORM pg_advisory_xact_lock_shared(530090, 1);\n  PERFORM public.fn_ca_lock_mtt_admission_contract();"
      },
      {
        "old": "  v_result := public.fn_begin_tournament_launch_before_lease_generation(",
        "new": "  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);\n  IF v_format='mtt-v2' THEN\n    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);\n  END IF;\n\n  v_result := public.fn_begin_tournament_launch_before_lease_generation("
      },
      {
        "old": "RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation);",
        "new": "RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,\n    'format_contract', v_format);"
      }
    ]
  },
  {
    "signature": "public.fn_complete_tournament_launch_atomic(uuid,uuid)",
    "pre_source_md5": "fcb8cec35d672f897eb8db852b33b4d0",
    "pre_definition_md5": "554c10597600a0408c5698039f1aa046",
    "post_source_md5": "17cc10e9c9d6595b65baa02e31adb2b3",
    "post_definition_md5": "ab0d03139203d89e16a0cfdae4e1e292",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "DECLARE\n",
        "new": "DECLARE\n  v_format text;\n"
      },
      {
        "old": "  RETURN public.fn_complete_tournament_launch_before_lease_generation(",
        "new": "  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);\n  IF v_format='mtt-v2' THEN\n    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);\n  END IF;\n\n  RETURN public.fn_complete_tournament_launch_before_lease_generation("
      },
      {
        "old": "  RETURN public.fn_complete_tournament_launch_before_lease_generation(",
        "new": "  RETURN (public.fn_complete_tournament_launch_before_lease_generation("
      },
      {
        "old": "    p_launch_id\n  );",
        "new": "    p_launch_id\n  )) || jsonb_build_object('format_contract',v_format);"
      }
    ]
  },
  {
    "signature": "public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)",
    "pre_source_md5": "5f6597231e323454438ab66aa7defcb3",
    "pre_definition_md5": "089328dfdae64c78cb2f7976a3a02b83",
    "post_source_md5": "efe5d5c79fe14eafe808a75ec1e8f84f",
    "post_definition_md5": "d300cf2470354e570ebb02fdecff0537",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
      {
        "grantee": "service_role",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "DECLARE\n",
        "new": "DECLARE\n  v_format text;\n"
      },
      {
        "old": "  v_result := public.fn_complete_tournament_launch_before_lease_generation(",
        "new": "  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);\n  IF v_format='mtt-v2' THEN\n    RETURN jsonb_build_object('ok',false,'reason','launch_format_argument_required','format_contract',v_format);\n  END IF;\n\n  v_result := public.fn_complete_tournament_launch_before_lease_generation("
      },
      {
        "old": "RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation);",
        "new": "RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,\n    'format_contract', v_format);"
      }
    ]
  },
  {
    "signature": "public.fn_complete_tournament_launch_before_lease_generation(uuid,uuid)",
    "pre_source_md5": "3666a6fb50cc8bbea728dd7c861ad915",
    "pre_definition_md5": "bd3d1bcaf633ecc8f448a075a9240084",
    "post_source_md5": "540e955df8128b677a531c2513b9ab7e",
    "post_definition_md5": "d1a25ca8de559144fe83b7639634baff",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "postgres",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      }
    ],
    "edits": [
      {
        "old": "CASE WHEN COALESCE(t.max_players, 0) > 0\n              THEN GREATEST(2, LEAST(3, t.max_players))\n              ELSE 3 END",
        "new": "CASE WHEN t.format_contract='mtt-v1' THEN GREATEST(2,COALESCE(t.min_players,2))\n              WHEN t.format_contract='mtt-v2' THEN GREATEST(3,COALESCE(t.min_players,3))\n              WHEN COALESCE(t.max_players,0)>0 THEN GREATEST(2,LEAST(3,t.max_players))\n              ELSE 3 END"
      }
    ]
  }
]$targets$::jsonb;
 item jsonb; edit jsonb; phase text; fn oid; definition text; actual_acl jsonb;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'MTT_LAUNCH_FORMAT_OWNER_REQUIRED'; END IF;
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
      AND md5(p.prosrc)=item->>(phase||'_source_md5')
      AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
      AND p.proowner='postgres'::regrole) THEN
    RAISE EXCEPTION 'MTT_LAUNCH_FORMAT_%_AUTHORITY_DRIFT: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type) INTO actual_acl
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'MTT_LAUNCH_FORMAT_%_ACL_DRIFT: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))/length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'MTT_LAUNCH_FORMAT_SPLICE_DRIFT: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $launch_format$;
CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_started_at timestamp with time zone, p_lease_generation uuid, p_expected_format text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF p_expected_format IS DISTINCT FROM v_format THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_mismatch','format_contract',v_format);
  END IF;

  v_result := public.fn_begin_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id,
    p_started_at
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false)
     AND NOT COALESCE((v_result ->> 'completed')::boolean, false) THEN
    SELECT r.lease_generation INTO STRICT v_receipt_generation
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id = p_tournament_id
     FOR UPDATE;
    IF v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
      PERFORM set_config(
        'app.atomic_tournament_launch_lease_adoption',
        p_tournament_id::text || ':' || v_receipt_generation::text || ':' || p_lease_generation::text,
        true
      );
      UPDATE public.tournament_launch_receipts r
         SET lease_generation = p_lease_generation
       WHERE r.tournament_id = p_tournament_id
         AND r.completed_at IS NULL
         AND r.lease_generation = v_receipt_generation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament launch receipt changed during lease adoption'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$
;
ALTER FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text) TO service_role;
DO $post$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamp with time zone,uuid,text)'::regprocedure AND md5(p.prosrc)='cf142af11906a0562e0cc23651318e21' AND md5(pg_get_functiondef(p.oid))='a0718c687780f7cf3ce36f50c558f456' AND p.proowner='postgres'::regrole) THEN RAISE EXCEPTION 'MTT_FORMAT_LAUNCH_POSTIMAGE_DRIFT'; END IF; END $post$;
CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid, p_expected_format text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_format text;
  v_current_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_receipt_generation uuid;
  v_receipt_launch_id uuid;
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_launch_id IS NULL OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_launch_request');
  END IF;

  SELECT l.lease_generation, l.protocol_version, l.heartbeat_at
    INTO v_current_generation, v_protocol_version, v_heartbeat_at
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_current_generation IS DISTINCT FROM p_lease_generation
     OR v_heartbeat_at < clock_timestamp() - interval '30 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_lease_lost');
  END IF;

  SELECT r.launch_id, r.lease_generation
    INTO v_receipt_launch_id, v_receipt_generation
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_receipt_launch_id IS DISTINCT FROM p_launch_id
     OR v_receipt_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
  END IF;

  v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF p_expected_format IS DISTINCT FROM v_format THEN
    RETURN jsonb_build_object('ok',false,'reason','launch_format_mismatch','format_contract',v_format);
  END IF;

  v_result := public.fn_complete_tournament_launch_before_lease_generation(
    p_tournament_id,
    p_launch_id
  );
  RETURN v_result || jsonb_build_object('lease_generation', p_lease_generation,
    'format_contract', v_format);
END;
$function$
;
ALTER FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text) TO service_role;
DO $post$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)'::regprocedure AND md5(p.prosrc)='6d3321680ed0e23afc633d941765de40' AND md5(pg_get_functiondef(p.oid))='faeb38ce1a2e975dc80468abaf74c588' AND p.proowner='postgres'::regrole) THEN RAISE EXCEPTION 'MTT_FORMAT_LAUNCH_POSTIMAGE_DRIFT'; END IF; END $post$;
DO $launch_acl$ DECLARE s text; BEGIN
 FOREACH s IN ARRAY ARRAY['public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid,text)',
 'public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)'] LOOP
  IF (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl)a WHERE p.oid=to_regprocedure(s))<>2
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl)a WHERE p.oid=to_regprocedure(s)
      AND (a.grantor<>p.proowner OR a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole)
        OR a.privilege_type<>'EXECUTE' OR a.is_grantable))
    OR has_function_privilege('anon',s,'EXECUTE') OR has_function_privilege('authenticated',s,'EXECUTE') THEN
   RAISE EXCEPTION 'MTT_FORMAT_LAUNCH_ACL_DRIFT';
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_begin_tournament_launch_atomic')<>3
   OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='fn_complete_tournament_launch_atomic')<>3 THEN
  RAISE EXCEPTION 'MTT_FORMAT_LAUNCH_OVERLOAD_DRIFT';
 END IF;
END $launch_acl$;
COMMIT;
