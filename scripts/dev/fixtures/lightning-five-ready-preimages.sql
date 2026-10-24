-- Read-only production catalog captured 2026-10-23 for source-bound native transition qualification.
CREATE OR REPLACE FUNCTION public.fn_cash_game_create(p_club_id uuid, p_template text, p_variant text, p_sb numeric, p_bb numeric, p_handedness integer DEFAULT NULL::integer, p_overrides jsonb DEFAULT '{}'::jsonb, p_name text DEFAULT NULL::text, p_must_move boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: this club is managed by its union';
  END IF;

  -- ca-commerce-admission: opening a NEW table, and offering insurance on
  -- it, are prospective owner actions (R2 4.3, 6.3, D22). Shadow records and
  -- proceeds; enforced refuses here, before anything is written.
  DECLARE
    v_ca_admission jsonb;
    v_ca_insurance boolean;
  BEGIN
    v_ca_admission := public.fn_ca_commerce_admit('club', p_club_id, 'open_table', 'fn_cash_game_create', NULL);
    IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required';
    END IF;
    BEGIN
      v_ca_insurance := public.fn_cash_override_bool(COALESCE(p_overrides->'options', '{}'::jsonb), 'insurance_enabled', false);
    EXCEPTION WHEN OTHERS THEN
      v_ca_insurance := false;  -- the creator below refuses a malformed option in its own words
    END;
    IF v_ca_insurance THEN
      v_ca_admission := public.fn_ca_commerce_admit('club', p_club_id, 'club_insurance', 'fn_cash_game_create', NULL);
      IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
        RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required';
      END IF;
    END IF;
  END;

  RETURN public.fn_cash_game_create_impl_20260905(
    p_club_id, p_template, p_variant, p_sb, p_bb, p_handedness,
    p_overrides, p_name, p_must_move
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text, p_variant text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(coalesce(p_variant, 'nlh'));
  v_family text;
  v_seats integer; v_seats_locked boolean; v_seat_choices integer[];
  v_vpip integer; v_vpip_window integer;
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;

  v_family := CASE
    WHEN v_v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo'
    WHEN v_v = 'short_deck' THEN 'shortdeck'
    WHEN v_v = 'pineapple' THEN 'pineapple'
    ELSE 'holdem' END;

  IF v_family = 'plo' THEN
    v_seats := 6; v_seats_locked := true; v_seat_choices := ARRAY[6];
  ELSIF v_family = 'holdem' THEN
    IF v_t = 'classic' THEN v_seats := 9; v_seat_choices := ARRAY[9, 6];
    ELSE v_seats := 6; v_seat_choices := ARRAY[2,3,4,5,6,7,8,9]; END IF;
    v_seats_locked := false;
  ELSE
    v_seats := 6; v_seats_locked := false; v_seat_choices := ARRAY[2,3,4,5,6,7,8];
  END IF;

  -- VPIP floor per template (percent), FLAT ACROSS FAMILIES (Dan 2026-09-05).
  v_vpip := CASE v_t
    WHEN 'classic' THEN 0
    WHEN 'action'  THEN 30
    ELSE                50 END;
  v_vpip_window := 10;

  RETURN jsonb_build_object(
    'template', v_t,
    'variant', v_v,
    'family', v_family,
    'seats', v_seats,
    'seats_locked', v_seats_locked,
    'seat_choices', to_jsonb(v_seat_choices),
    'min_buyin_bb', CASE v_t WHEN 'classic' THEN 40 WHEN 'action' THEN 50 ELSE 100 END,
    'max_buyin_bb', 200,
    'regular_ante', CASE v_t WHEN 'classic' THEN 'none' WHEN 'action' THEN 'sb' ELSE 'bb' END,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object(
      'enabled', v_t <> 'classic',
      'trigger', CASE v_t WHEN 'action' THEN 'timed_20m' WHEN 'madness' THEN 'timed_10m' ELSE NULL END,
      'ante_bb', CASE v_t WHEN 'action' THEN 2 WHEN 'madness' THEN 3 ELSE NULL END,
      'boards', CASE WHEN v_t = 'classic' THEN NULL ELSE 2 END),
    'straddle', false,
    'stay_clock_min', 10,
    'rejoin_window_min', 120,
    'run_it_n_times', 'opt_in',
    'rake', 'existing'
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_config(p_cluster_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g          record;
  v_cfg      jsonb;
  v_inv      jsonb := '[]'::jsonb;
  v_thr      jsonb;
  v_on       integer;
  v_off      integer;
  v_size     integer;
  r          jsonb;
  v_text     text;
  v_version  text;
  v_mode     text;
  v_rule     text;
  v_p3       boolean;
  v_interval integer;
  v_budget   integer;
  v_keep     integer;
  v_max      integer;
  v_target   integer;
  v_min      integer;
  v_ttl      integer;
  v_form     integer;
  v_deal     integer;
  v_win_h    integer;
  v_win_s    integer;
  v_thin     integer;
  v_medium   integer;
  v_large    integer;
  v_w_large  numeric;
  v_w_medium numeric;
  v_mtl      integer;
  v_mtl_cfg  jsonb;
  v_mtl_obj  jsonb := '{}'::jsonb;
  v_mtl_p    text;
  v_batch    integer;
  v_replans  integer;
  v_found    boolean;
  v_row_wait integer;
  v_keep_h   integer;
  v_prune    integer;
  v_dwell    integer;
  v_disc     integer;
  v_ar_on    boolean;
  v_ar_trig  text;
  v_ar_bb    numeric;
  v_ar_pct   integer;
  v_ar_tgt   text;
  v_ar_max   integer;
  v_ar_cap   numeric;
  v_qw_def   jsonb;
  v_qw       jsonb;
  v_qw_cfg   jsonb;
  v_qw_k     text;
  v_qw_sum   numeric;
  v_sh_on    boolean;
  v_sh_ver   text;
  v_sh_win   integer;
  v_sh_max   integer;
  v_sh_bud   integer;
  v_it_on    boolean;
  v_lt_on    boolean;
  v_lt_win   integer;
  v_al_win   integer;
  v_al_stuck integer;
  v_al_drive integer;
  v_al_reap  integer;
  v_al_integ integer;
  v_al_lwin  integer;
  v_al_lmin  integer;
  v_lc_def   jsonb;
  v_lc       jsonb;
  v_lc_cfg   jsonb;
  v_lc_k     text;
  v_p13_drain    integer;
  v_p13_joins    boolean;
  v_p13_closed   timestamptz;
  v_p13_prev     text;
  v_p13_off      text[];
  v_p13_bad      boolean;
  v_p13_known    text[];
  v_p13_ff       boolean;
  v_p13_fw       boolean;
BEGIN
  SELECT cg.id, cg.handedness, cg.ruleset_snapshot INTO g
    FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  -- AN UNKNOWN CLUSTER still answers every key, at its default, with ok
  -- false: a client that reads only worker_mode reads 'off'.
  v_found := FOUND;

  v_cfg := CASE WHEN v_found THEN g.ruleset_snapshot -> 'lightning' END;
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg) = 'null' THEN
    v_cfg := '{}'::jsonb;
  ELSIF jsonb_typeof(v_cfg) <> 'object' THEN
    v_inv := v_inv || jsonb_build_object('key', 'lightning', 'given', v_cfg, 'reason', 'not_an_object');
    v_cfg := '{}'::jsonb;
  END IF;

  -- THE POPULATION'S OWN THRESHOLD READER, not a second copy of its rule.
  IF v_found THEN
    v_thr := public.fn_cash_cluster_lightning_thresholds(g.id);
  ELSE
    v_thr := public.fn_cash_cluster_lightning_thresholds_probe(NULL, 6);
  END IF;
  v_on  := (v_thr ->> 'on')::integer;
  v_off := (v_thr ->> 'off')::integer;
  v_size := LEAST(GREATEST(coalesce(g.handedness, 6), 2), 9);

  -- matcher_version: a short name, recorded on every hand.
  v_version := 'm1';
  IF v_cfg ? 'matcher_version' AND jsonb_typeof(v_cfg -> 'matcher_version') <> 'null' THEN
    v_text := CASE WHEN jsonb_typeof(v_cfg -> 'matcher_version') = 'string' THEN v_cfg ->> 'matcher_version' END;
    IF v_text IS NOT NULL AND v_text ~ '^[A-Za-z0-9._:-]{1,32}$' THEN
      v_version := v_text;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'matcher_version', 'given', v_cfg -> 'matcher_version',
                                           'reason', 'not_a_version_name', 'used', v_version);
    END IF;
  END IF;

  -- worker_mode: off (the default: the worker does nothing), shadow (plans
  -- and compares, forms nothing) or form.
  v_mode := 'off';
  IF v_cfg ? 'worker_mode' AND jsonb_typeof(v_cfg -> 'worker_mode') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'worker_mode') = 'string' AND (v_cfg ->> 'worker_mode') IN ('off', 'shadow', 'form') THEN
      v_mode := v_cfg ->> 'worker_mode';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'worker_mode', 'given', v_cfg -> 'worker_mode',
                                           'reason', 'not_off_shadow_or_form', 'used', v_mode);
    END IF;
  END IF;

  -- first_entry_rule: any_seat (the default) or big_blind (a player new to
  -- the Cluster's blind ledger is dealt in only as a big blind, while that
  -- does not cost the pass a hand).
  v_rule := 'any_seat';
  IF v_cfg ? 'first_entry_rule' AND jsonb_typeof(v_cfg -> 'first_entry_rule') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'first_entry_rule') = 'string' AND (v_cfg ->> 'first_entry_rule') IN ('any_seat', 'big_blind') THEN
      v_rule := v_cfg ->> 'first_entry_rule';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'first_entry_rule', 'given', v_cfg -> 'first_entry_rule',
                                           'reason', 'not_any_seat_or_big_blind', 'used', v_rule);
    END IF;
  END IF;

  -- position_fairness: P3 on or off. Advisory either way.
  v_p3 := true;
  IF v_cfg ? 'position_fairness' AND jsonb_typeof(v_cfg -> 'position_fairness') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'position_fairness') = 'boolean' THEN
      v_p3 := (v_cfg ->> 'position_fairness')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'position_fairness', 'given', v_cfg -> 'position_fairness',
                                           'reason', 'wrong_type', 'used', v_p3);
    END IF;
  END IF;

  r := public.fn_lightning_config_number(v_cfg, 'pass_interval_ms', 1000, 100, 60000, true);
  v_interval := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  r := public.fn_lightning_config_number(v_cfg, 'pass_time_budget_ms', LEAST(750, v_interval), 50, v_interval, true);
  v_budget := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  r := public.fn_lightning_config_number(v_cfg, 'keepalive_interval_ms', 5000, 500, 60000, true);
  v_keep := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- INSTANCE SIZE: the table size is the maximum and the target; the minimum
  -- is two, because a one-player Lightning instance must never exist.
  r := public.fn_lightning_config_number(v_cfg, 'instance_max', v_size, 2, v_size, true);
  v_max := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'instance_target', v_max, 2, v_max, true);
  v_target := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'instance_min', 2, 2, v_target, true);
  v_min := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- The barrier's and begin_dealing's own defaults and floors.
  r := public.fn_lightning_config_number(v_cfg, 'reservation_ttl_ms', 20000, 5000, 120000, true);
  v_ttl := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'form_window_ms', 45000, 5000, 300000, true);
  v_form := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'deal_window_ms', 600000, 30000, 3600000, true);
  v_deal := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- P5's memory: the Cluster's most recent hands, no older than the seconds.
  r := public.fn_lightning_config_number(v_cfg, 'recent_opponent_window_hands', 60, 1, 5000, true);
  v_win_h := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'recent_opponent_window_seconds', 900, 1, 86400, true);
  v_win_s := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- POOL-SIZE BANDS, by legal count: tiny below thin_min, thin below
  -- medium_min, medium below large_min, large from large_min. Defaults from
  -- the population's thresholds: OFF, ON and twice ON.
  r := public.fn_lightning_config_number(v_cfg, 'diversity_thin_min', v_off, 2, 100000, true);
  v_thin := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'diversity_medium_min', v_on, 2, 100000, true);
  v_medium := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'diversity_large_min', 2 * v_on, 2, 100000, true);
  v_large := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  IF NOT (v_thin <= v_medium AND v_medium <= v_large) THEN
    v_inv := v_inv || jsonb_build_object('key', 'diversity_bands',
      'given', jsonb_build_array(v_thin, v_medium, v_large), 'reason', 'bands_out_of_order',
      'used', jsonb_build_array(v_off, v_on, 2 * v_on));
    v_thin := v_off; v_medium := v_on; v_large := 2 * v_on;
  END IF;

  r := public.fn_lightning_config_number(v_cfg, 'diversity_weight_large', 1, 0, 1, false);
  v_w_large := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'diversity_weight_medium', 0.5, 0, 1, false);
  v_w_medium := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- Thin and tiny are zero by rule, not by default: a thin pool prioritises
  -- formation and a tiny one makes the hand if it is legal.
  IF v_cfg ? 'diversity_weight_thin' THEN
    v_inv := v_inv || jsonb_build_object('key', 'diversity_weight_thin', 'given', v_cfg -> 'diversity_weight_thin',
                                         'reason', 'zero_by_rule', 'used', 0);
  END IF;
  IF v_cfg ? 'diversity_weight_tiny' THEN
    v_inv := v_inv || jsonb_build_object('key', 'diversity_weight_tiny', 'given', v_cfg -> 'diversity_weight_tiny',
                                         'reason', 'zero_by_rule', 'used', 0);
  END IF;

  -- LIGHTNING PHASE 8 (20261007212735): THE LIMIT IS PER PLATFORM, an
  -- object {desktop, tablet, mobile}, defaults 4, 3 and 2, each 1..8. The old
  -- scalar is still read: a number is the limit of every platform.
  v_mtl_cfg := v_cfg -> 'multi_table_limit';
  IF v_mtl_cfg IS NOT NULL AND jsonb_typeof(v_mtl_cfg) = 'number' THEN
    r := public.fn_lightning_config_number(v_cfg, 'multi_table_limit', 4, 1, 8, true);
    v_mtl := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
    v_mtl_obj := jsonb_build_object('desktop', v_mtl, 'tablet', v_mtl, 'mobile', v_mtl);
  ELSE
    IF v_mtl_cfg IS NOT NULL AND jsonb_typeof(v_mtl_cfg) NOT IN ('object', 'null') THEN
      v_inv := v_inv || jsonb_build_object('key', 'multi_table_limit', 'given', v_mtl_cfg, 'reason', 'wrong_type',
                                           'used', jsonb_build_object('desktop', 4, 'tablet', 3, 'mobile', 2));
    END IF;
    IF v_mtl_cfg IS NULL OR jsonb_typeof(v_mtl_cfg) IS DISTINCT FROM 'object' THEN
      v_mtl_cfg := '{}'::jsonb;
    END IF;
    FOREACH v_mtl_p IN ARRAY ARRAY['desktop', 'tablet', 'mobile'] LOOP
      r := public.fn_lightning_config_number(v_mtl_cfg, v_mtl_p,
             CASE v_mtl_p WHEN 'desktop' THEN 4 WHEN 'tablet' THEN 3 ELSE 2 END, 1, 8, true);
      v_mtl_obj := v_mtl_obj || jsonb_build_object(v_mtl_p, (r ->> 'value')::integer);
      IF r ? 'invalid' THEN
        v_inv := v_inv || jsonb_set(r -> 'invalid', '{key}', to_jsonb('multi_table_limit.' || v_mtl_p));
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_mtl_cfg) k WHERE k NOT IN ('desktop', 'tablet', 'mobile')) THEN
      v_inv := v_inv || jsonb_build_object('key', 'multi_table_limit', 'given', v_mtl_cfg,
                                           'reason', 'unknown_platform', 'used', v_mtl_obj);
    END IF;
  END IF;
  -- The admission batch: the most hands one pass forms, so a join burst is
  -- admitted in deterministic micro-batches rather than all at once.
  r := public.fn_lightning_config_number(v_cfg, 'admission_batch_hands', 32, 1, 500, true);
  v_batch := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'max_replans', 3, 0, 20, true);
  v_replans := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- How long a pass waits for the Cluster row that something other than a
  -- pass holds (the tick, a conversion) before answering cluster_row_busy.
  r := public.fn_lightning_config_number(v_cfg, 'cluster_row_wait_ms', 200, 10, 2000, true);
  v_row_wait := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- 20261007222717: how long the OFF condition must stand before a
  -- population-triggered PENDING_OFF opens (0 disables the dwell; a disabled
  -- Cluster or game always drains at once).
  r := public.fn_lightning_config_number(v_cfg, 'pending_off_dwell_ms', 10000, 0, 3600000, true);
  v_dwell := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- The pass record's retention, pruned by the writer a bounded batch at a time.
  r := public.fn_lightning_config_number(v_cfg, 'pass_record_retention_hours', 168, 1, 8760, true);
  v_keep_h := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'pass_record_prune_batch', 100, 1, 10000, true);
  v_prune := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- LIGHTNING PHASE 9 (20261008050805): how long a reported disconnect may
  -- stand before fn_lightning_reap_expired_disconnects exits the pool
  -- session (never a player in a live hand). 30 seconds to 30 minutes.
  r := public.fn_lightning_config_number(v_cfg, 'disconnect_timeout_ms', 180000, 30000, 1800000, true);
  v_disc := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- LIGHTNING PHASE 10 (20261008111425): AUTO-REBUY, off unless the Cluster
  -- turns it on. The trigger names when fn_lightning_auto_rebuy fires (at
  -- zero, under a big-blind count, under a percentage of the target), the
  -- target names where the top-up aims (the session's starting stack or the
  -- table maximum), and the caps bound how many times and how much.
  v_ar_on := false;
  IF v_cfg ? 'auto_rebuy_enabled' AND jsonb_typeof(v_cfg -> 'auto_rebuy_enabled') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'auto_rebuy_enabled') = 'boolean' THEN
      v_ar_on := (v_cfg ->> 'auto_rebuy_enabled')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'auto_rebuy_enabled', 'given', v_cfg -> 'auto_rebuy_enabled',
                                           'reason', 'wrong_type', 'used', v_ar_on);
    END IF;
  END IF;
  v_ar_trig := 'zero';
  IF v_cfg ? 'auto_rebuy_trigger' AND jsonb_typeof(v_cfg -> 'auto_rebuy_trigger') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'auto_rebuy_trigger') = 'string'
       AND (v_cfg ->> 'auto_rebuy_trigger') IN ('zero', 'below_bb', 'below_pct') THEN
      v_ar_trig := v_cfg ->> 'auto_rebuy_trigger';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'auto_rebuy_trigger', 'given', v_cfg -> 'auto_rebuy_trigger',
                                           'reason', 'not_zero_below_bb_or_below_pct', 'used', v_ar_trig);
    END IF;
  END IF;
  v_ar_tgt := 'initial';
  IF v_cfg ? 'auto_rebuy_target' AND jsonb_typeof(v_cfg -> 'auto_rebuy_target') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'auto_rebuy_target') = 'string'
       AND (v_cfg ->> 'auto_rebuy_target') IN ('initial', 'max') THEN
      v_ar_tgt := v_cfg ->> 'auto_rebuy_target';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'auto_rebuy_target', 'given', v_cfg -> 'auto_rebuy_target',
                                           'reason', 'not_initial_or_max', 'used', v_ar_tgt);
    END IF;
  END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_threshold_bb', 1, 0, 100, false);
  v_ar_bb := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_threshold_pct', 25, 1, 99, true);
  v_ar_pct := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_max_count', 3, 0, 100, true);
  v_ar_max := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'auto_rebuy_session_cap', 0, 0, 1000000, false);
  v_ar_cap := (r ->> 'value')::numeric; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- LIGHTNING PHASE 11 (20261008161509): THE SHADOW MATCHER, THE INTEGRITY
  -- TELEMETRY AND THE QUALITY WEIGHTS. All off unless the Cluster turns them
  -- on; the shadow never seats anyone and the telemetry never steers the
  -- matcher.
  v_sh_on := false;
  IF v_cfg ? 'lightning_shadow_matcher' AND jsonb_typeof(v_cfg -> 'lightning_shadow_matcher') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_shadow_matcher') = 'boolean' THEN
      v_sh_on := (v_cfg ->> 'lightning_shadow_matcher')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_shadow_matcher', 'given', v_cfg -> 'lightning_shadow_matcher',
                                           'reason', 'wrong_type', 'used', v_sh_on);
    END IF;
  END IF;
  v_it_on := false;
  IF v_cfg ? 'integrity_telemetry' AND jsonb_typeof(v_cfg -> 'integrity_telemetry') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'integrity_telemetry') = 'boolean' THEN
      v_it_on := (v_cfg ->> 'integrity_telemetry')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'integrity_telemetry', 'given', v_cfg -> 'integrity_telemetry',
                                           'reason', 'wrong_type', 'used', v_it_on);
    END IF;
  END IF;
  v_sh_ver := 'm2';
  IF v_cfg ? 'shadow_matcher_version' AND jsonb_typeof(v_cfg -> 'shadow_matcher_version') <> 'null' THEN
    v_text := CASE WHEN jsonb_typeof(v_cfg -> 'shadow_matcher_version') = 'string' THEN v_cfg ->> 'shadow_matcher_version' END;
    IF v_text IS NOT NULL AND v_text ~ '^[A-Za-z0-9._:-]{1,32}$' THEN
      v_sh_ver := v_text;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'shadow_matcher_version', 'given', v_cfg -> 'shadow_matcher_version',
                                           'reason', 'not_a_version_name', 'used', v_sh_ver);
    END IF;
  END IF;
  r := public.fn_lightning_config_number(v_cfg, 'shadow_window_ms', 300000, 60000, 3600000, true);
  v_sh_win := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'shadow_max_players', 500, 2, 5000, true);
  v_sh_max := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'shadow_pass_budget_ms', 50, 5, 1000, true);
  v_sh_bud := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;

  -- The weights of the internal Lightning Quality Score
  -- (fn_lightning_quality_score), which compares matcher versions in the
  -- shadow ledger and is never shown to a player.
  v_qw_def := jsonb_build_object('next_hand_speed', 0.25, 'formation_success', 0.20,
                                 'bb_fairness', 0.15, 'opponent_diversity', 0.15,
                                 'instance_utilization', 0.10, 'reliability', 0.15);
  v_qw := v_qw_def;
  v_qw_cfg := v_cfg -> 'quality_weights';
  IF v_qw_cfg IS NOT NULL AND jsonb_typeof(v_qw_cfg) <> 'null' THEN
    IF jsonb_typeof(v_qw_cfg) <> 'object' THEN
      v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                           'reason', 'wrong_type', 'used', v_qw_def);
    ELSE
      FOREACH v_qw_k IN ARRAY ARRAY['next_hand_speed', 'formation_success', 'bb_fairness',
                                    'opponent_diversity', 'instance_utilization', 'reliability'] LOOP
        r := public.fn_lightning_config_number(v_qw_cfg, v_qw_k, (v_qw_def ->> v_qw_k)::numeric, 0, 1, false);
        v_qw := v_qw || jsonb_build_object(v_qw_k, (r ->> 'value')::numeric);
        IF r ? 'invalid' THEN
          v_inv := v_inv || jsonb_set(r -> 'invalid', '{key}', to_jsonb('quality_weights.' || v_qw_k));
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_qw_cfg) k
                  WHERE k NOT IN ('next_hand_speed', 'formation_success', 'bb_fairness',
                                  'opponent_diversity', 'instance_utilization', 'reliability')) THEN
        v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                             'reason', 'unknown_weight', 'used', v_qw);
      END IF;
      SELECT sum(e.value::numeric) INTO v_qw_sum FROM jsonb_each_text(v_qw) e;
      IF coalesce(v_qw_sum, 0) <= 0 THEN
        v_qw := v_qw_def;
        v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                             'reason', 'weights_sum_to_zero', 'used', v_qw);
      ELSIF abs(v_qw_sum - 1) > 0.000001 THEN
        SELECT jsonb_object_agg(e.key, round(e.value::numeric / v_qw_sum, 6)) INTO v_qw
          FROM jsonb_each_text(v_qw) e;
        v_inv := v_inv || jsonb_build_object('key', 'quality_weights', 'given', v_qw_cfg,
                                             'reason', 'normalized_to_sum_one', 'used', v_qw);
      END IF;
    END IF;
  END IF;

  -- LIGHTNING PHASE 12 (20261009144343): THE LATENCY LEDGER AND THE
  -- OPERATOR ALERTS. latency_telemetry is on by default and inert without
  -- Lightning traffic; the alert thresholds are read by
  -- fn_lightning_alert_sweep. Nothing in the seating path reads any of them.
  v_lt_on := true;
  IF v_cfg ? 'latency_telemetry' AND jsonb_typeof(v_cfg -> 'latency_telemetry') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'latency_telemetry') = 'boolean' THEN
      v_lt_on := (v_cfg ->> 'latency_telemetry')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'latency_telemetry', 'given', v_cfg -> 'latency_telemetry',
                                           'reason', 'wrong_type', 'used', v_lt_on);
    END IF;
  END IF;
  r := public.fn_lightning_config_number(v_cfg, 'latency_window_ms', 60000, 10000, 600000, true);
  v_lt_win := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_window_ms', 600000, 60000, 86400000, true);
  v_al_win := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_stuck_conversion_ms', 1200000, 60000, 86400000, true);
  v_al_stuck := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_drive_errors', 3, 1, 100000, true);
  v_al_drive := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_reaper_failures', 1, 1, 100000, true);
  v_al_reap := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_integrity_high_signals', 5, 1, 100000, true);
  v_al_integ := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_latency_windows', 3, 2, 60, true);
  v_al_lwin := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'alert_latency_min_samples', 20, 1, 1000000, true);
  v_al_lmin := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  v_lc_def := jsonb_build_object('fold_ack', 500, 'ack_to_idle', 500, 'idle_to_match', 5000,
                                 'match_to_hand', 2000, 'hand_to_first_render', 2000,
                                 'fast_fold_to_next_hand', 5000, 'normal_fold_to_next_hand', 60000,
                                 'fold_watch_to_next_hand', 90000);
  v_lc := v_lc_def;
  v_lc_cfg := v_cfg -> 'alert_latency_p95_ms';
  IF v_lc_cfg IS NOT NULL AND jsonb_typeof(v_lc_cfg) <> 'null' THEN
    IF jsonb_typeof(v_lc_cfg) <> 'object' THEN
      v_inv := v_inv || jsonb_build_object('key', 'alert_latency_p95_ms', 'given', v_lc_cfg,
                                           'reason', 'wrong_type', 'used', v_lc_def);
    ELSE
      FOREACH v_lc_k IN ARRAY ARRAY['fold_ack', 'ack_to_idle', 'idle_to_match', 'match_to_hand',
                                    'hand_to_first_render', 'fast_fold_to_next_hand',
                                    'normal_fold_to_next_hand', 'fold_watch_to_next_hand'] LOOP
        r := public.fn_lightning_config_number(v_lc_cfg, v_lc_k, (v_lc_def ->> v_lc_k)::numeric, 10, 3600000, true);
        v_lc := v_lc || jsonb_build_object(v_lc_k, (r ->> 'value')::integer);
        IF r ? 'invalid' THEN
          v_inv := v_inv || jsonb_set(r -> 'invalid', '{key}', to_jsonb('alert_latency_p95_ms.' || v_lc_k));
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_lc_cfg) k
                  WHERE k NOT IN ('fold_ack', 'ack_to_idle', 'idle_to_match', 'match_to_hand',
                                  'hand_to_first_render', 'fast_fold_to_next_hand',
                                  'normal_fold_to_next_hand', 'fold_watch_to_next_hand')) THEN
        v_inv := v_inv || jsonb_build_object('key', 'alert_latency_p95_ms', 'given', v_lc_cfg,
                                             'reason', 'unknown_leg', 'used', v_lc);
      END IF;
    END IF;
  END IF;

  -- LIGHTNING PHASE 13 (20261009235505): ROLLOUT, DRAIN AND ROLLBACK. The
  -- drain's deadline for formations that never dealt, the pool's door
  -- (joins), the matcher versions (the live one is a version the SQL matcher
  -- implements and that is not disabled; a disabled shadow version records
  -- nothing) and the engine's kill switches for LIGHTNING FOLD and FOLD &
  -- WATCH. Written by fn_lightning_operator_control.
  v_p13_known := ARRAY['m1', 'm1-port', 'm2'];
  r := public.fn_lightning_config_number(v_cfg, 'drain_timeout_ms', 120000, 10000, 3600000, true);
  v_p13_drain := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  v_p13_joins := true;
  IF v_cfg ? 'lightning_joins_enabled' AND jsonb_typeof(v_cfg -> 'lightning_joins_enabled') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_joins_enabled') = 'boolean' THEN
      v_p13_joins := (v_cfg ->> 'lightning_joins_enabled')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_joins_enabled', 'given', v_cfg -> 'lightning_joins_enabled',
                                           'reason', 'wrong_type', 'used', v_p13_joins);
    END IF;
  END IF;
  v_p13_closed := NULL;
  IF NOT v_p13_joins AND v_cfg ? 'lightning_joins_disabled_at'
     AND jsonb_typeof(v_cfg -> 'lightning_joins_disabled_at') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_joins_disabled_at') = 'string' THEN
      BEGIN
        v_p13_closed := (v_cfg ->> 'lightning_joins_disabled_at')::timestamptz;
      EXCEPTION WHEN data_exception THEN
        v_inv := v_inv || jsonb_build_object('key', 'lightning_joins_disabled_at', 'given', v_cfg -> 'lightning_joins_disabled_at',
                                             'reason', 'not_a_timestamp', 'used', NULL);
      END;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_joins_disabled_at', 'given', v_cfg -> 'lightning_joins_disabled_at',
                                           'reason', 'wrong_type', 'used', NULL);
    END IF;
  END IF;
  v_p13_off := ARRAY[]::text[];
  IF v_cfg ? 'matcher_versions_disabled' AND jsonb_typeof(v_cfg -> 'matcher_versions_disabled') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'matcher_versions_disabled') = 'array' THEN
      SELECT coalesce(array_agg(DISTINCT y.e ORDER BY y.e) FILTER (WHERE y.e = ANY (v_p13_known)), ARRAY[]::text[]),
             coalesce(bool_or(y.e IS NULL OR NOT (y.e = ANY (v_p13_known))), false)
        INTO v_p13_off, v_p13_bad
        FROM jsonb_array_elements(v_cfg -> 'matcher_versions_disabled') x(v)
       CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x.v) = 'string' THEN x.v #>> '{}' END AS e) y;
      IF v_p13_bad THEN
        v_inv := v_inv || jsonb_build_object('key', 'matcher_versions_disabled', 'given', v_cfg -> 'matcher_versions_disabled',
                                             'reason', 'unknown_version', 'used', to_jsonb(v_p13_off));
      END IF;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'matcher_versions_disabled', 'given', v_cfg -> 'matcher_versions_disabled',
                                           'reason', 'wrong_type', 'used', to_jsonb(v_p13_off));
    END IF;
  END IF;
  -- THE LIVE MATCHER IS THE SQL MATCHER. fn_lightning_match_plan implements
  -- one algorithm, m1; a hand labelled with any other live version would
  -- name a matcher that never seated it.
  IF v_version IS DISTINCT FROM 'm1' THEN
    v_inv := v_inv || jsonb_build_object('key', 'matcher_version', 'given', v_version,
                                         'reason', CASE WHEN v_version = ANY (v_p13_known) THEN 'not_a_sql_matcher'
                                                        ELSE 'unknown_version' END,
                                         'used', 'm1');
    v_version := 'm1';
  ELSIF v_version = ANY (v_p13_off) THEN
    v_inv := v_inv || jsonb_build_object('key', 'matcher_version', 'given', v_version,
                                         'reason', 'version_disabled', 'used', 'm1');
  END IF;
  v_p13_prev := 'm1';
  IF v_cfg ? 'matcher_version_previous' AND jsonb_typeof(v_cfg -> 'matcher_version_previous') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'matcher_version_previous') = 'string'
       AND (v_cfg ->> 'matcher_version_previous') = ANY (v_p13_known) THEN
      v_p13_prev := v_cfg ->> 'matcher_version_previous';
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'matcher_version_previous', 'given', v_cfg -> 'matcher_version_previous',
                                           'reason', 'unknown_version', 'used', v_p13_prev);
    END IF;
  END IF;
  v_p13_ff := true;
  IF v_cfg ? 'lightning_fast_fold' AND jsonb_typeof(v_cfg -> 'lightning_fast_fold') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_fast_fold') = 'boolean' THEN
      v_p13_ff := (v_cfg ->> 'lightning_fast_fold')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_fast_fold', 'given', v_cfg -> 'lightning_fast_fold',
                                           'reason', 'wrong_type', 'used', v_p13_ff);
    END IF;
  END IF;
  v_p13_fw := true;
  IF v_cfg ? 'lightning_fold_watch' AND jsonb_typeof(v_cfg -> 'lightning_fold_watch') <> 'null' THEN
    IF jsonb_typeof(v_cfg -> 'lightning_fold_watch') = 'boolean' THEN
      v_p13_fw := (v_cfg ->> 'lightning_fold_watch')::boolean;
    ELSE
      v_inv := v_inv || jsonb_build_object('key', 'lightning_fold_watch', 'given', v_cfg -> 'lightning_fold_watch',
                                           'reason', 'wrong_type', 'used', v_p13_fw);
    END IF;
  END IF;

  RETURN CASE WHEN v_found THEN '{}'::jsonb
              ELSE jsonb_build_object('reason', 'not_found') END
    || jsonb_build_object(
    'ok', v_found,
    'cluster_id', p_cluster_id,
    'handedness', g.handedness,
    'matcher_version', v_version,
    'worker_mode', v_mode,
    'pass_interval_ms', v_interval,
    'pass_time_budget_ms', v_budget,
    'keepalive_interval_ms', v_keep,
    'instance_min', v_min,
    'instance_target', v_target,
    'instance_max', v_max,
    'reservation_ttl_ms', v_ttl,
    'form_window_ms', v_form,
    'deal_window_ms', v_deal,
    'recent_opponent_window_hands', v_win_h,
    'recent_opponent_window_seconds', v_win_s,
    'diversity_thin_min', v_thin,
    'diversity_medium_min', v_medium,
    'diversity_large_min', v_large,
    'diversity_weight_large', v_w_large,
    'diversity_weight_medium', v_w_medium,
    'diversity_weight_thin', 0,
    'diversity_weight_tiny', 0,
    'multi_table_limit', v_mtl_obj,
    'admission_batch_hands', v_batch,
    'max_replans', v_replans,
    'cluster_row_wait_ms', v_row_wait,
    'pending_off_dwell_ms', v_dwell,
    'pass_record_retention_hours', v_keep_h,
    'pass_record_prune_batch', v_prune,
    'disconnect_timeout_ms', v_disc,
    'auto_rebuy_enabled', v_ar_on,
    'auto_rebuy_trigger', v_ar_trig,
    'auto_rebuy_threshold_bb', v_ar_bb,
    'auto_rebuy_threshold_pct', v_ar_pct,
    'auto_rebuy_target', v_ar_tgt,
    'auto_rebuy_max_count', v_ar_max,
    'auto_rebuy_session_cap', v_ar_cap,
    'first_entry_rule', v_rule,
    'position_fairness', v_p3,
    'on_threshold', v_on,
    'off_threshold', v_off,
    'threshold_source', v_thr ->> 'source',
    'invalid', v_inv)
    -- LIGHTNING PHASE 12 (20261009144343): a third object, so neither the
    -- first (88 of 100 arguments) nor the Phase 11 second one is touched.
    || jsonb_build_object(
    'latency_telemetry', v_lt_on,
    'latency_window_ms', v_lt_win,
    'alert_window_ms', v_al_win,
    'alert_stuck_conversion_ms', v_al_stuck,
    'alert_drive_errors', v_al_drive,
    'alert_reaper_failures', v_al_reap,
    'alert_integrity_high_signals', v_al_integ,
    'alert_latency_windows', v_al_lwin,
    'alert_latency_min_samples', v_al_lmin,
    'alert_latency_p95_ms', v_lc,
    -- LIGHTNING PHASE 13 (20261009235505): rollout, drain and rollback.
    'drain_timeout_ms', v_p13_drain,
    'lightning_joins_enabled', v_p13_joins,
    'lightning_joins_disabled_at', v_p13_closed,
    'matcher_version_previous', v_p13_prev,
    'matcher_versions_disabled', to_jsonb(v_p13_off),
    'shadow_matcher_disabled', v_sh_ver = ANY (v_p13_off),
    'lightning_fast_fold', v_p13_ff,
    'lightning_fold_watch', v_p13_fw,
    'known_matcher_versions', to_jsonb(v_p13_known),
    'sql_matcher_versions', to_jsonb(ARRAY['m1']))
    -- LIGHTNING PHASE 11 (20261008161509): the first object is at 88 of its
    -- 100 arguments, so the Phase 11 keys ride in a second.
    || jsonb_build_object(
    'lightning_shadow_matcher', v_sh_on,
    'shadow_matcher_version', v_sh_ver,
    'shadow_window_ms', v_sh_win,
    'shadow_max_players', v_sh_max,
    'shadow_pass_budget_ms', v_sh_bud,
    'integrity_telemetry', v_it_on,
    'quality_weights', v_qw);
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_form_hand(p_cluster_id uuid, p_players uuid[], p_target_size smallint DEFAULT NULL::smallint, p_max_size smallint DEFAULT NULL::smallint, p_bb_player uuid DEFAULT NULL::uuid, p_reservation_ttl interval DEFAULT '00:00:20'::interval, p_form_window interval DEFAULT '00:00:45'::interval, p_now timestamp with time zone DEFAULT clock_timestamp(), p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g           record;
  v_epoch     integer;
  v_cand      uuid[];
  v_legal     uuid[];
  v_pool      jsonb;
  v_seats     jsonb;
  v_n         integer;
  v_target    smallint;
  v_max       smallint;
  v_bb        uuid;
  v_sb        uuid;
  v_btn       uuid;
  v_ok        boolean;
  v_instance  uuid;
  v_hand      uuid;
  v_before    numeric;
  v_after     numeric;
  v_sqlstate  text;
  v_msg       text;
  -- 2026-09-26: the participants' money under the FOR SHARE lock, and the
  -- versions the hand is stamped with at step 7.
  v_money_before      text;
  v_money_after       text;
  v_rules_version     text;
  v_rake_version      text;
  v_blind_version     text;
  v_lightning_version text;
  -- 2026-09-26: the replayed hand, the constraint a refusal names, and
  -- nothing else.
  v_replay    record;
  v_constraint text;
  v_alert_id  uuid;
  v_alert_error text;
  -- 20261008043021: the cross-Cluster multi-table recount.
  v_mtl       jsonb;
  v_mtl_pid   uuid;
  v_mtl_row   record;
  v_ttl       interval := GREATEST(coalesce(p_reservation_ttl, interval '20 seconds'), interval '5 seconds');
  v_window    interval := GREATEST(coalesce(p_form_window, interval '45 seconds'), interval '5 seconds');
BEGIN
  IF p_cluster_id IS NULL OR p_players IS NULL OR coalesce(array_length(p_players, 1), 0) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'no_candidate_set');
  END IF;

  -- SPECIFICATION 2139 (2026-09-26). Every hand records its matcher_version,
  -- and the matcher is the one component the database cannot see, so only the
  -- caller can say which one it is. Refused before anything is locked, read or
  -- written.
  IF p_matcher_version IS NULL OR length(btrim(p_matcher_version)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'matcher_version_required');
  END IF;

  -- A RETRY IS ANSWERED WITH THE HAND IT ALREADY FORMED (2026-09-26). A
  -- matcher that lost the answer to a formation - a timeout, a dropped
  -- connection - retries with the same p_request_id and is told what happened
  -- instead of forming a second hand out of the same players. Answered before
  -- the freeze, because reading what already happened is not forming a hand;
  -- two racing calls with one request id are decided by
  -- lightning_hand_one_per_request, whose violation is a retry, and the retry
  -- lands here.
  IF p_request_id IS NOT NULL THEN
    SELECT lh.hand_id, lh.cluster_id, lh.cluster_epoch, lh.lightning_instance_id, lh.player_count
      INTO v_replay FROM public.lightning_hand lh WHERE lh.request_id = p_request_id;
    IF FOUND THEN
      IF v_replay.cluster_id IS DISTINCT FROM p_cluster_id THEN
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                  'reason', 'request_id_belongs_to_another_cluster',
                                  'request_id', p_request_id);
      END IF;
      RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false, 'replayed', true,
        'hand_id', v_replay.hand_id, 'instance_id', v_replay.lightning_instance_id,
        'cluster_id', v_replay.cluster_id, 'cluster_epoch', v_replay.cluster_epoch,
        'players', v_replay.player_count,
        'bb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'bb'),
        'sb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'sb'),
        'btn', (SELECT hp.player_id FROM public.lightning_hand_player hp
                 WHERE hp.hand_id = v_replay.hand_id AND hp."position" = 'btn'),
        'seats', (SELECT jsonb_agg(jsonb_build_object(
                           'player_id', hp.player_id, 'pool_slot_id', hp.pool_slot_id,
                           'pool_session_id', sl.pool_session_id, 'stack_before', hp.stack_before,
                           'seat', hp.seat, 'position', hp."position", 'blind_role', hp.blind_role)
                         ORDER BY hp.seat)
                    FROM public.lightning_hand_player hp
                    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
                   WHERE hp.hand_id = v_replay.hand_id),
        'state', (SELECT li.state FROM public.lightning_instance li
                   WHERE li.id = v_replay.lightning_instance_id),
        'request_id', p_request_id);
    END IF;
  END IF;

  -- theFreezeIsTotal. Forming a hand during the maintenance break is exactly
  -- what the freeze forbids; releasing one is not, which is why
  -- fn_lightning_reap_formations and fn_lightning_instance_abandon are not
  -- gated and this is.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                              'reason', 'platform_frozen');
  END IF;

  -- CONTENTION IS A RETRY, NOT A CRASH (2026-09-26). From here to the end of
  -- the function the barrier waits on locks - the Cluster row, the slots, the
  -- participants' pool sessions, the reap - and the estate sets lock_timeout.
  -- This sub-block catches lock_not_available, deadlock_detected and
  -- serialization_failure, and only those, rolls the whole formation back and
  -- answers formation_contended with a matcher_retry. It does NOT catch
  -- query_canceled: a cancel belongs to whoever asked for it, and the header of
  -- 20260926023047 says why.
  BEGIN

  -- THE CLUSTER ROW IS TAKEN FOR UPDATE BEFORE THE EPOCH IS READ, which
  -- serialises formation against fn_cash_cluster_commit_lightning's own
  -- FOR UPDATE on the same row. Without it "the epoch I bound is the epoch the
  -- Cluster is in" is likely rather than true, and a conversion landing
  -- between the read and the INSERT would bind a hand to an epoch that no
  -- longer exists.
  SELECT id, cluster_mode, lightning_enabled, cluster_epoch, handedness
    INTO g FROM public.cash_games WHERE id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'reason', 'not_found');
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'cluster_is_not_lightning',
                              'cluster_mode', g.cluster_mode,
                              'lightning_enabled', coalesce(g.lightning_enabled, false));
  END IF;
  IF NOT public.fn_lightning_template_allowed((SELECT cg.template_name FROM public.cash_games cg WHERE cg.id=g.id),(SELECT cg.ruleset_snapshot FROM public.cash_games cg WHERE cg.id=g.id)) THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'retry',false,'reason','lightning_template_not_allowed');
  END IF;
  IF NOT public.fn_lightning_table_size_allowed((SELECT cg.handedness FROM public.cash_games cg WHERE cg.id=g.id)) THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'retry',false,'reason','lightning_table_size_not_allowed');
  END IF;
  v_epoch := g.cluster_epoch;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                  WHERE e.cluster_id = g.id AND e.epoch = v_epoch AND e.ended_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'epoch_is_not_open', 'cluster_epoch', v_epoch);
  END IF;

  -- THE NEXT FORMATION BURIES THE LAST ONE'S CORPSE (2026-09-26). DECISION 2 of
  -- 20260925215731 said this and put it in fn_lightning_instance_open, which no
  -- formation path calls. It is here now, under the Cluster row lock and before
  -- the INSERT below, so a player it hands back is a legal candidate in this
  -- same call. The reaper clamps its clock to clock_timestamp().
  PERFORM public.fn_lightning_reap_formations(p_now, 200, g.id);

  -- SPECIFICATION 2137-2143: THE VERSIONS THIS HAND IS FORMED UNDER, read now,
  -- under the same Cluster row lock that binds its epoch. The header of
  -- 20260926023047 says why each comes from where it does.
  SELECT 'ruleset:' || md5(coalesce(cg.ruleset_snapshot, '{}'::jsonb)::text),
         'rake:' || md5(coalesce(cg.ruleset_snapshot -> 'rake', 'null'::jsonb)::text)
    INTO v_rules_version, v_rake_version
    FROM public.cash_games cg WHERE cg.id = g.id;
  SELECT 'fn_lightning_blind_order:' || md5(p.prosrc) INTO v_blind_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure;
  SELECT 'fn_lightning_form_hand:' || md5(p.prosrc) INTO v_lightning_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure;

  -- THE MONEY GUARD NO LONGER MEASURES THE WHOLE POOL (2026-09-26). It read
  -- every pool session of the Cluster in two READ COMMITTED statements under no
  -- lock, so any commit anywhere in the Cluster between them looked like this
  -- formation moving money. It measures the participants now, under the
  -- FOR SHARE lock step 1 takes; see v_money_before below.

  -- The caller's order is the matcher's order and is preserved exactly;
  -- duplicates are collapsed to their first mention rather than silently
  -- seating somebody twice.
  v_cand := ARRAY(SELECT x.pid FROM (
              SELECT u.pid, min(u.ord) AS ord
                FROM unnest(p_players) WITH ORDINALITY AS u(pid, ord)
               WHERE u.pid IS NOT NULL
               GROUP BY u.pid) x ORDER BY x.ord);

  -- THE ANCHOR SEATS, FOR SHARE, FIRST (2026-09-26). The seat is the economic
  -- anchor and fn_lightning_pool_stack reads it, so from here to commit
  -- nothing may change a candidate's seat stack, departure or occupant - and
  -- they are taken BEFORE the slots and the pool sessions, because the
  -- deferred table_seats trigger that exits a departing anchor holds that seat
  -- and then writes its session and slot: a formation that already held those
  -- and waited on the seat would close the cycle. In seat id order, so two
  -- matchers queue rather than deadlock.
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.id IN (SELECT ps.anchor_seat_id
                     FROM public.lightning_pool_slot sl
                     JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ts.id
   FOR SHARE;

  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING. The slots are
  -- taken FOR UPDATE in player_id order - a fixed order, so two matchers
  -- racing for an overlapping candidate set queue rather than deadlock.
  PERFORM 1 FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
     AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand)
   ORDER BY sl.player_id
   FOR UPDATE;

  -- AND THEIR POOL SESSIONS, FOR SHARE (2026-09-26), in pool session id order
  -- and BEFORE a single stack is read. From here to commit no other
  -- transaction can change a candidate's starting_stack, net_result,
  -- ending_stack or exited_at, so the stack_before snapshotted below is the
  -- stack that is still there when the hand commits, and the money guard at the
  -- end measures what THIS transaction did and nothing else. A settlement
  -- writing to one of these players waits for the formation, which is
  -- milliseconds.
  PERFORM 1 FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT sl.pool_session_id FROM public.lightning_pool_slot sl
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ps.id
   FOR SHARE;

  -- P0 LEGALITY, and there is no is_horse in it. Law 10.5: a horse is a
  -- player. A candidate is legal when they hold an open pool slot at THIS
  -- Cluster and THIS epoch, an open and active pool session, a strictly
  -- positive stack - a player who cannot post is not a legal candidate - and
  -- no reservation anybody else is already holding.
  SELECT coalesce(array_agg(q.pid), ARRAY[]::uuid[]) INTO v_legal FROM (
    SELECT sl.player_id AS pid
      FROM public.lightning_pool_slot sl
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch AND sl.closed_at IS NULL
       AND sl.player_id = ANY (v_cand)
       AND ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch
       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND public.fn_lightning_pool_stack(ps.id) > 0
       -- THE SAME QUESTION THE POPULATION ASKS (2026-09-26): the anchor seat is
       -- live eligible - not left, not sitting out, not leaving, chips on it,
       -- at a live table of this Cluster, held by this player - and the cash
       -- session the pool session is subordinate to is still open.
       AND public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)
       AND EXISTS (SELECT 1 FROM public.cash_player_session cps
                    WHERE cps.id = ps.cash_player_session_id AND cps.closed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r
                        WHERE r.cluster_id = sl.cluster_id AND r.player_id = sl.player_id
                          AND r.state IN ('pending', 'committed'))
  ) q;

  -- AND THE P2 ORDER COMES FROM THE ONE FUNCTION THAT OWNS THE KEY. An earlier
  -- cut of this file wrote the ordering out a second time here, and the two
  -- copies were then two places for the key to drift - which a mutation run
  -- caught by changing one of them and watching nothing go red, because the
  -- other was the one that mattered. fn_lightning_blind_order is now the only
  -- expression of specification 601-608 in the database, and this is its
  -- caller.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       bo.player_id,
           'pool_slot_id',    bo.pool_slot_id,
           'pool_session_id', sl.pool_session_id,
           'stack',           public.fn_lightning_pool_stack(sl.pool_session_id),
           'bb_unresolved',   bo.bb_unresolved,
           'last_bb_at',      bo.last_bb_at,
           'debt_age',        bo.debt_age,
           'entered_pool',    bo.entered_pool,
           'caller_rank',     o.ord)
         ORDER BY bo.p2_rank)
    INTO v_pool
    FROM public.fn_lightning_blind_order(g.id, v_epoch, v_legal) bo
    JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
    JOIN unnest(v_cand) WITH ORDINALITY AS o(pid, ord) ON o.pid = bo.player_id;

  v_n      := coalesce(jsonb_array_length(v_pool), 0);
  v_target := coalesce(p_target_size, GREATEST(2, LEAST(6, coalesce(g.handedness, 6)))::smallint);
  v_max    := coalesce(p_max_size, GREATEST(v_target, LEAST(9, coalesce(g.handedness, 6))::smallint));
  IF v_max < v_target THEN v_max := v_target; END IF;
  IF v_target < 2 THEN v_target := 2; END IF;
  IF v_max > 9 THEN v_max := 9; END IF;

  IF v_n < v_target THEN
    -- SPECIFICATION 733. Nothing was taken, so there is nothing to release -
    -- but the retry still has to be VISIBLE, or a matcher spinning on a pool
    -- that can never fill leaves no trace anywhere.
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
      'reason', 'insufficient_legal_candidates', 'offered', array_length(v_cand, 1),
      'legal', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);
    RETURN jsonb_build_object('ok', true, 'formed', false, 'retry', true,
                              'reason', 'insufficient_legal_candidates',
                              'offered', array_length(v_cand, 1), 'legal', v_n,
                              'target_size', v_target);
  END IF;

  -- OVER-SUPPLY IS TRIMMED ALONG THE P2 KEY, not along the caller's order, so
  -- the player most owed a big blind is never the one dropped.
  IF v_n > v_max THEN
    SELECT jsonb_agg(z.e ORDER BY z.ord) INTO v_pool
      FROM (SELECT e, ord FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)) z
     WHERE z.ord <= v_max;
    v_n := v_max;
  END IF;

  -- BARRIER STEP 5, FIRST HALF, AND THE ONE P2 RULE THAT HAS TO LIVE DOWN
  -- HERE. The barrier's own choice is the P2-maximal candidate. A matcher may
  -- override it, and may not override it with somebody P2 could never have
  -- chosen: p_bb_player is accepted only if it ties on the WHOLE key -
  -- unresolved obligation, last_bb_at, blind-debt age - with the candidate the
  -- barrier would have taken.
  v_bb := (v_pool -> 0 ->> 'player_id')::uuid;
  IF p_bb_player IS NOT NULL AND p_bb_player IS DISTINCT FROM v_bb THEN
    -- AND POOL ENTRY (2026-09-26), P2 tie-break 3. Without it a matcher could
    -- name a player who loses on pool entry. The only freedom left is among
    -- players P2 cannot tell apart except by id, and the id is a tie-break for
    -- determinism, not a fairness rule.
    SELECT ((e -> 'bb_unresolved'), (e -> 'last_bb_at'), (e -> 'debt_age'), (e -> 'entered_pool'))
           IS NOT DISTINCT FROM
           ((v_pool -> 0 -> 'bb_unresolved'), (v_pool -> 0 -> 'last_bb_at'), (v_pool -> 0 -> 'debt_age'),
            (v_pool -> 0 -> 'entered_pool'))
      INTO v_ok
      FROM jsonb_array_elements(v_pool) e
     WHERE (e ->> 'player_id')::uuid = p_bb_player;
    IF NOT coalesce(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                'reason', 'bb_choice_is_not_p2_legal',
                                'asked_for', p_bb_player, 'p2_would_choose', v_bb);
    END IF;
    v_bb := p_bb_player;
  END IF;

  SELECT (t.e ->> 'player_id')::uuid INTO v_sb
    FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
   WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
   ORDER BY t.ord LIMIT 1;

  -- BARRIER STEPS 3, 4, 5 AND 6 AS ONE MAP. Seat 1 is the small blind, seat 2
  -- the big blind, and seats 3..n are filled IN THE ORDER THE CALLER GAVE
  -- THEM: P3 position fairness is advisory and the matcher's, and a barrier
  -- that re-sorted those seats would be quietly overruling it. Heads-up, seat
  -- 1 is the button and posts the small blind, which is why blind_role and
  -- position are separate columns.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       s.pid,
           'pool_slot_id',    (s.e ->> 'pool_slot_id')::uuid,
           'pool_session_id', (s.e ->> 'pool_session_id')::uuid,
           'stack_before',    (s.e ->> 'stack')::numeric,
           'seat',            s.seat,
           'position', CASE WHEN v_n = 2 AND s.seat = 1 THEN 'btn'
                            WHEN v_n = 2                THEN 'bb'
                            WHEN s.seat = 1             THEN 'sb'
                            WHEN s.seat = 2             THEN 'bb'
                            WHEN s.seat = v_n           THEN 'btn'
                            WHEN s.seat = v_n - 1       THEN 'co'
                            WHEN s.seat = v_n - 2       THEN 'hj'
                            -- SEVEN, EIGHT AND NINE HANDED (2026-09-26). Every
                            -- seat below the hijack used to be utg, so an
                            -- eight-handed hand had three players under the
                            -- gun and three utg_counts moved. Exactly one now.
                            WHEN s.seat = 3             THEN 'utg'
                            WHEN s.seat = v_n - 3       THEN 'lj'
                            WHEN s.seat = 4             THEN 'utg1'
                            ELSE 'utg2' END,
           'blind_role', CASE WHEN s.seat = 1 THEN 'sb'
                              WHEN s.seat = 2 THEN 'bb'
                              ELSE 'none' END)
         ORDER BY s.seat)
    INTO v_seats
    FROM (
      SELECT r.e, r.pid,
             (CASE WHEN r.pid = v_bb THEN 2
                   WHEN r.pid = v_sb THEN 1
                   ELSE 2 + row_number() OVER (PARTITION BY (r.pid IN (v_bb, v_sb))
                                               ORDER BY r.crank) END)::smallint AS seat
        FROM (SELECT t.e, (t.e ->> 'player_id')::uuid AS pid, (t.e ->> 'caller_rank')::integer AS crank
                FROM jsonb_array_elements(v_pool) t(e)) r
    ) s;

  SELECT (x ->> 'player_id')::uuid INTO v_btn
    FROM jsonb_array_elements(v_seats) x WHERE x ->> 'position' = 'btn';

  -- F12'S SHAPE, MEASURED OVER THE PARTICIPANTS (2026-09-26). Every money
  -- column of every participant's pool session, ordered, as text - not a sum,
  -- so two stacks that swapped are a difference too. These rows are held
  -- FOR SHARE since step 1, so nothing but this transaction can change them
  -- before the comparison at the end.
  SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                    || ':' || coalesce(ps.net_result::text, 'null')
                    || ':' || coalesce(ps.ending_stack::text, 'null')
                    || ':' || coalesce(ps.exited_at::text, 'open')
                    || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                          || '@' || coalesce(ts.user_id::text, 'empty')
                                          FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                    '|' ORDER BY ps.id)
    INTO v_money_before
    FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);

  v_hand := gen_random_uuid();

  -- =========================================================================
  -- THE ATOMIC BLOCK. Everything below either all happens or none of it does.
  -- An exception here rolls back to this block's implicit savepoint, and the
  -- instance, the reservations, the hand and the participants cease to have
  -- ever existed - which is a stronger form of specification 728-731 than
  -- releasing them would be, because there is nothing left to release, nothing
  -- to reap, and the players' pool state is restored by never having changed.
  -- The exception list is CLOSED: anything that is not one of these eight
  -- classes propagates and aborts the caller, because a barrier that swallows
  -- every error is a pool that silently stops dealing with no row saying why.
  -- =========================================================================
  BEGIN
    INSERT INTO public.lightning_instance
      (cluster_id, cluster_epoch, state, target_size, max_size, created_at, deadline_at)
    VALUES (g.id, v_epoch, 'forming', v_target, v_max, p_now, p_now + v_window)
    RETURNING id INTO v_instance;

    -- STEPS 2 AND 3: the player reservation and the seat reservation are one
    -- row, because they are one claim. lightning_reservation_one_active_per_-
    -- player is what refuses a second matcher holding the same person;
    -- lightning_reservation_one_seat_per_instance is what refuses two people
    -- holding the same seat. Both are indexes, so both are decided by the
    -- database at INSERT time rather than by a read anybody can lose a race to.
    INSERT INTO public.lightning_reservation
      (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
       seat_number, state, created_at, expires_at)
    SELECT g.id, v_epoch, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           v_instance, (x ->> 'seat')::smallint, 'pending', p_now, p_now + v_ttl
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 7: the immutable hand id, and STEPS 8 AND 9: the instance and the
    -- epoch it is bound to. The hand is born UNLOCKED - the latch goes on
    -- after the participants are in, which is what makes step 10 a step.
    INSERT INTO public.lightning_hand
      (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at,
       rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version,
       request_id)
    VALUES (v_hand, g.id, v_epoch, v_instance, p_now,
            v_rules_version, btrim(p_matcher_version), v_blind_version, v_lightning_version, v_rake_version,
            p_request_id);

    -- STEPS 4, 5 AND 6: positions, blind roles and the stack snapshot.
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, "position", blind_role, stack_before,
       fold_type, cluster_id, cluster_epoch)
    SELECT v_hand, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           (x ->> 'seat')::smallint, (x ->> 'position'), (x ->> 'blind_role'),
           (x ->> 'stack_before')::numeric, 'none', g.id, v_epoch
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 10. The latch and its count move in one statement, and
    -- trg_lightning_hand_is_immutable refuses the statement unless the count
    -- matches the rows that are actually there.
    UPDATE public.lightning_hand h
       SET participants_locked_at = p_now, player_count = v_n::smallint
     WHERE h.hand_id = v_hand;

    UPDATE public.lightning_reservation r
       SET state = 'committed', resolved_at = p_now
     WHERE r.lightning_instance_id = v_instance AND r.state = 'pending';

    -- 20261008043021: THE MULTI-TABLE LIMIT HOLDS ACROSS CLUSTERS AT THE
    -- MOMENT IT MATTERS. P0 (fn_lightning_player_legality) counts a player's
    -- live committed reservations, but each Cluster's pass serialises only on
    -- its own Cluster, so k Clusters forming in the same instant could each
    -- admit the same player and a mobile limit of 2 could end with 4 live
    -- hands. The barrier therefore takes one transaction advisory lock per
    -- participant, in sorted player-id order, AFTER the committed
    -- reservations above are written, and recounts each participant's live
    -- committed reservations across every Cluster against that participant's
    -- platform limit (p_player_platforms as the matcher passes it; an
    -- unreported platform is the NARROWEST limit, mobile, exactly as P0 now
    -- defaults it). Two barriers racing for one player queue on the player's
    -- lock, and the one that waited counts the winner's committed rows in a
    -- fresh statement snapshot, so exactly one wins.
    --
    -- LOCK ORDER, AND WHY THIS CANNOT DEADLOCK AGAINST THE ANCHOR-SEAT
    -- LOCKING. These advisory locks are taken AFTER every row lock this
    -- function holds, always in sorted player-id order. Two formations in the
    -- SAME Cluster are serialised by the cash_games row taken FOR UPDATE
    -- before any seat, slot or session lock, so they never hold these locks
    -- concurrently. Two formations in DIFFERENT Clusters share no row lock at
    -- all - the Cluster row, the anchor seats, the slots, the pool sessions,
    -- the instance and the events they touch are rows of their own Cluster -
    -- so the only resource two of them can both want is this one advisory
    -- lock class, and a fixed sorted order within one lock class cannot
    -- cycle.
    FOR v_mtl_pid IN
      SELECT DISTINCT (x ->> 'player_id')::uuid FROM jsonb_array_elements(v_seats) x ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('lightning_player:' || v_mtl_pid::text, 0));
    END LOOP;
    v_mtl := public.fn_lightning_config(g.id) -> 'multi_table_limit';
    SELECT q.pid, q.live, q.platform, q.limit_n INTO v_mtl_row FROM (
      SELECT p.pid,
             (SELECT count(DISTINCT r.cluster_id)
                FROM public.lightning_reservation r
                JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
               WHERE r.player_id = p.pid AND r.state = 'committed'
                 AND i.state IN ('forming', 'reserved', 'dealing', 'settling')) AS live,
             p.platform,
             coalesce((v_mtl ->> p.platform)::integer, 2) AS limit_n
        FROM (SELECT DISTINCT (x ->> 'player_id')::uuid AS pid,
                     CASE WHEN (p_player_platforms ->> (x ->> 'player_id')) IN ('desktop', 'tablet', 'mobile')
                          THEN p_player_platforms ->> (x ->> 'player_id') ELSE 'mobile' END AS platform
                FROM jsonb_array_elements(v_seats) x) p) q
     WHERE q.live > q.limit_n
     ORDER BY q.pid LIMIT 1;
    IF FOUND THEN
      -- A NORMAL RETRYABLE REFUSAL: 40001 is in this block's retry class, so
      -- the whole formation rolls back - the instance, the hand and every
      -- reservation it wrote cease to exist, which is how its reservations
      -- are released - and the matcher replans, where P0 now sees the winning
      -- Cluster's committed reservation and refuses the player as
      -- MULTI_TABLE_LIMIT.
      RAISE EXCEPTION 'LIGHTNING_MULTI_TABLE_LIMIT: player % would hold % live Lightning hands against a % limit of %',
        v_mtl_row.pid, v_mtl_row.live, v_mtl_row.platform, v_mtl_row.limit_n
        USING ERRCODE = '40001';
    END IF;

    UPDATE public.lightning_instance li
       SET hand_id = v_hand, state = 'reserved', deadline_at = p_now + v_window
     WHERE li.id = v_instance;

    -- P2 BOOKKEEPING, AND NOT ONE COLUMN OF IT IS MONEY. last_bb_at is what
    -- makes the next formation pick somebody else; without this stamp the same
    -- player is the big blind of every hand for ever. missed_bb_debt, bb_owed
    -- and sb_owed are obligations created when a blind is DUE and discharged
    -- when it is POSTED, and posting is barrier step 12, which is the engine's.
    UPDATE public.lightning_pool_slot sl
       SET last_bb_at     = CASE WHEN sl.player_id = v_bb  THEN p_now ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN sl.player_id = v_sb  THEN p_now ELSE sl.last_sb_at END,
           last_button_at = CASE WHEN sl.player_id = v_btn THEN p_now ELSE sl.last_button_at END,
           hands_since_bb = CASE WHEN sl.player_id = v_bb  THEN 0 ELSE sl.hands_since_bb + 1 END,
           hands_since_sb = CASE WHEN sl.player_id = v_sb  THEN 0 ELSE sl.hands_since_sb + 1 END,
           updated_at     = p_now
     WHERE sl.id IN (SELECT hp.pool_slot_id FROM public.lightning_hand_player hp
                      WHERE hp.hand_id = v_hand);

    INSERT INTO public.lightning_blind_ledger
      (cluster_id, player_id, bb_count, sb_count, btn_count, utg_count, hj_count, co_count,
       first_seen_at, updated_at)
    SELECT g.id, hp.player_id,
           (coalesce(hp.blind_role, 'none') = 'bb')::integer,
           (coalesce(hp.blind_role, 'none') = 'sb')::integer,
           (coalesce(hp."position", '') = 'btn')::integer,
           (coalesce(hp."position", '') = 'utg')::integer,
           (coalesce(hp."position", '') = 'hj')::integer,
           (coalesce(hp."position", '') = 'co')::integer,
           p_now, p_now
      FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand
    ON CONFLICT (cluster_id, player_id) DO UPDATE SET
      bb_count   = public.lightning_blind_ledger.bb_count   + EXCLUDED.bb_count,
      sb_count   = public.lightning_blind_ledger.sb_count   + EXCLUDED.sb_count,
      btn_count  = public.lightning_blind_ledger.btn_count  + EXCLUDED.btn_count,
      utg_count  = public.lightning_blind_ledger.utg_count  + EXCLUDED.utg_count,
      hj_count   = public.lightning_blind_ledger.hj_count   + EXCLUDED.hj_count,
      co_count   = public.lightning_blind_ledger.co_count   + EXCLUDED.co_count,
      updated_at = EXCLUDED.updated_at;

    -- THE BARRIER'S OWN PRE-COMMIT RE-CHECKS. Each is a state the locks above
    -- make impossible, so each raises PLT02, LIGHTNING_FORMATION_INVARIANT
    -- (2026-09-26), which the handler below does NOT retry: it rolls the block
    -- back, freezes the Cluster and writes the evidence.
    IF (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand) <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % was formed for % players and holds %',
        v_hand, v_n, (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand)
        USING ERRCODE = 'PLT02';
    END IF;
    IF (SELECT count(*) FROM public.lightning_reservation r
         WHERE r.lightning_instance_id = v_instance AND r.state = 'committed') <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % has % committed reservations for % seats',
        v_hand, (SELECT count(*) FROM public.lightning_reservation r
                  WHERE r.lightning_instance_id = v_instance AND r.state = 'committed'), v_n
        USING ERRCODE = 'PLT02';
    END IF;
    IF (SELECT count(*) FROM public.lightning_hand_player hp
         WHERE hp.hand_id = v_hand AND hp.blind_role = 'bb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp.blind_role = 'sb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp."position" = 'btn') <> 1 THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % does not have exactly one big blind, one small blind and one button',
        v_hand USING ERRCODE = 'PLT02';
    END IF;
    IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_hand
                  AND (hp.stack_before IS NULL OR hp.stack_before <= 0)) THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % seated a player with no stack to post from',
        v_hand USING ERRCODE = 'PLT02';
    END IF;

    -- F12'S SHAPE, ONE PHASE ON (moved inside the block 2026-09-26). Every
    -- money column of every participant's pool session AND its anchor seat,
    -- which are held FOR SHARE, compared with the snapshot taken before the
    -- first write.
    SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                      || ':' || coalesce(ps.net_result::text, 'null')
                      || ':' || coalesce(ps.ending_stack::text, 'null')
                      || ':' || coalesce(ps.exited_at::text, 'open')
                      || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                            || '@' || coalesce(ts.user_id::text, 'empty')
                                            FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                      '|' ORDER BY ps.id)
      INTO v_money_after
      FROM public.lightning_pool_session ps
     WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);
    IF v_money_after IS DISTINCT FROM v_money_before THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: the pool sessions or anchor seats of the % participants of hand % in Cluster % were rewritten while it was formed (% became %), and forming a hand is a seating transition, not an economic transaction',
        v_n, v_hand, g.id, v_money_before, v_money_after USING ERRCODE = 'PLT02';
    END IF;

  EXCEPTION
    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE 'PLT02'
      OR exclusion_violation
      -- THE RETRYABLE CLASSES (2026-09-26). A lock wait past lock_timeout, a
      -- deadlock victim and a serialization failure are exactly what
      -- specification 732-733 means by "retry where safe": this block is
      -- rolled back whole and the caller retries in a fresh transaction.
      OR lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_constraint = CONSTRAINT_NAME;
      -- ONLY A RACE IS RETRIED (2026-09-26). A lock timeout, a deadlock victim,
      -- a serialization failure, and a unique violation on one of the indexes
      -- two matchers can genuinely race for, are what specification 732-733
      -- means by "retry where safe". Everything else that lands here - the
      -- barrier's own PLT02 re-checks, the immutability and discipline
      -- triggers, a CHECK, a foreign key, a unique index nobody races for - is
      -- a state the locks this function holds make impossible. Retrying it
      -- would form the same wrong hand again, so it is not retried: the block
      -- is already rolled back, the Cluster is frozen through its own
      -- cluster_mode (the row is held FOR UPDATE since the start, and every
      -- formation, opening and deal refuses a Cluster that is not lightning),
      -- and the evidence is written in the two events an operator will look
      -- for.
      IF NOT (v_sqlstate IN ('55P03', '40P01', '40001')
              OR (v_sqlstate = '23505' AND v_constraint IN (
                    'lightning_reservation_one_active_per_player',
                    'lightning_reservation_one_pending_per_slot',
                    'lightning_reservation_one_seat_per_instance',
                    'lightning_reservation_one_seat_per_player_instance',
                    'lightning_pool_slot_one_open',
                    'lightning_pool_slot_one_open_per_player',
                    'lightning_hand_one_per_request'))) THEN
        UPDATE public.cash_games cg
           SET cluster_mode = 'frozen', updated_at = now()
         WHERE cg.id = g.id AND cg.cluster_mode = 'lightning';
        -- THE PAGE. The estate's operator alert path: a critical
        -- financial_alerts row, which the incident trigger turns into an
        -- incident, deduplicated per Cluster. In its own sub-block, so that an
        -- alert that cannot be written costs the page and never the freeze;
        -- its failure is recorded in the freeze's own evidence instead.
        BEGIN
          v_alert_id := public.fn_raise_server_financial_alert(
            'critical', 'lightning_formation',
            format('LIGHTNING_CLUSTER_FROZEN: Cluster %s froze at epoch %s on %s: %s', g.id, v_epoch, v_sqlstate, v_msg),
            jsonb_build_object('cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand,
                               'sqlstate', v_sqlstate, 'constraint', v_constraint,
                               'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
            'lightning_cluster_frozen:' || g.id, g.id::text);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;
        END;
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES
          (g.id, 'stack_invariant_failed', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch,
             'hand_id', v_hand, 'instance_id', v_instance,
             'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
             'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                           FROM jsonb_array_elements(v_seats) x),
             'seats', v_seats, 'money_before', v_money_before, 'money_after', v_money_after,
             'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id),
          (g.id, 'cluster_frozen', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch, 'from_mode', 'lightning', 'to_mode', 'frozen',
             'reason', 'stack_invariant_failed', 'sqlstate', v_sqlstate, 'message', v_msg,
             'hand_id', v_hand, 'instance_id', v_instance, 'alert_id', v_alert_id, 'alert_error', v_alert_error,
             'at', clock_timestamp()), v_epoch, p_request_id);
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'frozen', true,
                                  'reason', 'formation_invariant_failed',
                                  'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
                                  'cluster_id', g.id, 'cluster_epoch', v_epoch,
                                  'alerted', v_alert_id IS NOT NULL);
      END IF;
      -- Everything above is now rolled back. This INSERT is in the OUTER
      -- block, after the rollback, and is the only thing that survives it:
      -- specification 733's matcher_retry, carrying what refused and why.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_refused', 'sqlstate', v_sqlstate, 'message', v_msg,
        'players', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_refused',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;

  -- F12'S SHAPE, ONE PHASE ON, is measured INSIDE the atomic block since
  -- 2026-09-26, so that money moving during a formation is caught as the
  -- impossible state it is: rolled back, the Cluster frozen and the evidence
  -- written, rather than an uncaught error that leaves no row saying why.

  -- THE EVENTS OF A FORMED HAND (2026-09-26): the instance that was created,
  -- ONE reservation event carrying every player it holds, and the hand with
  -- every participant's seat, position and blind role. hand_created replaces
  -- the kind 20260925215731 wrote here, which nothing outside the Phase 9
  -- harness read.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES
    (g.id, 'instance_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'target_size', v_target, 'max_size', v_max, 'via', 'fn_lightning_form_hand', 'at', p_now),
     v_epoch, p_request_id),
    (g.id, 'pool_player_reserved', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                     FROM jsonb_array_elements(v_seats) x),
       'at', p_now), v_epoch, p_request_id),
    (g.id, 'hand_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand, 'instance_id', v_instance,
       'players', v_n, 'target_size', v_target, 'max_size', v_max,
       'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
       'participants', (SELECT jsonb_agg(jsonb_build_object(
                                 'player_id', x -> 'player_id', 'seat', x -> 'seat',
                                 'position', x -> 'position', 'blind_role', x -> 'blind_role',
                                 'stack_before', x -> 'stack_before')
                               ORDER BY (x ->> 'seat')::integer)
                          FROM jsonb_array_elements(v_seats) x),
       'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id);

  RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false,
                            'hand_id', v_hand, 'instance_id', v_instance,
                            'cluster_id', g.id, 'cluster_epoch', v_epoch,
                            'players', v_n, 'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
                            'seats', v_seats, 'state', 'reserved', 'request_id', p_request_id);

  EXCEPTION
    WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- Everything since the sub-block opened is rolled back: the reap, the
      -- formation, every lock taken after the Cluster row. The evidence is
      -- written here, after the rollback, and is the one thing that survives
      -- it. cluster_epoch 0 lets trg_cash_cluster_events_take_the_clusters_epoch
      -- fill in the Cluster's epoch when the lock that failed was the one
      -- taken before the epoch was read.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (p_cluster_id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_contended', 'sqlstate', v_sqlstate, 'message', v_msg,
        'at', p_now), coalesce(v_epoch, 0), p_request_id);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_contended',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_formation_sizes(p_legal integer, p_min integer, p_target integer, p_max integer, p_oldest_idle timestamp with time zone, p_now timestamp with time zone)
 RETURNS integer[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_max integer := LEAST(GREATEST(coalesce(nullif(p_max,0),2),2),9);
  v_min integer := LEAST(GREATEST(coalesce(nullif(p_min,0),2),2),v_max);
  v_target integer := LEAST(GREATEST(coalesce(nullif(p_target,0),v_max),v_min),v_max);
BEGIN
  IF p_now - p_oldest_idle >= interval '3 seconds' THEN
    RETURN public.fn_lightning_group_sizes(p_legal,v_min,v_target,v_max);
  END IF;
  RETURN ARRAY(SELECT v_target FROM generate_series(1,GREATEST(coalesce(p_legal,0),0)/v_target));
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_instance_begin_dealing(p_instance_id uuid, p_deal_window interval DEFAULT '00:10:00'::interval, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  i          record;
  g          record;
  v_cluster  uuid;
  v_why      text;
  v_gone     text;
  -- THE DEADLINE IS JUDGED BY THE DATABASE'S CLOCK (2026-09-26), never by the
  -- caller's: an old p_now would make an expired formation look alive.
  v_now      timestamptz := clock_timestamp();
  h          record;
  v_players  integer;
  v_committed integer;
  v_window   interval := GREATEST(coalesce(p_deal_window, interval '10 minutes'), interval '30 seconds');
BEGIN
  -- BARRIER STEP 13, AND ONLY ITS PRECONDITION. What is on the far side of
  -- this door is steps 11 and 12 - the shuffle, using the engine's
  -- authoritative RNG, and the deal - and neither of those is or should be in
  -- this database.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'platform_frozen');
  END IF;

  -- THE CLUSTER ROW FIRST, FOR SHARE (2026-09-26), in the order formation
  -- takes it, so that nothing can convert, freeze or disable the Cluster
  -- between the checks below and the release into gameplay.
  SELECT li.cluster_id INTO v_cluster FROM public.lightning_instance li WHERE li.id = p_instance_id;
  SELECT cg.id, cg.cluster_mode, cg.lightning_enabled, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = v_cluster FOR SHARE;

  SELECT li.id, li.state, li.hand_id, li.cluster_id, li.cluster_epoch, li.deadline_at, li.created_at
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'not_found');
  END IF;
  IF i.state IS DISTINCT FROM 'reserved' THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'wrong_state', 'state', i.state);
  END IF;
  IF i.deadline_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'past_deadline',
                              'deadline_at', i.deadline_at);
  END IF;

  SELECT lh.hand_id, lh.participants_locked_at, lh.player_count
    INTO h FROM public.lightning_hand lh WHERE lh.hand_id = i.hand_id;
  IF NOT FOUND OR h.participants_locked_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'participant_set_is_not_locked');
  END IF;

  SELECT count(*)::integer INTO v_players
    FROM public.lightning_hand_player hp WHERE hp.hand_id = h.hand_id;
  SELECT count(*)::integer INTO v_committed
    FROM public.lightning_reservation r
   WHERE r.lightning_instance_id = i.id AND r.state = 'committed';

  IF v_players IS DISTINCT FROM h.player_count
     OR v_committed IS DISTINCT FROM h.player_count THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'participant_set_does_not_agree',
                              'player_count', h.player_count, 'players', v_players,
                              'committed_reservations', v_committed);
  END IF;

  -- EVERY COMMITTED RESERVATION SITS IN THE SEAT THE HAND GAVE IT. Counting
  -- agreement is satisfied by two sets of the same size holding different
  -- people, which is the substitution the whole barrier exists to prevent.
  IF EXISTS (
    SELECT 1 FROM public.lightning_reservation r
     WHERE r.lightning_instance_id = i.id AND r.state = 'committed'
       AND NOT EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                        WHERE hp.hand_id = h.hand_id AND hp.player_id = r.player_id
                          AND hp.seat = r.seat_number)) THEN
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'reason', 'reservations_do_not_match_the_seats');
  END IF;

  -- THE WORLD OUTSIDE THE INSTANCE (2026-09-26). Everything above asks the
  -- instance about itself. A hand is released into gameplay only while its
  -- Cluster is still a Lightning pool at the epoch it was formed in, and while
  -- every participant is still in that pool: an open pool session, an open
  -- slot, an anchor seat that is live eligible, and an open cash session. If
  -- not, the formation is void and is abandoned HERE, so its players are
  -- handed back now rather than when the reaper finds it.
  v_why := CASE
    WHEN g.id IS NULL THEN 'cluster_not_found'
    WHEN g.cluster_mode IS DISTINCT FROM 'lightning' THEN 'cluster_is_not_lightning'
    WHEN coalesce(g.lightning_enabled, false) = false THEN 'lightning_disabled'
    WHEN g.cluster_epoch IS DISTINCT FROM i.cluster_epoch
      OR NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                      WHERE e.cluster_id = i.cluster_id AND e.epoch = i.cluster_epoch
                        AND e.ended_at IS NULL) THEN 'epoch_is_not_current'
    ELSE NULL END;
  IF v_why IS NULL THEN
    SELECT string_agg(hp.player_id::text, ',' ORDER BY hp.seat) INTO v_gone
      FROM public.lightning_hand_player hp
      JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE hp.hand_id = h.hand_id
       AND (sl.closed_at IS NOT NULL
            OR ps.exited_at IS NOT NULL
            OR NOT public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, i.cluster_id, ps.player_id)
            OR NOT EXISTS (SELECT 1 FROM public.cash_player_session cps
                            WHERE cps.id = ps.cash_player_session_id AND cps.closed_at IS NULL));
    IF v_gone IS NOT NULL THEN
      v_why := 'participant_left_the_pool';
    END IF;
  END IF;
  IF v_why IS NOT NULL THEN
    PERFORM public.fn_lightning_instance_abandon(
      i.id, 'begin_dealing refused: ' || v_why || coalesce(' [' || v_gone || ']', ''), v_now);
    RETURN jsonb_build_object('ok', false, 'dealing', false, 'abandoned', true, 'reason', v_why,
                              'instance_id', i.id, 'hand_id', h.hand_id, 'players', v_gone,
                              'cluster_mode', g.cluster_mode);
  END IF;

  UPDATE public.lightning_instance li
     SET state = 'dealing', started_at = GREATEST(v_now, i.created_at),
         deadline_at = GREATEST(v_now, i.created_at) + v_window
   WHERE li.id = i.id;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch)
  VALUES (i.cluster_id, 'instance_started', jsonb_build_object(
    'cluster_id', i.cluster_id, 'cluster_epoch', i.cluster_epoch, 'instance_id', i.id,
    'hand_id', h.hand_id, 'players', v_players,
    'deadline_at', GREATEST(v_now, i.created_at) + v_window, 'at', v_now), i.cluster_epoch);

  RETURN jsonb_build_object('ok', true, 'dealing', true, 'instance_id', i.id,
                            'hand_id', h.hand_id, 'players', v_players,
                            'cluster_id', i.cluster_id, 'cluster_epoch', i.cluster_epoch,
                            'deadline_at', GREATEST(v_now, i.created_at) + v_window);
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_match_plan(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text, p_max_groups integer, p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now       timestamptz := coalesce(p_now, now());
  v_cfg       jsonb;
  v_version   text;
  v_epoch     integer;
  v_min       integer;
  v_target    integer;
  v_max       integer;
  v_cap       integer;
  v_rule      text;
  v_p3        boolean;
  v_rows      jsonb;
  v_info      jsonb := '{}'::jsonb;
  v_legal     uuid[] := ARRAY[]::uuid[];
  v_newcomer  uuid[] := ARRAY[]::uuid[];
  v_seatable  uuid[];
  v_next      uuid[];
  v_held      uuid[] := ARRAY[]::uuid[];
  v_sizes     integer[];
  v_sizes2    integer[];
  v_g         integer;
  v_g2        integer;
  v_bbs       uuid[];
  v_rest_all  uuid[];
  v_rest      uuid[];
  v_sbs       uuid[];
  v_wait      uuid[];
  v_need      integer;
  v_sizing_left integer;
  v_n         integer;
  v_band      text;
  v_w         numeric;
  v_enc       jsonb := '{}'::jsonb;
  v_recent_sets jsonb := '{}'::jsonb;
  v_grp       jsonb;
  v_capleft   integer[];
  v_moved     integer[];
  v_assign    jsonb;
  v_last      jsonb := '{}'::jsonb;
  v_glast     integer;
  j           integer;
  v_members   uuid[];
  v_bb        uuid;
  v_sb        uuid;
  v_order     uuid[];
  v_left      uuid[];
  v_pick      uuid;
  v_label     text;
  v_size      integer;
  v_seat_no   integer;
  v_groups    jsonb := '[]'::jsonb;
  v_diag      jsonb;
  v_pairs     integer := 0;
  v_repeat_pairs integer := 0;
  v_gpairs    integer;
  v_grepeat   integer;
  v_genc      integer;
  v_matched   uuid[] := ARRAY[]::uuid[];
  v_capacity_reason text;
  v_win_h     integer;
  v_win_s     integer;
  v_variant   text;
BEGIN
  v_cfg := public.fn_lightning_config(p_cluster_id);
  v_version := coalesce(nullif(btrim(coalesce(p_matcher_version, '')), ''), v_cfg ->> 'matcher_version', 'm1');
  SELECT cg.cluster_epoch INTO v_epoch FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true OR v_epoch IS NULL THEN
    RETURN jsonb_build_object('matcher_version', v_version, 'generated_at', v_now, 'legal_count', 0,
                              'groups', '[]'::jsonb, 'diagnosis', '[]'::jsonb, 'pool_diversity_score', 1);
  END IF;
  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): ONLY A VARIANT THE
  -- LIGHTNING HOST CAN DEAL IS MATCHED. Pineapple's discard round needs the
  -- physical discard pipeline, which the host does not run (it abandons such
  -- a hand at begin: LightningHandHost.checkVariant), so every hand formed
  -- would be abandoned and the pool would churn. The Cluster's variant and
  -- its front table's rules (the host's) are read; every open-pool player
  -- is diagnosed BLOCKED_WITH_REASON VARIANT_NOT_SUPPORTED.
  SELECT CASE WHEN cg.variant = 'pineapple' THEN cg.variant
              WHEN tb.game_variant = 'pineapple' THEN tb.game_variant
              WHEN coalesce(tb.pineapple_holdem, false) THEN 'pineapple_holdem' END
    INTO v_variant
    FROM public.cash_games cg
    LEFT JOIN public.tables tb ON tb.id = public.fn_cash_cluster_front_table(cg.id)
   WHERE cg.id = p_cluster_id;
  IF v_variant IS NOT NULL THEN
    RETURN jsonb_build_object('matcher_version', v_version, 'generated_at', v_now, 'legal_count', 0,
                              'groups', '[]'::jsonb, 'refused', true, 'reason', 'variant_not_supported',
                              'variant', v_variant,
                              'diagnosis', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                                     'player_id', l.player_id, 'state', 'BLOCKED_WITH_REASON',
                                                     'reason_code', 'VARIANT_NOT_SUPPORTED') ORDER BY l.player_id), '[]'::jsonb)
                                              FROM public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected, p_player_platforms) l),
                              'pool_diversity_score', 1);
  END IF;
  v_min    := (v_cfg ->> 'instance_min')::integer;
  v_target := (v_cfg ->> 'instance_target')::integer;
  v_max    := (v_cfg ->> 'instance_max')::integer;
  v_rule   := v_cfg ->> 'first_entry_rule';
  v_p3     := (v_cfg ->> 'position_fairness')::boolean;
  v_win_h  := (v_cfg ->> 'recent_opponent_window_hands')::integer;
  v_win_s  := (v_cfg ->> 'recent_opponent_window_seconds')::integer;
  v_cap    := LEAST(GREATEST(coalesce(p_max_groups, (v_cfg ->> 'admission_batch_hands')::integer), 0),
                    (v_cfg ->> 'admission_batch_hands')::integer);

  -- P0, once. Every open-pool player, ordered by player_id.
  SELECT coalesce(jsonb_agg(jsonb_build_object('player_id', l.player_id, 'legal', l.legal,
                                               'reason_code', l.reason_code) ORDER BY l.player_id), '[]'::jsonb)
    INTO v_rows
    FROM public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected, p_player_platforms) l;

  -- THE KEYS OF EVERY LEGAL PLAYER. P2 is the barrier's own order; P4 is
  -- idle_since, pool entry, Cluster join, player_id.
  WITH lg AS (
    SELECT (x ->> 'player_id')::uuid AS pid
      FROM jsonb_array_elements(v_rows) x
     WHERE (x ->> 'legal')::boolean
  ), bo AS (
    SELECT b.* FROM public.fn_lightning_blind_order(p_cluster_id, v_epoch,
                      coalesce((SELECT array_agg(lg.pid) FROM lg), ARRAY[]::uuid[])) b
  ), k AS (
    SELECT bo.p2_rank, bo.player_id, bo.pool_slot_id, bo.bb_unresolved, bo.last_bb_at, bo.debt_age,
           sl.idle_since, ps.entered_at, cps.opened_at AS joined_at,
           (bl.player_id IS NULL) AS newcomer,
           coalesce(bl.btn_count, 0) AS btn, coalesce(bl.co_count, 0) AS co,
           coalesce(bl.hj_count, 0) AS hj, coalesce(bl.utg_count, 0) AS utg,
           row_number() OVER (ORDER BY sl.idle_since, ps.entered_at, cps.opened_at, bo.player_id) AS p4
      FROM bo
      JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
      LEFT JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
      LEFT JOIN public.lightning_blind_ledger bl ON bl.cluster_id = sl.cluster_id AND bl.player_id = sl.player_id
  )
  SELECT coalesce(array_agg(k.player_id ORDER BY k.p2_rank), ARRAY[]::uuid[]),
         coalesce(array_agg(k.player_id ORDER BY k.p2_rank) FILTER (WHERE k.newcomer), ARRAY[]::uuid[]),
         coalesce(jsonb_object_agg(k.player_id::text, jsonb_build_object(
           'p2', k.p2_rank, 'p4', k.p4, 'slot', k.pool_slot_id,
           'bb_unresolved', k.bb_unresolved, 'last_bb_at', k.last_bb_at, 'debt_age', k.debt_age,
           'idle_since', k.idle_since, 'entered_at', k.entered_at, 'joined_at', k.joined_at,
           'btn', k.btn, 'co', k.co, 'hj', k.hj, 'utg', k.utg)), '{}'::jsonb)
    INTO v_legal, v_newcomer, v_info
    FROM k;

  v_n := cardinality(v_legal);

  -- P5's band, by the legal count.
  v_band := CASE WHEN v_n >= (v_cfg ->> 'diversity_large_min')::integer THEN 'large'
                 WHEN v_n >= (v_cfg ->> 'diversity_medium_min')::integer THEN 'medium'
                 WHEN v_n >= (v_cfg ->> 'diversity_thin_min')::integer THEN 'thin'
                 ELSE 'tiny' END;
  v_w := CASE v_band WHEN 'large' THEN (v_cfg ->> 'diversity_weight_large')::numeric
                     WHEN 'medium' THEN (v_cfg ->> 'diversity_weight_medium')::numeric
                     ELSE 0 END;

  -- P1: sizes from the legal count. P2: the first g legal players in P2
  -- order are the g big blinds.
  v_seatable := v_legal;
  v_sizes := public.fn_lightning_formation_sizes(cardinality(v_seatable), v_min, v_target, v_max, (SELECT min((v_info -> q.pid::text ->> 'idle_since')::timestamptz) FROM unnest(v_seatable) q(pid)), v_now);
  v_g := LEAST(cardinality(v_sizes), v_cap);

  -- THE FIRST-ENTRY RULE, when configured: a player new to the Cluster's
  -- ledger waits to be dealt in as a big blind - but only while holding them
  -- costs the pass no hand (P1 outranks it).
  IF v_rule = 'big_blind' AND v_g > 0 THEN
    v_bbs := v_seatable[1:v_g];
    v_next := ARRAY(SELECT u.pid FROM unnest(v_seatable) WITH ORDINALITY u(pid, ord)
                     WHERE NOT (u.pid = ANY (v_newcomer)) OR u.pid = ANY (v_bbs)
                     ORDER BY u.ord);
    IF cardinality(v_next) < cardinality(v_seatable) THEN
      v_sizes2 := public.fn_lightning_formation_sizes(cardinality(v_next), v_min, v_target, v_max, (SELECT min((v_info -> q.pid::text ->> 'idle_since')::timestamptz) FROM unnest(v_next) q(pid)), v_now);
      v_g2 := LEAST(cardinality(v_sizes2), v_cap);
      IF v_g2 = v_g THEN
        v_held := ARRAY(SELECT u.pid FROM unnest(v_seatable) WITH ORDINALITY u(pid, ord)
                         WHERE NOT (u.pid = ANY (v_next)) ORDER BY u.ord);
        v_seatable := v_next;
        v_sizes := v_sizes2;
      END IF;
    END IF;
  END IF;

  v_bbs := CASE WHEN v_g > 0 THEN v_seatable[1:v_g] ELSE ARRAY[]::uuid[] END;

  -- P4: the non-blind seats of this pass go to the non-blind seatable
  -- players in queue order; the rest wait for formation.
  v_rest_all := ARRAY(SELECT u.pid FROM unnest(v_seatable) u(pid)
                       WHERE NOT (u.pid = ANY (v_bbs))
                       ORDER BY (v_info -> u.pid::text ->> 'p4')::integer);
  v_need := coalesce((SELECT sum(s) FROM unnest(v_sizes[1:v_g]) s), 0)::integer - v_g;
  v_rest := v_rest_all[1:v_need];
  v_wait := coalesce(v_rest_all[v_need + 1:cardinality(v_rest_all)], ARRAY[]::uuid[]);
  v_sizing_left := cardinality(v_seatable) - coalesce((SELECT sum(s) FROM unnest(v_sizes) s), 0)::integer;

  -- P5's MEMORY: pair encounters among this pass's seated players in the
  -- Cluster's most recent hands, and the recent full-table compositions.
  IF v_g > 0 THEN
    WITH recent AS (
      SELECT h.hand_id
        FROM public.lightning_hand h
       WHERE h.cluster_id = p_cluster_id AND h.cluster_epoch = v_epoch
         AND h.formed_at <= v_now
         AND h.formed_at > v_now - make_interval(secs => v_win_s)
       ORDER BY h.formed_at DESC, h.hand_id
       LIMIT v_win_h
    ), hp AS (
      SELECT hp.hand_id, hp.player_id, h.formed_at
        FROM recent
        JOIN public.lightning_hand h ON h.hand_id = recent.hand_id
        JOIN public.lightning_hand_player hp ON hp.hand_id = recent.hand_id
    ), last_hand AS (
      SELECT DISTINCT ON (hp.player_id) hp.player_id, hp.hand_id
        FROM hp ORDER BY hp.player_id, hp.formed_at DESC, hp.hand_id
    )
    SELECT coalesce((SELECT jsonb_object_agg(q.pair, q.n)
                       FROM (SELECT a.player_id::text || '/' || b.player_id::text AS pair, count(*)::integer AS n
                               FROM hp a JOIN hp b ON b.hand_id = a.hand_id AND a.player_id < b.player_id
                              WHERE a.player_id = ANY (v_bbs || v_rest) AND b.player_id = ANY (v_bbs || v_rest)
                              GROUP BY a.player_id, b.player_id) q), '{}'::jsonb),
           coalesce((SELECT jsonb_object_agg(s.members, true)
                       FROM (SELECT DISTINCT string_agg(hp.player_id::text, ',' ORDER BY hp.player_id) AS members
                               FROM hp GROUP BY hp.hand_id) s), '{}'::jsonb),
           -- Ordered pairs a/b: b sat in a's most recent hand (an immediate repeat).
           coalesce((SELECT jsonb_object_agg(l.player_id::text || '/' || o.player_id::text, true)
                       FROM last_hand l JOIN hp o ON o.hand_id = l.hand_id AND o.player_id <> l.player_id
                      WHERE l.player_id = ANY (v_bbs || v_rest)), '{}'::jsonb)
      INTO v_enc, v_recent_sets, v_last;
  END IF;

  -- P2 FOR THE SMALL BLIND: of the players seated this pass, the next g in
  -- P2 order are the small blinds, one to a group - the classical orbit, in
  -- which the small blind is the player next due for the big blind. Every one
  -- of them is seated this pass either way, so which group each sits in is a
  -- choice among P4-equivalents; and each ranks above every other non-blind
  -- member of its group, so the barrier's own P2-second is this player.
  v_sbs := ARRAY(SELECT u.pid FROM unnest(v_rest) u(pid)
                  ORDER BY (v_info -> u.pid::text ->> 'p2')::integer LIMIT v_g);
  v_rest := ARRAY(SELECT u.pid FROM unnest(v_rest) WITH ORDINALITY u(pid, ord)
                   WHERE NOT (u.pid = ANY (v_sbs)) ORDER BY u.ord);

  -- THE ASSIGNMENT. Each group starts with its big and small blinds; each
  -- other seated player, in P4 order, goes to the first group with room
  -- (plain P4) unless P5 saves weight x (encounters, and a repeated full
  -- table) >= 1 elsewhere: fn_lightning_diversity_assign, pure.
  v_grp := '[]'::jsonb;
  v_capleft := ARRAY[]::integer[];
  FOR j IN 1 .. v_g LOOP
    v_grp := v_grp || jsonb_build_array(jsonb_build_array(v_bbs[j], v_sbs[j]));
    v_capleft := v_capleft || (v_sizes[j] - 2);
  END LOOP;
  v_assign := public.fn_lightning_diversity_assign(v_grp, v_rest, v_capleft, v_enc, v_recent_sets, v_w);
  v_grp := v_assign -> 'groups';
  v_moved := ARRAY(SELECT x::integer FROM jsonb_array_elements_text(v_assign -> 'moved') WITH ORDINALITY t(x, o) ORDER BY o);

  -- EACH GROUP: P3's advisory order of the non-blind seats, and the evidence.
  FOR j IN 1 .. v_g LOOP
    v_bb := v_bbs[j];
    v_members := ARRAY(SELECT m.pid::uuid FROM jsonb_array_elements_text(v_grp -> (j - 1)) m(pid));
    -- The small blind, placed above; the barrier's own P2-second in the group.
    v_sb := v_sbs[j];
    -- P3, ADVISORY, AND ONLY THE ORDER OF THE NON-BLIND SEATS. The barrier
    -- seats the caller's order from seat 3 onward and names the positions by
    -- seat (the last is the button, then the cut-off, the hijack, and seat 3
    -- under-the-gun). Filled from the button backward, each seat goes to the
    -- remaining member who has held that position least; a tie - and every
    -- seat when P3 is off - keeps queue order.
    v_left := ARRAY(SELECT m FROM unnest(v_members) m
                     WHERE m <> v_bb AND m IS DISTINCT FROM v_sb
                     ORDER BY (v_info -> m::text ->> 'p4')::integer);
    v_order := ARRAY[]::uuid[];
    v_size := cardinality(v_members);
    FOR v_seat_no IN REVERSE v_size .. 3 LOOP
      v_label := CASE WHEN v_seat_no = v_size THEN 'btn'
                      WHEN v_seat_no = v_size - 1 THEN 'co'
                      WHEN v_seat_no = v_size - 2 THEN 'hj'
                      WHEN v_seat_no = 3 THEN 'utg'
                      ELSE NULL END;
      SELECT u.m INTO v_pick FROM unnest(v_left) WITH ORDINALITY u(m, o)
       ORDER BY CASE WHEN v_p3 AND v_label IS NOT NULL THEN (v_info -> u.m::text ->> v_label)::integer ELSE 0 END,
                u.o DESC
       LIMIT 1;
      v_order := v_pick || v_order;
      v_left := array_remove(v_left, v_pick);
    END LOOP;
    SELECT count(*)::integer,
           coalesce(sum(CASE WHEN coalesce((v_enc ->> (a.m::text || '/' || b.m::text))::integer, 0) > 0 THEN 1 ELSE 0 END), 0)::integer,
           coalesce(sum(coalesce((v_enc ->> (a.m::text || '/' || b.m::text))::integer, 0)), 0)::integer
      INTO v_gpairs, v_grepeat, v_genc
      FROM unnest(v_members) a(m) JOIN unnest(v_members) b(m) ON a.m < b.m;
    SELECT count(*)::integer INTO v_glast
      FROM unnest(v_members) a(m) JOIN unnest(v_members) b(m) ON a.m <> b.m
     WHERE v_last ? (a.m::text || '/' || b.m::text);
    v_pairs := v_pairs + v_gpairs;
    v_repeat_pairs := v_repeat_pairs + v_grepeat;
    v_matched := v_matched || v_members;
    v_groups := v_groups || jsonb_build_array(jsonb_build_object(
      'players', to_jsonb(ARRAY[v_bb] || CASE WHEN v_sb IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_sb] END || v_order),
      'bb', v_bb,
      'keys', jsonb_build_object(
        'size', cardinality(v_members),
        'instance', jsonb_build_object('min', v_min, 'target', v_target, 'max', v_max),
        'p2', jsonb_build_object('bb', v_bb, 'bb_p2_rank', (v_info -> v_bb::text -> 'p2'),
                                 'bb_unresolved', (v_info -> v_bb::text -> 'bb_unresolved'),
                                 'bb_last_bb_at', (v_info -> v_bb::text -> 'last_bb_at'),
                                 'bb_debt_age', (v_info -> v_bb::text -> 'debt_age'),
                                 'sb', v_sb, 'sb_p2_rank', (v_info -> v_sb::text -> 'p2')),
        -- Heads-up, the small blind is the button (the barrier's own rule).
        'p3', jsonb_build_object('applied', v_p3,
                                 'btn', coalesce(v_order[cardinality(v_order)], v_sb),
                                 'btn_count_before', (v_info -> (coalesce(v_order[cardinality(v_order)], v_sb))::text -> 'btn'),
                                 'order', to_jsonb(v_order)),
        'p4', jsonb_build_object('ranks', (SELECT jsonb_agg((v_info -> m::text -> 'p4') ORDER BY (v_info -> m::text ->> 'p4')::integer)
                                             FROM unnest(v_members) m WHERE m <> v_bb),
                                 'oldest_idle_since', (SELECT min((v_info -> m::text ->> 'idle_since')::timestamptz)
                                                         FROM unnest(v_members) m)),
        'p5', jsonb_build_object('band', v_band, 'weight', v_w, 'pairs', v_gpairs,
                                 'repeat_pairs', v_grepeat, 'pair_encounters', v_genc,
                                 'moved_here', v_moved[j],
                                 'repeat_full_table', v_recent_sets ? (SELECT string_agg(m::text, ',' ORDER BY m) FROM unnest(v_members) m),
                                 -- The specification's diversity measures, for this hand:
                                 -- pairings in it nobody met in the window, those per player,
                                 -- the share of pairings that are repeats, and the share of
                                 -- (player, opponent) pairs where the opponent sat in the
                                 -- player's most recent hand.
                                 'unique_opponents', v_gpairs - v_grepeat,
                                 'new_opponents_per_hand', CASE WHEN cardinality(v_members) = 0 THEN 0
                                   ELSE round(2 * (v_gpairs - v_grepeat)::numeric / cardinality(v_members), 4) END,
                                 'repeat_pair_rate', CASE WHEN v_gpairs = 0 THEN 0
                                   ELSE round(v_grepeat::numeric / v_gpairs, 4) END,
                                 'repeat_opponent_rate', CASE WHEN cardinality(v_members) < 2 THEN 0
                                   ELSE round(v_glast::numeric / (cardinality(v_members) * (cardinality(v_members) - 1)), 4) END),
        'p6', jsonb_build_object('new_instance', true, 'merged_into_committed_hand', false))));
  END LOOP;

  -- THE DIAGNOSIS: every open-pool player, exactly once.
  v_capacity_reason := CASE WHEN v_g < cardinality(v_sizes) THEN 'PASS_CAPACITY' ELSE 'GROUP_SIZING' END;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'player_id', d.pid,
           'state', CASE
             WHEN d.pid = ANY (v_matched) THEN 'MATCHED'
             WHEN d.code = 'DISCONNECTED' THEN 'WAITING_FOR_RECONNECT'
             WHEN d.code IS NOT NULL THEN 'BLOCKED_WITH_REASON'
             WHEN d.pid = ANY (v_held) THEN 'WAITING_FOR_BB'
             WHEN v_n < v_min THEN 'WAITING_FOR_PLAYERS'
             ELSE 'WAITING_FOR_FORMATION' END,
           'reason_code', CASE
             WHEN d.pid = ANY (v_matched) THEN NULL
             WHEN d.code IS NOT NULL THEN d.code
             WHEN d.pid = ANY (v_held) THEN 'FIRST_ENTRY_WAITS_FOR_BB'
             WHEN v_n < v_min THEN 'NOT_ENOUGH_LEGAL_PLAYERS'
             -- The sizing leftovers are the last in queue order.
             WHEN v_sizing_left > 0
                  AND array_position(v_wait, d.pid) > cardinality(v_wait) - v_sizing_left THEN 'GROUP_SIZING'
             ELSE v_capacity_reason END) ORDER BY d.pid), '[]'::jsonb)
    INTO v_diag
    FROM (SELECT (x ->> 'player_id')::uuid AS pid, x ->> 'reason_code' AS code
            FROM jsonb_array_elements(v_rows) x) d;

  RETURN jsonb_build_object(
    'matcher_version', v_version,
    'generated_at', v_now,
    'legal_count', v_n,
    'groups', v_groups,
    'diagnosis', v_diag,
    'pool_diversity_score', CASE WHEN v_pairs = 0 THEN 1
                                 ELSE round(1 - v_repeat_pairs::numeric / v_pairs, 4) END);
END
$function$
;
