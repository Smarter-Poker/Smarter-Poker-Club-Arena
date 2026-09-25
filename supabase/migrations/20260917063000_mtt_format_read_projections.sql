-- Expose canonical recorded tournament format without inventing historical markers.
-- The dashboard also recognizes the uppercase status values actually persisted
-- by the engine; its lower-case-only predicate previously returned zero live events.
-- No cap, fee, structure, membership, privacy or pagination rule changes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $column$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_attribute
 WHERE attrelid='public.tournaments'::regclass AND attname='format_contract'
 AND atttypid='text'::regtype AND NOT attisdropped) THEN
 RAISE EXCEPTION 'MTT_FORMAT_PROJECTION_REQUIRES_FORMAT_COLUMN';END IF;END $column$;
DO $format_projection$
DECLARE targets jsonb:=$targets$[
  {
    "signature": "public.fn_community_search(text,text,integer)",
    "pre_source_md5": "1c28e2d0bd58880ccadc90fb1f3dda5a",
    "pre_definition_md5": "7354f0e9a4912d3acfca1248fceb484f",
    "post_source_md5": "722e68de2b50fbc1154054ec1f531d36",
    "post_definition_md5": "43733303ec00de630c740bae68257a58",
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
        "old": "t.current_players, t.max_players, t.start_time, t.club_id, t.union_id,",
        "new": "t.current_players, t.max_players, t.format_contract, t.start_time, t.club_id, t.union_id,"
      },
      {
        "old": "'tournament_type', r.tournament_type,",
        "new": "'tournament_type', r.tournament_type,\n              'format_contract', r.format_contract,"
      }
    ]
  },
  {
    "signature": "public.fn_list_managed_games(text,uuid,timestamp with time zone,text,uuid,integer,integer,integer,text,uuid,integer)",
    "pre_source_md5": "d7ef96526d76c5b26cf89653d0fe9771",
    "pre_definition_md5": "37de6b536ecc0a0870884b1924147afd",
    "post_source_md5": "dcba66507bdf67df15905984bc080eab",
    "post_definition_md5": "aab6ac28551b11fdb6b74d7fcd430580",
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
        "old": "GREATEST(t.created_at, COALESCE(t.updated_at, t.created_at)) AS touched_at\n    FROM public.tables t WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)\n      AND (NOT v_one",
        "new": "GREATEST(t.created_at, COALESCE(t.updated_at, t.created_at)) AS touched_at,\n      NULL::text AS format_contract\n    FROM public.tables t WHERE t.tournament_id IS NULL AND NOT COALESCE(t.is_deleted,false)\n      AND (NOT v_one"
      },
      {
        "old": "GREATEST(COALESCE(t.start_time, t.created_at), COALESCE(t.updated_at, t.created_at))\n    FROM public.tournaments t WHERE\n      (NOT v_one",
        "new": "GREATEST(COALESCE(t.start_time, t.created_at), COALESCE(t.updated_at, t.created_at)),\n      t.format_contract\n    FROM public.tournaments t WHERE\n      (NOT v_one"
      }
    ]
  },
  {
    "signature": "public.get_club_home(text)",
    "pre_source_md5": "b40b6cc79c482925ab7a9b46c0bdf3be",
    "pre_definition_md5": "bedbd16935c74ba4e8be39d7a9c093b0",
    "post_source_md5": "fd183391fb114598aaf57896726168c3",
    "post_definition_md5": "a81d488c364fd20d7015a7bae2b774e4",
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
        "old": "guaranteed_prize, start_time, status, current_players, max_players,\n           starting_chips",
        "new": "guaranteed_prize, start_time, status, current_players, max_players, format_contract,\n           starting_chips"
      }
    ]
  },
  {
    "signature": "public.ca_club_tournaments(uuid,integer,integer)",
    "pre_source_md5": "5eada3db23363039e83ebbfe361a009e",
    "pre_definition_md5": "eeeb0c51e9459996dd5a9187d47bcc10",
    "post_source_md5": "ae4be6ca62947acddf468a8b64c57cd6",
    "post_definition_md5": "4637d9ee6db98fddcd88597ed3b31411",
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
        "old": "t.max_players, t.start_time",
        "new": "t.max_players, t.start_time, t.format_contract"
      },
      {
        "old": "           t.ended_at\n    FROM scoped t",
        "new": "           t.ended_at, t.format_contract\n    FROM scoped t"
      },
      {
        "old": "WHERE t.status IN ('running', 'registering', 'late_reg', 'starting', 'scheduled')",
        "new": "WHERE lower(t.status) IN ('running', 'registering', 'late_reg', 'starting', 'scheduled')"
      },
      {
        "old": "WHERE t.status IN ('running','registering','late_reg','starting','scheduled')",
        "new": "WHERE lower(t.status) IN ('running','registering','late_reg','starting','scheduled')"
      }
    ]
  }
]$targets$::jsonb;
 item jsonb; edit jsonb; phase text; fn oid; definition text; actual_acl jsonb;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'MTT_FORMAT_PROJECTION_OWNER_REQUIRED'; END IF;
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
      AND md5(p.prosrc)=item->>(phase||'_source_md5')
      AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
      AND p.proowner='postgres'::regrole) THEN
    RAISE EXCEPTION 'MTT_FORMAT_PROJECTION_%_AUTHORITY_DRIFT: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type) INTO actual_acl
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'MTT_FORMAT_PROJECTION_%_ACL_DRIFT: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))/length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'MTT_FORMAT_PROJECTION_SPLICE_DRIFT: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $format_projection$;
COMMIT;
