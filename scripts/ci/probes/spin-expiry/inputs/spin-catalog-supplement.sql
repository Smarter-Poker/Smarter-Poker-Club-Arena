-- Isolated FIFO5 catalog supplement; never a production migration.
-- Exact missing metadata captured 2026-09-16 11:36:58UTC via read-only query.
-- Two tables are empty isolated stores; no production history is copied.
-- Current selected expiry/global/cancel baseline absence was observed without active RLS.
-- This does not provide financial fixtures or qualify business behavior.
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL statement_timeout='15s';
DO $boundary$ BEGIN
  IF current_user <> 'fixture_bootstrap'
     OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
     OR current_database() <> 'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid'),'-','')
     OR to_regclass('public.ca_guard_defs') IS NOT NULL
     OR to_regclass('public.ca_guard_def_history') IS NOT NULL
     OR to_regprocedure('public.fn_spin_expire_unfilled(integer)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_guard_watchlist()') IS NOT NULL
  THEN RAISE EXCEPTION 'Spin supplement requires the exact empty isolated catalog boundary'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_sequence s WHERE s.seqrelid='public.ca_guard_def_history_id_seq'::regclass
     AND s.seqtypid='bigint'::regtype AND s.seqstart=1 AND s.seqincrement=1
     AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND NOT s.seqcycle)
     OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
       AND d.objid='public.ca_guard_def_history_id_seq'::regclass
       AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i'))
  THEN RAISE EXCEPTION 'Spin history orphan sequence boundary changed'; END IF;
