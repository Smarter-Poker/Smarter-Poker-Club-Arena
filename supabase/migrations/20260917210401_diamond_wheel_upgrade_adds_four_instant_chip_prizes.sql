-- Eight Upgrade outcomes retain the approved primary twelve prizes and exact
-- 0.80 model expectation. Secondary expectation is 4 entry units:
-- .8*1.6 + .096*5 + .074*10 + .02*25 + .01*100 = 4.
-- Primary: .4*.8 + .02*4 + .05*2 + .05 + .02*2 + .01*3 + .45*.4 = .80.
-- Existing version-2 receipts, game awards and seeded open rounds are immutable.
-- This additive change remains disabled until its compatible client is deployed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.diamond_wheel_release WHERE singleton AND NOT enabled AND contract_version=2) THEN
  RAISE EXCEPTION 'Install The Eight-Prize Upgrade Before Activation'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure))<>'2bd109b8db8401cc13564057843dd1a5' THEN RAISE EXCEPTION 'Wheel Function Changed: fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_wheel_state_v2(uuid,integer)'::regprocedure))<>'2e2a2a54df4f06b5faf253876419e6de' THEN RAISE EXCEPTION 'Wheel Function Changed: fn_wheel_state_v2(uuid,integer)'; END IF;
END $guard$;
ALTER TABLE public.diamond_wheel_release DROP CONSTRAINT diamond_wheel_release_contract_version_check;
ALTER TABLE public.diamond_wheel_release ALTER COLUMN contract_version SET DEFAULT 3;
UPDATE public.diamond_wheel_release SET contract_version=3 WHERE singleton;
ALTER TABLE public.diamond_wheel_release ADD CONSTRAINT diamond_wheel_release_contract_version_check CHECK(contract_version=3);

CREATE FUNCTION public.fn_wheel_v3_model() RETURNS TABLE(ord smallint,label text,kind text,game text,multiplier numeric,weight integer)
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT o::smallint,l,k,g,m,w FROM (VALUES
 (1,'Diamond Plinko','bonus','plinko',1::numeric,10000),
 (2,'1x Chips','chips',NULL,1,5000),
 (3,'Throwables','throwables',NULL,.4,15000),
 (4,'Diamond Crash','bonus','crash',1,10000),
 (5,'2x Diamonds','diamonds',NULL,2,5000),
 (6,'Time Bank','time_bank',NULL,.4,15000),
 (7,'Donkey Cross','bonus','crossing',1,10000),
 (8,'2x Chips','chips',NULL,2,2000),
 (9,'Rabbit Hunt','rabbit_hunt',NULL,.4,15000),
 (10,'Diamond Mines','bonus','mines',1,10000),
 (11,'3x Chips','chips',NULL,3,1000),
 (12,'Upgrade','upgrade',NULL,2,2000)) x(o,l,k,g,m,w)
$$;
CREATE FUNCTION public.fn_wheel_v3_upgrade_model() RETURNS TABLE(ord smallint,label text,kind text,game text,multiplier numeric,weight integer)
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT o::smallint,l,k,g,m,w FROM (VALUES
 (1,'Super Plinko','bonus','plinko',2::numeric,20000),
 (2,'Super Crash','bonus','crash',2,20000),
 (3,'Super Donkey Cross','bonus','crossing',2,20000),
 (4,'Super Diamond Mines','bonus','mines',2,20000),
 (5,'5x Chips','chips',NULL,5,9600),
 (6,'10x Chips','chips',NULL,10,7400),
 (7,'25x Chips','chips',NULL,25,2000),
 (8,'100x Chips','chips',NULL,100,1000)) x(o,l,k,g,m,w)
