-- SOURCE ONLY / UNRUN. Exact guarded rollback; never an automatic migration.
-- No repair invocation or financial/history/status rewrite. Native owner must
-- qualify exact bytes and compose the captured bridge dependency before admission.
DO $component$
DECLARE
  v_rollback constant boolean := true;
  v_pre constant text := $captured_pre$CREATE OR REPLACE FUNCTION public.fn_spin_repair_missing_multiplier(p_lookback_mins integer DEFAULT 1440)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- MIRRORS server/src/config/spinSpec.ts SPIN_TIERS. Pinned by
  -- tests/config/spinNullMultiplierRepair.test.ts.
  v_tiers    numeric[] := ARRAY[2, 3, 4, 5, 10, 25, 50, 100];
  v_t        record;
  v_ratio    numeric;
  v_witness  numeric;
  v_use      numeric;
  v_source   text;
  v_overpaid numeric;
  v_hit      integer;
  v_fixed    integer := 0;
  v_flag     integer := 0;
  v_over     integer := 0;
  v_aged     integer := 0;
  v_raced    integer := 0;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.prize_pool, t.buy_in_amount,
           t.started_at, t.created_at,
           d.multiplier AS witness,
           (COALESCE(t.started_at, t.created_at)
              <= now() - make_interval(mins => GREATEST(p_lookback_mins, 1))) AS outside_window
      FROM public.tournaments t
      LEFT JOIN LATERAL (
        SELECT l.multiplier
          FROM public.spin_reserve_ledger l
         WHERE l.tournament_id = t.id
           AND l.kind = 'jackpot_draw'
           AND COALESCE(l.multiplier, 0) > 0
         ORDER BY l.created_at ASC
         LIMIT 1) d ON true
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING', 'COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) <= 0
       -- A spin that never stamped a start is the spin MOST likely to have
       -- lost its draw. Gating on a bare started_at hid exactly the rows this
       -- function exists to repair, for four days.
       AND COALESCE(t.started_at, t.created_at) IS NOT NULL
       AND (
         COALESCE(t.started_at, t.created_at)
           > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
         -- AT ANY AGE when the reserve ledger already booked a draw: such a row
         -- is broken by definition and the window must not bound it.
         -- Self-draining, so it cannot become an unbounded scan.
         OR d.multiplier IS NOT NULL
       )
  LOOP
    v_witness := v_t.witness;
    IF v_t.outside_window THEN
      v_aged := v_aged + 1;
    END IF;

    v_ratio := NULL;
    IF COALESCE(v_t.buy_in_amount, 0) > 0 AND COALESCE(v_t.prize_pool, 0) > 0 THEN
      v_ratio := round(v_t.prize_pool / v_t.buy_in_amount, 4);
    END IF;

    -- THE WITNESS FIRST. fn_spin_settle_game stamps the multiplier it drew on
    -- the jackpot_draw row at the instant of the draw. The pool ratio equals it
    -- only once the draw has been applied to the pool, which on a spin that
    -- lost its stamp it has not been.
    IF v_witness IS NOT NULL AND v_witness = ANY (v_tiers) THEN
      v_use := v_witness; v_source := 'spin_reserve_ledger.jackpot_draw';
    ELSIF v_ratio IS NOT NULL AND v_ratio = ANY (v_tiers) THEN
      v_use := v_ratio;   v_source := 'prize_pool / buy_in_amount';
    ELSE
      v_use := NULL;      v_source := NULL;
    END IF;

    IF v_use IS NOT NULL THEN
      UPDATE public.tournaments
         SET spin_multiplier  = v_use,
             is_premium_spin  = (v_use >= 100)
       WHERE id = v_t.id
         AND COALESCE(spin_multiplier, 0) <= 0;
      -- A GUARDED UPDATE THAT MATCHES NOTHING IS NOT A REPAIR. Two crons drive
      -- this function under different advisory locks, so the row can be stamped
      -- between the SELECT and here. Counting that as a fix - and filing an
      -- alert for it - is a lie about work that another pass did.
      GET DIAGNOSTICS v_hit = ROW_COUNT;
      IF v_hit = 0 THEN
        v_raced := v_raced + 1;
        CONTINUE;
      END IF;
      v_fixed := v_fixed + 1;

      -- The pool that was PAID, against the draw that was made. A positive gap
      -- is money already in a player's wallet: 10.9 rule 3 keeps it there and
      -- requires it to be reported rather than reversed.
      v_overpaid := round(COALESCE(v_t.prize_pool, 0) - (v_use * COALESCE(v_t.buy_in_amount, 0)), 2);
      IF v_overpaid > 0 THEN
        v_over := v_over + 1;
      END IF;

      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (CASE WHEN v_overpaid > 0 THEN 'warning' ELSE 'info' END,
              'fn_spin_repair_missing_multiplier',
              CASE WHEN v_overpaid > 0
                   THEN 'Spin lost its draw stamp; multiplier restored from the reserve ledger, and '
                        || v_overpaid || ' paid over the draw is absorbed by the house (10.9 rule 3): '
                        || COALESCE(v_t.name, v_t.id::text)
                   ELSE 'Spin lost its draw stamp; multiplier restored from the reserve ledger: '
                        || COALESCE(v_t.name, v_t.id::text) END,
              jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                 'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                 'reconstructed_multiplier', v_use,
                                 'reconstructed_from', v_source,
                                 'ledger_witness_multiplier', v_witness,
                                 'pool_ratio', v_ratio,
                                 'paid_over_drawn', v_overpaid,
                                 'clawed_back', false,
                                 'outside_lookback_window', v_t.outside_window,
                                 'started_at', v_t.started_at,
                                 'created_at', v_t.created_at));
    ELSE
      v_flag := v_flag + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_spin_repair_missing_multiplier',
             'Spin ran without a draw and the multiplier cannot be reconstructed: '
               || COALESCE(v_t.name, v_t.id::text),
             jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                'implied_ratio', v_ratio,
                                'ledger_witness_multiplier', v_witness,
                                'started_at', v_t.started_at, 'created_at', v_t.created_at,
                                'detail', 'needs a human decision; no multiplier was invented')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts
          WHERE source = 'fn_spin_repair_missing_multiplier'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_t.id::text);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'repaired', v_fixed,
                            'unreconstructable', v_flag,
                            'paid_over_drawn_count', v_over,
                            'repaired_outside_window', v_aged,
                            'lost_the_race', v_raced,
                            'lookback_mins', p_lookback_mins);
