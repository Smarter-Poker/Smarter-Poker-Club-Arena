-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4.2, SECOND CUT - A POOL THE METER HAS NEVER SEEN OPENS ITS OWN
-- BALANCE (chip standard, 2026-09-04 21:35 UTC). Found in the gate review:
-- fn_bbj_reconcile_all only ran for pools that already had a snapshot, so a
-- pool created after the epoch opened (the engine auto-creates one for a new
-- club or union) would have been skipped in silence, forever. Now a pool with
-- no snapshot is opened on first sight: its opening balance is RECONSTRUCTED
-- as the banks now minus every journalled leg since the later of its creation
-- and the epoch, so the identity holds from that moment and the first real
-- snapshot verifies everything since. The row says it was auto-opened.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_bbj_open_pool_baseline(p_pool_id uuid)
 RETURNS public.ca_bbj_pool_snapshots
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_epoch timestamptz; v_created timestamptz; v_at timestamptz;
  v_m numeric; v_b numeric; v_p numeric; jm numeric; jb numeric; jp numeric;
  v_row public.ca_bbj_pool_snapshots%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_open_pool_baseline is service only' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_bbj_pool_snapshots WHERE pool_id = p_pool_id) THEN
    SELECT * INTO v_row FROM public.ca_bbj_pool_snapshots WHERE pool_id = p_pool_id AND is_baseline ORDER BY taken_at LIMIT 1;
    RETURN v_row;
  END IF;
  SELECT min(taken_at) INTO v_epoch FROM public.ca_bbj_pool_snapshots WHERE is_baseline;
  SELECT created_at INTO v_created FROM public.bbj_pools WHERE id = p_pool_id;
  IF v_created IS NULL THEN
    RAISE EXCEPTION 'fn_bbj_open_pool_baseline: pool % not found', p_pool_id;
  END IF;
  v_at := GREATEST(v_created, COALESCE(v_epoch, v_created));

  -- One statement, one snapshot: the banks now and every labelled leg since v_at.
  WITH legs AS (
    SELECT CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.amount
                WHEN l.from_label LIKE 'bbj_pools.%' THEN -l.amount ELSE 0 END AS signed,
           CASE WHEN l.to_label LIKE 'bbj_pools.%' THEN l.to_label
                WHEN l.from_label LIKE 'bbj_pools.%' THEN l.from_label END AS lbl
      FROM public.chip_ledger l
     WHERE ((l.to_entity_id = p_pool_id AND l.to_type = 'bbj_pool') OR (l.from_entity_id = p_pool_id AND l.from_type = 'bbj_pool'))
       AND l.created_at > v_at
       AND (l.to_label LIKE 'bbj_pools.%' OR l.from_label LIKE 'bbj_pools.%')
  ), banks AS (
    SELECT COALESCE(main_balance, 0) AS m, COALESCE(backup_balance, 0) AS b, COALESCE(promo_balance, 0) AS p
      FROM public.bbj_pools WHERE id = p_pool_id
  )
  SELECT banks.m, banks.b, banks.p,
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.main_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.backup_balance'), 0),
         COALESCE(sum(signed) FILTER (WHERE lbl = 'bbj_pools.promo_balance'), 0)
    INTO v_m, v_b, v_p, jm, jb, jp
    FROM banks LEFT JOIN legs ON true GROUP BY banks.m, banks.b, banks.p;

  INSERT INTO public.ca_bbj_pool_snapshots (pool_id, taken_at, is_baseline, main, backup, promo, note)
  VALUES (p_pool_id, v_at, true, round(v_m - jm, 2), round(v_b - jb, 2), round(v_p - jp, 2),
          format('auto-opened by the meter on first sight (%s): opening balance reconstructed as the banks at first sight minus the journal since %s (the later of the pool''s creation and the epoch); not a movement',
                 to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS UTC'), v_at))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_open_pool_baseline(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_open_pool_baseline(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_reconcile_all()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p record; s public.ca_bbj_pool_snapshots%ROWTYPE; prev public.ca_bbj_pool_snapshots%ROWTYPE;
  v_out jsonb := '[]'::jsonb; v_two numeric; v_alerts int := 0; v_opened int := 0;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_reconcile_all is service only' USING ERRCODE = '42501';
  END IF;
  FOR p IN SELECT b.id, b.union_id, b.club_id FROM public.bbj_pools b WHERE b.status = 'active' ORDER BY b.created_at LOOP
    -- A pool the meter has never seen opens its own balance (second cut).
    IF NOT EXISTS (SELECT 1 FROM public.ca_bbj_pool_snapshots x WHERE x.pool_id = p.id) THEN
      PERFORM public.fn_bbj_open_pool_baseline(p.id);
      v_opened := v_opened + 1;
    END IF;
    s := public.fn_bbj_reconcile(p.id);
    SELECT * INTO prev FROM public.ca_bbj_pool_snapshots WHERE id = s.prev_id;
    -- Two consecutive snapshots: a leg that commits after a read straddles one
    -- boundary and reverses at the next, so a single-interval swing is noise
    -- and a two-interval sum is a finding.
    v_two := (s.unexplained_main + s.unexplained_backup + s.unexplained_promo)
           + COALESCE(CASE WHEN prev.is_baseline THEN 0 ELSE prev.unexplained_main + prev.unexplained_backup + prev.unexplained_promo END, 0);
    IF abs(v_two) > 0.01 OR s.write_failures > 0 THEN
      v_alerts := v_alerts + 1;
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_bbj_reconcile', 'bbj_error', CASE WHEN abs(v_two) >= 100 OR s.write_failures > 0 THEN 'critical' ELSE 'warning' END,
        'bbj-meter:' || p.id::text || ':' || to_char(s.taken_at, 'YYYY-MM-DD-HH24'),
        round(v_two, 2), 0, round(v_two, 2), 'ledger', 'bbj_pools', p.id, p.club_id, p.union_id,
        NULL, NULL, NULL, NULL, NULL, NULL,
        format('BBJ pool banks moved by %s beyond the journal over the last two snapshots (main %s, backup %s, promo %s this interval; %s ledger write failure(s)): a bbj_pools write without a leg, or a leg without a write',
               round(v_two, 2), s.unexplained_main, s.unexplained_backup, s.unexplained_promo, s.write_failures),
        false,
        jsonb_build_object('snapshot_id', s.id, 'pool_id', p.id, 'unexplained_main', s.unexplained_main,
                           'unexplained_backup', s.unexplained_backup, 'unexplained_promo', s.unexplained_promo,
                           'write_failures', s.write_failures));
    END IF;
    v_out := v_out || jsonb_build_object('pool_id', p.id, 'snapshot_id', s.id,
                'main', s.main, 'backup', s.backup, 'promo', s.promo,
                'unexplained', round(s.unexplained_main + s.unexplained_backup + s.unexplained_promo, 2),
                'drops', s.drops_since, 'payouts', s.payouts_since, 'sweeps', s.sweeps_since);
  END LOOP;
  RETURN jsonb_build_object('pools', v_out, 'alerts', v_alerts, 'opened', v_opened);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_reconcile_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reconcile_all() TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_bbj_open_pool_baseline', 'approved', 'chip standard Phase 4.2 second cut (2026-09-04): opens a labelled baseline for a pool the meter has never seen, reconstructed from the banks and the journal; writes no balance')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;
