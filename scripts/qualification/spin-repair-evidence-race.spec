# SOURCE ONLY / UNRUN. PostgreSQL 17 isolationtester input, not a receipt.
# Use a separately admitted empty allocation, never the primary SQL allocation.
# The protected executor supplies qualification.execution_uuid on all connections.
# Expect repair_call to WAIT on claimant, then resume after claim_commit.
# The owner must reject unexpected SQL errors/wait order even if the runner exits0.
# No teardown drops shared objects. The allocation owner must independently close
# every connection, capture receipts and destroy this exact disposable database.

setup
{
DO $admission$
DECLARE v_id text := current_setting('qualification.execution_uuid',true);
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_spin_' || replace(v_id,'-','')
     OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
     OR session_user <> 'postgres' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
     OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','f'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
     OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN
    RAISE EXCEPTION 'Requires protected empty disposable PostgreSQL 17 qualification allocation';
  END IF;
END;
$admission$;

SET statement_timeout='15s';
SET lock_timeout='8s';
SET timezone='UTC';
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,name text NOT NULL,club_id uuid,prize_pool numeric(18,2),
  buy_in_amount numeric(15,2) NOT NULL,started_at timestamptz,created_at timestamptz,
  ended_at timestamptz,variant text,status text NOT NULL,spin_multiplier numeric,
  is_premium_spin boolean);
CREATE TABLE public.spin_reserve_ledger (
  id uuid PRIMARY KEY,tournament_id uuid,kind text NOT NULL,multiplier numeric,
  created_at timestamptz NOT NULL,original_evidence jsonb);
CREATE TABLE public.financial_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),severity text NOT NULL,
  source text NOT NULL,message text NOT NULL,context jsonb,resolved boolean NOT NULL DEFAULT false);
CREATE TABLE public.ca_guard_defs (proname text PRIMARY KEY);

