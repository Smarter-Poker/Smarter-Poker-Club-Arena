-- R35: independent tables do not acquire a false PKO head dependency merely
-- because one dealt first and finished second. Exact disjoint participant/table
-- proof admits that case; unknown or shared dependencies retain all refusals.
-- R34 settled-marker replay must already be installed. No historical row repair.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $preflight$
DECLARE item jsonb; p record; helper oid;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)","before":"d10ceaad9c867902c7407f20151f28b7","after":"7891b176cdfdf8d8088c10b59240cfe3","acl":"{postgres=X/postgres}","patterns":[{"old":"IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN","new":"IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark\n       AND NOT public.fn_pko_hand_is_independent_of_later_settlements(\n         p_tournament_id,p_table_id,p_hand_number,p_eliminated_user_id,v_claimants) THEN"},{"old":"      /* The watermark keeps PKO bounties in payment order and cannot be\n         rewound without letting settled bounties re-settle, so a bust\n         behind it can never be paid in order. The player still busted and\n         the place is still theirs: record it, and leave the head in the\n         pool for fn_finalize_bounty_pool to resolve as residual. */","new":"      /* Independent tables are admitted by the exact proof above. Shared\n         players/tables or incomplete evidence retain the existing order\n         refusal. The place can still be recorded; historical unresolved\n         head disposition is a separate policy and is unchanged here. */"}]},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","before":"6dcaf498835e691b15384aa5aabcfdfe","after":"64474c90007dc5a91e253d02150dc94e","acl":"{postgres=X/postgres,service_role=X/postgres}","patterns":[{"old":"IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN","new":"IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark\n       AND NOT public.fn_pko_hand_is_independent_of_later_settlements(\n         o.tournament_id,o.table_id,o.hand_number,o.eliminated_user_id,o.claimants) THEN"}]}]$manifest$::jsonb) LOOP
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
   WHERE f.oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR md5(p.prosrc) NOT IN(item->>'before',item->>'after')
     OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'v' THEN
   RAISE EXCEPTION 'independent PKO tables refused: unreviewed source or metadata for %',item->>'signature';
  END IF;
 END LOOP;
 helper:=to_regprocedure('public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb)');
 IF helper IS NOT NULL THEN
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner WHERE f.oid=helper;
  IF md5(p.prosrc)<>'72c2a52fc8509125a7ed442d4ae8b2f0'
     OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' THEN
   RAISE EXCEPTION 'independent PKO tables refused: unreviewed independence predicate';
  END IF;
 END IF;
END $preflight$;
-- Private predicate: both callers already hold the tournament row lock
-- and have independently verified the accepted hand and head generation.
CREATE OR REPLACE FUNCTION public.fn_pko_hand_is_independent_of_later_settlements(
  p_tournament_id uuid,p_table_id uuid,p_hand_number bigint,
  p_eliminated_user_id uuid,p_claimants jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public,pg_temp AS $function$
DECLARE
  participants uuid[]; watermark bigint; later record;
BEGIN
  IF p_tournament_id IS NULL OR p_table_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_hand_number IS NULL OR p_hand_number<1000000
     OR jsonb_typeof(p_claimants) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_claimants)=0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_claimants) c
     WHERE coalesce(c->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR c->>'weight' IS DISTINCT FROM '1'
  ) THEN RETURN false; END IF;
  SELECT ARRAY[p_eliminated_user_id]||array_agg((c->>'user_id')::uuid)
    INTO participants FROM jsonb_array_elements(p_claimants) c;
  IF cardinality(participants)<>(SELECT count(DISTINCT u) FROM unnest(participants) u)
     OR EXISTS (
       SELECT 1 FROM unnest(participants[2:cardinality(participants)]) u
        WHERE NOT EXISTS (SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id=p_tournament_id AND tp.user_id=u AND tp.status='playing')
     ) THEN RETURN false; END IF;

  -- A missing, stale or corrupt watermark cannot authorize admission.
  SELECT w.last_settled_hand_number INTO watermark
    FROM public.tournament_pko_settlement_watermarks w
    JOIN public.tournament_bounty_obligations o
      ON o.id=w.last_obligation_id AND o.tournament_id=w.tournament_id
     AND o.hand_number=w.last_settled_hand_number AND o.mode='pko' AND o.state='settled'
   WHERE w.tournament_id=p_tournament_id;
  IF watermark IS NULL OR watermark<=p_hand_number OR EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id AND o.mode='pko'
       AND o.state='settled' AND o.hand_number>watermark
  ) THEN RETURN false; END IF;

  -- Validate each later identity before the marker function casts claimant UUIDs.
  -- Disjoint head mutations commute. Any shared table or person, including a
  -- pending later head snapshot, keeps the existing order refusal intact.
  FOR later IN
    SELECT o.table_id,o.eliminated_user_id,o.claimants,o.state,o.id
      FROM public.tournament_bounty_obligations o
     WHERE o.tournament_id=p_tournament_id AND o.mode='pko'
       AND o.hand_number>p_hand_number
  LOOP
    IF later.table_id IS NULL OR later.table_id=p_table_id
       OR later.eliminated_user_id IS NULL OR later.eliminated_user_id=ANY(participants)
       OR jsonb_typeof(later.claimants) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(later.claimants)=0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(later.claimants) c
       WHERE coalesce(c->>'user_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR c->>'weight' IS DISTINCT FROM '1'
    ) THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(later.claimants) c
      WHERE (c->>'user_id')::uuid=ANY(participants)
         OR (c->>'user_id')::uuid=later.eliminated_user_id)
       OR jsonb_array_length(later.claimants)<>(SELECT count(DISTINCT (c->>'user_id')::uuid)
          FROM jsonb_array_elements(later.claimants) c)
       OR later.state NOT IN ('pending','settled')
       OR (later.state='settled' AND NOT public.fn_bounty_obligation_has_complete_marker(later.id))
    THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$function$;