END;
$function$
$captured_pre$;
  v_post constant text := $candidate_post$CREATE OR REPLACE FUNCTION public.fn_spin_repair_missing_multiplier(p_lookback_mins integer DEFAULT 1440)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- MIRRORS server/src/config/spinSpec.ts SPIN_TIERS. Pinned by
  -- tests/config/spinNullMultiplierRepair.test.ts.
  v_tiers    numeric[] := ARRAY[2, 3, 4, 5, 10, 25, 50, 100];
  v_t        record;
  v_ratio    numeric;
  v_witness  numeric;
  v_use      numeric;
  v_source   text;
  v_overpaid numeric;
  v_hit      integer;
  v_fixed    integer := 0;
  v_flag     integer := 0;
  v_over     integer := 0;
  v_aged     integer := 0;
  v_raced    integer := 0;
BEGIN
  FOR v_t IN
    SELECT t.id, t.name, t.club_id, t.prize_pool, t.buy_in_amount,
           t.started_at, t.created_at, t.ended_at,
           d.multiplier AS witness, d.id AS witness_id,
           d.created_at AS witness_created_at,
           (COALESCE(t.started_at, t.created_at)
              <= now() - make_interval(mins => GREATEST(p_lookback_mins, 1))) AS outside_window
      FROM public.tournaments t
      LEFT JOIN LATERAL (
        SELECT l.id, l.multiplier, l.created_at
          FROM public.spin_reserve_ledger l
         WHERE l.tournament_id = t.id
           AND l.kind = 'jackpot_draw'
           AND COALESCE(l.multiplier, 0) > 0
         ORDER BY l.created_at ASC
         LIMIT 1) d ON true
     WHERE t.variant = 'spin'
       AND t.status IN ('RUNNING', 'COMPLETED')
       AND COALESCE(t.spin_multiplier, 0) <= 0
       -- A spin that never stamped a start is the spin MOST likely to have
       -- lost its draw. Gating on a bare started_at hid exactly the rows this
       -- function exists to repair, for four days.
       AND COALESCE(t.started_at, t.created_at) IS NOT NULL
       AND (
         COALESCE(t.started_at, t.created_at)
           > now() - make_interval(mins => GREATEST(p_lookback_mins, 1))
         -- AT ANY AGE when the reserve ledger already booked a draw: such a row
         -- is broken by definition and the window must not bound it.
         -- Self-draining, so it cannot become an unbounded scan.
         OR d.multiplier IS NOT NULL
       )
  LOOP
    v_witness := v_t.witness;
    IF v_t.outside_window THEN
      v_aged := v_aged + 1;
    END IF;

    v_ratio := NULL;
    IF COALESCE(v_t.buy_in_amount, 0) > 0 AND COALESCE(v_t.prize_pool, 0) > 0 THEN
      v_ratio := round(v_t.prize_pool / v_t.buy_in_amount, 4);
    END IF;

    -- Preserve booking-first selection. A reserve row records a booked
    -- multiplier; it can be written after play using an earlier reconstruction.
    -- Neither this row nor a pool ratio establishes the original random draw.
    IF v_witness IS NOT NULL AND v_witness = ANY (v_tiers) THEN
      v_use := v_witness; v_source := 'spin_reserve_ledger.jackpot_draw';
    ELSIF v_ratio IS NOT NULL AND v_ratio = ANY (v_tiers) THEN
      v_use := v_ratio;   v_source := 'prize_pool / buy_in_amount';
    ELSE
      v_use := NULL;      v_source := NULL;
    END IF;

    IF v_use IS NOT NULL THEN
      UPDATE public.tournaments
         SET spin_multiplier  = v_use,
             is_premium_spin  = (v_use >= 100)
       WHERE id = v_t.id
         AND COALESCE(spin_multiplier, 0) <= 0;
      -- A GUARDED UPDATE THAT MATCHES NOTHING IS NOT A REPAIR. Two crons drive
      -- this function under different advisory locks, so the row can be stamped
      -- between the SELECT and here. Counting that as a fix - and filing an
      -- alert for it - is a lie about work that another pass did.
      GET DIAGNOSTICS v_hit = ROW_COUNT;
      IF v_hit = 0 THEN
        v_raced := v_raced + 1;
        CONTINUE;
      END IF;
      v_fixed := v_fixed + 1;

      -- Keep the legacy arithmetic and field name for compatibility. This is
      -- recorded pool minus buy-in times the selected multiplier. No wallet
      -- or immutable RNG receipt is read here; payment and RNG remain unknown.
      v_overpaid := round(COALESCE(v_t.prize_pool, 0) - (v_use * COALESCE(v_t.buy_in_amount, 0)), 2);
      IF v_overpaid > 0 THEN
        v_over := v_over + 1;
      END IF;

      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES (CASE WHEN v_overpaid > 0 THEN 'warning' ELSE 'info' END,
              'fn_spin_repair_missing_multiplier',
              CASE WHEN v_source = 'spin_reserve_ledger.jackpot_draw'
                   THEN 'Spin multiplier restored from a recorded reserve booking'
                   ELSE 'Spin multiplier reconstructed from the recorded prize-pool/buy-in ratio'
              END
              || '; original RNG not established by this repair'
              || CASE WHEN v_overpaid > 0
                      THEN '; recorded pool exceeds the selected multiplier amount by '
                           || v_overpaid || ' (payment not verified; no clawback)'
                      ELSE '' END
              || ': ' || COALESCE(v_t.name, v_t.id::text),
              jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                 'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                 'reconstructed_multiplier', v_use,
                                 'reconstructed_from', v_source,
                                 'ledger_witness_multiplier', v_witness,
                                 'pool_ratio', v_ratio,
                                 'paid_over_drawn', v_overpaid,
                                 'clawed_back', false,
                                 'evidence_version', 1,
                                 'rng_evidence', 'not_established_by_this_repair',
                                 'payment_evidence', 'not_established_by_this_repair',
                                 'amount_basis', 'recorded_pool_minus_buy_in_times_selected_multiplier',
                                 'pool_minus_selected_multiplier_amount', v_overpaid,
                                 'reserve_booking_id', v_t.witness_id,
                                 'reserve_booking_created_at', v_t.witness_created_at,
                                 'reserve_booking_used', v_source = 'spin_reserve_ledger.jackpot_draw',
                                 'reserve_booking_timing', CASE
                                   WHEN v_t.witness_id IS NULL THEN 'not_observed'
                                   WHEN v_t.ended_at IS NOT NULL
                                     AND v_t.witness_created_at > v_t.ended_at
                                     THEN 'after_recorded_end'
                                   WHEN v_t.started_at IS NOT NULL
                                     AND v_t.witness_created_at > v_t.started_at
                                     THEN 'after_recorded_start'
                                   WHEN v_t.started_at IS NOT NULL
                                     THEN 'at_or_before_recorded_start'
                                   ELSE 'game_time_unknown' END,
                                 'ended_at', v_t.ended_at,
                                 'outside_lookback_window', v_t.outside_window,
                                 'started_at', v_t.started_at,
                                 'created_at', v_t.created_at));
    ELSE
      v_flag := v_flag + 1;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_spin_repair_missing_multiplier',
             'Spin ran without a draw and the multiplier cannot be reconstructed: '
               || COALESCE(v_t.name, v_t.id::text),
             jsonb_build_object('tournament_id', v_t.id, 'club_id', v_t.club_id,
                                'buy_in', v_t.buy_in_amount, 'prize_pool', v_t.prize_pool,
                                'implied_ratio', v_ratio,
                                'ledger_witness_multiplier', v_witness,
                                'started_at', v_t.started_at, 'created_at', v_t.created_at,
                                'detail', 'needs a human decision; no multiplier was invented')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts
          WHERE source = 'fn_spin_repair_missing_multiplier'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_t.id::text);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'repaired', v_fixed,
                            'unreconstructable', v_flag,
                            'paid_over_drawn_count', v_over,
                            'repaired_outside_window', v_aged,
                            'lost_the_race', v_raced,
                            'lookback_mins', p_lookback_mins);