$$;
CREATE FUNCTION public.fn_wheel_v3_segments(p_entry integer,p_rate integer,p_secondary boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_agg(jsonb_build_object('ord',ord,'label',label,'kind',kind,'game',game,'multiplier',multiplier,
 'amount',CASE WHEN kind='chips' THEN p_entry::numeric*multiplier/p_rate ELSE p_entry*multiplier END,
 'value_chips',p_entry::numeric*multiplier/p_rate,'weight',weight,'probability',weight/100000::numeric,'locked',false) ORDER BY ord)
 FROM (SELECT * FROM public.fn_wheel_v3_model() WHERE NOT p_secondary
 UNION ALL SELECT * FROM public.fn_wheel_v3_upgrade_model() WHERE p_secondary) q
$$;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_v2(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_entry_diamonds integer, p_mode text DEFAULT 'paid'::text, p_bonus_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  p_welcome boolean:=p_mode='welcome';
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  v_ticket public.diamond_bonus_spin_tickets;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
  v_gcfg public.diamond_game_configs; v_gpool public.diamond_game_pools; v_caps jsonb:='{}';
  v_boost integer; v_budget integer; v_cap integer; v_hold numeric; v_reserved numeric;
  v_game text; v_award public.wheel_bonus_awards; v_secondary jsonb; v_secondary_segments jsonb; v_segments jsonb;
  v_second_hmac bytea; v_second_roll numeric; v_second_ord integer; v_outcome jsonb;
  v_second_point numeric; v_second_acc integer:=0; v_second_outcome jsonb;
  v_prize_multiplier numeric; v_prize_label text;
  v_feature text; v_cost integer:=0; v_unit integer; v_uses integer; v_remainder integer; v_grants jsonb:='[]';

BEGIN
  IF p_mode IS NULL OR p_mode NOT IN('paid','welcome','daily') OR p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500
   OR (p_mode<>'paid' AND p_entry_diamonds<>100) OR (p_mode='daily')<>(p_bonus_ticket_id IS NOT NULL)
   OR p_commit_id IS NULL OR p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 OR p_client_seed<>btrim(p_client_seed) THEN
   RETURN jsonb_build_object('ok',false,'error','Choose A Valid Diamond Spins Entry'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','The New Wheel Is Not Open Yet'); END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    IF p_welcome THEN RETURN jsonb_build_object('ok',false,'error','Choose One Free Spin Reward'); END IF;
    SELECT * INTO v_ticket FROM public.diamond_bonus_spin_tickets WHERE id=p_bonus_ticket_id FOR UPDATE;
    IF v_ticket.id IS NULL OR v_ticket.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok',false,'error','Claim This Bonus Spin In Daily Bonus First');
    END IF;
    IF v_ticket.redeemed_spin_id IS NOT NULL THEN
      SELECT * INTO prior FROM public.wheel_spins WHERE id=v_ticket.redeemed_spin_id;
      IF prior.user_id=v_user AND prior.club_id=p_club_id AND prior.commit_id=p_commit_id
         AND prior.client_seed=v_client AND prior.bonus_ticket_id=p_bonus_ticket_id AND NOT prior.is_welcome THEN
        RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
      END IF;
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
    IF v_ticket.funded_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    -- Match the canonical Mint's lock order before taking host/owner rows.
    PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id=p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
       OR prior.client_seed IS DISTINCT FROM v_client OR prior.is_welcome IS DISTINCT FROM p_welcome
       OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
  END IF;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  IF (SELECT sum(weight) FROM public.fn_wheel_v3_model())<>100000 OR (SELECT count(*) FROM public.fn_wheel_v3_model())<>12 THEN
   RAISE EXCEPTION 'The Wheel Model Is Invalid'; END IF;
  v_mult:=1; v_price:=p_entry_diamonds;
  v_segments:=public.fn_wheel_v3_segments(v_price,v_rate);
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  IF NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); END IF;
  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- The budget used to be checked tier by tier, so as the spend approached it
    -- the top prizes locked one after another and the last new members to
    -- arrive were handed a visibly worse wheel than the first ones. A gift that
    -- gets meaner the longer you take to join is not the gift Dan described.
    -- So the budget is asked ONE question before anything is offered: can it
    -- still cover the biggest prize on this table? If it can, every tier is
    -- live. If it cannot, there is no welcome spin here until the window turns.
    -- ONE DEFINITION OF THE QUESTION (2026-09-11). The door, the page and the
    -- entry read all asked it, and the entry read asked a DIFFERENT one, so a
    -- player could be told "Welcome Spin Ready" and then be refused by the
    -- door. There is one helper now and three callers.
    v_welcome_spent:=public.fn_wheel_v2_welcome_spent(v_host);
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND p_bonus_ticket_id IS NULL AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  -- Take game configuration and pools before the shared host wallet, matching game entry.
  PERFORM 1 FROM public.diamond_game_configs WHERE host_id=v_host ORDER BY game FOR UPDATE;
  PERFORM 1 FROM public.diamond_game_pools WHERE host_id=v_host ORDER BY game FOR UPDATE;
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  SELECT COALESCE(sum(reserved_chips),0) INTO v_reserved FROM public.diamond_game_pools WHERE host_id=v_host;
  IF v_bank-v_reserved < ceil(v_price::numeric/v_rate*100*100)/100 OR v_owner_dia+v_dia_now<v_price*2 OR (NOT p_welcome AND pool.diamond_float+v_dia_now<v_price*2) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF p_welcome AND cfg.welcome_budget_chips-v_welcome_spent<100*v_price::numeric/v_rate THEN
   RETURN jsonb_build_object('ok',false,'error','The Welcome Spins Here Are Gone For Now'); END IF;
  -- Fixed odds require the entire 100x secondary prize to fit the configured
  -- exposure policy before reading the seed. Never silently remove a prize.
  IF NOT p_welcome AND pool.chips_paid+ceil(100*v_price::numeric/v_rate*100)/100>v_intake_chips+cfg.exposure_allowance_chips THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF (SELECT count(*) FROM public.fn_wheel_v3_upgrade_model())<>8 OR (SELECT sum(weight) FROM public.fn_wheel_v3_upgrade_model())<>100000 THEN
   RAISE EXCEPTION 'The Upgrade Model Is Invalid'; END IF;
  -- Every possible game/upgrade is admitted before looking at the random seed.
  -- All game locks use the same order; one admitted outcome reserves its promise.
  FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
   SELECT * INTO v_gcfg FROM public.diamond_game_configs WHERE host_id=v_host AND game=v_game FOR UPDATE;
   IF NOT FOUND OR NOT v_gcfg.enabled OR (v_is_fixture AND NOT v_gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'error','Every Bonus Game Must Be Open Before A Spin'); END IF;
   INSERT INTO public.diamond_game_pools(host_id,game) VALUES(v_host,v_game) ON CONFLICT DO NOTHING;
   SELECT * INTO v_gpool FROM public.diamond_game_pools WHERE host_id=v_host AND game=v_game FOR UPDATE;
   FOR v_boost IN 1..2 LOOP
    v_budget:=v_price*v_boost;
    v_cap:=public.fn_diamond_game_cap_cents(v_gcfg,v_gpool,v_bank,v_budget::numeric/v_rate,v_gcfg.max_multiplier_cents);
    IF p_welcome THEN v_cap:=LEAST(v_cap,floor((cfg.welcome_budget_chips-v_welcome_spent)/(v_budget::numeric/v_rate)*100)::integer); END IF;
    -- Steady20x covers base plus one original entry:40x ordinary,30x upgraded.
    IF v_cap<2000*(v_boost+1)/v_boost THEN RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Bonus Before A Spin'); END IF;
    v_caps:=jsonb_set(v_caps,ARRAY[v_game||':'||v_boost],to_jsonb(v_cap));
   END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
   RETURN jsonb_build_object('ok',false,'error','An Approved Plinko Table Must Be Open Before A Spin'); END IF;
  IF EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
    LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
    WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
   RETURN jsonb_build_object('ok',false,'error','The Reward Prices Changed. The Wheel Must Be Requalified'); END IF;
  SELECT count(*)+1 INTO v_nonce FROM public.wheel_spins WHERE user_id=v_user;
  v_hmac:=extensions.hmac(convert_to('wheel-v3:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
  v_roll:=(('x'||encode(substring(v_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
  v_total:=100000; v_eligible:=ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[];
  v_point:=floor(v_roll*v_total/c_two48);
  FOR seg IN SELECT * FROM public.fn_wheel_v3_model() ORDER BY ord LOOP
   v_acc:=v_acc+seg.weight;
   IF v_point<v_acc THEN v_pick:=seg;v_found:=true;EXIT;END IF;
  END LOOP;
  IF NOT v_found THEN RAISE EXCEPTION 'The Wheel Draw Is Invalid'; END IF;
  SELECT value INTO v_outcome FROM jsonb_array_elements(v_segments) WHERE (value->>'ord')::integer=v_pick.ord;
  IF v_pick.kind='upgrade' THEN
   v_secondary_segments:=public.fn_wheel_v3_segments(v_price,v_rate,true);
   v_second_hmac:=extensions.hmac(convert_to('wheel-v3-upgrade:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
   v_second_roll:=(('x'||encode(substring(v_second_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
   v_second_point:=floor(v_second_roll*100000/c_two48);
   FOR seg IN SELECT * FROM public.fn_wheel_v3_upgrade_model() ORDER BY ord LOOP
    v_second_acc:=v_second_acc+seg.weight;
    IF v_second_point<v_second_acc THEN v_second_ord:=seg.ord;EXIT;END IF;
   END LOOP;
   IF v_second_ord IS NULL THEN RAISE EXCEPTION 'The Upgrade Draw Is Invalid'; END IF;
   v_second_outcome:=v_secondary_segments->(v_second_ord-1);
   IF v_second_outcome->>'kind'='bonus' THEN v_game:=v_second_outcome->>'game';
   ELSE v_prize_multiplier:=(v_second_outcome->>'multiplier')::numeric;v_prize_label:=v_second_outcome->>'label'; END IF;
   v_secondary:=jsonb_build_object('segments',v_secondary_segments,'outcome',v_secondary_segments->(v_second_ord-1),
    'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_second_roll,'weight_total',100000,'eligible_ords',jsonb_build_array(1,2,3,4,5,6,7,8),'locked','[]'::jsonb,'domain','wheel-v3-upgrade'));
  ELSIF v_pick.kind='bonus' THEN v_game:=v_pick.game;
  ELSIF v_pick.kind='chips' THEN v_prize_multiplier:=v_pick.multiplier;v_prize_label:=v_pick.label; END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF p_bonus_ticket_id IS NOT NULL THEN
    BEGIN
      UPDATE public.diamond_bonus_spin_tickets SET club_id=p_club_id,host_id=v_host,host_kind=v_kind,
        owner_id=v_owner,commit_id=p_commit_id,client_seed=v_client,
        funded_at=transaction_timestamp(),mint_op_id='daily-bonus-spin:'||p_bonus_ticket_id::text
       WHERE id=p_bonus_ticket_id RETURNING * INTO v_ticket;
    EXCEPTION WHEN SQLSTATE 'PDS01' THEN
      RETURN jsonb_build_object('ok',false,'error',SQLERRM);
    END;
  ELSIF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  IF v_prize_multiplier IS NOT NULL THEN
   v_prize_chips:=public.fn_diamond_round_chip_cents(v_price::numeric*v_prize_multiplier/v_rate,cm.server_seed,'wheel-v3-rounding:'||v_client||':'||v_nonce);
   v_value_chips:=v_prize_chips;
   SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips('wheel_prize',v_host,v_kind,p_club_id,v_user,v_prize_chips,
    'wheel-prize:'||v_spin_id,'Diamond Spins: '||v_prize_label,jsonb_build_object('spin_id',v_spin_id,'host_id',v_host,'host_kind',v_kind,'welcome',p_welcome,'bonus_ticket_id',p_bonus_ticket_id,'contract_version',3,'multiplier',v_prize_multiplier,'secondary_ord',v_second_ord));
   v_member_after:=v_pay.member_after;
   IF v_pick.kind='chips' THEN v_outcome:=v_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips);
   ELSE v_secondary:=jsonb_set(v_secondary,'{outcome}',v_second_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips)); END IF;
  ELSIF v_pick.kind='diamonds' THEN
   v_prize_dia:=v_price*2; v_value_chips:=v_prize_dia::numeric/v_rate;
   PERFORM public.fn_diamond_game_pay_diamonds(v_owner,v_user,v_prize_dia,'Diamond Spins: Diamonds','wheel:'||v_spin_id||':prize');
  ELSIF v_pick.kind IN('throwables','time_bank','rabbit_hunt') THEN
   v_feature:=CASE v_pick.kind WHEN 'throwables' THEN 'throwable' WHEN 'time_bank' THEN 'time_bank_seconds' ELSE 'rabbit_hunt' END;
   v_cost:=(public.fn_diamond_round_chip_cents(v_price*.4/100,cm.server_seed,'wheel-v3-consumable:'||v_client||':'||v_nonce)*100)::integer;
   SELECT diamond_cost INTO v_unit FROM public.feature_pricing WHERE feature=v_feature;
   v_uses:=v_cost/v_unit;v_remainder:=v_cost%v_unit;
   v_deduct:=public.add_diamonds_to_balance(v_owner,-v_cost,'deduction',
    'Diamond Spins: '||v_pick.label||' for '||v_user,'wheel:'||v_spin_id||':inventory',NULL);
   IF COALESCE((v_deduct->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'The Owner Reward Debit Failed'; END IF;
   INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,v_feature,v_uses*v_unit,'per_use',v_uses,'diamond_wheel');
   v_grants:=jsonb_build_array(jsonb_build_object('feature',v_feature,'uses',v_uses));
   IF v_remainder>0 THEN
    INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,'throwable',v_remainder,'per_use',v_remainder,'diamond_wheel');
    v_grants:=v_grants||jsonb_build_object('feature','throwable','uses',v_remainder);
   END IF;
   v_value_chips:=v_cost::numeric/v_rate;
   v_outcome:=v_outcome||jsonb_build_object('amount',v_uses,'value_chips',v_value_chips,'grants',v_grants);
  ELSE
   v_boost:=CASE WHEN v_pick.kind='upgrade' THEN 2 ELSE 1 END;v_budget:=v_price*v_boost;
   v_cap:=(v_caps->>(v_game||':'||v_boost))::integer;v_hold:=ceil(v_budget::numeric/v_rate*v_cap)/100;
   INSERT INTO public.wheel_bonus_awards(spin_id,user_id,club_id,host_id,host_kind,game,entry_diamonds,boost_multiplier,base_diamonds,cap_cents,reserved_chips)
   VALUES(v_spin_id,v_user,p_club_id,v_host,v_kind,v_game,v_price,v_boost,v_budget,v_cap,v_hold) RETURNING * INTO v_award;
   UPDATE public.diamond_game_pools SET wheel_allocated_diamonds=wheel_allocated_diamonds+v_budget,reserved_chips=reserved_chips+v_hold,updated_at=now() WHERE host_id=v_host AND game=v_game;
   -- The welcome budget reserves the full liability until the awarded round settles.
   v_value_chips:=v_hold;
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia+v_cost END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF NOT p_welcome AND pool.chips_paid>pool.intake_diamonds/v_rate+cfg.exposure_allowance_chips THEN RAISE EXCEPTION 'The Wheel Exposure Limit Was Exceeded'; END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  v_result:=jsonb_build_object('ok',true,'contract_version',3,'welcome',p_welcome,'daily_bonus',p_mode='daily','bonus_ticket_id',p_bonus_ticket_id,
   'player_cost_diamonds',CASE WHEN p_mode='paid' THEN v_price ELSE 0 END,'entry_value_diamonds',v_price,
   'entry_funded_by',CASE p_mode WHEN 'daily' THEN 'mint' WHEN 'welcome' THEN 'welcome' ELSE 'player' END,
   'spin_id',v_spin_id,'club_id',p_club_id,'host_id',v_host,'segment_version',3,'spin_price_diamonds',CASE WHEN p_welcome THEN 0 ELSE v_price END,
   'diamonds_per_chip',v_rate,'segments',v_segments,'outcome',v_outcome,
   'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_roll,'weight_total',v_total,'eligible_ords',to_jsonb(v_eligible),'locked','[]'::jsonb,'domain','wheel-v3'),
   'balances',jsonb_build_object('diamonds',v_dia_after,'member_chips',v_member_after),'pool',jsonb_build_object('chips_paid',pool.chips_paid,'diamond_float',pool.diamond_float),'created_at',transaction_timestamp());
  IF v_award.id IS NOT NULL THEN v_result:=v_result||jsonb_build_object('bonus',jsonb_build_object('id',v_award.id,'game',v_award.game,'club_id',v_award.club_id,'base_diamonds',v_award.base_diamonds,'entry_diamonds',v_award.entry_diamonds,'boost_multiplier',v_award.boost_multiplier,'cap_cents',v_award.cap_cents)); END IF;
  IF v_secondary IS NOT NULL THEN v_result:=v_result||jsonb_build_object('secondary',v_secondary); END IF;
  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id,receipt_v2)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, 3,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, (v_outcome->>'amount')::numeric, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id,v_result)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_wheel_state_v2(p_club_id uuid, p_entry_diamonds integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s jsonb;h uuid;k text;cfg public.wheel_configs;gcfg public.diamond_game_configs;gp public.diamond_game_pools;
 rate integer;cover numeric;held numeric;owner uuid;owner_diamonds numeric;room numeric;v_game text;boost integer;cap integer;funded boolean:=true;reason text;awards jsonb;welcome boolean;max_funded integer;headroom numeric;minimum_cap integer;welcome_funded boolean:=true;welcome_cap integer;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500 THEN RETURN jsonb_build_object('ok',false,'error','Choose 25 To 2,500 Diamonds'); END IF;
 IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',true,'contract_version',3,'enabled',false); END IF;
 s:=public.fn_wheel_state(p_club_id);
 IF s->>'ok' IS DISTINCT FROM 'true' THEN RETURN s; END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 SELECT * INTO cfg FROM public.wheel_configs WHERE host_id=h;
 IF NOT FOUND THEN RETURN s||jsonb_build_object('contract_version',3,'enabled',true); END IF;
 rate:=public.fn_ca_bridge_rate();cover:=public.fn_diamond_game_cover(h,k);
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=h;
 owner:=public.fn_diamond_game_owner(h,k);SELECT COALESCE(diamonds,0) INTO owner_diamonds FROM public.profiles WHERE id=owner;
 max_funded:=GREATEST(0,LEAST(2500,COALESCE(owner_diamonds,0),COALESCE((s#>>'{pool,diamond_float}')::numeric,0),floor((cover-held)*rate/100),floor((cfg.exposure_allowance_chips+COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)/rate-COALESCE((s#>>'{pool,chips_paid}')::numeric,0))*rate/99)))::integer;
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 IF NOT public.fn_diamond_spins_owner_agreed(h,k) THEN funded:=false;welcome_funded:=false;reason:='The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'; END IF;
 IF cover-held<ceil(p_entry_diamonds::numeric/rate*100*100)/100 OR COALESCE(owner_diamonds,0)+p_entry_diamonds<p_entry_diamonds*2 OR COALESCE((s#>>'{pool,diamond_float}')::numeric,0)+p_entry_diamonds<p_entry_diamonds*2 THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 IF COALESCE((s#>>'{pool,chips_paid}')::numeric,0)+ceil(100*p_entry_diamonds::numeric/rate*100)/100>round((COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)+p_entry_diamonds)/rate,2)+cfg.exposure_allowance_chips THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
  SELECT * INTO gcfg FROM public.diamond_game_configs WHERE host_id=h AND game=v_game;
  SELECT * INTO gp FROM public.diamond_game_pools WHERE host_id=h AND game=v_game;
  IF gcfg.host_id IS NULL OR NOT gcfg.enabled OR ((public.fn_ca_is_fixture_account(auth.uid()) OR public.fn_ca_is_cert_account(auth.uid())) AND NOT gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN funded:=false;welcome_funded:=false;max_funded:=0;reason:='Every Bonus Game Must Be Open Before A Spin';
  ELSE
   headroom:=(COALESCE(gp.intake_diamonds,0)+COALESCE(gp.wheel_allocated_diamonds,0))::numeric/rate+gcfg.exposure_allowance_chips-COALESCE(gp.chips_paid,0)-COALESCE(gp.reserved_chips,0);
   FOR boost IN 1..2 LOOP
    minimum_cap:=2000*(boost+1)/boost;
    welcome_cap:=LEAST(public.fn_diamond_game_cap_cents(gcfg,gp,cover,100*boost::numeric/rate,gcfg.max_multiplier_cents),floor(room/(100*boost::numeric/rate)*100)::integer);
    IF welcome_cap<minimum_cap THEN welcome_funded:=false; END IF;
    IF gcfg.max_multiplier_cents<minimum_cap THEN max_funded:=0;
    ELSE max_funded:=LEAST(max_funded,GREATEST(0,floor(rate*gcfg.cap_fraction*headroom/(minimum_cap::numeric/100-gcfg.cap_fraction)/boost))::integer); END IF;
    cap:=public.fn_diamond_game_cap_cents(gcfg,gp,cover,p_entry_diamonds*boost::numeric/rate,gcfg.max_multiplier_cents);
    IF cap<2000*(boost+1)/boost THEN funded:=false;reason:='The Host Must Fund Every Bonus Before A Spin'; END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='An Approved Plinko Table Must Be Open Before A Spin'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
  LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
  WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='The Reward Prices Changed. The Wheel Must Be Requalified'; END IF;
 SELECT COALESCE(jsonb_agg(public.fn_wheel_bonus_public_award(a,false) ORDER BY a.created_at),'[]') INTO awards FROM public.wheel_bonus_awards a WHERE a.user_id=auth.uid() AND a.club_id=p_club_id AND a.status='pending';
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 welcome:=cfg.enabled AND welcome_funded AND cfg.welcome_spin_enabled AND owner IS DISTINCT FROM auth.uid() AND room>=100*100::numeric/rate AND cover-held>=100*100::numeric/rate AND owner_diamonds>=200
  AND NOT EXISTS(SELECT 1 FROM public.wheel_spins WHERE host_id=h AND user_id=auth.uid() AND is_welcome);
 s:=jsonb_set(s,'{config}',(s->'config')-ARRAY['spec_rtp','chip_share','diamond_share','house_share','hit_rate']||jsonb_build_object('spin_price_diamonds',p_entry_diamonds,'spin_price_chips',p_entry_diamonds::numeric/rate,'segment_version',3,'multiplier',1,'min_entry',25,'max_entry',2500));
 RETURN s||jsonb_build_object('contract_version',3,'enabled',true,'available',COALESCE(cfg.enabled,false) AND funded,'reason',reason,
  'min_entry',25,'max_entry',2500,'max_funded_entry',max_funded,'segments',public.fn_wheel_v3_segments(p_entry_diamonds,rate),'upgrade_segments',public.fn_wheel_v3_segments(p_entry_diamonds,rate,true),'awards',awards,
  'welcome',jsonb_build_object('available',welcome,'eligible',welcome,'entry_diamonds',100));
END $function$
;

REVOKE ALL ON FUNCTION public.fn_wheel_v3_model(),public.fn_wheel_v3_upgrade_model(),public.fn_wheel_v3_segments(integer,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_v3_model(),public.fn_wheel_v3_upgrade_model(),public.fn_wheel_v3_segments(integer,integer,boolean) TO service_role;
-- CREATE OR REPLACE preserves the existing authenticated RPC grants.
COMMIT;
