-- ============================================================================
-- DIAMOND PHASE 11 LINE 7 - A REVOKED SESSION IS REFUSED BY NAME AT EVERY
-- DIAMOND STAFF DOOR (rehearsal fixture for migration 20260930131500)
-- ============================================================================
-- REHEARSAL ONLY. Run by the swarm's rehearse.sh together with
-- supabase/migrations/20260930131500_every_diamond_staff_door_needs_a_live_session.sql
-- as ONE transaction against production that ends in a deliberate error
-- (RAISE EXCEPTION 'REHEARSAL OK: ...'), so NOTHING persists. Single-session
-- door behaviour only: no load, no concurrency, no money moves.
--
-- Identity, inside this rolled-back transaction only: the synthetic account
-- 00000000-0000-0000-0000-000000000098 (a hydra.bot account with no club
-- membership and no session, the same pool the Phase 9 conservation fixture
-- used) is made platform staff and given ONE live auth.sessions row. A revoked
-- session is modelled exactly as the database sees one: a session_id claim
-- with no auth.sessions row behind it. A token with no session_id claim at all
-- is the third shape.
--
-- Every call either refuses before it writes (dead session), or passes the
-- session check and is refused by the NEXT check on a row that does not exist
-- (random ids), so nothing is written even inside the rollback; the end counts
-- the tables the doors write and requires them unchanged.
--
-- Negative control: the same file with no migration (rehearse.sh /dev/null)
-- must FAIL on exactly the ten doors this migration guards, and write
-- nothing: every revoked call carries arguments the door's next check
-- refuses anyway.
--
-- Not called here: atomic_table_buyin, which takes a shared advisory lock
-- before its session check (the rehearsal-safety rules keep locks out of a
-- fixture). Its refusal is read from its live definition in the evidence file.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

CREATE TEMP TABLE res(n serial PRIMARY KEY, name text, ok boolean, detail text);
CREATE TEMP TABLE base(k text PRIMARY KEY, v numeric);

CREATE FUNCTION pg_temp.staff() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT '00000000-0000-0000-0000-000000000098'::uuid;
$f$;
CREATE FUNCTION pg_temp.live_sid() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT uuid_in(md5('p11-stale-client-live-session')::cstring);
$f$;
CREATE FUNCTION pg_temp.dead_sid() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT uuid_in(md5('p11-stale-client-revoked-session')::cstring);
$f$;

-- A browser call from the staff account: its uid, the authenticated role, the
-- given session_id claim (NULL: a token that carries none), no engine header.
CREATE FUNCTION pg_temp.as_staff(p_sid uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims',
    (jsonb_build_object('sub', pg_temp.staff(), 'role', 'authenticated')
       || CASE WHEN p_sid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('session_id', p_sid) END)::text,
    true);
  PERFORM set_config('request.jwt.claim.sub', pg_temp.staff()::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.headers', '{}', true);
END $f$;
CREATE FUNCTION pg_temp.as_engine() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true);
  PERFORM set_config('request.method','POST',true);
END $f$;

-- A door that must RAISE: pass when the error names p_needle (and, if given,
-- carries SQLSTATE p_state). Runs in a subtransaction.
CREATE FUNCTION pg_temp.raises(p_name text, p_sql text, p_needle text, p_state text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO pg_temp.res(name, ok, detail) VALUES (p_name, false, 'was not refused');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp.res(name, ok, detail)
    VALUES (p_name, position(p_needle IN SQLERRM) > 0 AND (p_state IS NULL OR SQLSTATE = p_state),
            SQLSTATE || ' ' || SQLERRM);
  END;
END $f$;

-- A door that ANSWERS: pass when its jsonb answer carries p_key = p_value.
CREATE FUNCTION pg_temp.answers(p_name text, p_sql text, p_key text, p_value text) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  BEGIN
    EXECUTE p_sql INTO v;
    INSERT INTO pg_temp.res(name, ok, detail) VALUES (p_name, v ->> p_key = p_value, left(v::text, 160));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp.res(name, ok, detail) VALUES (p_name, false, SQLSTATE || ' ' || SQLERRM);
  END;
END $f$;

-- What these doors write, counted by the fixture account only, so a live
-- commit by anyone else between the two readings cannot move the verdict.
CREATE FUNCTION pg_temp.snapshot() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'tables_created', (SELECT count(*) FROM public.tables WHERE created_by = pg_temp.staff()),
    'adjustments', (SELECT count(*) FROM public.ca_manual_adjustments WHERE actor = pg_temp.staff()),
    'adjustment_receipts', (SELECT count(*) FROM public.ca_diamond_adjustment_receipts
                             WHERE settled_by = pg_temp.staff()),
    'incident_events', (SELECT count(*) FROM public.ca_diamond_incident_events WHERE actor = pg_temp.staff()),
    'incidents_touched', (SELECT count(*) FROM public.ca_diamond_incidents
                           WHERE acknowledged_by = pg_temp.staff()
                              OR resolved_by = pg_temp.staff()),
    'audit_rows', (SELECT count(*) FROM public.admin_audit_log WHERE admin_user_id = pg_temp.staff()),
    'transfers_sent', (SELECT count(*) FROM public.diamond_wallet_transfers WHERE sender_id = pg_temp.staff()),
    'identity_difference', (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()));
