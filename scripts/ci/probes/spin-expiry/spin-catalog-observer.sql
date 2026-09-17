-- Read-only selected catalog observer derived exactly from existing qualifier.
-- Scope: public schema ACL, five functions, two empty baseline stores, five trigger relations.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SET LOCAL search_path=public,pg_temp;
SET LOCAL timezone='UTC';
  SELECT jsonb_build_object(
    'public_schema_acl',(SELECT n.nspacl::text FROM pg_namespace n WHERE n.nspname='public'),
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p
      WHERE p.oid IN (
        to_regprocedure('public.fn_spin_expire_unfilled(integer)'),
        to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)'),
        to_regprocedure('public.fn_ca_lock_settlement_lane_global()'),
        to_regprocedure('public.fn_sync_seat_first_player_count(uuid)'),
        to_regprocedure('public.fn_ca_guard_watchlist()'))),
    'baseline',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.proname) FROM public.ca_guard_defs d),
    'baseline_history',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.proname,d.def_hash)
      FROM public.ca_guard_def_history d),
    'bindings',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgrelid IN (
        'public.tournaments'::regclass,'public.tournament_players'::regclass,
        'public.table_seats'::regclass,'public.spin_draw_receipts'::regclass,
        'public.tournament_cancellation_receipts'::regclass)));
ROLLBACK;
