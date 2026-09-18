-- Exact read-only catalog dependencies, September 17; no replacement financial writers.
CREATE TABLE public.feature_pricing(
 id uuid DEFAULT gen_random_uuid() NOT NULL,
 feature text NOT NULL,
 diamond_cost integer NOT NULL,
 usage_type text NOT NULL,
 description text,
 vip_tiers_included text[] DEFAULT '{}'::text[],
 created_at timestamptz DEFAULT now()
);
ALTER TABLE public.feature_pricing ADD CONSTRAINT feature_pricing_feature_key UNIQUE (feature);
ALTER TABLE public.feature_pricing ADD CONSTRAINT feature_pricing_pkey PRIMARY KEY (id);
ALTER TABLE public.feature_pricing ADD CONSTRAINT feature_pricing_usage_type_check CHECK ((usage_type = ANY (ARRAY['per_use'::text, 'per_session'::text, 'permanent'::text])));
CREATE OR REPLACE FUNCTION public.fn_diamond_spins_owner_agreed(p_host uuid, p_kind text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.diamond_spins_owner_consents c
  WHERE c.host_id=p_host AND c.host_kind=p_kind
   AND c.owner_id=public.fn_diamond_game_owner(p_host,p_kind)
   AND c.terms_version='diamond-spins-2026-09-14-v1');
