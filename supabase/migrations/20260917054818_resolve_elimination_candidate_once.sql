-- Resolve each exact knockout candidate once, then use its primary key.
-- Installed VOLATILE resolver predicates caused whole-estate sequential scans
-- and repeated accepted-hand receipt reads while holding event/player locks.
-- Do not relabel the resolver STABLE: retain its existing snapshot semantics.
-- This changes lookup execution only; public refusal/replay paths, locks,
-- receipts, causal checks, financial operations and explicit ACLs are preserved.
-- The owner-only core now eagerly resolves even an unprovable candidate; the
-- public door already proves and locks that candidate before entering the core.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $candidate_lookup$
DECLARE
 targets jsonb := $lookup_targets$[
  {
    "signature": "public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)",
    "pre_source_md5": "48ea5c39b7b4ed9925c4d43505f6c33a",
    "pre_definition_md5": "5ad0378441a9152a23c7884035dbfa2b",
    "post_source_md5": "e9615b08f4d5b46857fc7ac5d902b2d2",
    "post_definition_md5": "9eb078e5860e9bdd8c0afcdbffc02504",
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
        "old": "  v_candidate public.tournament_knockout_candidates%ROWTYPE;",
        "new": "  v_candidate public.tournament_knockout_candidates%ROWTYPE;\n  v_resolved_candidate_id uuid;"
      },
      {
        "old": "  SELECT c.* INTO v_candidate",
        "new": "  v_resolved_candidate_id:=public.fn_ca_latest_committed_knockout_candidate(\n    p_tournament_id,p_eliminated_user_id);\n  SELECT c.* INTO v_candidate"
      },
      {
        "old": "   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(\n     p_tournament_id,p_eliminated_user_id);",
        "new": "   WHERE c.id=v_resolved_candidate_id;"
      }
    ]
  },
  {
    "signature": "public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)",
    "pre_source_md5": "97abb184dc27e3c7a333a6160636f473",
    "pre_definition_md5": "7e09f2f870e542e8f509236b15f21107",
    "post_source_md5": "062e046be56367f1f65a5ecc280e17e6",
    "post_definition_md5": "be0bc3420eca1e0c6e579c35b31fed43",
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
        "old": "  v_bust_captured_at timestamptz;",
        "new": "  v_bust_captured_at timestamptz;\n  v_resolved_candidate_id uuid;"
      },
      {
        "old": "  SELECT a.committed_at",
        "new": "  v_resolved_candidate_id:=public.fn_ca_latest_committed_knockout_candidate(\n    p_tournament_id,p_user_id);\n  SELECT a.committed_at"
      },
      {
        "old": "   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(\n           p_tournament_id,p_user_id)",
        "new": "   WHERE c.id=v_resolved_candidate_id"
      }
    ]
  },
  {
    "signature": "public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)",
    "pre_source_md5": "5fa082e7fe25c3cd08dfb301e18a8294",
    "pre_definition_md5": "3f351808d8536c1a581e73ed51784039",
    "post_source_md5": "59028dfca77ee07b3b014679e3d351f3",
    "post_definition_md5": "2c34f4cb405753e1180aa59bfb8b1f35",
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
        "old": "  v_candidate public.tournament_knockout_candidates%ROWTYPE;",
        "new": "  v_candidate public.tournament_knockout_candidates%ROWTYPE;\n  v_resolved_candidate_id uuid;"
      },
      {
        "old": "  SELECT c.* INTO v_candidate",
        "new": "  v_resolved_candidate_id:=public.fn_ca_latest_committed_knockout_candidate(\n    p_tournament_id,p_user_id);\n  SELECT c.* INTO v_candidate"
      },
      {
        "old": "   WHERE c.id=public.fn_ca_latest_committed_knockout_candidate(\n     p_tournament_id,p_user_id);",
        "new": "   WHERE c.id=v_resolved_candidate_id;"
      }
    ]
  }
]$lookup_targets$::jsonb;
 item jsonb; edit jsonb; fn oid; definition text; actual_acl jsonb; phase text;
BEGIN
 IF current_user <> 'postgres' THEN
  RAISE EXCEPTION 'candidate lookup repair requires the reviewed postgres owner';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)')
      AND md5(p.prosrc)='0602827901be20bbb6e0dce6ece17f94'
      AND md5(pg_get_functiondef(p.oid))='8e5cfccfbe100dce021dd17603832e40'
      AND p.proowner='postgres'::regrole AND p.prosecdef
      AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN
  RAISE EXCEPTION 'candidate lookup resolver authority drift';
 END IF;
 SELECT jsonb_agg(jsonb_build_object(
   'grantor',pg_get_userbyid(x.grantor),
   'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
   'privilege_type',x.privilege_type,'is_grantable',x.is_grantable)
   ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
     x.privilege_type) INTO actual_acl
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
  WHERE p.oid=to_regprocedure('public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)');
 IF actual_acl IS DISTINCT FROM
   '[{"grantor":"postgres","grantee":"postgres","privilege_type":"EXECUTE","is_grantable":false}]'::jsonb THEN
  RAISE EXCEPTION 'candidate lookup resolver ACL drift';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_index i
   WHERE i.indrelid='public.tournament_knockout_candidates'::regclass
     AND i.indisprimary AND i.indisvalid AND i.indisready
     AND pg_get_indexdef(i.indexrelid)=
       'CREATE UNIQUE INDEX tournament_knockout_candidates_pkey ON public.tournament_knockout_candidates USING btree (id)') THEN
  RAISE EXCEPTION 'candidate lookup primary-key authority drift';
 END IF;
 -- Validate every preimage before changing any function; then re-check the
 -- exact resulting definitions and permissions in this same transaction.
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
     AND md5(p.prosrc)=item->>(phase||'_source_md5')
     AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
     AND p.proowner='postgres'::regrole AND p.prosecdef
     AND p.provolatile='v' AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'candidate lookup % authority drift: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object(
     'grantor',pg_get_userbyid(x.grantor),
     'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
     'privilege_type',x.privilege_type,'is_grantable',x.is_grantable)
     ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
       x.privilege_type) INTO actual_acl
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
    WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'candidate lookup % ACL drift: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))
         /length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'candidate lookup splice mismatch: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $candidate_lookup$;
COMMIT;
