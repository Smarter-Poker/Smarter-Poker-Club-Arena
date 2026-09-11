DO $qualification_placement_gate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.fn_tournament_live_seat_acquisition_requires_authority()','5a60bdd761aaaaad4b3bf982a3c50f6e','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp'],true),
      ('public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)','68c25bbb9c7b30e19e6351e48f3f85ae','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp','statement_timeout=30s'],true),
      ('public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)','16a587f7567336fe4379135f22e3fb41','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp','statement_timeout=30s'],true),
      ('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)','3acb4c1d763181905cf5b64287f8f28f','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp'],false),
      ('public.fn_ca_lock_settlement_lane_global()','343015440ea5c84ee4ca7ae583c73d30','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp'],false),
      ('public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)','b7d371b05e543f1fa9ac3131288bca13','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp'],true),
      ('public.fn_ca_tournament_seat_cap(uuid)','177e2e82ef01b126d16e7706f9d29e12','{postgres=X/postgres}',ARRAY['search_path=public, pg_temp'],true),
      ('public.fn_ensure_late_registration_capacity(uuid,integer)','b36dd36a9348d29be1092c7d42954c03','{postgres=X/postgres,service_role=X/postgres}',ARRAY['search_path=public, pg_temp'],true)
    ) expected(signature,body_md5,acl,settings,definer)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR md5(p.prosrc) IS DISTINCT FROM expected.body_md5
       OR p.proowner IS DISTINCT FROM 'postgres'::regrole
       OR p.proacl::text IS DISTINCT FROM expected.acl
       OR p.proconfig IS DISTINCT FROM expected.settings
       OR p.prosecdef IS DISTINCT FROM expected.definer
       OR p.provolatile IS DISTINCT FROM 'v'::"char"
       OR p.proisstrict IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION 'qualification placement requires the reviewed capacity, seat and current G/T lock authorities'
      USING ERRCODE='55000';
  END IF;
END;
$qualification_placement_gate$;