END;
$function$
$candidate_post$;
  v_oid oid;
  v_actual text;
  v_target text;
  v_dep record;
  v_pass integer;
BEGIN
  PERFORM set_config('search_path','public',true);
  PERFORM set_config('lock_timeout','3s',true);
  PERFORM set_config('statement_timeout','10s',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('component:spin-repair-evidence',0));
  IF current_user <> 'postgres' OR md5(v_pre) <> '833c06b59dfdd8fd29b74cce0c6be6a2' THEN
    RAISE EXCEPTION 'spin repair evidence: owner or bundled preimage mismatch';
  END IF;
  v_oid := to_regprocedure('public.fn_spin_repair_missing_multiplier(integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'spin repair evidence: missing exact target'; END IF;
  v_actual := pg_get_functiondef(v_oid);
  IF v_actual IS DISTINCT FROM v_pre AND v_actual IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'spin repair evidence: unknown function preimage/postimage';
  END IF;
  v_target := CASE WHEN v_rollback THEN v_pre ELSE v_post END;
  -- Relation locks prevent consumed column/PK changes while these guards run.
  -- Exclusive protected DDL admission is still required for noncooperating writers.
  LOCK TABLE public.tournaments, public.spin_reserve_ledger, public.financial_alerts
    IN ACCESS SHARE MODE;
  FOR v_pass IN 1..2 LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
        AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
        AND NOT p.proisstrict AND p.provolatile='v' AND p.proparallel='u'
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}')
       OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
             AND proname='fn_spin_repair_missing_multiplier') <> 1 THEN
      RAISE EXCEPTION 'spin repair evidence: target authority/overload drift';
    END IF;
    FOR v_dep IN SELECT * FROM (VALUES
      ('spin_reserve_ledger','id','uuid',true),
      ('spin_reserve_ledger','tournament_id','uuid',false),
      ('spin_reserve_ledger','kind','text',true),
      ('spin_reserve_ledger','multiplier','numeric',false),
      ('spin_reserve_ledger','created_at','timestamp with time zone',true),
      ('financial_alerts','id','uuid',true),
      ('financial_alerts','severity','text',true),
      ('financial_alerts','source','text',true),
      ('financial_alerts','message','text',true),
      ('financial_alerts','context','jsonb',false),
      ('financial_alerts','resolved','boolean',true),
      ('tournaments','id','uuid',true),
      ('tournaments','name','text',true),
      ('tournaments','variant','text',false),
      ('tournaments','buy_in_amount','numeric(15,2)',true),
      ('tournaments','status','text',true),
      ('tournaments','created_at','timestamp with time zone',false),
      ('tournaments','club_id','uuid',false),
      ('tournaments','started_at','timestamp with time zone',false),
      ('tournaments','ended_at','timestamp with time zone',false),
      ('tournaments','prize_pool','numeric(18,2)',false),
      ('tournaments','spin_multiplier','numeric',false),
      ('tournaments','is_premium_spin','boolean',false)
    ) d(table_name,column_name,type_name,not_null) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute a
          WHERE a.attrelid=to_regclass('public.'||v_dep.table_name)
            AND a.attname=v_dep.column_name AND a.attnum>0 AND NOT a.attisdropped
            AND format_type(a.atttypid,a.atttypmod)=v_dep.type_name
            AND a.attnotnull=v_dep.not_null) THEN
        RAISE EXCEPTION 'spin repair evidence: consumed column drift %.%',
          v_dep.table_name,v_dep.column_name;
      END IF;
    END LOOP;
    FOR v_dep IN SELECT unnest(ARRAY['tournaments','spin_reserve_ledger','financial_alerts']) table_name LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint c
          WHERE c.conrelid=to_regclass('public.'||v_dep.table_name) AND c.contype='p'
            AND NOT c.condeferrable AND NOT c.condeferred
            AND pg_get_constraintdef(c.oid)='PRIMARY KEY (id)') THEN
        RAISE EXCEPTION 'spin repair evidence: identity PK drift %',v_dep.table_name;
      END IF;
    END LOOP;
    FOR v_dep IN SELECT * FROM (VALUES
      ('public.fn_ca_financial_alert_to_incident()','00a43ae03ab12cec9505e2bfed71d937',true,'{postgres=X/postgres,service_role=X/postgres}'),
      ('public.fn_ca_guard_watchlist()','92ee208d0887728444bda396d0b4d442',false,'{postgres=X/postgres,service_role=X/postgres}')
    ) d(signature,definition_md5,secdef,acl) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(v_dep.signature)
          AND md5(pg_get_functiondef(p.oid))=v_dep.definition_md5
          AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=v_dep.secdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
          AND p.proacl::text IS NOT DISTINCT FROM v_dep.acl) THEN
        RAISE EXCEPTION 'spin repair evidence: bridge/watchlist dependency drift %',v_dep.signature;
      END IF;
    END LOOP;
    IF 'fn_spin_repair_missing_multiplier'=ANY(public.fn_ca_guard_watchlist())
       OR EXISTS (SELECT 1 FROM public.ca_guard_defs WHERE proname='fn_spin_repair_missing_multiplier') THEN
      RAISE EXCEPTION 'spin repair evidence: target watchlist mode changed; declaration review required';
    END IF;
    IF v_pass=1 AND v_actual IS DISTINCT FROM v_target THEN EXECUTE v_target; END IF;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_target THEN
      RAISE EXCEPTION 'spin repair evidence: exact native target readback mismatch';
    END IF;
  END LOOP;
END;
$component$;

