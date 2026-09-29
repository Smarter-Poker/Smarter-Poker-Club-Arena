-- ============================================================================
-- STAFF READ THE DIAMOND BOOKS
-- ============================================================================
--
-- Diamond Arena programme, Phase 10 line 4 ("Add staff-only game
-- configuration, incident review and audited adjustments"): the one read the
-- staff surface needs, item 8 of the ordered build list in
-- docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md.
--
-- What was there (read live 2026-09-29): the staff page can reach every door
-- it needs except two kinds of figure.
--   * The adjustments queue. ca_manual_adjustments,
--     ca_diamond_adjustment_receipts and ca_diamond_correction_source are
--     readable by the service role only and no door lists them, so a
--     correction could be proposed, approved and settled on screen and never
--     seen there again.
--   * The books. fn_ca_diamond_health(), fn_ca_diamond_trial_balance() and
--     fn_ca_diamond_register_vs_supply() are granted to the service role only,
--     and the health report also refuses every caller whose role is not the
--     service role.
--
-- What this adds:
--   1. fn_ca_diamond_health() admits platform staff as well as the service
--      role. Its one guard changes by asserted substitution and nothing else
--      in it moves. Its grant is unchanged (the owner and the service role),
--      so a signed-in account reaches it only through a SECURITY DEFINER door
--      that asks fn_is_platform_admin() first.
--   2. fn_ca_diamond_staff_books(p_view text): one platform-staff read with
--      three views, each its own call, so the slow health report never holds
--      up the queue:
--        adjustments - every Diamond row of ca_manual_adjustments, newest
--                      first (at most 200), each with its receipt once
--                      settled; the count per status; and what pays for a
--                      correction (the row of ca_diamond_correction_source,
--                      or null, when every settlement is refused by name).
--        health      - fn_ca_diamond_health() as it reads now, in its order.
--        books       - fn_ca_diamond_trial_balance() over its own default
--                      window, in its order, and
--                      fn_ca_diamond_register_vs_supply().
--      It asks fn_is_platform_admin() before anything else and refuses every
--      other caller by name (platform_staff_only); a view it does not know is
--      refused by name (unknown_view). It is STABLE and writes nothing.
--
-- No table, policy, switch or other function changes, and no grant but the
-- new door's own. Nothing is reviewed, proposed, approved, settled or
-- authorized. tournaments_enabled and cash_games_enabled stay false.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_diamond_health()                     3ed2ac4e441befea2072b3c3e941b37e  changed: one guard
--   fn_ca_diamond_trial_balance(timestamptz)   f744e044e7575283be20f73cd1f2f7d5  called, not changed
--   fn_ca_diamond_register_vs_supply()         4831173c57fc3d4e2bc0fa5eea346ee2  called, not changed
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond Arena switch is already on; this migration expects both closed';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_staff_books(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'fn_ca_diamond_staff_books already exists; this migration creates it';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_ca_diamond_health()', '3ed2ac4e441befea2072b3c3e941b37e'),
      ('public.fn_ca_diamond_trial_balance(timestamptz)', 'f744e044e7575283be20f73cd1f2f7d5'),
      ('public.fn_ca_diamond_register_vs_supply()', '4831173c57fc3d4e2bc0fa5eea346ee2')
    ) AS p(sig, pin)
  LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', r.sig, md5(pg_get_functiondef(r.sig::regprocedure));
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE HEALTH REPORT ADMITS PLATFORM STAFF
-- ---------------------------------------------------------------------------
-- The report refused any caller whose role was not the service role, so a
-- staff door could not read it for a staff member. It now also admits a
-- caller for whom fn_is_platform_admin() is true. The service role and the
-- hourly watch (the owner, no role) are admitted exactly as before.
DO $m$
DECLARE
  c_pin constant text := '3ed2ac4e441befea2072b3c3e941b37e';
  c_old constant text := E'  IF COALESCE(auth.role(), ''service_role'') <> ''service_role'' THEN\n    RAISE EXCEPTION ''service_role required'';';
  c_new constant text := E'  IF COALESCE(auth.role(), ''service_role'') <> ''service_role'' AND NOT public.fn_is_platform_admin() THEN\n    RAISE EXCEPTION ''service_role or platform staff required'';';
  v_def text; v_new text; v_n integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_diamond_health()'::regprocedure);
  IF md5(v_def) <> c_pin THEN
    RAISE EXCEPTION 'fn_ca_diamond_health is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the health report: its guard occurs % times, expected 1', v_n;
  END IF;
  v_new := replace(v_def, c_old, c_new);
  IF md5(replace(v_new, c_new, c_old)) <> c_pin THEN
    RAISE EXCEPTION 'the health report: the reverse substitution does not reproduce the pinned text';
  END IF;
  EXECUTE v_new;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. ONE STAFF READ OF THE DIAMOND BOOKS
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_diamond_staff_books', 'system',
   'Diamond Phase 10. Platform-staff read for the staff desk (fn_is_platform_admin): the Diamond adjustments queue with its receipts and what pays for a correction, the health report, and the trial balance with the register against supply. STABLE; writes nothing. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

