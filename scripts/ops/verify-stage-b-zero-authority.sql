\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

SELECT
  b.phase,
  b.enforce_freeze,
  b.break_started_at,
  b.break_ends_at,
  floor(extract(epoch FROM (b.break_ends_at - clock_timestamp())))::bigint,
  b.declared_by,
  public.fn_platform_frozen(),
  (SELECT count(*) FROM public.engine_leader l
    WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'),
  (SELECT count(*) FROM public.engine_table_leases l
    WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'),
  (SELECT count(*) FROM public.engine_tournament_leases l
    WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'),
  (SELECT max(l.heartbeat_at) FROM public.engine_leader l),
  (SELECT max(l.heartbeat_at) FROM public.engine_table_leases l),
  (SELECT max(l.heartbeat_at) FROM public.engine_tournament_leases l)
FROM public.engine_maintenance_break b
WHERE b.id;