END $boundary$;
CREATE TABLE public."ca_guard_def_history" (
  "id" bigint DEFAULT nextval('ca_guard_def_history_id_seq'::regclass) NOT NULL,
  "proname" text NOT NULL,
  "def_hash" text NOT NULL,
  "def_text" text NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public."ca_guard_def_history" OWNER TO postgres;
ALTER TABLE public."ca_guard_def_history" ADD CONSTRAINT "ca_guard_def_history_pkey" PRIMARY KEY (id);
CREATE UNIQUE INDEX ca_guard_def_history_proname_hash_idx ON public.ca_guard_def_history USING btree (proname, def_hash);
ALTER TABLE public."ca_guard_def_history" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public."ca_guard_defs" (
  "proname" text NOT NULL,
  "def_hash" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "declared_ref" text,
  "declared_at" timestamp with time zone
);
ALTER TABLE public."ca_guard_defs" OWNER TO postgres;
ALTER TABLE public."ca_guard_defs" ADD CONSTRAINT "ca_guard_defs_pkey" PRIMARY KEY (proname);
ALTER TABLE public."ca_guard_defs" ENABLE ROW LEVEL SECURITY;
ALTER SEQUENCE public.ca_guard_def_history_id_seq OWNER TO postgres;
ALTER SEQUENCE public.ca_guard_def_history_id_seq OWNED BY public.ca_guard_def_history.id;
SET LOCAL ROLE postgres;
REVOKE ALL ON TABLE public.ca_guard_defs, public.ca_guard_def_history FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.ca_guard_defs, public.ca_guard_def_history TO postgres, service_role;
REVOKE ALL ON SEQUENCE public.ca_guard_def_history_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.ca_guard_def_history_id_seq TO postgres, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO postgres, service_role;
CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_minutes integer;
  g record;
  v_current record;
  v_skipped integer := 0;
  res jsonb;
  v_expired integer := 0;
  v_failed integer := 0;
  v_refunded numeric := 0;
  v_ids jsonb := '[]'::jsonb;
BEGIN
  SELECT unfilled_timeout_minutes INTO v_minutes FROM public.spin_fill_policy LIMIT 1;
  v_minutes := COALESCE(v_minutes, 30);

  -- 0 (or a missing row) means the operator has switched the sweep off.
  IF v_minutes <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'disabled', true, 'expired', 0);
  END IF;

  FOR g IN
    SELECT t.id,
           t.buy_in_amount,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL) AS live_seats
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING', 'ANNOUNCED')
       AND t.started_at IS NULL
       -- somebody has actually been waiting too long
       AND EXISTS (SELECT 1 FROM public.table_seats s
                     JOIN public.tables tb ON tb.id = s.table_id
                    WHERE tb.tournament_id = t.id
                      AND s.left_at IS NULL
                      AND s.joined_at < now() - make_interval(mins => v_minutes))
       -- and the game is NOT full: a full unstarted spin is about to deal.
       AND (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL)
           < COALESCE(t.max_players, 3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    -- The scan is only a candidate list. A final join or launch may commit
    -- before cancellation reaches this parent. Busy parents belong to that
    -- work; the next sweep may reconsider them.
    PERFORM 1 FROM public.tournaments t WHERE t.id=g.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    -- Read in a new statement AFTER acquiring the parent, so seat subqueries
    -- cannot retain the candidate scan's earlier snapshot.
    SELECT t.status,t.variant,t.started_at,t.spin_multiplier,t.buy_in_amount,
           COALESCE(t.max_players,3) AS max_players,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL) AS live_seats,
           EXISTS(SELECT 1 FROM public.table_seats s
              JOIN public.tables tb ON tb.id=s.table_id
             WHERE tb.tournament_id=t.id AND s.left_at IS NULL
               AND s.joined_at < now()-make_interval(mins=>v_minutes)) AS has_expired_waiter,
           EXISTS(SELECT 1 FROM public.spin_reserve_ledger l
             WHERE l.tournament_id=t.id AND l.kind='jackpot_draw')
             OR EXISTS(SELECT 1 FROM public.spin_draw_receipts r
               WHERE r.tournament_id=t.id) AS has_booked_draw
      INTO v_current FROM public.tournaments t WHERE t.id=g.id;
    -- A drawn Spin is never expired. tournaments.spin_multiplier has DEFAULT 0
    -- and the seat-first creator omits the column, so `IS NOT NULL` read every
    -- undrawn Spin as drawn and this sweep expired nothing since 2026-09-08.
    -- Every other reader uses COALESCE(...,0) > 0 (2026-09-10, C-stuck-spins D3).
    IF v_current.variant IS DISTINCT FROM 'spin'
       OR v_current.status NOT IN ('REGISTERING','ANNOUNCED')
       OR v_current.status IS NULL OR v_current.started_at IS NOT NULL
       OR v_current.live_seats >= v_current.max_players
       OR NOT v_current.has_expired_waiter
       OR COALESCE(v_current.spin_multiplier, 0) > 0 OR v_current.has_booked_draw THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    BEGIN
      res := public.atomic_cancel_tournament(g.id, NULL);
      v_expired := v_expired + 1;
      v_refunded := v_refunded + (COALESCE(v_current.buy_in_amount, 0) * COALESCE(v_current.live_seats, 0));
      v_ids := v_ids || to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      -- Loud, never fatal: one stuck game must not stop the rest being freed.
      v_failed := v_failed + 1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %', g.id, SQLERRM;
    END;
    -- The counter derives from the seats either way (see 20260830110000).
    PERFORM public.fn_sync_seat_first_player_count(g.id);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'expired', v_expired,
    'failed', v_failed,
    'skipped_raced', v_skipped,
    'chips_refunded_estimate', round(v_refunded, 2),
    'timeout_minutes', v_minutes,
    'tournament_ids', v_ids);
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer) TO postgres, service_role;
DO $verify$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_guard_watchlist()'::regprocedure
    AND md5(pg_get_functiondef(p.oid))='92ee208d0887728444bda396d0b4d442' AND pg_get_userbyid(p.proowner)='postgres'
    AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'missing function catalog mismatch: fn_ca_guard_watchlist()'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_spin_expire_unfilled(integer)'::regprocedure
    AND md5(pg_get_functiondef(p.oid))='cda7ea3e231248f1d2b597c74e04bb72' AND pg_get_userbyid(p.proowner)='postgres'
    AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'missing function catalog mismatch: fn_spin_expire_unfilled(integer)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.ca_guard_def_history'::regclass
    AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relacl::text='{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}')
    OR (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_guard_def_history'::regclass AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM '[{"name":"id","type":"bigint","notnull":true,"default":"nextval(''ca_guard_def_history_id_seq''::regclass)"},{"name":"proname","type":"text","notnull":true,"default":null},{"name":"def_hash","type":"text","notnull":true,"default":null},{"name":"def_text","type":"text","notnull":true,"default":null},{"name":"captured_at","type":"timestamp with time zone","notnull":true,"default":"now()"}]'::jsonb
    OR (SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true)) ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid='public.ca_guard_def_history'::regclass) IS DISTINCT FROM '[{"name":"ca_guard_def_history_pkey","definition":"PRIMARY KEY (id)"}]'::jsonb
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.ca_guard_def_history'::regclass)
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ca_guard_def_history'::regclass AND NOT tgisinternal)
    THEN RAISE EXCEPTION 'missing table catalog mismatch: public.ca_guard_def_history'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.ca_guard_defs'::regclass
    AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relacl::text='{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}')
    OR (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.ca_guard_defs'::regclass AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM '[{"name":"proname","type":"text","notnull":true,"default":null},{"name":"def_hash","type":"text","notnull":true,"default":null},{"name":"updated_at","type":"timestamp with time zone","notnull":true,"default":"now()"},{"name":"declared_ref","type":"text","notnull":false,"default":null},{"name":"declared_at","type":"timestamp with time zone","notnull":false,"default":null}]'::jsonb
    OR (SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true)) ORDER BY c.conname) FROM pg_constraint c WHERE c.conrelid='public.ca_guard_defs'::regclass) IS DISTINCT FROM '[{"name":"ca_guard_defs_pkey","definition":"PRIMARY KEY (proname)"}]'::jsonb
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.ca_guard_defs'::regclass)
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ca_guard_defs'::regclass AND NOT tgisinternal)
    THEN RAISE EXCEPTION 'missing table catalog mismatch: public.ca_guard_defs'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.ca_guard_def_history_id_seq'::regclass AND pg_get_userbyid(c.relowner)='postgres' AND c.relacl::text='{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}') OR NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid='public.ca_guard_def_history_id_seq'::regclass AND d.refclassid='pg_class'::regclass AND d.refobjid='public.ca_guard_def_history'::regclass AND d.refobjsubid=1 AND d.deptype='a') THEN RAISE EXCEPTION 'history sequence authority mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM public.ca_guard_defs) OR EXISTS(SELECT 1 FROM public.ca_guard_def_history) THEN RAISE EXCEPTION 'isolated baseline unexpectedly populated'; END IF;
END $verify$;
COMMIT;
