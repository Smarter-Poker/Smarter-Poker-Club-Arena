CREATE OR REPLACE FUNCTION smarter_private.f06_hand_cards_unresolved(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  -- The one unresolved test, shared with public.sp_prune_hand_state_snapshots:
  -- an exact (table_id, hand_number) whose F06 permit is still 'reserved'.
  -- 'accepted', 'never_started' and 'aborted_unsettled' are the other three
  -- states admitted by f06_hand_permits_state_check, and each is written
  -- together with the evidence_id of the receipt that resolved the hand, so a
  -- permit leaves 'reserved' exactly when its disposition has been decided.
  -- Reads permit state only; never card data.
  SELECT EXISTS (
    SELECT 1 FROM smarter_private.f06_hand_permits p
     WHERE p.table_id = p_table_id AND p.hand_number = p_hand_number
       AND p.state = 'reserved');
$function$
;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained(p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.tables tb
      LEFT JOIN public.tournaments t ON t.id = tb.tournament_id
     WHERE tb.id = p_table_id
       AND tb.tournament_id IS NOT NULL
       AND NOT COALESCE(tb.is_deleted, false)
       AND lower(COALESCE(tb.status, '')) <> 'closed'
       AND upper(COALESCE(t.status::text, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
       AND p_hand_number = (
         SELECT max(a.hand_number) FROM public.hand_atomic_commits a
          WHERE a.table_id = p_table_id)
  );
$function$
;
