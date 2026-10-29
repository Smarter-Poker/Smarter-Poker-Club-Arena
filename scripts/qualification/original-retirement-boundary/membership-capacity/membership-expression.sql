(CASE WHEN v_inv THEN EXISTS(SELECT 1 FROM public.union_pnl_inventory_touches t WHERE t.source_name='tournaments'
   AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
   AND t.row_id::text=d.tournament_id
   AND t.union_id=p_union_id::text) ELSE EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
  AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
  AND t.row_id::text=d.tournament_id
  AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text) END)