CREATE FUNCTION public.fn_ca_diamond_staff_books(p_view text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_view text := lower(btrim(COALESCE(p_view, '')));
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;

  IF v_view = 'adjustments' THEN
    RETURN jsonb_build_object(
      'ok', true, 'view', v_view, 'as_of', now(),
      'correction_source', (
        SELECT jsonb_build_object('source', s.source, 'authorized_by', s.authorized_by,
                                  'ruling', s.ruling, 'authorized_at', s.authorized_at)
          FROM public.ca_diamond_correction_source s WHERE s.id = 1),
      'counts', (
        SELECT COALESCE(jsonb_object_agg(c.status, c.n), '{}'::jsonb)
          FROM (SELECT a.status, count(*) AS n FROM public.ca_manual_adjustments a
                 WHERE a.asset = 'diamonds' GROUP BY a.status) c),
      'adjustments', (
        SELECT COALESCE(jsonb_agg(q.j ORDER BY q.created_at DESC, q.id), '[]'::jsonb)
          FROM (SELECT a.created_at, a.id, jsonb_build_object(
                  'id', a.id, 'status', a.status, 'target_kind', a.target_kind, 'target_id', a.target_id,
                  'target_label', CASE WHEN a.target_kind = 'diamond_wallet' THEN
                    (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name) FROM public.profiles p WHERE p.id = a.target_id) END,
                  'amount', a.amount, 'reason', a.reason,
                  'proposed_by', a.actor, 'proposed_by_label', a.actor_label, 'proposed_at', a.created_at,
                  'approved_by', a.approver, 'approved_by_label', a.approver_label, 'approved_at', a.approved_at,
                  'rejected_by', a.rejected_by, 'rejected_at', a.rejected_at,
                  'rejected_by_label', CASE WHEN a.rejected_by IS NOT NULL THEN
                    (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name) FROM public.profiles p WHERE p.id = a.rejected_by) END,
                  'decision_note', a.decision_note,
                  'receipt', (SELECT jsonb_build_object('source', r.source, 'settled_by', r.settled_by,
                                       'settled_by_label', r.settled_by_label, 'settled_at', r.settled_at,
                                       'supply_moved', r.receipt -> 'supply_moved')
                                FROM public.ca_diamond_adjustment_receipts r WHERE r.adjustment_id = a.id)) AS j
                  FROM public.ca_manual_adjustments a
                 WHERE a.asset = 'diamonds'
                 ORDER BY a.created_at DESC, a.id
                 LIMIT 200) q));
  END IF;

  IF v_view = 'health' THEN
    RETURN jsonb_build_object(
      'ok', true, 'view', v_view, 'as_of', now(),
      'areas', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('area', h.area, 'status', h.status, 'detail', h.detail)
                                  ORDER BY h.n), '[]'::jsonb)
          FROM public.fn_ca_diamond_health() WITH ORDINALITY AS h(area, status, detail, n)));
  END IF;

  IF v_view = 'books' THEN
    RETURN jsonb_build_object(
      'ok', true, 'view', v_view, 'as_of', now(),
      'trial_balance', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'account', t.account, 'balance_now', t.balance_now, 'balance_delta', t.balance_delta,
                 'journal_net', t.journal_net, 'mint_net', t.mint_net, 'difference', t.difference,
                 'note', t.note) ORDER BY t.n), '[]'::jsonb)
          FROM public.fn_ca_diamond_trial_balance()
               WITH ORDINALITY AS t(account, balance_now, balance_delta, journal_net, mint_net, difference, note, n)),
      'register', (
        SELECT jsonb_build_object('register_net', r.register_net, 'meter_total', r.meter_total,
                                  'player_diamonds', r.player_diamonds, 'house_diamonds', r.house_diamonds,
                                  'difference', r.difference)
          FROM public.fn_ca_diamond_register_vs_supply() r));
  END IF;

  RETURN jsonb_build_object('ok', false, 'refused_reason', 'unknown_view', 'view', v_view);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_staff_books(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_staff_books(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_oid oid; v_txt text; v_bad text;
BEGIN
  -- the health report: one guard changed, and still no client grant
  v_oid := 'public.fn_ca_diamond_health()'::regprocedure;
  v_txt := pg_get_functiondef(v_oid);
  IF position(E'<> ''service_role'' AND NOT public.fn_is_platform_admin() THEN\n    RAISE EXCEPTION ''service_role or platform staff required'';' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the health report does not admit platform staff as this migration states';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'the health report is reachable by a client without a staff door';
  END IF;
  -- the read: a stable definer that asks for staff first, signed-in only
  v_oid := 'public.fn_ca_diamond_staff_books(text)'::regprocedure;
  v_txt := pg_get_functiondef(v_oid);
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'the staff read is reachable without an account';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'the staff read is not reachable by a signed-in staff member';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.provolatile = 's' FROM pg_proc p WHERE p.oid = v_oid)
     OR position(E'BEGIN\n  IF NOT public.fn_is_platform_admin() THEN' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the staff read is not a stable definer that asks for staff first';
  END IF;
  -- the called readers are the text they were
  IF md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamptz)'::regprocedure)) <> 'f744e044e7575283be20f73cd1f2f7d5'
     OR md5(pg_get_functiondef('public.fn_ca_diamond_register_vs_supply()'::regprocedure)) <> '4831173c57fc3d4e2bc0fa5eea346ee2' THEN
    RAISE EXCEPTION 'a reader this migration only calls has moved';
  END IF;
  -- the switches stay off, the identity is whole, every watched guard is on its baseline
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'staff read the Diamond books: one staff read with three views, and the health report admits platform staff; nothing opened to players';
END $m$;
