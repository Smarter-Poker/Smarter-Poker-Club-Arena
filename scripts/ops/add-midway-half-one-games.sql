-- Explicit owner-authorized catalog operation. Run once after installing
-- 20261020204148. Reuse durable identities before retrying an unknown outcome.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $$
DECLARE v text; t text; game_id uuid; g public.cash_games%ROWTYPE; n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('midway-half-one-20261020'));
  IF public.fn_cash_game_category_key('fade0000-0000-0000-0000-000000000001','nlh',.5,1) <> 'half_one' THEN
    RAISE EXCEPTION 'required_category_migration_not_installed';
  END IF;
  FOREACH v IN ARRAY ARRAY['nlh','plo4','plo5','plo6','plo8'] LOOP
    FOREACH t IN ARRAY ARRAY['classic','action','madness'] LOOP
      game_id := public.fn_cash_game_ensure('fade0000-0000-0000-0000-000000000001',v,.5,1,t,NULL);
      SELECT * INTO STRICT g FROM public.cash_games WHERE id=game_id;
      IF NOT g.enabled OR g.union_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
        OR g.club_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
        OR g.variant<>v OR g.template_name<>t OR g.sb<>.5 OR g.bb<>1
        OR coalesce((g.ruleset_snapshot->'options'->>'is_private')::boolean,false)
        OR coalesce((g.ruleset_snapshot->'options'->>'is_vip_only')::boolean,false) THEN
        RAISE EXCEPTION 'catalog_contract_mismatch: %',game_id;
      END IF;
      SELECT count(*) INTO n FROM public.tables tb WHERE tb.cluster_id=game_id
        AND tb.lifecycle<>'closed' AND tb.status<>'closed' AND NOT coalesce(tb.is_deleted,false)
        AND tb.union_id=g.union_id AND tb.small_blind=.5 AND tb.big_blind=1;
      IF n<1 THEN RAISE EXCEPTION 'game_has_no_open_union_table: %',game_id;END IF;
      RAISE NOTICE '% %: %',v,t,game_id;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
