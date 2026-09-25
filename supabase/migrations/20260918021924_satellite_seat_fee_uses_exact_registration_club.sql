-- Union satellite seats must book their funding at the exact admitted club,
-- as maintained tournament-ticket admission already does. Both terminal seat
-- producers used the target host instead, so the immutable entitlement and fee
-- capture disagreed with the registration selected by the admission trigger.
-- Change only the two producers. Keep every existing entitlement, commit,
-- cancellation, refund, escrow, fee and source-capacity guard unchanged.
-- Exact live predecessors captured read-only 2026-09-18 02:33:45 UTC. Native
-- qualification exercises genuine funded v2/v3 awards, deferred fee capture,
-- rollback, replay and target cancellation through the unchanged authorities.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $seat_producer$
DECLARE r record; d text; old_fragment text; new_fragment text; replacement record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('fn_ca_settle_satellite_cohort(uuid,uuid[])','628fc436567cf3b9d93bfe47468545e7','b99a9d24f3c0c3f931414f7dd25bb317','postgres','{postgres=X/postgres}','b63df892075c02b00e1bc52463dbe396','fe7945e734dcb1a8f68e078661bb9c28'),
  ('fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)','abfd5c17068aa10a21bc891039c8a191','35808158e9c73902be5a55293624d003','postgres','{postgres=X/postgres,service_role=X/postgres}','8b52e3e2b46dd1d7d4d51a0de74e4086','b59705a793ab0e57286321ceef5f9346')
 ) AS expected(signature,source_md5,definition_md5,owner,acl,next_source_md5,next_definition_md5) LOOP
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
   WHERE p.oid=('public.'||r.signature)::regprocedure
    AND md5(p.prosrc)=r.source_md5 AND md5(pg_get_functiondef(p.oid))=r.definition_md5
    AND pg_get_userbyid(p.proowner)=r.owner AND p.proacl::text=r.acl;
  IF d IS NULL THEN RAISE EXCEPTION 'satellite entry club producer predecessor differs: %',r.signature; END IF;
  FOR replacement IN SELECT * FROM (VALUES
   ('  v_registration_id uuid;','  v_registration_id uuid;
  v_admitted public.tournament_players%ROWTYPE;'),
   ('      RETURNING id INTO v_registration_id;','      RETURNING * INTO v_admitted;
      v_registration_id := v_admitted.id;
      -- The admission trigger selects the member club for a union entrant.
      -- It is the funding/refund identity used by ordinary ticket admission.
      IF v_admitted.club_id IS NULL
         OR v_admitted.tournament_id IS DISTINCT FROM v_target_id
         OR v_admitted.user_id IS DISTINCT FROM v_finisher.user_id
         OR v_admitted.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR v_admitted.is_satellite_qualifier IS DISTINCT FROM true THEN
        RAISE EXCEPTION ''satellite seat returned inconsistent registration identity''
          USING ERRCODE=''P0404'';
      END IF;'),
   ('v_ticket_cost, ''tournament_buyin'', v_target.club_id, p_tournament_id,','v_ticket_cost, ''tournament_buyin'', v_admitted.club_id, p_tournament_id,')
  ) AS fragments(old_fragment,new_fragment) LOOP
   old_fragment:=replacement.old_fragment; new_fragment:=replacement.new_fragment;
   IF (length(d)-length(replace(d,old_fragment,'')))/length(old_fragment)<>1 THEN
    RAISE EXCEPTION 'satellite entry club producer seam differs: %',r.signature;
   END IF;
   d:=replace(d,old_fragment,new_fragment);
  END LOOP;
  EXECUTE d;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=('public.'||r.signature)::regprocedure
   AND md5(p.prosrc)=r.next_source_md5 AND md5(pg_get_functiondef(p.oid))=r.next_definition_md5
   AND pg_get_userbyid(p.proowner)=r.owner AND p.proacl::text=r.acl) THEN
   RAISE EXCEPTION 'satellite entry club producer successor differs: %',r.signature;
  END IF;
 END LOOP;
END $seat_producer$;
COMMIT;
