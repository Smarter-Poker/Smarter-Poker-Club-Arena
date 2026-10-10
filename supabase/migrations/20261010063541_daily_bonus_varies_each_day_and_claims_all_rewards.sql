-- One explicit claim accepts the day's eligible rewards through canonical
-- per-slot claims. No new mint, financial caps or eligibility bypass.
-- Existing snapshots/claims are preserved. New snapshots vary types by date.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='90s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_daily_bonus_open_day(uuid,date)'::regprocedure)) <> '99368881e41829478f592456f453a10e' THEN RAISE EXCEPTION 'Daily bonus open_day predecessor changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_daily_bonus_status()'::regprocedure)) <> '83a741fd82881664e20215ce1faf39b5' THEN RAISE EXCEPTION 'Daily bonus status predecessor changed'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_ca_daily_bonus_claim_all','approved','Authenticated daily batch delegates all value movements to canonical idempotent daily claims, under the same per-player transaction lock. Caps, freeze, eligibility and VIP guards remain authoritative.'),
 ('fn_ca_daily_bonus_pick_tiles','approved','Private read-only daily reward selector using maintained calendar quantities. Excludes yesterday corresponding reward type. Moves no value.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE FUNCTION public.fn_ca_daily_bonus_pick_tiles(p_user_id uuid, p_date date, p_streak integer, p_previous jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE c record; picked record; previous_kind text; result jsonb := '[]';
BEGIN
  -- Use the maintained calendar's reward quantities and slot count. Pick the
  -- type on the server; the date and account seed keep previews reproducible.
  FOR c IN SELECT * FROM public.ca_daily_bonus_calendar WHERE active AND
    ((streak_day=p_streak) OR (cycle_day=((p_streak-1)%7)+1 AND NOT EXISTS
      (SELECT 1 FROM public.ca_daily_bonus_calendar WHERE active AND streak_day=p_streak))) ORDER BY slot
  LOOP
    SELECT t->>'kind' INTO previous_kind FROM jsonb_array_elements(p_previous) t
      WHERE (t->>'slot')::integer=c.slot;
    SELECT pool.* INTO picked FROM public.ca_daily_bonus_calendar pool
      WHERE pool.active AND pool.kind NOT IN ('mystery','free_spin')
        AND pool.kind IS DISTINCT FROM previous_kind
        AND (pool.kind<>'boost' OR (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result) t WHERE t->>'kind'='boost') AND NOT EXISTS (SELECT 1 FROM public.player_boosts b
          WHERE b.user_id=p_user_id AND b.kind='mission_diamonds'
          AND b.ends_at > p_date::timestamp AT TIME ZONE 'America/Chicago')))
      ORDER BY
        -- Prefer different types within today's sheet as well.
        EXISTS (SELECT 1 FROM jsonb_array_elements(result) t WHERE t->>'kind'=pool.kind),
        md5(p_user_id::text || ':' || p_date::text || ':' || c.slot::text || ':' || pool.kind),
        abs(COALESCE(pool.cycle_day,7)-COALESCE(c.cycle_day,7)), pool.id
      LIMIT 1;
    IF picked.id IS NULL THEN RAISE EXCEPTION 'No nonrepeating daily reward available'; END IF;
    result := result || jsonb_build_array(jsonb_build_object(
      'slot',c.slot,'kind',picked.kind,
      'label',CASE WHEN c.vip_only THEN 'VIP ' || picked.label ELSE picked.label END,
      'vip_only',c.vip_only,'quantity',picked.quantity,'base_diamonds',picked.diamonds,
      'diamonds',CASE WHEN picked.kind='diamonds' THEN
        LEAST(125,round(picked.diamonds * public.fn_get_streak_multiplier(p_streak))::integer) ELSE 0 END,
      'mystery',NULL));
  END LOOP;
  RETURN result || public.fn_ca_daily_bonus_spin_tile(p_streak);
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_pick_tiles(uuid,date,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_pick_tiles(uuid,date,integer,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_open_day(p_user_id uuid, p_today date)
 RETURNS ca_daily_bonus_days
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row        public.ca_daily_bonus_days;
  v_yesterday  public.ca_daily_bonus_days;
  v_last       public.ca_daily_bonus_days;
  v_shield     public.feature_purchases;
  v_streak     integer;
  v_cycle_day  integer;
  v_streak_day integer;
  v_tiles      jsonb;
  v_mystery    jsonb;
  v_protected  boolean := false;
  v_shield_id  uuid := NULL;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:' || p_user_id::text, 0));
  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  IF FOUND THEN
    IF p_today=(now() AT TIME ZONE 'America/Chicago')::date AND v_row.streak % 10=0
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_row.tiles) t WHERE (t->>'slot')::integer=7) THEN
      UPDATE public.ca_daily_bonus_days SET tiles=tiles||public.fn_ca_daily_bonus_spin_tile(v_row.streak)
       WHERE user_id=p_user_id AND bonus_date=p_today RETURNING * INTO v_row;
    END IF;
    RETURN v_row;
  END IF;

  -- The streak advances only across consecutive CLAIMED days. An opened but
  -- unclaimed yesterday is a gap, exactly like a day never opened.
  SELECT * INTO v_yesterday FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today - 1;
  IF FOUND AND v_yesterday.first_claimed_at IS NOT NULL THEN
    v_streak := v_yesterday.streak + 1;
  ELSE
    -- PHASE 3, THE SHIELD. Exactly one missed day, and a shield in hand: the
    -- shield is spent here, at the moment the gap would have reset the
    -- streak, and the streak carries on from the last claimed day. Two missed
    -- days are a reset; a shield covers one day, never a holiday.
    SELECT * INTO v_last FROM public.ca_daily_bonus_days
     WHERE user_id = p_user_id AND bonus_date < p_today AND first_claimed_at IS NOT NULL
     ORDER BY bonus_date DESC LIMIT 1;
    IF FOUND AND v_last.bonus_date = p_today - 2 THEN
      SELECT * INTO v_shield FROM public.feature_purchases f
       WHERE f.user_id = p_user_id AND f.feature = 'streak_shield'
         AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now())
       ORDER BY f.expires_at NULLS LAST, f.created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED;
      IF FOUND THEN
        UPDATE public.feature_purchases SET uses_remaining = uses_remaining - 1 WHERE id = v_shield.id;
        v_streak    := v_last.streak + 1;
        v_protected := true;
        v_shield_id := v_shield.id;
      END IF;
    END IF;
    IF NOT v_protected THEN
      v_streak := 1;
    END IF;
  END IF;

  v_cycle_day := ((v_streak - 1) % 7) + 1;
  SELECT c.streak_day INTO v_streak_day
    FROM public.ca_daily_bonus_calendar c
   WHERE c.streak_day = v_streak AND c.active
   LIMIT 1;

  v_tiles := public.fn_ca_daily_bonus_pick_tiles(p_user_id, p_today, v_streak, COALESCE(v_yesterday.tiles, '[]'::jsonb));

  IF v_tiles = '[]'::jsonb THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_open_day: no calendar rows for streak % (cycle day %)', v_streak, v_cycle_day
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ca_daily_bonus_days (user_id, bonus_date, streak, cycle_day, streak_day, tiles, streak_protected, shield_consumed_id)
  VALUES (p_user_id, p_today, v_streak, v_cycle_day, v_streak_day, v_tiles, v_protected, v_shield_id)
  ON CONFLICT (user_id, bonus_date) DO NOTHING;

  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  RETURN v_row;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reset_at   timestamptz := ((now() AT TIME ZONE 'America/Chicago')::date + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_caps       jsonb;
  v_tiles      jsonb;
  v_week       jsonb;
  v_next       jsonb;
  v_next_streak integer;
  v_next_cycle  integer;
  v_shield     jsonb;
  v_boost      jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_status requires an authenticated caller' USING ERRCODE = '28000';
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN jsonb_build_object('eligible', false, 'reason', v_elig, 'today', v_today,
                              'reset_at', v_reset_at,
                              'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
                              'shown_today', false,
                              'tiles', '[]'::jsonb);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;

  v_day  := public.fn_ca_daily_bonus_open_day(v_uid, v_today);
  v_caps := public.fn_ca_daily_bonus_caps(v_uid, v_is_vip);

  -- Today's tiles with their claim state. The mystery result stays hidden
  -- until it is claimed; the claim reveals it. A diamond tile the daily cap
  -- would trim is flagged so the sheet can say so before the tap.
  SELECT COALESCE(jsonb_agg(
           (t - 'mystery') || jsonb_build_object(
             'claimed', cl.id IS NOT NULL,
             'claimed_at', cl.created_at,
             'granted', cl.granted,
             'revealed', CASE WHEN cl.id IS NOT NULL THEN cl.result->'revealed' ELSE NULL END,
             'locked', (t->>'vip_only')::boolean AND NOT v_is_vip,
             'capped', cl.id IS NULL AND t->>'kind' = 'diamonds'
                       AND (t->>'diamonds')::int > (v_caps->>'daily_remaining')::int
           ) ORDER BY (t->>'slot')::int), '[]'::jsonb)
    INTO v_tiles
    FROM jsonb_array_elements(v_day.tiles) t
    LEFT JOIN public.ca_daily_bonus_claims cl
      ON cl.user_id = v_uid AND cl.bonus_date = v_today AND cl.slot = (t->>'slot')::int;

  SELECT jsonb_agg(jsonb_build_object(
    'day', d, 'streak', v_day.streak - v_day.cycle_day + d,
    'diamonds', CASE WHEN d = v_day.cycle_day THEN
      (SELECT sum((t->>'diamonds')::integer) FROM jsonb_array_elements(v_day.tiles) t
        WHERE t->>'kind'='diamonds' AND NOT (t->>'vip_only')::boolean) ELSE NULL END,
    'extras', 'Daily Rewards',
    'chest', d=v_day.cycle_day AND v_day.streak_day IS NOT NULL,
    'state', CASE WHEN d<v_day.cycle_day THEN 'done' WHEN d=v_day.cycle_day THEN 'today' ELSE 'upcoming' END
  ) ORDER BY d) INTO v_week FROM generate_series(1,7) d;

  v_next_streak := v_day.streak + 1;
  v_next_cycle  := ((v_next_streak - 1) % 7) + 1;
  v_next := public.fn_ca_daily_bonus_pick_tiles(v_uid, v_today + 1, v_next_streak, v_day.tiles);
  SELECT jsonb_agg(CASE WHEN (d->>'day')::integer<>v_day.cycle_day
      AND (d->>'streak')::integer>0 AND (d->>'streak')::integer % 10=0
    THEN d || jsonb_build_object('extras',concat_ws(', ',NULLIF(d->>'extras',''),'100 Diamond Bonus Spin'))
    ELSE d END ORDER BY (d->>'day')::integer) INTO v_week FROM jsonb_array_elements(v_week) d;

  -- PHASE 3. What the player holds: shields (unspent, unexpired credits) and
  -- a live Mission Boost, and whether a shield saved today's streak.
  SELECT jsonb_build_object(
           'held', COALESCE(sum(f.uses_remaining), 0),
           'expires_at', min(f.expires_at))
    INTO v_shield
    FROM public.feature_purchases f
   WHERE f.user_id = v_uid AND f.feature = 'streak_shield'
     AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now());
  SELECT jsonb_build_object(
           'active', true, 'factor', b.factor, 'kind', b.kind,
           'ends_at', b.ends_at,
           'seconds_left', GREATEST(0, floor(extract(epoch FROM (b.ends_at - now())))::integer),
           'applied_diamonds', b.applied_diamonds)
    INTO v_boost
    FROM public.player_boosts b
   WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.starts_at <= now() AND b.ends_at > now()
   ORDER BY b.ends_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'eligible', true,
    'bonus_spin_every_days',10,
    'bonus_spin_entry_diamonds',100,
    'bonus_spins_held',(SELECT count(*) FROM public.diamond_bonus_spin_tickets WHERE user_id=v_uid AND redeemed_spin_id IS NULL),
    'today', v_today,
    'reset_at', v_reset_at,
    'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
    'streak', v_day.streak,
    'cycle_day', v_day.cycle_day,
    'streak_day', v_day.streak_day,
    'multiplier', public.fn_get_streak_multiplier(v_day.streak),
    'is_vip', v_is_vip,
    'claimed_today', v_day.first_claimed_at IS NOT NULL,
    'shown_today', v_day.sheet_shown_at IS NOT NULL,
    'unclaimed', (SELECT count(*) FROM jsonb_array_elements(v_tiles) x
                   WHERE NOT (x->>'claimed')::boolean AND NOT (x->>'locked')::boolean),
    'tiles', v_tiles,
    'week', v_week,
    'tomorrow', v_next,
    'caps', v_caps,
    'cents_per_diamond', 1,
    'shield', COALESCE(v_shield, jsonb_build_object('held', 0, 'expires_at', NULL)),
    'streak_protected', COALESCE(v_day.streak_protected, false),
    'boost', COALESCE(v_boost, jsonb_build_object('active', false))
  );
