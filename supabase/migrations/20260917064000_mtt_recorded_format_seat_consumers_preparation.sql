-- R46 preparation: recorded-format seat consumers and physical capacity.
-- The ABI remains legacy; this migration does not authorize activation.
-- Physical chairs remain bounded, and funded HU satellites keep their existing
-- seat-first play and scheduled-clock withdrawal contracts. No money formula,
-- refund source, committed receipt, table cap, or existing format is rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $preparation$ BEGIN
 IF to_regprocedure('public.fn_ca_lock_mtt_admission_contract()') IS NULL
    OR to_regprocedure('public.fn_ca_tournament_recorded_format(uuid)') IS NULL
    OR (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)
       IS DISTINCT FROM 'legacy-capacity-v1' THEN
  RAISE EXCEPTION 'MTT_SEAT_CONSUMERS_REQUIRE_LEGACY_PREPARATION';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
     AND proname='fn_ca_tournament_recorded_seat_first') THEN
  RAISE EXCEPTION 'MTT_SEAT_CONSUMERS_NAME_COLLISION';
 END IF;
END $preparation$;

-- Reads immutable parent metadata only. AFTER-seat helpers must not acquire
-- an ABI/global lock after the writer already holds seat rows. Their owning
-- effect roots take the ABI lock before effects; this reader never takes it.
-- Unknown terminal history may leave seats without inventing a product. The
-- cleanup exception only skips seat-first bookkeeping; it never grants entry
-- or creation, and a known terminal format retains its existing bookkeeping.
CREATE FUNCTION public.fn_ca_tournament_recorded_seat_first(
 p_tournament_id uuid,p_terminal_cleanup boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE v_format text; v_cap integer; v_status text;
BEGIN
 SELECT t.format_contract,t.max_players,upper(COALESCE(t.status::text,''))
 INTO v_format,v_cap,v_status FROM public.tournaments t WHERE t.id=p_tournament_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
 END IF;
 IF p_terminal_cleanup IS TRUE AND v_format IS NULL
    AND v_status IN ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN false;
 END IF;
 v_format:=public.fn_ca_tournament_recorded_format(p_tournament_id);
 RETURN v_format IN ('spin-v1','seat-first-satellite-v1')
     OR (v_format='sng-v1' AND v_cap BETWEEN 1 AND 2);
END $function$;
ALTER FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_seat_first(uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

DO $seat_consumers$
DECLARE targets jsonb:=$targets$[
  {
    "signature": "public.fn_ca_guard_seat_creation()",
    "pre_source_md5": "534207f17003588a6ada8b6ea894442d",
    "pre_definition_md5": "81d6f8dd922f5078daf6f1c49f773634",
    "post_source_md5": "e8513a24efc4708b029b68c93caa088f",
    "post_definition_md5": "b3e14f411d43b01e84fd614c87f8bf6a",
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
        "old": "IF lower(COALESCE(v_variant,'')) = 'spin'\n       OR COALESCE(v_max_players,0) <= 2 THEN",
        "new": "IF public.fn_ca_tournament_recorded_seat_first(v_tournament_id, false) THEN"
      }
    ]
  },
  {
    "signature": "public.fn_ca_tournament_seat_cap(uuid)",
    "pre_source_md5": "177e2e82ef01b126d16e7706f9d29e12",
    "pre_definition_md5": "510ac3eb3e6547c94f3ea6a8886d459c",
    "post_source_md5": "6d7fab237807b044d28eddcae4f9aa45",
    "post_definition_md5": "557b6fd0f941fd7ee803f408580224db",
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
        "old": "v_format:=lower(COALESCE(v_t.variant,''));",
        "new": "v_format:=public.fn_ca_tournament_recorded_format(p_tournament_id);"
      },
      {
        "old": "WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'",
        "new": "WHEN v_format='spin-v1'"
      },
      {
        "old": "WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'",
        "new": "WHEN v_format='seat-first-satellite-v1' THEN 2\n    WHEN v_format='sng-v1'"
      }
    ]
  },
  {
    "signature": "public.fn_ca_unregister_tournament_player_exact(uuid,uuid,uuid,text,uuid)",
    "pre_source_md5": "e37cab626ca4bdd3c84c8acec8d9dba3",
    "pre_definition_md5": "a9d682f690138b90c381cd89aa6a97b9",
    "post_source_md5": "aaf6b87492d6c083d3625be78e2a84a2",
    "post_definition_md5": "3fc3f147808ab3ecc50982f5b6968bff",
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
        "old": "USING ERRCODE='22004';\n  END IF;",
        "new": "USING ERRCODE='22004';\n  END IF;\n  PERFORM public.fn_ca_lock_mtt_admission_contract();"
      },
      {
        "old": "IF v_t.satellite_target_id IS NULL\n     AND upper(COALESCE(v_t.tournament_type::text,''))<>'SATELLITE'\n     AND (lower(COALESCE(v_t.variant::text,''))='spin'\n       OR upper(COALESCE(v_t.tournament_type::text,''))='SPIN') THEN",
        "new": "IF v_t.format_contract='spin-v1' THEN"
      },
      {
        "old": "ELSIF v_t.satellite_target_id IS NULL\n     AND upper(COALESCE(v_t.tournament_type::text,''))='SNG'\n     AND lower(COALESCE(v_t.variant::text,''))<>'spin'\n     AND COALESCE(v_t.max_players,0)=2 THEN",
        "new": "ELSIF v_t.format_contract='sng-v1'\n     AND COALESCE(v_t.max_players,0)=2 THEN"
      },
      {
        "old": "IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN\n    RETURN jsonb_build_object('ok',false,'reason','registration_closed');\n  END IF;",
        "new": "IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN\n    RETURN jsonb_build_object('ok',false,'reason','registration_closed');\n  END IF;\n  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);"
      }
    ]
  },
  {
    "signature": "public.fn_ensure_late_registration_capacity(uuid,integer)",
    "pre_source_md5": "b36dd36a9348d29be1092c7d42954c03",
    "pre_definition_md5": "231f56742d40351b5121622ef068d02c",
    "post_source_md5": "301d0175746ef6c9fce6cfd22e7f273d",
    "post_definition_md5": "cee652fdd8962e43b8e2861bf5c5407e",
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
        "old": "\nBEGIN\n",
        "new": "\nBEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n"
      },
      {
        "old": "v_format := lower(COALESCE(v_t.variant,''));",
        "new": "v_format := public.fn_ca_tournament_recorded_format(p_tournament_id);"
      },
      {
        "old": "WHEN v_format='spin' OR upper(COALESCE(v_t.tournament_type,''))='SPIN'",
        "new": "WHEN v_format='spin-v1'"
      },
      {
        "old": "WHEN v_format='sng' OR upper(COALESCE(v_t.tournament_type,''))='SNG'",
        "new": "WHEN v_format='seat-first-satellite-v1' THEN 2\n    WHEN v_format='sng-v1'"
      }
    ]
  },
  {
    "signature": "public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)",
    "pre_source_md5": "b208b04fce4a32f5273119bcf2d25450",
    "pre_definition_md5": "fd9570d3b373036bd1b93f6d7fbe5673",
    "post_source_md5": "0f6ed03556cfbdd0a536698ae369d184",
    "post_definition_md5": "39f95b499619cab7a1eb65ff583aa638",
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
        "old": "USING ERRCODE='22004';\n  END IF;",
        "new": "USING ERRCODE='22004';\n  END IF;\n  PERFORM public.fn_ca_lock_mtt_admission_contract();"
      },
      {
        "old": "IF v_t.satellite_target_id IS NULL\n     AND upper(COALESCE(v_t.tournament_type::text,''))<>'SATELLITE'\n     AND (lower(COALESCE(v_t.variant::text,''))='spin'\n       OR upper(COALESCE(v_t.tournament_type::text,''))='SPIN') THEN",
        "new": "IF v_t.format_contract='spin-v1' THEN"
      },
      {
        "old": "ELSIF v_t.satellite_target_id IS NULL\n     AND upper(COALESCE(v_t.tournament_type::text,''))='SNG'\n     AND lower(COALESCE(v_t.variant::text,''))<>'spin'\n     AND COALESCE(v_t.max_players,0)=2 THEN",
        "new": "ELSIF v_t.format_contract='sng-v1'\n     AND COALESCE(v_t.max_players,0)=2 THEN"
      },
      {
        "old": "IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN\n    RETURN jsonb_build_object('ok',false,'reason','tournament_started');\n  END IF;",
        "new": "IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN\n    RETURN jsonb_build_object('ok',false,'reason','tournament_started');\n  END IF;\n  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);"
      }
    ]
  },
  {
    "signature": "public.fn_release_phantom_seat_claims()",
    "pre_source_md5": "2153075f26134fa1092bddab64218620",
    "pre_definition_md5": "e1bfa132ceb072fc479e9a506f0c74ba",
    "post_source_md5": "bf5fbd0a048d5abf9c5efc466d995506",
    "post_definition_md5": "21628db27f7430a3414cbd2b893a660f",
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
        "old": "\nBEGIN\n",
        "new": "\nBEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n"
      },
      {
        "old": "AND (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)",
        "new": "AND (t.format_contract IN ('spin-v1','seat-first-satellite-v1')\n          OR (t.format_contract='sng-v1' AND t.max_players BETWEEN 1 AND 2))"
      }
    ]
  },
  {
    "signature": "public.fn_seat_change_syncs_seat_first_count()",
    "pre_source_md5": "d105db62a249ba49b267d8d28bb55b2f",
    "pre_definition_md5": "f5b45635a8203fc8fbd95282d4770dc8",
    "post_source_md5": "34957b7bf0e2496d0f97ddb80a634816",
    "post_definition_md5": "3d222458b40d5aec09f8f1e88bf60d53",
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
        "old": "AND (lower(COALESCE(t.variant,'')) = 'spin'\n            OR COALESCE(t.max_players,0) <= 2)",
        "new": "AND public.fn_ca_tournament_recorded_seat_first(t.id, true)"
      }
    ]
  },
  {
    "signature": "public.fn_seat_first_boards_ready()",
    "pre_source_md5": "822966ea0bf2979145c10a1c4e010399",
    "pre_definition_md5": "af5bb071b214029918476ff55cec4d6b",
    "post_source_md5": "4ee882de7aa2dd92d95fb5a700fc6383",
    "post_definition_md5": "52d79b624a2f58a1800ccc1ddb496ed1",
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
        "old": "AND (t.variant = 'spin' OR (t.variant = 'sng' AND t.max_players <= 2))",
        "new": "AND (t.format_contract IN ('spin-v1','seat-first-satellite-v1')\n      OR (t.format_contract='sng-v1' AND t.max_players BETWEEN 1 AND 2))"
      }
    ]
  },
  {
    "signature": "public.fn_seat_horse_in_seat_first_game_before_maintenance_gate(uuid,uuid)",
    "pre_source_md5": "f99ebe17189d4b1efef52336cef69715",
    "pre_definition_md5": "e8d6861e5353a92e2ee347da454f6549",
    "post_source_md5": "4b64cfdef0137bd668bafdb3c7464eac",
    "post_definition_md5": "28f1d2ea26fb3b3f2bc3af3d817393bf",
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
        "old": "\nBEGIN\n",
        "new": "\nBEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n"
      },
      {
        "old": "IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN",
        "new": "IF NOT public.fn_ca_tournament_recorded_seat_first(p_tournament_id, false) THEN"
      }
    ]
  },
  {
    "signature": "public.fn_sync_seat_first_player_count(uuid)",
    "pre_source_md5": "609983772f8468d96b7b3d8dcfeafaea",
    "pre_definition_md5": "6ca19586d771591fb674d07e4b0c323c",
    "post_source_md5": "37411be012972744862335f4c9ec1f03",
    "post_definition_md5": "0e4acaf0ff080d4dafd1aa85068cf0b2",
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
        "old": "SELECT (lower(COALESCE(t.variant, '')) = 'spin'\n          OR COALESCE(t.max_players, 0) <= 2),\n         lower(COALESCE(t.variant, '')) = 'spin',",
        "new": "SELECT public.fn_ca_tournament_recorded_seat_first(t.id, true),\n         t.format_contract = 'spin-v1',"
      }
    ]
  },
  {
    "signature": "public.fn_take_seat_and_buy_in_before_maintenance_announcement_gate(uuid,integer)",
    "pre_source_md5": "a4b73120eb5bad86eba900abec29b60a",
    "pre_definition_md5": "d5ec9bc535b1a0b84140af8a48da8640",
    "post_source_md5": "510603f9f49884f162c3f0e084a6f25e",
    "post_definition_md5": "67a6b85f00a785e22c4d89c6168253d3",
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
        "old": "\nBEGIN\n",
        "new": "\nBEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n"
      },
      {
        "old": "IF NOT (COALESCE(v_t.variant, '') = 'spin' OR COALESCE(v_t.max_players, 0) <= 2) THEN",
        "new": "IF NOT public.fn_ca_tournament_recorded_seat_first(v_t.id, false) THEN"
      }
    ]
  }
]$targets$::jsonb;
 item jsonb; edit jsonb; phase text; fn oid; definition text; actual_acl jsonb;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'MTT_SEAT_CONSUMERS_OWNER_REQUIRED'; END IF;
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
      AND md5(p.prosrc)=item->>(phase||'_source_md5')
      AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
      AND p.proowner='postgres'::regrole) THEN
    RAISE EXCEPTION 'MTT_SEAT_CONSUMERS_%_AUTHORITY_DRIFT: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type) INTO actual_acl
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'MTT_SEAT_CONSUMERS_%_ACL_DRIFT: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))/length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'MTT_SEAT_CONSUMERS_SPLICE_DRIFT: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $seat_consumers$;
COMMIT;