$f$;

-- ============================================================================
-- THE SCENE (inside this rolled-back transaction only)
-- ============================================================================
DO $scene$
BEGIN
  PERFORM pg_temp.as_engine();
  UPDATE public.profiles SET role = 'admin' WHERE id = pg_temp.staff();
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
  VALUES (pg_temp.live_sid(), pg_temp.staff(), now(), now());
  PERFORM set_config('p11.before', pg_temp.snapshot()::text, true);
END $scene$;

DO $checks$
DECLARE
  v_id uuid := uuid_in(md5('p11-stale-client-no-such-row')::cstring);
  v_sid uuid;
  v_label text;
BEGIN
  -- Two sessions per door: a revoked one (a claim with no session row) and a
  -- live one. The revoked call must be refused BY NAME before anything else;
  -- the live call must get past the session check to the door's next refusal.
  FOREACH v_label IN ARRAY ARRAY['revoked', 'no-session-claim', 'live'] LOOP
    v_sid := CASE v_label WHEN 'revoked' THEN pg_temp.dead_sid()
                          WHEN 'live' THEN pg_temp.live_sid() ELSE NULL END;
    PERFORM pg_temp.as_staff(v_sid);
    IF v_label <> 'live' THEN
      -- Arguments the door's own next check refuses (zero stakes, no such
      -- target): refused either way, so even the negative control, run on
      -- the definitions before this migration, writes nothing.
      PERFORM pg_temp.raises(v_label || ': open cash table',
        $q$SELECT public.fn_poker_diamond_open_cash_table('p11', 0, 2, 40, 200, 6, 'nlh')$q$,
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': straddle',
        format('SELECT public.fn_poker_diamond_set_table_straddle(%L, true, false)', v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': run it twice',
        format('SELECT public.fn_poker_diamond_set_table_run_it_twice(%L, true)', v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': bomb pot',
        format('SELECT public.fn_poker_diamond_set_table_bomb_pot(%L, false, 2, 1::smallint)', v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.answers(v_label || ': propose correction',
        format('SELECT public.fn_ca_diamond_adjustment_propose(%L, %L, 5, %L)', 'not_a_target', v_id,
               'phase eleven rehearsal, never committed'),
        'refused_reason', 'diamond_staff_session_required');
      PERFORM pg_temp.answers(v_label || ': approve correction',
        format('SELECT public.fn_ca_diamond_adjustment_approve(%L, NULL)', v_id),
        'refused_reason', 'diamond_staff_session_required');
      PERFORM pg_temp.answers(v_label || ': reject correction',
        format('SELECT public.fn_ca_diamond_adjustment_reject(%L, NULL)', v_id),
        'refused_reason', 'diamond_staff_session_required');
      PERFORM pg_temp.answers(v_label || ': settle correction',
        format('SELECT public.fn_ca_diamond_adjustment_settle(%L)', v_id),
        'refused_reason', 'diamond_staff_session_required');
      PERFORM pg_temp.answers(v_label || ': review incident',
        $q$SELECT public.fn_ca_diamond_incident_review(-1, 'acknowledge', NULL)$q$,
        'error', 'authentication_required');
      PERFORM pg_temp.answers(v_label || ': resolve incident family',
        $q$SELECT public.fn_ca_diamond_incident_resolve_family('p11_no_such_family', NULL, NULL, 'phase eleven rehearsal')$q$,
        'error', 'authentication_required');
      -- The five that already refused, unchanged, and the player transfer door.
      PERFORM pg_temp.raises(v_label || ': close cash table (already guarded)',
        format('SELECT public.fn_poker_diamond_close_cash_table(%L)', v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': edit cash table (already guarded)',
        format('SELECT public.fn_poker_diamond_edit_cash_table(%L, NULL, NULL, NULL, NULL, NULL, NULL)', v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': cancel event (already guarded)',
        format('SELECT public.fn_poker_diamond_cancel_tournament(%L)', v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': remove entry (already guarded)',
        format('SELECT public.fn_poker_diamond_remove_tournament_player(%L, %L, NULL)', v_id, v_id),
        'diamond_staff_session_required', '28000');
      PERFORM pg_temp.raises(v_label || ': send diamonds (player door)',
        format('SELECT public.send_wallet_diamond_transfer(%L, 1, NULL, %L)', v_id, 'p11-rehearsal-0001'),
        'authentication_required', '42501');
    ELSE
      PERFORM pg_temp.raises('live: open cash table passes to its stakes check',
        $q$SELECT public.fn_poker_diamond_open_cash_table('p11', 0, 2, 40, 200, 6, 'nlh')$q$,
        'diamond_table_requires_whole_positive_stakes', NULL);
      PERFORM pg_temp.raises('live: straddle passes to its table lookup',
        format('SELECT public.fn_poker_diamond_set_table_straddle(%L, true, false)', v_id),
        'diamond_table_not_found', NULL);
      PERFORM pg_temp.raises('live: run it twice passes to its table lookup',
        format('SELECT public.fn_poker_diamond_set_table_run_it_twice(%L, true)', v_id),
        'diamond_table_not_found', NULL);
      PERFORM pg_temp.raises('live: bomb pot passes to its table lookup',
        format('SELECT public.fn_poker_diamond_set_table_bomb_pot(%L, false, 2, 1::smallint)', v_id),
        'diamond_table_not_found', NULL);
      PERFORM pg_temp.answers('live: propose passes to its target check',
        format('SELECT public.fn_ca_diamond_adjustment_propose(%L, %L, 5, %L)', 'not_a_target', v_id,
               'phase eleven rehearsal, never committed'),
        'refused_reason', 'not_a_diamond_target');
      PERFORM pg_temp.answers('live: approve passes to its lookup',
        format('SELECT public.fn_ca_diamond_adjustment_approve(%L, NULL)', v_id),
        'refused_reason', 'not_found');
      PERFORM pg_temp.answers('live: reject passes to its lookup',
        format('SELECT public.fn_ca_diamond_adjustment_reject(%L, NULL)', v_id),
        'refused_reason', 'not_found');
      PERFORM pg_temp.answers('live: settle passes to its lookup',
        format('SELECT public.fn_ca_diamond_adjustment_settle(%L)', v_id),
        'refused_reason', 'not_found');
      PERFORM pg_temp.answers('live: review passes to its lookup',
        $q$SELECT public.fn_ca_diamond_incident_review(-1, 'acknowledge', NULL)$q$,
        'error', 'incident_not_found');
      PERFORM pg_temp.answers('live: family passes to its reason check',
        $q$SELECT public.fn_ca_diamond_incident_resolve_family('p11_no_such_family', NULL, NULL, 'short')$q$,
        'error', 'reason_required');
    END IF;
  END LOOP;
END $checks$;

-- ============================================================================
-- THE VERDICT: every check passed and nothing was written.
-- ============================================================================
DO $end$
DECLARE v_fail text; v_n int; v_before jsonb := current_setting('p11.before')::jsonb; v_after jsonb;
BEGIN
  PERFORM pg_temp.as_engine();
  v_after := pg_temp.snapshot();
  INSERT INTO pg_temp.res(name, ok, detail)
  VALUES ('nothing written: the tables the doors write are unchanged and the identity holds',
          v_after = v_before AND (v_after ->> 'identity_difference')::numeric = 0,
          v_before::text || ' -> ' || v_after::text);
  SELECT count(*), string_agg(name || ' [' || detail || ']', ' | ' ORDER BY n) FILTER (WHERE NOT ok)
    INTO v_n, v_fail FROM pg_temp.res;
  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAILED (% checks): %', v_n, v_fail;
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK: % checks. %', v_n,
    (SELECT string_agg(name || ' -> ' || left(detail, 90), ' | ' ORDER BY n) FROM pg_temp.res);
END $end$;
