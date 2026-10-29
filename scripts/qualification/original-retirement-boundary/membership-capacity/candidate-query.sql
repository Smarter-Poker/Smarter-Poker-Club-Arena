 WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
  FROM public.fn_union_pnl_touched_registrations(p_start,p_end,v_inv) w
 ), distinct_tournaments AS MATERIALIZED (
  SELECT DISTINCT tournament_id FROM touched
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM distinct_tournaments d
  WHERE (CASE WHEN v_inv THEN EXISTS(SELECT 1 FROM public.union_pnl_inventory_touches t WHERE t.source_name='tournaments'
   AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
   AND t.row_id::text=d.tournament_id
   AND t.union_id=p_union_id::text) ELSE EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
  AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
  AND t.row_id::text=d.tournament_id
  AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text) END)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration (column for
  -- column: a whole-row argument would detoast every receipt's snapshots)
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ), unresolved_registrations AS MATERIALIZED (
  SELECT DISTINCT i.row_id FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
  WHERE NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
 ), satellite_owners AS MATERIALIZED (
  SELECT i.row_id,public.fn_union_pnl_satellite_seat_owner(i.row_id,NULL) owner
  FROM unresolved_registrations i
 ) SELECT to_jsonb(count(*)) FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 LEFT JOIN satellite_owners o ON o.row_id=i.row_id
 WHERE (NOT COALESCE(e.has_entry,false) AND i.row_id<>ALL(v_open_resolved)
   AND o.owner IS NULL)
  OR COALESCE(e.has_other,false);