ALTER FUNCTION public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $install$
DECLARE item jsonb; pattern jsonb; target oid; source_text text; definition text; p record;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)","before":"d10ceaad9c867902c7407f20151f28b7","after":"7891b176cdfdf8d8088c10b59240cfe3","acl":"{postgres=X/postgres}","patterns":[{"old":"IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN","new":"IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark\n       AND NOT public.fn_pko_hand_is_independent_of_later_settlements(\n         p_tournament_id,p_table_id,p_hand_number,p_eliminated_user_id,v_claimants) THEN"},{"old":"      /* The watermark keeps PKO bounties in payment order and cannot be\n         rewound without letting settled bounties re-settle, so a bust\n         behind it can never be paid in order. The player still busted and\n         the place is still theirs: record it, and leave the head in the\n         pool for fn_finalize_bounty_pool to resolve as residual. */","new":"      /* Independent tables are admitted by the exact proof above. Shared\n         players/tables or incomplete evidence retain the existing order\n         refusal. The place can still be recorded; historical unresolved\n         head disposition is a separate policy and is unchanged here. */"}]},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","before":"6dcaf498835e691b15384aa5aabcfdfe","after":"64474c90007dc5a91e253d02150dc94e","acl":"{postgres=X/postgres,service_role=X/postgres}","patterns":[{"old":"IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN","new":"IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark\n       AND NOT public.fn_pko_hand_is_independent_of_later_settlements(\n         o.tournament_id,o.table_id,o.hand_number,o.eliminated_user_id,o.claimants) THEN"}]}]$manifest$::jsonb) LOOP
  target:=to_regprocedure(item->>'signature');
  SELECT prosrc,pg_get_functiondef(target) INTO source_text,definition FROM pg_proc WHERE oid=target;
  IF md5(source_text)=item->>'before' THEN
   FOR pattern IN SELECT value FROM jsonb_array_elements(item->'patterns') LOOP
    IF (length(definition)-length(replace(definition,pattern->>'old','')))/length(pattern->>'old')<>1 THEN
     RAISE EXCEPTION 'independent PKO tables refused: replacement anchor mismatch';
    END IF;
    definition:=replace(definition,pattern->>'old',pattern->>'new');
   END LOOP;
   EXECUTE definition;
  END IF;
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner WHERE f.oid=target;
  IF md5(p.prosrc)<>item->>'after' OR p.owner<>'postgres'
     OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'v' THEN
   RAISE EXCEPTION 'independent PKO tables postimage or privileges mismatch for %',item->>'signature';
  END IF;
 END LOOP;
 SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
  WHERE f.oid='public.fn_pko_hand_is_independent_of_later_settlements(uuid,uuid,bigint,uuid,jsonb)'::regprocedure;
 IF md5(p.prosrc)<>'72c2a52fc8509125a7ed442d4ae8b2f0'
    OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' THEN
  RAISE EXCEPTION 'independence predicate postimage or metadata mismatch';
 END IF;
END $install$;
COMMIT;
