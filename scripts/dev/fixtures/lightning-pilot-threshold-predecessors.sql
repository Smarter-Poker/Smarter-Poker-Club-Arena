-- Exact production images read 2026-10-22 05:30 UTC (PostgreSQL 17.6) through the
-- read-only management query endpoint: the five functions the pilot threshold
-- change is read through, and the two private pilot games as they stood
-- (ruleset_snapshot verbatim). Fixture only; never production source.
CREATE TABLE public.cash_games(id uuid PRIMARY KEY, club_id uuid, union_id uuid, template_name text,
  handedness integer, ruleset_snapshot jsonb, lightning_enabled boolean DEFAULT false);
CREATE OR REPLACE FUNCTION public.fn_lightning_table_size_allowed(p_handedness integer)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT coalesce(p_handedness = 6, false) $function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds_probe(p_cfg jsonb, p_handedness integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_int_re constant text := '^-?[0-9]{1,9}(\.0+)?$';
  v_on      integer;
  v_off     integer;
  v_got_on  boolean := false;
  v_got_off boolean := false;
  v_source  text;
  -- WHICH CONFIGURED VALUES WERE THROWN AWAY, AND THEREFORE WHY THE ANSWER IS
  -- A DEFAULT. Without this a typo is indistinguishable from an empty config:
  -- {"on_threshold": 18.5} answers 18 and reports source 'default', which is
  -- true and useless, because it is also what {} answers. An operator who
  -- fat-fingers a threshold gets no signal at all that it was discarded. A
  -- hysteresis failure already had its own source value; a type failure did
  -- not. This is additive - it takes nothing away from the four sources - and
  -- it is the difference between a silent discard and a reportable one.
  v_rejected jsonb := '[]'::jsonb;
BEGIN
  -- THE MANDATED DEFAULTS, AND THE ONLY PLACE THEY ARE WRITTEN.
  -- Specification: 6-max ON 18 / OFF 12; 9-max and full ring ON 27 / OFF 18.
  -- handedness is the seats at one table. A handedness at or below zero is not
  -- a six-max game, it is a missing value, so it takes the full-ring default
  -- rather than silently landing in the smaller band.
  IF p_handedness IS NULL OR p_handedness <= 0 OR p_handedness > 6 THEN
    v_on := 27; v_off := 18;
  ELSE
    v_on := 18; v_off := 12;
  END IF;

  IF jsonb_typeof(p_cfg) = 'object' THEN
    IF jsonb_typeof(p_cfg -> 'on_threshold') = 'number'
       AND (p_cfg ->> 'on_threshold') ~ v_int_re THEN
      v_on := floor((p_cfg ->> 'on_threshold')::numeric)::integer; v_got_on := true;
    -- Present and unusable is reported. A JSON null is ABSENT, not a typo:
    -- "unset it" is a legitimate thing for a config writer to mean, and
    -- listing it as rejected would cry wolf on every deliberate clear.
    ELSIF p_cfg ? 'on_threshold' AND jsonb_typeof(p_cfg -> 'on_threshold') <> 'null' THEN
      v_rejected := v_rejected || to_jsonb('on_threshold'::text);
    END IF;
    IF jsonb_typeof(p_cfg -> 'off_threshold') = 'number'
       AND (p_cfg ->> 'off_threshold') ~ v_int_re THEN
      v_off := floor((p_cfg ->> 'off_threshold')::numeric)::integer; v_got_off := true;
    ELSIF p_cfg ? 'off_threshold' AND jsonb_typeof(p_cfg -> 'off_threshold') <> 'null' THEN
      v_rejected := v_rejected || to_jsonb('off_threshold'::text);
    END IF;
  END IF;

  -- source IS PER-FIELD NOW. The first cut reported 'ruleset' whenever either
  -- half came from configuration, so an operator who wrote {"on_threshold":
  -- "30", "off_threshold": 5} - a string and a number - was told 'ruleset' for
  -- a pair of 18 and 5, where the 18 was the band default and only the 5 was
  -- theirs. That pair passes the validity guard, so nothing else flagged it.
  v_source := CASE
    WHEN v_got_on AND v_got_off THEN 'ruleset'
    WHEN v_got_on OR  v_got_off THEN 'ruleset_partial'
    ELSE 'default' END;

  -- HYSTERESIS IS A RULE, NOT A CONVENTION. "The OFF threshold provides
  -- hysteresis and prevents rapid ON/OFF oscillation." An OFF at or above the
  -- ON would convert a Cluster every tick, forever, in both directions. A
  -- configuration that says so is refused and the defaults answer instead.
  -- The first cut also tested v_on IS NULL here; both are unconditionally
  -- assigned above and no branch can unset them, so that half was dead, and
  -- reading dead cover as live cover is part of how the blocker survived.
  IF v_on <= v_off OR v_off < 2 THEN
    IF p_handedness IS NULL OR p_handedness <= 0 OR p_handedness > 6 THEN
      v_on := 27; v_off := 18;
    ELSE
      v_on := 18; v_off := 12;
    END IF;
    v_source := 'default_after_invalid_config';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'handedness', p_handedness,
    'band', CASE WHEN p_handedness IS NOT NULL AND p_handedness > 0 AND p_handedness <= 6
                 THEN 'six_max' ELSE 'full_ring' END,
    'on', v_on,
    'off', v_off,
    'source', v_source,
    'rejected', v_rejected);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_thresholds(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE g record;
BEGIN
  SELECT id, handedness, ruleset_snapshot INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  RETURN public.fn_cash_cluster_lightning_thresholds_probe(g.ruleset_snapshot -> 'lightning', g.handedness)
         || jsonb_build_object('game_id', g.id,
              'lightning_allowed', public.fn_lightning_table_size_allowed(g.handedness))
         || CASE WHEN public.fn_lightning_table_size_allowed(g.handedness) THEN '{}'::jsonb
                 ELSE jsonb_build_object('reason', 'LIGHTNING_TABLE_SIZE_NOT_ALLOWED') END;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_lightning_config_number(p_cfg jsonb, p_key text, p_default numeric, p_lo numeric, p_hi numeric, p_integer boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_raw jsonb;
  v     numeric;
  v_use numeric;
BEGIN
  IF jsonb_typeof(p_cfg) IS DISTINCT FROM 'object' OR NOT (p_cfg ? p_key)
     OR jsonb_typeof(p_cfg -> p_key) = 'null' THEN
    RETURN jsonb_build_object('value', p_default);
  END IF;
  v_raw := p_cfg -> p_key;
  IF jsonb_typeof(v_raw) IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('value', p_default, 'invalid', jsonb_build_object(
      'key', p_key, 'given', v_raw, 'reason', 'wrong_type', 'used', p_default));
  END IF;
  -- The threshold reader's own integer rule: digits, optionally .0.
  IF p_integer AND (v_raw #>> '{}') !~ '^-?[0-9]{1,9}(\.0+)?$' THEN
    RETURN jsonb_build_object('value', p_default, 'invalid', jsonb_build_object(
      'key', p_key, 'given', v_raw, 'reason', 'not_an_integer', 'used', p_default));
  END IF;
  v := (v_raw #>> '{}')::numeric;
  IF p_integer THEN v := trunc(v); END IF;
  IF v < p_lo OR v > p_hi THEN
    v_use := LEAST(GREATEST(v, p_lo), p_hi);
    RETURN jsonb_build_object('value', v_use, 'invalid', jsonb_build_object(
      'key', p_key, 'given', v_raw, 'reason', 'out_of_range_clamped', 'used', v_use,
      'range', jsonb_build_array(p_lo, p_hi)));
  END IF;
  RETURN jsonb_build_object('value', v);
END
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

INSERT INTO public.cash_games(id,club_id,template_name,handedness,ruleset_snapshot,lightning_enabled) VALUES
('56d5d6f0-23e9-41b0-b407-852aa1026c2a','e14bc9f7-736d-425f-8f2c-e78305ebac1d','action',6,$snap${"bb": 0.02, "sb": 0.01, "rake": "existing", "bombs": {"boards": 2, "ante_bb": 2, "enabled": true, "trigger": "timed_20m"}, "seats": 6, "family": "holdem", "options": {"ban_chat": false, "is_private": true, "is_vip_only": false, "is_anonymous": false, "insurance_enabled": false, "action_time_seconds": 15, "seven_deuce_enabled": false}, "variant": "nlh", "straddle": false, "template": "action", "lightning": {"worker_mode": "form", "shadow_window_ms": 60000, "integrity_telemetry": true, "shadow_matcher_version": "m1-port", "lightning_joins_enabled": true, "lightning_shadow_matcher": true}, "table_mode": "must_move", "vpip_floor": 30, "resolved_at": "2026-10-17T00:57:33.249258+00:00", "vpip_window": 10, "max_buyin_bb": 200, "min_buyin_bb": 50, "regular_ante": "sb", "seat_choices": [2, 3, 4, 5, 6, 7, 8, 9], "seats_locked": false, "run_it_n_times": "opt_in", "stay_clock_min": 10, "rejoin_window_min": 120}$snap$::jsonb,true),
('681eb9e8-e9fd-4026-8ec6-64075b911d33','e14bc9f7-736d-425f-8f2c-e78305ebac1d','madness',6,$snap${"bb": 0.04, "sb": 0.02, "rake": "existing", "bombs": {"boards": 2, "ante_bb": 3, "enabled": true, "trigger": "timed_10m"}, "seats": 6, "family": "holdem", "options": {"ban_chat": false, "is_private": true, "is_vip_only": false, "is_anonymous": false, "insurance_enabled": false, "action_time_seconds": 15, "seven_deuce_enabled": false}, "variant": "nlh", "straddle": false, "template": "madness", "lightning": {"worker_mode": "form", "shadow_window_ms": 60000, "integrity_telemetry": true, "shadow_matcher_version": "m1-port", "lightning_shadow_matcher": true}, "table_mode": "must_move", "vpip_floor": 50, "resolved_at": "2026-10-17T17:08:21.813703+00:00", "vpip_window": 10, "max_buyin_bb": 200, "min_buyin_bb": 100, "regular_ante": "bb", "seat_choices": [2, 3, 4, 5, 6, 7, 8, 9], "seats_locked": false, "run_it_n_times": "opt_in", "stay_clock_min": 10, "rejoin_window_min": 120}$snap$::jsonb,true);
