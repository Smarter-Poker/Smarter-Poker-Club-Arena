-- R46 preparation slice: admission barrier and effective-capacity authority.
-- The private ABI remains legacy and its existing guard STILL refuses activation.
-- Legacy branches retain their prior predicates verbatim; no parent/financial row
-- is rewritten. This slice alone is insufficient for unlimited activation.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $preparation$ BEGIN
 IF to_regprocedure('public.fn_ca_lock_mtt_admission_contract()') IS NULL
    OR to_regprocedure('public.fn_ca_tournament_recorded_format(uuid)') IS NULL
    OR (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)
      IS DISTINCT FROM 'legacy-capacity-v1' THEN
  RAISE EXCEPTION 'MTT_DUAL_ADMISSION_REQUIRES_LEGACY_PREPARATION';
 END IF;
 IF to_regprocedure('public.fn_ca_tournament_is_unlimited(uuid)') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
       AND proname='fn_ca_tournament_admission_snapshot') THEN
  RAISE EXCEPTION 'MTT_DUAL_ADMISSION_NAME_COLLISION';
 END IF;
END $preparation$;

-- Recorded-row capacity only. Raw request JSON can never select a legacy
-- exception. The shared singleton row lock lasts through the entire operation.
CREATE FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE v_abi text;
BEGIN
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF v_abi='legacy-capacity-v1' THEN RETURN false; END IF;
 RETURN public.fn_ca_tournament_recorded_format(p_tournament_id) IN ('mtt-v1','mtt-v2');
END $function$;
ALTER FUNCTION public.fn_ca_tournament_is_unlimited(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_is_unlimited(uuid) TO authenticated,service_role;

-- A consistent, read-only eligibility projection for one existing discovery
-- pass. A snapshot is not an admission receipt: the financial/launch transaction
-- must still acquire the shared ABI lock and revalidate its owning decision.
CREATE FUNCTION public.fn_ca_tournament_admission_snapshot(p_tournament_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
DECLARE v_abi text; v_entries jsonb; v_count integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  RAISE EXCEPTION 'service_role required' USING ERRCODE='42501';
 END IF;
 IF p_tournament_ids IS NULL OR cardinality(p_tournament_ids) NOT BETWEEN 1 AND 500
    OR array_position(p_tournament_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT x) FROM unnest(p_tournament_ids)x)<>cardinality(p_tournament_ids) THEN
  RAISE EXCEPTION 'MTT_ADMISSION_SNAPSHOT_INVALID_IDS' USING ERRCODE='22023';
 END IF;
 SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton;
 IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
  RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
 END IF;
 SELECT count(*) INTO v_count FROM public.tournaments WHERE id=ANY(p_tournament_ids);
 IF v_count<>cardinality(p_tournament_ids) THEN
  RAISE EXCEPTION 'MTT_ADMISSION_SNAPSHOT_PARENT_MISSING' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=ANY(p_tournament_ids)
   AND (t.format_contract IS NULL OR t.format_contract NOT IN
     ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1'))) THEN
  RAISE EXCEPTION 'TOURNAMENT_FORMAT_NOT_PROVEN' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=ANY(p_tournament_ids)
   AND NOT(v_abi='unlimited-mtt-v2' AND t.format_contract IN ('mtt-v1','mtt-v2'))
   AND coalesce(t.max_players,0)<=0) THEN
  RAISE EXCEPTION 'MTT_ADMISSION_SNAPSHOT_CAPACITY_NOT_PROVEN' USING ERRCODE='55000';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('tournament_id',t.id,
   'format_contract',t.format_contract,'effective_max_players',
   CASE WHEN v_abi='unlimited-mtt-v2' AND t.format_contract IN ('mtt-v1','mtt-v2')
     THEN NULL ELSE t.max_players END) ORDER BY t.id) INTO v_entries
 FROM public.tournaments t WHERE t.id=ANY(p_tournament_ids);
 RETURN jsonb_build_object('ok',true,'admission_abi',v_abi,'entries',v_entries);