-- SOURCE ONLY. Exact captured target/dependency definitions; qualification only.
CREATE OR REPLACE FUNCTION public.fn_spin_repair_missing_multiplier(p_lookback_mins integer DEFAULT 1440)
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
;
ALTER FUNCTION public.fn_spin_repair_missing_multiplier(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_repair_missing_multiplier(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_financial_alert_to_incident()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dedupe text;
  v_echo_id uuid;
  v_severity text;
  v_shape text;
BEGIN
  IF NEW.severity <> 'critical' THEN RETURN NEW; END IF;
  IF NEW.source LIKE 'drift_incident:%' THEN RETURN NEW; END IF;

  /* A REFUSED HAND IS A RATE, NOT AN INCIDENT (2026-09-09). */
  IF NEW.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
     OR COALESCE(NEW.context->>'error', '') LIKE '%authoritative_hand_semantic_refusal%' THEN
    RETURN NEW;
  END IF;

  /* A HANDOFF THAT NAMES ITS SUCCESSOR IS NOT AN INCIDENT (2026-09-10). */
  IF NEW.source = 'ServerTableEngine.post_commit_obligations_pending' THEN
    RETURN NEW;
  END IF;

  /* ONE CAUSE IS ONE INCIDENT (2026-09-09). The key is the SHAPE of the
     finding, not its instance. */
  v_shape := public.fn_ca_normalize_alert_text(left(NEW.message, 200))
             || '|' ||
             public.fn_ca_normalize_alert_text(left(COALESCE(NEW.context->>'error', ''), 200));

  v_dedupe := CASE
      -- A failed leave can strand this table/hand's stack obligation. Keep its
      -- exact entity; normalizing hand numbers must not merge another leave.
      WHEN NEW.source = 'postHandTasks.leave_pending_failed'
        THEN 'fa:postHandTasks.leave_pending_failed:'
          || CASE
              WHEN jsonb_typeof(NEW.context->'table_id') = 'string'
               AND (NEW.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
               AND jsonb_typeof(NEW.context->'hand_number') = 'number'
               AND (NEW.context->>'hand_number') ~ '^[1-9][0-9]*$'
               AND (length(NEW.context->>'hand_number') < 19
                    OR (length(NEW.context->>'hand_number') = 19
                        AND (NEW.context->>'hand_number') COLLATE "C" <= '9223372036854775807'))
              THEN 'table:' || (NEW.context->>'table_id')::uuid::text
                   || ':hand:' || (NEW.context->>'hand_number')
              ELSE 'alert:' || NEW.id::text
             END
          || ':' || md5(v_shape)
      -- A terminal refusal belongs to one tournament. Normalizing the error
      -- removes its UUID; shape-only folding then mixes different events.
      -- Without an entity, retain the original alert as its own unknown.
      WHEN NEW.source = 'Tournament.atomic_finish_refused'
        THEN 'fa:Tournament.atomic_finish_refused:'
          || COALESCE(NULLIF(lower(NEW.context->>'tournament_id'), ''),
                      'alert:' || NEW.id::text)
          || ':' || md5(v_shape)
      WHEN NEW.source ~* 'prize_credit_failed' AND NULLIF(NEW.context->>'tournament_id','') IS NOT NULL
        THEN 'fa:prize_credit_failed:' || (NEW.context->>'tournament_id')
      ELSE 'fa:' || NEW.source || ':' || md5(v_shape) END;

  SELECT i.id INTO v_echo_id FROM public.ca_drift_incidents i
   WHERE i.dedupe_key = v_dedupe AND i.status = 'resolved'
     AND i.resolved_at > now() - interval '48 hours'
     AND i.suspected_cause = left(NEW.message, 300)
   ORDER BY i.resolved_at DESC LIMIT 1;
  IF v_echo_id IS NOT NULL THEN
    UPDATE public.ca_drift_incidents SET occurrences = occurrences + 1 WHERE id = v_echo_id;
    INSERT INTO public.ca_incident_events (incident_id, at, kind, actor_label, detail)
    VALUES (v_echo_id, now(), 'comment', 'system',
            jsonb_build_object('note', 'Byte-identical echo of this resolved incident re-reported by '
              || NEW.source || '; folded without re-paging (alert ' || NEW.id || ').'));
    RETURN NEW;
  END IF;

  /* A DRIFT INCIDENT IS CRITICAL WHEN CHIPS ARE AT STAKE (2026-09-10). */
  v_severity := CASE
      WHEN NEW.source ~* 'conservation' THEN 'info'
      /* THE ENGINE ALREADY DECIDED THIS ONE (2026-09-12, incident bf4ef6e0).
         ServerTableEngineSettlement.runStep raises a financial alert ONLY when
         its moneyCritical argument is true, so every postHandTasks.* row here
         is already filtered to "this moves chips" - the five steps that move
         none (promo_playthrough, horse_rebuys, chip_continuity, horse_cashouts,
         deferred_sitouts) never arrive. Re-deciding it in SQL downgraded all of
         them, on two broken tests: a source-name scan for money words, which
         'leave_pending' fails while returning a player's whole stack to their
         wallet; and COALESCE(discrepancy, amount, 0) = 0 as proof of zero, when
         runStep writes neither key - 0 of 1,551 alerts in seven days carry one,
         so the test was unconditionally true and this branch could only ever
         return info. And info is not a colour: fn_ca_raise_drift_incident opens
         with IF p_severity = 'info' THEN NULL, so six failures across six
         tables paged nobody. When the engine asserts moves_chips in the
         context, that fact decides; absent, critical, because absent must fail
         toward being seen. Compared as text rather than cast to boolean on
         purpose: this trigger ends in EXCEPTION WHEN OTHERS ... RETURN NEW, so
         a bad cast would silently stop creating incidents rather than raise. */
      WHEN NEW.source LIKE 'postHandTasks.%'
        THEN CASE WHEN lower(COALESCE(NEW.context->>'moves_chips','true')) IN ('false','f','0')
                  THEN 'info' ELSE 'critical' END
      WHEN NEW.source LIKE 'ServerTableEngine.%'
           AND NOT (NEW.source ~* 'prize|payout|bounty|rake|treasury|guarantee|insurance|bbj|rakeback')
           AND COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                        NULLIF(NEW.context->>'amount','')::numeric, 0) = 0
        THEN 'info'
      WHEN NEW.source ~* 'prize_credit_failed'
           AND NULLIF(NEW.context->>'user_id','') IS NOT NULL
           AND public.fn_ca_is_cert_account((NEW.context->>'user_id')::uuid) THEN 'info'
      ELSE 'critical' END;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source         => 'financial_alerts:' || NEW.source,
    p_classification => CASE
        WHEN NEW.source ~* 'rake'                   THEN 'incorrect_rake'
        WHEN NEW.source ~* 'bbj'                    THEN 'bbj_error'
        WHEN NEW.source ~* 'rakeback'               THEN 'incorrect_rakeback'
        WHEN NEW.source ~* 'treasury|guarantee'     THEN 'treasury_error'
        WHEN NEW.source ~* 'payout|prize|bounty'    THEN 'settlement_error'
        WHEN NEW.source ~* 'insurance'              THEN 'settlement_error'
        WHEN NEW.source ~* 'conservation'           THEN 'ledger_imbalance'
        ELSE 'unknown' END,
    p_severity       => v_severity,
    p_dedupe_key     => v_dedupe,
    p_discrepancy    => COALESCE(NULLIF(NEW.context->>'discrepancy','')::numeric,
                                 NULLIF(NEW.context->>'amount','')::numeric, 0),
    p_layer          => 'ledger',
    p_club_id        => NULLIF(NEW.context->>'club_id','')::uuid,
    p_tournament_id  => NULLIF(NEW.context->>'tournament_id','')::uuid,
    p_table_id       => CASE WHEN NEW.source = 'postHandTasks.leave_pending_failed'
                            THEN CASE WHEN jsonb_typeof(NEW.context->'table_id') = 'string'
                                       AND (NEW.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                      THEN (NEW.context->>'table_id')::uuid
                                      ELSE NULL::uuid END
                            ELSE NULLIF(NEW.context->>'table_id','')::uuid END,
    p_suspected_cause => left(NEW.message, 300),
    p_metadata       => COALESCE(NEW.context,'{}'::jsonb) ||
                        jsonb_build_object('alert_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_financial_alert_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$
;
ALTER FUNCTION public.fn_ca_financial_alert_to_incident() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_financial_alert_to_incident() TO service_role;

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
ALTER FUNCTION public.fn_ca_guard_watchlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO service_role;


-- SOURCE ONLY / UNRUN. Exact guarded installation; never an automatic migration.
-- No repair invocation or financial/history/status rewrite. Native owner must
-- qualify exact bytes and compose the captured bridge dependency before admission.
DO $component$
DECLARE
  v_rollback constant boolean := false;
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

CREATE TABLE public.qualification_spin_race_results(result jsonb NOT NULL);
INSERT INTO public.tournaments VALUES
 ('40000000-0000-4000-8000-000000000001','modeled concurrent CAS',NULL,
  3,1,now()-interval'5 minutes',now()-interval'5 minutes',NULL,'spin','RUNNING',NULL,false);
}

session "claimant"
setup { SET statement_timeout='15s'; SET lock_timeout='8s'; }
step "claim_begin" { BEGIN; }
step "claim_write" {
  UPDATE public.tournaments SET spin_multiplier=5
   WHERE id='40000000-0000-4000-8000-000000000001'
     AND spin_multiplier IS NULL;
}
step "claim_commit" { COMMIT; }

session "repair"
setup { SET statement_timeout='15s'; SET lock_timeout='8s'; }
step "repair_call" {
  INSERT INTO public.qualification_spin_race_results(result)
  SELECT public.fn_spin_repair_missing_multiplier(60);
}
step "repair_assert" {
  DO $assert$
  BEGIN
    IF (SELECT count(*)=1 AND bool_and(result=jsonb_build_object(
         'ok',true,'repaired',0,'unreconstructable',0,'paid_over_drawn_count',0,
         'repaired_outside_window',0,'lost_the_race',1,'lookback_mins',60))
        FROM public.qualification_spin_race_results) IS DISTINCT FROM true
       OR (SELECT count(*)=1 AND bool_and(spin_multiplier=5 AND is_premium_spin=false
            AND prize_pool=3 AND buy_in_amount=1 AND status='RUNNING')
           FROM public.tournaments) IS DISTINCT FROM true
       OR EXISTS (SELECT 1 FROM public.financial_alerts)
       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger) THEN
      RAISE EXCEPTION 'CAS race: competing stamp, exact counters or no-alert/no-money invariant failed';
    END IF;
  END;
  $assert$;
  SELECT 'spin-repair-evidence-cas-race' stage,result,
         current_database() allocation,
         current_setting('qualification.execution_uuid') execution_uuid
    FROM public.qualification_spin_race_results;
}
step "restore_preimage" {
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

  DO $assert$
  BEGIN
    IF md5(pg_get_functiondef('public.fn_spin_repair_missing_multiplier(integer)'::regprocedure))
        IS DISTINCT FROM '833c06b59dfdd8fd29b74cce0c6be6a2' THEN
      RAISE EXCEPTION 'CAS race: captured target was not restored';
    END IF;
  END;
  $assert$;
}

permutation "claim_begin" "claim_write" "repair_call" "claim_commit" "repair_assert" "restore_preimage"

