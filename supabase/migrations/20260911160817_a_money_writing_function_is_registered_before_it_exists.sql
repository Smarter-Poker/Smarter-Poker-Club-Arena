-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260911160817; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260911160817   (the stamp IS the apply time, UTC: 2026-09-11 16:08:17)
--   name        a_money_writing_function_is_registered_before_it_exists
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 17856 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260911160817 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     EVENT TRIGGER  ab_ca_money_rpc_registered
--     FUNCTION       public.fn_ca_money_rpc_balance_columns, public.fn_ca_money_rpc_writes_balances, public.fn_ca_money_rpc_drift, public.fn_ca_money_rpc_registry_guard, public.fn_ca_resolve_cleared_incidents
--     DROP           EVENT TRIGGER ab_ca_money_rpc_registered
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

BEGIN;

-- A MONEY WRITING FUNCTION IS REGISTERED BEFORE IT EXISTS
--
-- Seven open drift incidents said the same thing: "NEW unregistered function
-- writes balance columns". fn_ca_money_rpc_drift was right every time. Three
-- defects sat underneath it, and this migration closes all three.
--
--   1. Seven live functions were never registered. Audited here, registered
--      below. One of them, fn_bbj_set_club_mini_enabled, shipped at 14:07 on
--      2026-09-11, two hours before this migration was written: the class was
--      still happening while the fix for it was being typed, which is the
--      whole argument for defect 3.
--   2. fn_diamond_game_promo_lock, the seventh, NO LONGER EXISTS, and its
--      incident stayed open anyway. fn_ca_money_rpc_drift is absent from
--      fn_ca_resolve_cleared_incidents and records no run, so nothing could
--      ever close one of its findings. It scans the whole of pg_proc on every
--      run, which is exactly the eligibility rule that function documents, so
--      it joins the list.
--   3. Nothing REFUSED an unregistered money writer. The detector noticed
--      hours later at warning severity and the incident then sat open. The
--      event trigger below refuses the CREATE outright.
--
-- The predicate is factored into one function so the guard that refuses and
-- the detector that reports can never drift apart.

-- ── 1. the predicate, said once ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_balance_columns()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT array_agg(DISTINCT c)
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;
$$;

COMMENT ON FUNCTION public.fn_ca_money_rpc_balance_columns() IS
  'The balance columns, read from the autoledger triggers that watch them plus a fixed floor. One definition, shared by the drift detector and the DDL guard.';

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_writes_balances(p_src text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
  SELECT COALESCE(
    p_src ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
    OR p_src ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y', false)
  AND COALESCE(p_src ~* ('\y(' || array_to_string(public.fn_ca_money_rpc_balance_columns(), '|') || ')\y'), false);
$$;

COMMENT ON FUNCTION public.fn_ca_money_rpc_writes_balances(text) IS
  'True when a function body both writes a money bearing table and names a balance column. The rule that opens a drift incident and the rule that refuses a CREATE are this one predicate, so they cannot disagree.';

-- ── 2. the seven audited functions ─────────────────────────────────────────
-- Each body was read in full before it was written here. What each one is:

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_diamond_game_cover_lock', 'system',
   'Reads a diamond game host cover and takes the wallet row FOR UPDATE. Moves no money: its only write is an ON CONFLICT DO NOTHING insert of an empty union_wallets row so the lock has something to hold. Flagged because that insert names balance columns.'),
  ('fn_diamond_game_pay_chips', 'approved',
   'Pays a diamond game chip prize from the host promo wallet, then the host bank, into the winner club_members chip_balance. Declares every leg through fn_ca_declare_ledger under its own idempotency key and RAISES if a balance moved with no journal leg written.'),
  ('fn_diamond_game_fund_promo', 'approved',
   'Operator button. Moves a host own chip_treasury into its own promo_balance to cover diamond game chip prizes. Gated on fn_wheel_can_operate, refuses during the maintenance freeze, whole cents only, replay guarded on the journal, and RAISES if the move wrote no leg.'),
  ('fn_complete_tournament_terminal_pre_seat_guard', 'approved',
   'Terminal tournament closure. Clears current_bounty on the roster and marks seats left. Writes no stack and moves no balance; flagged for its table_seats and tournament_players writes.'),
  ('fn_ca_settle_bounty_rebuy_generation_v1', 'approved',
   'Zeroes a roster current_bounty once its bounty obligation is settled, and only when the standing value matches the obligation head amount. A bounty quotation, not a wallet.'),
  ('fn_ca_reprice_unpaid_tournament_place', 'approved',
   'Reprices an UNPAID tournament place. Engine authority only, exact cents, takes the tournament settlement lane, refuses once any prepared or paid terminal evidence exists, and compare and sets against the expected prize.'),
  ('fn_bbj_set_club_mini_enabled', 'system',
   'Turns the mini bad beat jackpot on or off for a union free club. Moves no money: it flips bbj_pools.mini_enabled, or inserts a pool whose every balance is zero when the club has none yet. Actor is auth.uid() and never a parameter, club admins only, and a union club is refused after the authorization check so a refusal leaks no union shape. Flagged because that insert names the pool balance columns.')
ON CONFLICT (proname) DO NOTHING;

-- ── 3. the detector uses the shared predicate and records that it ran ──────

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_drift()
RETURNS TABLE(proname text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  r RECORD;
  v_found int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT p.proname AS pn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND public.fn_ca_money_rpc_writes_balances(p.prosrc)
      AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname)
  LOOP
    v_found := v_found + 1;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-drift:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NEW unregistered function writes balance columns: ' || r.pn
        || ' - audit it, then register it in ca_money_rpc_registry',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;

  /* Phase 2 lane 2.5 (F9): a door the registry says is CLOSED must stay
     closed. If any client role - or service_role - can execute it again,
     that is drift of the authorization surface, not of a balance. */
  FOR r IN
    SELECT g.proname AS pn
      FROM public.ca_money_rpc_registry g
      JOIN pg_proc p ON p.proname = g.proname
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE g.status = 'closed'
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('service_role', p.oid, 'EXECUTE'))
  LOOP
    v_found := v_found + 1;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-closed-door-open:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'CLOSED money door is executable again: ' || r.pn
        || ' - it was revoked from every client role; revoke it again or change its registry status',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;

  /* A COMPLETED RUN IS ITSELF EVIDENCE. This detector reads the whole of
     pg_proc every run, so a name it stops reporting is a name that is now
     registered or gone. That is the eligibility rule in
     fn_ca_resolve_cleared_incidents, and without this row nothing could
     ever close one of these findings: fn_diamond_game_promo_lock was
     dropped and its incident stayed open regardless. */
  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_money_rpc_drift', jsonb_build_object('with_findings', v_found));