END $function$;
ALTER FUNCTION public.fn_ca_tournament_admission_snapshot(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_admission_snapshot(uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_admission_snapshot(uuid[]) TO service_role;

DO $dual_cap$
DECLARE targets jsonb:=$targets$[
  {
    "signature": "public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)",
    "pre_source_md5": "b7d371b05e543f1fa9ac3131288bca13",
    "pre_definition_md5": "24fc93502f66beb34c31e1a16c87a147",
    "post_source_md5": "6a8c7009cdce61869fefdaa8500b0810",
    "post_definition_md5": "2d8c9bd676a8ee02e009dd470fbfd585",
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
        "old": "PERFORM pg_advisory_xact_lock_shared(530090,1);",
        "new": "PERFORM pg_advisory_xact_lock_shared(530090,1);\n  PERFORM public.fn_ca_lock_mtt_admission_contract();"
      }
    ]
  },
  {
    "signature": "public.fn_tournament_late_registration_open(uuid)",
    "pre_source_md5": "ba1c6218246bddd37dc68f746df9e5ef",
    "pre_definition_md5": "46eac016bb51c2d2fc50423343ccc5c1",
    "post_source_md5": "920def27870ad5babe69dac7622025f7",
    "post_definition_md5": "0a189819d8064f393f5de5b12a2c51f4",
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
        "old": "t.max_players IS NULL OR t.max_players<=0 OR (",
        "new": "public.fn_ca_tournament_is_unlimited(t.id)\n         OR t.max_players IS NULL OR t.max_players<=0 OR ("
      }
    ]
  },
  {
    "signature": "public.fn_tournament_entry_cap_reached(uuid)",
    "pre_source_md5": "b3fe14943dd45edcca84f9396034b28c",
    "pre_definition_md5": "2234cadcda760b309c8542c0e6f26c41",
    "post_source_md5": "9a87c1a075b6091ee646dda3287c81a5",
    "post_definition_md5": "9a34a1460abf1c71f24d88bce182e488",
    "owner": "postgres",
    "acl": [
      {
        "grantee": "authenticated",
        "grantor": "postgres",
        "is_grantable": false,
        "privilege_type": "EXECUTE"
      },
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
        "old": "BEGIN\n  SELECT t.max_players, COALESCE(t.current_players, 0)\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n  SELECT t.max_players, COALESCE(t.current_players, 0)\n"
      },
      {
        "old": "IF NOT FOUND OR v_cap IS NULL OR v_cap <= 0 THEN",
        "new": "IF NOT FOUND OR public.fn_ca_tournament_is_unlimited(p_tournament_id)\n     OR v_cap IS NULL OR v_cap <= 0 THEN"
      },
      {
        "old": " STABLE SECURITY DEFINER",
        "new": " VOLATILE SECURITY DEFINER"
      }
    ]
  },
  {
    "signature": "public.fn_enforce_tournament_capacity()",
    "pre_source_md5": "002d409f182d90f7e802ca2723d8ec18",
    "pre_definition_md5": "7a1032ac1990c6cd01396364148218ce",
    "post_source_md5": "c45268348374ff7d0a3e6a18bb04be0b",
    "post_definition_md5": "c89a358115c8cd06ff93cfffc2aab84f",
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
        "old": "BEGIN\n  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_tournament_is_unlimited(NEW.tournament_id);\n  /* UNDER THE ROW LOCK (2026-09-06). This read the tournament without one, so\n"
      },
      {
        "old": "IF v_max IS NULL OR v_max <= 0 THEN",
        "new": "IF public.fn_ca_tournament_is_unlimited(NEW.tournament_id)\n     OR v_max IS NULL OR v_max <= 0 THEN"
      }
    ]
  },
  {
    "signature": "public.fn_tournament_atomic_register(uuid,uuid,uuid,numeric)",
    "pre_source_md5": "93009ae524c12102c965f46ef4381e43",
    "pre_definition_md5": "47f63fad88cd0c9a06b359fb9d5c36ca",
    "post_source_md5": "07729b959d6105b0e5b769b1d28c8504",
    "post_definition_md5": "c92af85df41906063958185a4250a130",
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
        "old": "BEGIN\n  SELECT * INTO v_tourn FROM tournaments WHERE id = p_tournament_id FOR UPDATE;\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n  SELECT * INTO v_tourn FROM tournaments WHERE id = p_tournament_id FOR UPDATE;\n"
      },
      {
        "old": "IF v_tourn.max_players IS NOT NULL AND COALESCE(v_tourn.current_players, 0) >= v_tourn.max_players THEN",
        "new": "IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)\n     AND v_tourn.max_players IS NOT NULL AND COALESCE(v_tourn.current_players, 0) >= v_tourn.max_players THEN"
      }
    ]
  },
  {
    "signature": "public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)",
    "pre_source_md5": "2c21c56c6a9d4a2f8ee79082bd4fef57",
    "pre_definition_md5": "208fe48a2697811d14e55a64271083a6",
    "post_source_md5": "ae1f189c2349688a043c2144c44433cd",
    "post_definition_md5": "92ab8b6d14cecd75bb945bbe2e6bc12b",
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
        "old": "BEGIN\n  PERFORM public.fn_ca_lock_settlement_lane_global();\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n  PERFORM public.fn_ca_lock_settlement_lane_global();\n"
      },
      {
        "old": "IF v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN",
        "new": "IF NOT public.fn_ca_tournament_is_unlimited(p_target_id)\n     AND v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN"
      }
    ]
  },
  {
    "signature": "public.fn_deliver_satellite_ticket_exact(uuid,uuid,uuid,text,integer,numeric)",
    "pre_source_md5": "216b09a2aaf0c60559538ad7caecfbae",
    "pre_definition_md5": "d6e958c08e34f8643eee3b33a6f9fe77",
    "post_source_md5": "88a8094c736732cb1aa13496ed09feb8",
    "post_definition_md5": "503a9f90806bf5498ebd0b006dcc0641",
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
        "old": "BEGIN\n  PERFORM public.fn_ca_lock_settlement_lane_global();\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n  PERFORM public.fn_ca_lock_settlement_lane_global();\n"
      },
      {
        "old": "v_open:=v_open AND (v_target.max_players IS NULL OR v_count<v_target.max_players);",
        "new": "v_open:=v_open AND (public.fn_ca_tournament_is_unlimited(p_target_id)\n     OR v_target.max_players IS NULL OR v_count<v_target.max_players);"
      }
    ]
  },
  {
    "signature": "public.fn_register_for_tournament_before_atomic_capacity_20260907(uuid,boolean)",
    "pre_source_md5": "fa10ae12b0b1882c497377ec1f3d36b9",
    "pre_definition_md5": "2f1b8cafdab8cb2249bdcdd0d12e36c2",
    "post_source_md5": "36ac4d1c17471a3ebf498c7e1d7143fe",
    "post_definition_md5": "f757226e48412a8c37b0c4770549c2e3",
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
        "old": "BEGIN\n  IF v_uid IS NULL THEN\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n  IF v_uid IS NULL THEN\n"
      },
      {
        "old": "IF NOT p_seat_first_internal\n     AND (lower",
        "new": "IF NOT p_seat_first_internal\n     AND NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)\n     AND (lower"
      },
      {
        "old": "IF v_t.max_players IS NOT NULL AND v_t.max_players > 0\n     AND v_players_before >= v_t.max_players THEN",
        "new": "IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)\n     AND v_t.max_players IS NOT NULL AND v_t.max_players > 0\n     AND v_players_before >= v_t.max_players THEN"
      }
    ]
  },
  {
    "signature": "public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)",
    "pre_source_md5": "b274c4f4e192e0b404397db939476284",
    "pre_definition_md5": "717b50ce09eec5915c401be795ae681b",
    "post_source_md5": "ea6778497dec396465c32b59900e4450",
    "post_definition_md5": "8a9b893eeb07cbcf518782391e757c2c",
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
        "old": "PERFORM pg_advisory_xact_lock_shared(530090,1);",
        "new": "PERFORM pg_advisory_xact_lock_shared(530090,1);\n  PERFORM public.fn_ca_lock_mtt_admission_contract();"
      },
      {
        "old": "IF lower(COALESCE(v_t.variant,''))='spin'\n     OR (v_t.max_players IS NOT NULL\n       AND v_t.max_players>0 AND v_t.max_players<=2) THEN",
        "new": "IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)\n     AND (lower(COALESCE(v_t.variant,''))='spin'\n       OR (v_t.max_players IS NOT NULL\n         AND v_t.max_players>0 AND v_t.max_players<=2)) THEN"
      }
    ]
  },
  {
    "signature": "public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)",
    "pre_source_md5": "33c365379bf739ed6d84a4e8cc09465e",
    "pre_definition_md5": "9825f5f2e7df23fee41360437fd3dce0",
    "post_source_md5": "abfd5c17068aa10a21bc891039c8a191",
    "post_definition_md5": "35808158e9c73902be5a55293624d003",
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
        "old": "BEGIN\n  -- Every terminal money authority takes this transaction lock before any\n",
        "new": "BEGIN\n  PERFORM public.fn_ca_lock_mtt_admission_contract();\n  -- Every terminal money authority takes this transaction lock before any\n"
      },
      {
        "old": "IF COALESCE(v_target.max_players, 0) < 0",
        "new": "IF (NOT public.fn_ca_tournament_is_unlimited(v_target_id)\n      AND COALESCE(v_target.max_players, 0) < 0)"
      },
      {
        "old": "IF v_target.max_players IS NOT NULL AND v_target.max_players > 0\n     AND v_target_count >= v_target.max_players THEN",
        "new": "IF NOT public.fn_ca_tournament_is_unlimited(v_target_id)\n     AND v_target.max_players IS NOT NULL AND v_target.max_players > 0\n     AND v_target_count >= v_target.max_players THEN"
      },
      {
        "old": "WHEN v_target.max_players IS NULL OR v_target.max_players = 0",
        "new": "WHEN public.fn_ca_tournament_is_unlimited(v_target_id)\n        OR v_target.max_players IS NULL OR v_target.max_players = 0"
      }
    ]
  }
]$targets$::jsonb;
 item jsonb; edit jsonb; phase text; fn oid; definition text; actual_acl jsonb;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'MTT_DUAL_CAP_OWNER_REQUIRED'; END IF;
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
      AND md5(p.prosrc)=item->>(phase||'_source_md5')
      AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
      AND p.proowner='postgres'::regrole) THEN
    RAISE EXCEPTION 'MTT_DUAL_CAP_%_AUTHORITY_DRIFT: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type) INTO actual_acl
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'MTT_DUAL_CAP_%_ACL_DRIFT: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))/length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'MTT_DUAL_CAP_SPLICE_DRIFT: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $dual_cap$;
COMMIT;