$function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_spins_owner_agreed(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_owner_agreed(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_choose(n integer, k integer)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE v numeric:=1; i integer;
BEGIN
 IF k<0 OR k>n THEN RETURN 0; END IF;
 FOR i IN 1..LEAST(k,n-k) LOOP v:=v*(n-i+1)/i; END LOOP;
 RETURN round(v);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_choose(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_choose(integer,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_ladder(p_mode text)
 RETURNS integer[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT CASE p_mode
 WHEN 'steady' THEN ARRAY[110,135,170,215,275,355,460,600,800,1100,1600,2400]
 WHEN 'bold' THEN ARRAY[150,220,330,500,800,1300,2200,4000,7500,15000]
 WHEN 'extreme' THEN ARRAY[200,400,800,1600,3200,6400,12800,25600] END
$function$
;
REVOKE ALL ON FUNCTION public.fn_choice_ladder(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_ladder(text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_prizes(p_game text, p_mode text, p_bet numeric)
 RETURNS numeric[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE out numeric[]:='{}'; ladder integer[]; m integer; k integer;
BEGIN
 IF p_game='crossing' THEN
  ladder:=public.fn_choice_ladder(p_mode);
  IF ladder IS NULL THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  FOR k IN 1..cardinality(ladder) LOOP out:=array_append(out,p_bet*ladder[k]/100); END LOOP;
 ELSIF p_game='mines' AND p_mode IN ('5','10','15') THEN
  m:=p_mode::integer;
  FOR k IN 1..25-m LOOP out:=array_append(out,p_bet*0.8*public.fn_choice_choose(25,k)/public.fn_choice_choose(25-m,k)); END LOOP;
 ELSE RAISE EXCEPTION 'Choose A Game Setting'; END IF;
 RETURN out;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_prizes(text,text,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_prizes(text,text,numeric) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_board(p_server text, p_client text, p_nonce bigint, p_mines integer)
 RETURNS integer[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE cells integer[]:=ARRAY(SELECT generate_series(0,24)); i integer; j integer; temp integer; cursor integer:=0; v bigint; lim bigint; out integer[];
BEGIN
 IF p_mines NOT IN (5,10,15) THEN RAISE EXCEPTION 'Choose A Mine Count'; END IF;
 FOR i IN REVERSE 25..2 LOOP
  lim:=(4294967296::bigint/i)*i;
  LOOP
   v:=('x'||substr(encode(extensions.hmac(p_client||':'||p_nonce||':board:'||cursor,p_server,'sha256'),'hex'),1,8))::bit(32)::bigint;
   cursor:=cursor+1; EXIT WHEN v<lim;
  END LOOP;
  j:=(v%i)::integer+1; temp:=cells[i]; cells[i]:=cells[j]; cells[j]:=temp;
 END LOOP;
 SELECT array_agg(x ORDER BY x) INTO out FROM unnest(cells[1:p_mines]) x;
 RETURN out;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_board(text,text,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_board(text,text,bigint,integer) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='open' AND
 (to_jsonb(NEW)-ARRAY['picked','status','payout_chips','settled_at']) =
 (to_jsonb(OLD)-ARRAY['picked','status','payout_chips','settled_at']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A Sealed Game Round Cannot Be Rewritten';
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_immutable() TO service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_act(p_round_id uuid, p_action text, p_cell integer, p_expected_step integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE r public.diamond_choice_rounds; n integer; safe boolean; v_pay numeric:=0; v_cents numeric; v_floor numeric; v_roll numeric;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE id=p_round_id AND user_id=auth.uid();
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','That Round Could Not Be Found'); END IF;
 -- Same config, pool, wallet, then round order as admission. The next state
 -- version is a compare-and-swap, so a delayed duplicate cannot reveal twice.
 PERFORM 1 FROM public.diamond_game_configs WHERE host_id=r.host_id AND game=r.game FOR UPDATE;
 PERFORM 1 FROM public.diamond_game_pools WHERE host_id=r.host_id AND game=r.game FOR UPDATE;
 PERFORM public.fn_diamond_game_cover_lock(r.host_id,r.host_kind);
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE id=p_round_id FOR UPDATE;
 IF r.status<>'open' THEN RETURN public.fn_choice_result(r); END IF;
 n:=cardinality(r.picked);
 IF p_expected_step IS DISTINCT FROM n THEN RETURN public.fn_choice_result(r); END IF;
 IF public.fn_platform_frozen() THEN RETURN jsonb_build_object('ok',false,'error','The Platform Is In Its Maintenance Break'); END IF;
 IF p_action='pick' THEN
  IF p_cell IS NULL OR p_cell<0 OR p_cell>24 OR p_cell=ANY(r.picked) OR (r.game='crossing' AND p_cell<>n) THEN
   RETURN jsonb_build_object('ok',false,'error','Choose An Unopened Tile'); END IF;
  IF r.game='mines' THEN safe:=NOT(p_cell=ANY(r.mine_cells));
  ELSE safe:=(r.road_roll::numeric+1)*(public.fn_choice_ladder(r.mode))[n+1] <= 80::numeric*281474976710656; END IF;
  r.picked:=array_append(r.picked,p_cell); n:=n+1;
  IF NOT safe THEN r.status:='lost';
  ELSIF n=r.max_steps THEN r.status:='cashed'; END IF;
 ELSIF p_action='cashout' AND n>0 THEN r.status:='cashed';
 ELSE RETURN jsonb_build_object('ok',false,'error','Make Your First Move Before Cashing Out'); END IF;
 IF r.status='cashed' THEN
  v_cents:=r.prizes[n]*100;
  v_floor:=floor(v_cents);
  -- An independent sealed draw rounds fractions only AFTER the stopping
  -- decision. Always rounding down would silently add another house edge.
  v_roll:=('x'||substr(encode(extensions.hmac(r.client_seed||':'||r.nonce||':rounding:'||n,r.server_seed,'sha256'),'hex'),1,12))::bit(48)::bigint;
  v_pay:=(v_floor+CASE WHEN (v_roll+1)<= (v_cents-v_floor)*281474976710656 THEN 1 ELSE 0 END)/100;
  IF v_pay>r.reserved_chips THEN RAISE EXCEPTION 'Prize Exceeds Its Reservation'; END IF;
 END IF;
 IF r.status<>'open' THEN
  UPDATE public.diamond_game_pools SET reserved_chips=reserved_chips-r.reserved_chips,
   chips_paid=chips_paid+v_pay,updated_at=now() WHERE host_id=r.host_id AND game=r.game;
  IF v_pay>0 THEN
   PERFORM public.fn_diamond_game_pay_chips(r.game||'_prize',r.host_id,r.host_kind,r.club_id,r.user_id,v_pay,'choice-prize:'||r.id,
    'Diamond Game Prize',jsonb_build_object('game',r.game,'round_id',r.id,'host_id',r.host_id));
  END IF;
 END IF;
 UPDATE public.diamond_choice_rounds SET picked=r.picked,status=r.status,payout_chips=v_pay,
  settled_at=CASE WHEN r.status<>'open' THEN clock_timestamp() END WHERE id=r.id RETURNING * INTO r;
 RETURN public.fn_choice_result(r);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_act(uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_act(uuid,text,integer,integer) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_choice_state(p_club_id uuid, p_game text, p_mode text, p_bet integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE h record; cfg public.diamond_game_configs; pool public.diamond_game_pools; r public.diamond_choice_rounds;
 rate integer; prizes numeric[]:='{}'; cap integer; lim integer:=0; k integer; dia numeric:=0; member numeric;
 hist jsonb; opened jsonb; today integer; last_play timestamptz; wait_seconds integer:=0;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN ('crossing','mines') THEN RETURN jsonb_build_object('ok',false,'error','Choose A Game'); END IF;
 SELECT * INTO h FROM public.fn_wheel_host(p_club_id);
 IF h.host_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id=h.host_id AND game=p_game;
 SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id=h.host_id AND game=p_game;
 rate:=public.fn_ca_bridge_rate();
 IF rate IS NULL OR rate<=0 THEN RETURN jsonb_build_object('ok',false,'error','The Bridge Rate Is Not Set'); END IF;
 IF cfg.host_id IS NOT NULL AND p_bet BETWEEN cfg.min_bet_diamonds AND cfg.max_bet_diamonds AND p_bet BETWEEN 25 AND 5000 THEN
  prizes:=public.fn_choice_prizes(p_game,p_mode,p_bet::numeric/rate);
  cap:=public.fn_diamond_game_cap_cents(cfg,pool,public.fn_diamond_game_cover(h.host_id,h.host_kind),p_bet::numeric/rate,cfg.max_multiplier_cents);
  FOR k IN 1..cardinality(prizes) LOOP EXIT WHEN ceil(prizes[k]*100)/100>(p_bet::numeric/rate)*cap/100; lim:=k; END LOOP;
  prizes:=prizes[1:lim];
 END IF;
 SELECT COALESCE(diamonds,0) INTO dia FROM public.profiles WHERE id=auth.uid();
 IF cfg.purchased_only THEN dia:=LEAST(dia,public.fn_wheel_purchased_available(auth.uid())); END IF;
 SELECT chip_balance INTO member FROM public.club_members WHERE club_id=p_club_id AND user_id=auth.uid() AND COALESCE(status,'active') IN ('active','approved');
 SELECT * INTO r FROM public.diamond_choice_rounds WHERE host_id=h.host_id AND club_id=p_club_id AND user_id=auth.uid() AND game=p_game AND status='open';
 IF FOUND THEN opened:=public.fn_choice_result(r); END IF;
 SELECT COALESCE(jsonb_agg(public.fn_choice_result(x) ORDER BY x.created_at DESC),'[]') INTO hist FROM
  (SELECT * FROM public.diamond_choice_rounds WHERE host_id=h.host_id AND club_id=p_club_id AND user_id=auth.uid() AND game=p_game AND status<>'open' ORDER BY created_at DESC LIMIT 20) x;
 SELECT count(*)::integer,max(created_at) INTO today,last_play FROM public.diamond_choice_rounds WHERE host_id=h.host_id AND user_id=auth.uid() AND game=p_game AND (created_at AT TIME ZONE 'America/Chicago')::date=(now() AT TIME ZONE 'America/Chicago')::date;
 IF last_play IS NOT NULL THEN wait_seconds:=GREATEST(0,cfg.min_seconds_between_rounds-floor(extract(epoch FROM (now()-last_play)))::integer); END IF;
 RETURN jsonb_build_object('ok',true,'rounds_today',today,'daily_limit',COALESCE(cfg.max_rounds_per_player_per_day,0),'diamonds_today',public.fn_diamond_games_spent_today(h.host_id,auth.uid()),'seconds_until_next',wait_seconds,'available',COALESCE(cfg.enabled,false) AND public.fn_diamond_spins_owner_agreed(h.host_id,h.host_kind),'reason',CASE WHEN cfg.host_id IS NULL THEN 'Not Open Here Yet' END,
 'frozen',public.fn_platform_frozen() OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=p_game AND cleared_at IS NULL),'diamonds',COALESCE(dia,0),'member_chips',COALESCE(member,0),'is_member',member IS NOT NULL,
 'diamonds_per_chip',rate,'bets',COALESCE(to_jsonb(cfg.bet_options),'[]'),'max_steps',lim,'prizes',to_jsonb(COALESCE(prizes,'{}'::numeric[])),
 'open_round',opened,'history',hist);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_choice_state(uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_state(uuid,text,text,integer) TO authenticated,service_role;
INSERT INTO public.feature_pricing(feature,diamond_cost,usage_type) VALUES('throwable',1,'per_use'),('rabbit_hunt',5,'per_use'),('time_bank_seconds',5,'per_use');

CREATE OR REPLACE FUNCTION public.fn_diamond_game_bank(p_host uuid, p_kind text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(CASE WHEN p_kind = 'union' THEN (SELECT w.chip_balance FROM public.union_wallets w WHERE w.union_id = p_host)
                       ELSE (SELECT c.chip_treasury FROM public.clubs c WHERE c.id = p_host) END, 0);
$function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_game_bank(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_bank(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_promo(p_host uuid, p_kind text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(CASE WHEN p_kind = 'union' THEN (SELECT w.promo_wallet FROM public.union_wallets w WHERE w.union_id = p_host)
                       ELSE (SELECT c.promo_balance FROM public.clubs c WHERE c.id = p_host) END, 0);
$function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_game_promo(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_promo(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_cover(p_host uuid, p_kind text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT GREATEST(public.fn_diamond_game_promo(p_host, p_kind), 0)
       + GREATEST(public.fn_diamond_game_bank(p_host, p_kind), 0);
$function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_game_cover(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_cover(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.trg_deliver_card_back_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_asset_id text;
BEGIN
  IF NEW.feature LIKE 'card\_back\_%' ESCAPE '\' THEN
    v_asset_id := substring(NEW.feature from 11);
    IF EXISTS (
      SELECT 1 FROM public.cosmetic_catalog
       WHERE category = 'cards_id' AND asset_id = v_asset_id
    ) THEN
      INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
      VALUES (NEW.user_id, 'cards_id', v_asset_id, 'purchase')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.trg_deliver_card_back_entitlement() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trg_deliver_card_back_entitlement() TO service_role;
CREATE OR REPLACE FUNCTION public.trg_deliver_table_studio_entitlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_category text;
  v_asset_id text;
  v_theme_id text;
BEGIN
  IF NEW.feature NOT LIKE 'studio:%' THEN RETURN NEW; END IF;

  v_category := split_part(NEW.feature, ':', 2);
  v_asset_id := substring(NEW.feature from length('studio:' || v_category || ':') + 1);

  IF v_category NOT IN ('theme_id', 'table_id', 'button_id', 'background_id')
     OR v_asset_id IS NULL OR btrim(v_asset_id) = ''
     OR NOT EXISTS (
       SELECT 1 FROM public.cosmetic_catalog c
        WHERE c.category = v_category AND c.asset_id = v_asset_id AND c.tier = 'vip'
     ) THEN
    RAISE EXCEPTION 'Invalid Table Studio entitlement SKU %', NEW.feature
      USING ERRCODE = '23514';
  END IF;

  IF v_category = 'theme_id' THEN
    v_theme_id := public.sp_grant_theme_preset(NEW.user_id, v_asset_id, 'diamond_purchase');
    IF v_theme_id IS NULL THEN
      RAISE EXCEPTION 'Table Studio preset % cannot be delivered', v_asset_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    INSERT INTO public.theme_asset_unlocks (user_id, category, asset_id, unlock_method)
    VALUES (NEW.user_id, v_category, v_asset_id, 'diamond_purchase')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION public.trg_deliver_table_studio_entitlement() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trg_deliver_table_studio_entitlement() TO service_role;
CREATE TRIGGER diamond_choice_immutable BEFORE DELETE OR UPDATE ON diamond_choice_rounds FOR EACH ROW EXECUTE FUNCTION fn_choice_immutable();
CREATE TRIGGER trg_deliver_card_back_entitlement AFTER INSERT ON feature_purchases FOR EACH ROW EXECUTE FUNCTION trg_deliver_card_back_entitlement();
CREATE TRIGGER trg_deliver_table_studio_entitlement AFTER INSERT ON feature_purchases FOR EACH ROW EXECUTE FUNCTION trg_deliver_table_studio_entitlement();
-- Captured current Crash point and completion helpers.
CREATE OR REPLACE FUNCTION public.fn_crash_point_cents(p_roll numeric)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT GREATEST(100::bigint, floor(22517998136852480::numeric / (p_roll + 1))::bigint);
$function$
;
GRANT EXECUTE ON FUNCTION public.fn_crash_point_cents(numeric) TO PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_crash_settle_decided(p_host uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE r public.crash_rounds; v_n integer := 0; v_after public.crash_rounds;
BEGIN
  FOR r IN SELECT * FROM public.crash_rounds c
            WHERE c.host_id = p_host AND c.status = 'open'
              AND clock_timestamp() >= c.started_at + make_interval(secs => (ln(c.cap_cents::numeric / 100) / c.growth_k)::double precision + 0.05)
            ORDER BY c.started_at FOR UPDATE LOOP
    v_after := public.fn_crash_decide(r, false, 'time');
    IF v_after.status <> 'open' THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_crash_settle_decided(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_crash_settle_decided(uuid) TO service_role;

-- Current wheel state reader, unchanged, for the versioned-state integration.
CREATE OR REPLACE FUNCTION public.fn_wheel_state(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_mult integer;
  v_bank numeric := 0;
  v_intake numeric; v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_segments jsonb;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  a record;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'host_id', v_host, 'host_kind', v_kind);
  END IF;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host;
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_intake   := cfg.spin_price_diamonds::numeric / v_rate;
  v_dia_now  := cfg.spin_price_diamonds;
  v_intake_chips := round((COALESCE(pool.intake_diamonds, 0) + cfg.spin_price_diamonds)::numeric / v_rate, 2);
  -- The prizes come out of the host's PROMO WALLET, its own bank behind that,
  -- and its owner's diamonds. v_bank is the cover: the two wallets together.
  v_bank  := public.fn_diamond_game_cover(v_host, v_kind);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;
  v_owner_dia := COALESCE(v_owner_dia, 0);

  SELECT jsonb_agg(jsonb_build_object(
           'ord', g.ord, 'label', g.label, 'kind', g.kind,
           'amount', g.amount * v_mult,
           'value_chips', CASE g.kind WHEN 'chips' THEN g.amount * v_mult
                                      WHEN 'diamonds' THEN round(g.amount * v_mult / v_rate, 4) ELSE 0 END,
           'weight', g.weight,
           'probability', round(g.weight::numeric / a.weight_total, 6),
           'locked', CASE
              WHEN g.kind = 'chips' AND (
                     COALESCE(pool.chips_paid, 0) + g.amount * v_mult
                       > v_intake_chips + cfg.exposure_allowance_chips
                  OR v_bank < g.amount * v_mult) THEN true
              WHEN g.kind = 'diamonds' AND (COALESCE(pool.diamond_float, 0) + v_dia_now < g.amount * v_mult
                  OR v_owner_dia + cfg.spin_price_diamonds < g.amount * v_mult) THEN true
              ELSE false END,
           'unlocks_at', CASE
              WHEN g.kind = 'chips' THEN round(GREATEST(
                     COALESCE(pool.chips_paid, 0) + g.amount * v_mult - cfg.exposure_allowance_chips,
                     g.amount * v_mult), 2)
              WHEN g.kind = 'diamonds' THEN round(g.amount * v_mult - v_dia_now, 0)
              ELSE NULL END
         ) ORDER BY g.ord)
    INTO v_segments
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_spins - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'spin_price_diamonds', cfg.spin_price_diamonds, 'diamonds_per_chip', v_rate,
      'spin_price_chips', v_intake, 'segment_version', cfg.segment_version, 'multiplier', v_mult,
      'purchased_only', cfg.purchased_only, 'max_spins_per_player_per_day', cfg.max_spins_per_player_per_day,
      'min_seconds_between_spins', cfg.min_seconds_between_spins,
      -- THE CONSOLE COULD NOT SEE ITS OWN SWITCH (2026-09-11). Neither of these
      -- was ever in this payload, so the operations page read undefined: the
      -- welcome pill always said Off however the switch was actually set, "Turn
      -- It Off" always posted ON, and the window field always showed the 30 day
      -- default, so an operator who had set 7 and then saved the budget silently
      -- put it back to 30.
      'welcome_spin_enabled', COALESCE(cfg.welcome_spin_enabled, false),
      'welcome_budget_period_days', COALESCE(cfg.welcome_budget_period_days, 0),
      'spec_rtp', a.spec_rtp, 'chip_share', a.chip_share, 'diamond_share', a.diamond_share,
      'house_share', a.house_share, 'hit_rate', a.hit_rate),
    'segments', COALESCE(v_segments, '[]'::jsonb),
    'pool', jsonb_build_object(
      'spins', COALESCE(pool.spins, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_paid', COALESCE(pool.chips_paid, 0),
      'promo_wallet_chips', public.fn_diamond_game_promo(v_host, v_kind),
      'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
      'cover_chips', v_bank,
      'welcome_chips_paid', COALESCE(pool.welcome_chips_paid, 0),
      'welcome_budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
      'welcome_spins', COALESCE(pool.welcome_spins, 0),
      'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
      'diamond_float', COALESCE(pool.diamond_float, 0), 'diamonds_paid', COALESCE(pool.diamonds_paid, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round((COALESCE(pool.chips_paid, 0) + COALESCE(pool.diamonds_paid, 0)::numeric / v_rate)
                                      / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'spins_today', v_today, 'seconds_until_next', v_wait,
      -- WHAT THE DAY HAS COST (2026-09-11). One figure across all three games
      -- at this host, because the player's diamonds are one wallet and the day
      -- is the day the caps are counted on.
      'diamonds_today', public.fn_diamond_games_spent_today(v_host, v_user),
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_state(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state(uuid) TO authenticated,service_role;

-- Exact existing configuration setter and table audit for funding-readiness proof.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_set_config(p_club_id uuid, p_game text, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bad integer;
BEGIN
  IF v_user IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Change This Game');
  END IF;

  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game FOR UPDATE;
  IF cfg.host_id IS NULL THEN
    INSERT INTO public.diamond_game_configs (host_id, game, host_kind, updated_by)
    VALUES (v_host, p_game, v_kind, v_user) RETURNING * INTO cfg;
    INSERT INTO public.diamond_game_pools (host_id, game) VALUES (v_host, p_game) ON CONFLICT (host_id, game) DO NOTHING;
  END IF;

  IF p_patch ? 'min_bet_diamonds' THEN cfg.min_bet_diamonds := (p_patch->>'min_bet_diamonds')::integer; END IF;
  IF p_patch ? 'max_bet_diamonds' THEN cfg.max_bet_diamonds := (p_patch->>'max_bet_diamonds')::integer; END IF;
  IF p_patch ? 'bet_options' THEN
    SELECT array_agg(x::integer ORDER BY x::integer) INTO cfg.bet_options FROM jsonb_array_elements_text(p_patch->'bet_options') x;
  END IF;
  IF p_patch ? 'exposure_allowance_chips' THEN cfg.exposure_allowance_chips := round((p_patch->>'exposure_allowance_chips')::numeric, 2); END IF;
  IF p_patch ? 'cap_fraction' THEN cfg.cap_fraction := round((p_patch->>'cap_fraction')::numeric, 3); END IF;
  IF p_patch ? 'max_multiplier_cents' THEN cfg.max_multiplier_cents := (p_patch->>'max_multiplier_cents')::integer; END IF;
  IF p_patch ? 'growth_k' THEN cfg.growth_k := round((p_patch->>'growth_k')::numeric, 4); END IF;
  IF p_patch ? 'purchased_only' THEN cfg.purchased_only := (p_patch->>'purchased_only')::boolean; END IF;
  IF p_patch ? 'allow_fixture_accounts' THEN cfg.allow_fixture_accounts := (p_patch->>'allow_fixture_accounts')::boolean; END IF;
  IF p_patch ? 'max_rounds_per_player_per_day' THEN cfg.max_rounds_per_player_per_day := (p_patch->>'max_rounds_per_player_per_day')::integer; END IF;
  IF p_patch ? 'min_seconds_between_rounds' THEN cfg.min_seconds_between_rounds := (p_patch->>'min_seconds_between_rounds')::integer; END IF;
  IF p_patch ? 'enabled' THEN cfg.enabled := (p_patch->>'enabled')::boolean; END IF;
  IF cfg.enabled AND NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); END IF;

  IF cfg.min_bet_diamonds<>25 OR cfg.max_bet_diamonds<>5000 OR cfg.purchased_only THEN RETURN jsonb_build_object('ok',false,'error','Diamond Spins Use Earned Or Purchased Diamonds, With Entries From 25 To 2,500 And One Optional Double Down'); END IF;
  IF cfg.bet_options IS NULL OR array_length(cfg.bet_options, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'At Least One Bet Size Is Required');
  END IF;
  SELECT count(*) INTO v_bad FROM unnest(cfg.bet_options) b
   WHERE b < cfg.min_bet_diamonds OR b > cfg.max_bet_diamonds;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Every Bet Size Must Be Inside The Diamond Limits');
  END IF;
  IF cfg.enabled AND p_game = 'plinko' AND NOT EXISTS (
       SELECT 1 FROM public.plinko_tables t, public.fn_plinko_table_audit(t.version) a
        WHERE t.activated_at IS NOT NULL AND a.spec_rtp = 0.800000) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Plinko Table Passes Its Payout Audit. The Game Cannot Be Enabled');
  END IF;

  UPDATE public.diamond_game_configs
     SET enabled = cfg.enabled, min_bet_diamonds = cfg.min_bet_diamonds, max_bet_diamonds = cfg.max_bet_diamonds,
         bet_options = cfg.bet_options, exposure_allowance_chips = cfg.exposure_allowance_chips,
         cap_fraction = cfg.cap_fraction, max_multiplier_cents = cfg.max_multiplier_cents, growth_k = cfg.growth_k,
         purchased_only = cfg.purchased_only, allow_fixture_accounts = cfg.allow_fixture_accounts,
         max_rounds_per_player_per_day = cfg.max_rounds_per_player_per_day,
         min_seconds_between_rounds = cfg.min_seconds_between_rounds,
         updated_at = now(), updated_by = v_user
   WHERE host_id = v_host AND game = p_game
   RETURNING * INTO cfg;
  RETURN jsonb_build_object('ok', true, 'config', to_jsonb(cfg));
END $function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_game_set_config(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_set_config(uuid,text,jsonb) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_plinko_table_audit(p_version integer, OUT spec_rtp numeric, OUT sd_chips numeric, OUT hit_rate numeric, OUT max_multiplier_cents integer, OUT slots integer)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  c constant integer[] := ARRAY[1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1];
  m integer[];
  v_ev numeric := 0; v_e2 numeric := 0; v_hit numeric := 0; i integer;
BEGIN
  SELECT t.multipliers_cents INTO m FROM public.plinko_tables t WHERE t.version = p_version;
  IF m IS NULL THEN RETURN; END IF;
  FOR i IN 1..17 LOOP
    v_ev  := v_ev  + c[i] * m[i];
    v_e2  := v_e2  + c[i] * (m[i]::numeric * m[i]);
    v_hit := v_hit + CASE WHEN m[i] > 0 THEN c[i] ELSE 0 END;
  END LOOP;
  spec_rtp := round(v_ev / (65536 * 100), 6);
  sd_chips := round(sqrt(v_e2 / (65536 * 10000) - power(v_ev / (65536 * 100), 2)), 6);
  hit_rate := round(v_hit / 65536, 6);
  max_multiplier_cents := (SELECT max(x) FROM unnest(m) x);
  slots := 17;
END $function$
;
GRANT EXECUTE ON FUNCTION public.fn_plinko_table_audit(integer) TO PUBLIC,anon,authenticated,service_role;