END;
$function$;

-- ── 4. the guard: registered BEFORE it exists, not hours after ────────────

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_registry_guard()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  obj record;
  v_name text;
  v_src  text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type <> 'function' OR obj.schema_name IS DISTINCT FROM 'public' THEN
      CONTINUE;
    END IF;

    SELECT p.proname, p.prosrc INTO v_name, v_src
      FROM pg_proc p WHERE p.oid = obj.objid AND p.prokind = 'f';
    IF v_name IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT public.fn_ca_money_rpc_writes_balances(v_src) THEN
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v_name) THEN
      CONTINUE;
    END IF;

    RAISE EXCEPTION
      'REFUSED: % writes balance columns and is not in ca_money_rpc_registry', v_name
      USING ERRCODE = '42501',
            DETAIL  = 'A function that can move money is registered before it exists, not after. '
                   || 'This is the guard for the seven drift incidents of 2026-09-11.',
            HINT    = 'Put the registry row ABOVE the CREATE FUNCTION in this same migration: '
                   || 'INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES ('
                   || quote_literal(v_name)
                   || ', ''approved'', ''what it moves, what gates it, how it is journaled'');  '
                   || 'Use status ''system'' if it moves no money and only reads or locks.';
  END LOOP;
END;
$function$;

DROP EVENT TRIGGER IF EXISTS ab_ca_money_rpc_registered;
CREATE EVENT TRIGGER ab_ca_money_rpc_registered
  ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION')
  EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();

-- ── 5. the findings can now close themselves ──────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_ca_resolve_cleared_incidents()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '120s'
AS $function$
DECLARE
  d          record;
  v_second   timestamptz;
  v_last     timestamptz;
  v_closed   int := 0;
  v_total    int := 0;
  v_out      jsonb := '[]'::jsonb;
  v_actor    uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
BEGIN
  /* WHAT MAY BE ON THIS LIST. Only a detector whose raise condition looks
     at the whole standing state, so that not raising a finding means the
     finding is gone. fn_ca_quick_reconcile is deliberately absent: it looks
     at a ten minute window, so its silence means the window moved on, not
     that anything was fixed, and auto-closing its criticals would bury real
     unanswered money.
     fn_ca_money_rpc_drift joined on 2026-09-11: it reads every row of
     pg_proc on every run, so a name it stops reporting is registered or
     gone. Before it recorded a run, a dropped function left an incident
     open forever. */
  FOR d IN SELECT unnest(ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile','fn_ca_money_rpc_drift']) AS detector
  LOOP
    SELECT ran_at INTO v_last
      FROM public.ca_detector_runs WHERE detector = d.detector
     ORDER BY ran_at DESC LIMIT 1;
    SELECT ran_at INTO v_second
      FROM public.ca_detector_runs WHERE detector = d.detector
     ORDER BY ran_at DESC OFFSET 1 LIMIT 1;

    IF v_second IS NULL THEN
      v_out := v_out || jsonb_build_object('detector', d.detector,
                 'closed', 0, 'why', 'fewer than two recorded runs so far');
      CONTINUE;
    END IF;

    UPDATE public.ca_drift_incidents i
       SET status         = 'resolved',
           resolved_at    = now(),
           resolved_by    = v_actor,
           root_cause     = 'the measurement that raised this stopped reporting it: '
                         || d.detector || ' completed at ' || v_second::text
                         || ' and again at ' || v_last::text
                         || ' without raising it either time, so the condition it '
                         || 'found no longer holds. Closed by the same measurement '
                         || 'that opened it, never by assumption.',
           correction_ref = 'verified: ' || d.detector || ' ran twice without re-raising this, '
                         || 'most recently at ' || v_last::text,
           resolution     = 'no chips moved to close this. The detector re-measured and '
                         || 'found nothing; if the condition returns, the next run raises '
                         || 'it again with a fresh incident.'
     WHERE i.resolved_at IS NULL
       AND i.source LIKE d.detector || '%'
       AND i.created_at < v_second
       AND i.last_seen_at < v_second;
    GET DIAGNOSTICS v_closed = ROW_COUNT;
    v_total := v_total + v_closed;
    v_out := v_out || jsonb_build_object('detector', d.detector, 'closed', v_closed,
               'clean_since', v_second, 'last_run', v_last);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'closed', v_total, 'detectors', v_out);
