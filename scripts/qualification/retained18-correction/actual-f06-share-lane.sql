CREATE OR REPLACE FUNCTION public.fn_ca_f06_share_table_lane(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
  /* THE SHARED TABLE LANE OF A TOURNAMENT (2026-10-03). For per-table F06
     hand calls only: what f06_prefix does for one table and no users, with
     the tournament lane T(id) taken SHARED instead of exclusive and no lock
     on the tournament row (its status is written only under T(id) or G
     exclusive). Same order as f06_prefix and as
     fn_ca_share_settlement_lane_for_table: lease fence, G shared, T(id)
     shared, lease re-check, table row, seats. */
  IF p_table_id IS NULL THEN
    RAISE EXCEPTION 'F06_TABLE_LANE_NEEDS_A_TABLE' USING ERRCODE = '22023';
  END IF;
  PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation);
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation, false);
  PERFORM 1 FROM public.tables WHERE id = p_table_id FOR UPDATE;
  PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.table_id = p_table_id
   ORDER BY s.id FOR UPDATE OF s;
END
$function$
;

