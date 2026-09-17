-- Read-only projections for the existing horse-entry and tournament-health callers.
-- The private admission ABI stays legacy; this migration does not activate MTTs.
-- No timers, financial writes, field conversion, or physical-seat changes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $preparation$ BEGIN
 IF (SELECT abi FROM public.ca_mtt_admission_contract WHERE singleton)
      IS DISTINCT FROM 'legacy-capacity-v1' THEN
  RAISE EXCEPTION 'MTT_READ_CAPACITY_REQUIRES_LEGACY_PREPARATION';END IF;
 IF to_regprocedure('public.fn_ca_read_mtt_admission_contract()') IS NOT NULL THEN
  RAISE EXCEPTION 'MTT_READ_CAPACITY_HELPER_COLLISION';END IF;
END $preparation$;
-- Unlike an admission transaction, a projection must not acquire a row lock.
-- STABLE and MATERIALIZED callers use one statement snapshot and no mode cache.
CREATE FUNCTION public.fn_ca_read_mtt_admission_contract() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_abi text;
BEGIN
 SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton;
 IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
  RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
 END IF;
 RETURN v_abi;
END $function$;
ALTER FUNCTION public.fn_ca_read_mtt_admission_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_read_mtt_admission_contract() FROM PUBLIC,anon,authenticated,service_role;
DO $read_capacity$
DECLARE targets jsonb:=$targets$[
  {
    "signature": "public.fn_freeroll_fill_targets(uuid)",
    "pre_source_md5": "ed7ffb085c67cbe299dd754738ae279f",
    "pre_definition_md5": "a36ac7392bb71a1ad589d3a9cd8bac3b",
    "post_source_md5": "eda59f1638bef4ec8166afb5ef9ee3ac",
    "post_definition_md5": "4e4e4aa8fd25b41beac236ad5e74449b",
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
        "old": "  select t.id",
        "new": "  WITH admission AS MATERIALIZED (SELECT public.fn_ca_read_mtt_admission_contract() AS abi)\n  select t.id"
      },
      {
        "old": "         coalesce(t.max_players, 0),",
        "new": "         CASE WHEN a.abi='unlimited-mtt-v2' AND t.format_contract IN ('mtt-v1','mtt-v2') THEN NULL ELSE coalesce(t.max_players, 0) END,"
      },
      {
        "old": "  from tournaments t\n",
        "new": "  from tournaments t CROSS JOIN admission a\n"
      },
      {
        "old": "    and coalesce(t.max_players, 0) > coalesce(t.current_players, 0)",
        "new": "    and ((a.abi='unlimited-mtt-v2' AND t.format_contract IN ('mtt-v1','mtt-v2'))\n         OR coalesce(t.max_players, 0) > coalesce(t.current_players, 0))"
      }
    ]
  },
  {
    "signature": "public.fn_overlay_at_risk(uuid)",
    "pre_source_md5": "5ccfc992bb8c775dd528843a71b52fdc",
    "pre_definition_md5": "4d0721c8ee7f542ad3ed1cad65542c6d",
    "post_source_md5": "ff7ba48340ea8b9800b8f4685a447196",
    "post_definition_md5": "2c4f699472be892cd81073a26828c3e0",
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
        "old": "  select t.id",
        "new": "  WITH admission AS MATERIALIZED (SELECT public.fn_ca_read_mtt_admission_contract() AS abi)\n  select t.id"
      },
      {
        "old": "             coalesce(t.max_players, 0) - coalesce(t.current_players, 0)",
        "new": "             CASE WHEN a.abi='unlimited-mtt-v2' AND t.format_contract IN ('mtt-v1','mtt-v2') THEN NULL\n               ELSE coalesce(t.max_players, 0) - coalesce(t.current_players, 0) END"
      },
      {
        "old": "         coalesce(t.max_players, 0),",
        "new": "         CASE WHEN a.abi='unlimited-mtt-v2' AND t.format_contract IN ('mtt-v1','mtt-v2') THEN NULL ELSE coalesce(t.max_players, 0) END,"
      },
      {
        "old": "  from tournaments t\n",
        "new": "  from tournaments t CROSS JOIN admission a\n"
      }
    ]
  },
  {
    "signature": "public.fn_tournament_progress_metrics(integer,integer)",
    "pre_source_md5": "2f2aa9b7f1647d3840c78475ea9616b5",
    "pre_definition_md5": "48fbeb982336d4303a6eb503e999d064",
    "post_source_md5": "83c47ada3ad271e124de227146029736",
    "post_definition_md5": "41bd10a2a01fe9100ffa95c0ab090c39",
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
        "old": "    AND upper(COALESCE(t.tournament_type,'')) IN ('MTT','SATELLITE')\n    -- Heads-up satellites use the seat-first product, not the scheduled MTT.\n    AND COALESCE(t.max_players,0)>2",
        "new": "    -- Immutable recorded format includes old numeric and new NULL MTTs.\n    -- Historical seat-first satellites retain their own lifecycle.\n    AND t.format_contract IN ('mtt-v1','mtt-v2')"
      }
    ]
  }
]$targets$::jsonb;
 item jsonb; edit jsonb; phase text; fn oid; definition text; actual_acl jsonb;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'MTT_READ_CAPACITY_OWNER_REQUIRED'; END IF;
 FOREACH phase IN ARRAY ARRAY['pre','post'] LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
   fn:=to_regprocedure(item->>'signature');
   IF fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=fn
      AND md5(p.prosrc)=item->>(phase||'_source_md5')
      AND md5(pg_get_functiondef(p.oid))=item->>(phase||'_definition_md5')
      AND p.proowner='postgres'::regrole) THEN
    RAISE EXCEPTION 'MTT_READ_CAPACITY_%_AUTHORITY_DRIFT: %',phase,item->>'signature';
   END IF;
   SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege_type',a.privilege_type,'is_grantable',a.is_grantable)
      ORDER BY a.grantee::regrole::text,a.privilege_type) INTO actual_acl
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=fn;
   IF actual_acl IS DISTINCT FROM item->'acl' THEN
    RAISE EXCEPTION 'MTT_READ_CAPACITY_%_ACL_DRIFT: %',phase,item->>'signature';
   END IF;
  END LOOP;
  IF phase='pre' THEN
   FOR item IN SELECT value FROM jsonb_array_elements(targets) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item->>'signature')) INTO STRICT definition;
    FOR edit IN SELECT value FROM jsonb_array_elements(item->'edits') LOOP
     IF (length(definition)-length(replace(definition,edit->>'old','')))/length(edit->>'old')<>1 THEN
      RAISE EXCEPTION 'MTT_READ_CAPACITY_SPLICE_DRIFT: %',item->>'signature';
     END IF;
     definition:=replace(definition,edit->>'old',edit->>'new');
    END LOOP;
    EXECUTE definition;
   END LOOP;
  END IF;
 END LOOP;
END $read_capacity$;
COMMIT;