END;
$function$;

-- ── 6. no new door is opened to a client role ─────────────────────────────
-- Default privileges on this project grant EXECUTE on a new function to anon
-- and authenticated, and REVOKE ... FROM PUBLIC does not remove a direct
-- grant. Named explicitly, then asserted below. GRANT/REVOKE fire no schema
-- cache reload (production DDL policy rule 5).

REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_balance_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_writes_balances(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_registry_guard() FROM PUBLIC, anon, authenticated;

-- ── 7. prove it, in the same transaction that made the claim ──────────────
--
-- NOTE: no CREATE FUNCTION probe. The production DDL policy (CLAUDE.md, rule
-- 3) forbids CREATE OR REPLACE FUNCTION used as a test against production:
-- every DDL statement reloads PostgREST's schema cache for about 28 seconds,
-- which is the PGRST002 outage of 2026-08-31. So the predicate is proved
-- directly and the trigger is proved to be armed and pointed at the function
-- that refuses. The behavioural refusal is pinned in
-- tests/a-money-writing-function-is-registered.law.test.ts.

DO $$
DECLARE
  v_unregistered int;
  v_evt record;
  r record;
BEGIN
  SELECT count(*) INTO v_unregistered
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND public.fn_ca_money_rpc_writes_balances(p.prosrc)
     AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname);
  IF v_unregistered <> 0 THEN
    RAISE EXCEPTION 'ABORT: % money writing function(s) are still unregistered', v_unregistered;
  END IF;

  -- The predicate must say yes to a money writer and no to a reader.
  IF NOT public.fn_ca_money_rpc_writes_balances(
       'UPDATE public.club_members SET chip_balance = chip_balance + 1 WHERE user_id = x') THEN
    RAISE EXCEPTION 'ABORT: the predicate does not recognise a balance write';
  END IF;
  IF public.fn_ca_money_rpc_writes_balances(
       'SELECT chip_balance FROM public.club_members WHERE user_id = x') THEN
    RAISE EXCEPTION 'ABORT: the predicate calls a plain read a balance write';
  END IF;
  IF public.fn_ca_money_rpc_writes_balances(
       'UPDATE public.clubs SET name = ''x'' WHERE id = y') THEN
    RAISE EXCEPTION 'ABORT: the predicate calls a non money write a balance write';
  END IF;

  -- The guard must be armed, and pointed at the function that refuses.
  SELECT e.evtname AS evtname, e.evtenabled AS evtenabled, p.proname AS proname INTO v_evt
    FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid
   WHERE e.evtname = 'ab_ca_money_rpc_registered';
  IF v_evt.evtname IS NULL THEN
    RAISE EXCEPTION 'ABORT: the registry guard event trigger is not installed';
  END IF;
  IF v_evt.evtenabled = 'D' THEN
    RAISE EXCEPTION 'ABORT: the registry guard event trigger is installed but DISABLED';
  END IF;
  IF v_evt.proname <> 'fn_ca_money_rpc_registry_guard' THEN
    RAISE EXCEPTION 'ABORT: the guard points at % instead of the refusing function', v_evt.proname;
  END IF;

  -- The detector must now be on the auto resolve list, or a dropped function
  -- leaves an incident open forever, which is the second of the three defects.
  IF position('fn_ca_money_rpc_drift' in
        (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_resolve_cleared_incidents')) = 0 THEN
    RAISE EXCEPTION 'ABORT: fn_ca_money_rpc_drift is not on the auto resolve list';
  END IF;

  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS a,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS u
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_money_rpc_balance_columns','fn_ca_money_rpc_writes_balances','fn_ca_money_rpc_registry_guard')
  LOOP
    IF r.a OR r.u THEN
      RAISE EXCEPTION 'ABORT: a client role can still execute %', r.sig;
    END IF;
  END LOOP;
END $$;

COMMIT;