END;
$function$;
CREATE FUNCTION public.fn_ca_daily_bonus_claim_all(p_bonus_date date, p_request_id uuid, p_client jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE uid uuid:=auth.uid(); day public.ca_daily_bonus_days; v_tile jsonb; receipt jsonb;
  results jsonb:='[]'; vip boolean; slot_request uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Sign In To Claim' USING ERRCODE='28000'; END IF;
  IF p_request_id IS NULL THEN RETURN jsonb_build_object('success',false,'reason','request_id_required'); END IF;
  IF p_bonus_date IS NULL OR p_bonus_date<>(now() AT TIME ZONE 'America/Chicago')::date THEN
    RETURN jsonb_build_object('success',false,'reason','day_rolled_over'); END IF;
  IF public.fn_ca_daily_bonus_eligibility(uid)<>'ok' THEN
    RETURN jsonb_build_object('success',false,'reason',public.fn_ca_daily_bonus_eligibility(uid)); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:' || uid::text,0));
  day:=public.fn_ca_daily_bonus_open_day(uid,p_bonus_date);
  SELECT COALESCE(is_vip,false) AND (vip_tier='lifetime' OR vip_expires_at IS NULL OR vip_expires_at>now())
    INTO vip FROM public.profiles WHERE id=uid;
  FOR v_tile IN SELECT value FROM jsonb_array_elements(day.tiles) ORDER BY (value->>'slot')::integer LOOP
    IF (v_tile->>'vip_only')::boolean AND NOT COALESCE(vip,false) THEN CONTINUE; END IF;
    -- Read durable receipts first, including a claim completed on another device.
    SELECT result || jsonb_build_object('idempotent',true) INTO receipt FROM public.ca_daily_bonus_claims
      WHERE user_id=uid AND bonus_date=p_bonus_date AND slot=(v_tile->>'slot')::integer;
    IF NOT FOUND THEN
      slot_request:=md5(p_request_id::text || ':' || (v_tile->>'slot'))::uuid;
      receipt:=public.fn_ca_daily_bonus_claim((v_tile->>'slot')::integer,slot_request,NULL,p_bonus_date,p_client);
    END IF;
    results:=results || jsonb_build_array(receipt);
  END LOOP;
  -- All canonical claims share this transaction. Business refusals remain
  -- explicit; an exception rolls back the whole request, never half a write.
  RETURN jsonb_build_object('success',true,'results',results,'status',public.fn_ca_daily_bonus_status());
END;
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claim_all(date,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim_all(date,uuid,jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid,date) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_status() TO authenticated;
COMMIT;
