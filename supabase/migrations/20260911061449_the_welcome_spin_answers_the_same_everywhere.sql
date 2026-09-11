-- 20260911061449_the_welcome_spin_answers_the_same_everywhere.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE WELCOME SPIN ANSWERS THE SAME EVERYWHERE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The audit after phase 2 found three ways the welcome spin disagreed with
-- itself. Two of them are mine from that phase; one has been there since the
-- feature was built and phase 2 walked straight past it.
--
-- 1. THE ENTRY READ ASKED A DIFFERENT QUESTION FROM THE DOOR.
--    fn_diamond_games_entry said the spin was ready whenever
--
--        welcome_budget_chips > welcome spend in the window
--
--    while fn_wheel_spin_core and fn_wheel_welcome_state require
--
--        spend + the biggest prize on the table <= welcome_budget_chips
--
--    because a welcome spin is the whole wheel or it is not offered. So on a
--    host whose window had room for something but not for the top prize, the
--    club lobby, the wallet, the cash buy-in and the tournament sign-up all
--    showed "Welcome Spin Ready", and the door then refused with "The Welcome
--    Spins Here Are Gone For Now". Four surfaces promising what the fifth
--    would not honour.
--
--    Three copies of one rule is what caused it, so there is one copy now:
--    fn_wheel_welcome_room answers it, and the core, the page and the entry
--    read all call it. The top-prize arithmetic was written out twice in the
--    phase 2 migration alone; that is now written once.
--
-- 2. THE OPERATOR CONSOLE COULD NOT SEE ITS OWN SWITCH.
--    fn_wheel_state's config payload never carried welcome_spin_enabled. Not
--    since phase 2 renamed it, and not before that under its old name either.
--    The operations page reads cfg.welcome_spin_enabled, so it read undefined:
--    the pill said Off whatever the switch was set to, and "Turn It Off"
--    posted enabled = NOT false = true, so the switch could never be turned
--    off from the console at all. It is in the payload now.
--
-- 3. AND IT COULD NOT SEE THE WINDOW, WHICH WAS WORSE THAN COSMETIC.
--    welcome_budget_period_days was not in the payload either, so the new
--    Budget Window field always showed the 30 day default. An operator who had
--    set 7 days, came back, and saved a budget change would have silently put
--    their window back to 30, because the console posts both together. That is
--    a write of a value the operator never chose, which is the part that makes
--    this a defect rather than a blank field.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. One definition of the one question
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_room(
  p_host uuid,
  OUT o_spent numeric,
  OUT o_top numeric,
  OUT o_open boolean
)
RETURNS record
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  cfg public.wheel_configs%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_mult integer := 1;
BEGIN
  o_spent := 0; o_top := 0; o_open := false;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = p_host;
  IF cfg.host_id IS NULL THEN RETURN; END IF;

  -- The VIP multiplier the table is priced at, the same way the core reads it.
  SELECT COALESCE(cfg.spin_price_diamonds / v.spin_price_diamonds, 1) INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_mult := COALESCE(v_mult, 1);

  -- The biggest prize this table can pay, in chips, whichever kind it is.
  SELECT COALESCE(max(CASE WHEN g.kind = 'chips'    THEN g.amount::numeric * v_mult
                           WHEN g.kind = 'diamonds' THEN round((g.amount * v_mult)::numeric / v_rate, 4)
                           ELSE 0 END), 0)
    INTO o_top
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;

  o_spent := public.fn_wheel_welcome_spent(p_host, cfg.welcome_budget_period_days);
  -- A budget of zero is unfunded, not open with nothing in it.
  o_open := COALESCE(cfg.welcome_budget_chips, 0) > 0
        AND o_spent + o_top <= cfg.welcome_budget_chips;
END $function$;

REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_room(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_room(uuid) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The door
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_welcome boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
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
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
BEGIN
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
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
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
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_price  := cfg.spin_price_diamonds;
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
    SELECT r.o_spent, r.o_top INTO v_welcome_spent, v_welcome_top
      FROM public.fn_wheel_welcome_room(v_host) r;
    IF v_welcome_spent + v_welcome_top > cfg.welcome_budget_chips THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spins Here Are Gone For Now');
    END IF;
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
  IF NOT p_welcome AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      -- There is no welcome branch here any more. The budget was asked about
      -- the WHOLE table before the spin was allowed, so on a welcome spin every
      -- tier is affordable by construction and none of them may be locked for
      -- being expensive. The exposure gate below is the paid wheel's alone: a
      -- welcome spin took nothing in, so it may not lean on what the paid game
      -- took in either.
      IF NOT p_welcome AND pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'cover', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      -- THE PAID WHEEL'S FLOAT IS NOT THE GIFT'S TO SPEND (audit 2026-09-11).
      -- A welcome diamond prize comes from the owner and is charged to the
      -- welcome budget, which was checked just above. Gating it on the paid
      -- float as well locked tiers a club had every right to give away, and
      -- draining that float for it made the paid wheel pay for the welcome.
      IF NOT p_welcome AND pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
      IF v_owner_dia + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'owner_diamonds',
                      'unlocks_at', round(seg.amount * v_mult, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake');
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

  -- ── 2. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the host cover % is below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    -- ONE PAYER FOR EVERY CHIP THE DIAMOND GAMES PAY. The promo wallet goes
    -- first and the host's own bank covers whatever is left (Dan 2026-09-10),
    -- journaled from the paying side so each row names the column the chips
    -- left, and the member side stands down so nothing is journaled twice.
    SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
      'wheel_prize', v_host, v_kind, p_club_id, v_user, v_prize_chips,
      'wheel-prize:' || v_spin_id::text,
      format('Diamond Wheel: %s', v_pick.label),
      jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                         'segment_version', cfg.segment_version, 'ord', v_pick.ord,
                         'welcome', p_welcome));
    v_member_after := v_pay.member_after;
    v_bank_after   := v_pay.cover_after;
    v_promo        := v_pay.promo_after;
    v_bank_only    := v_pay.bank_after;
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    -- The diamond prize is paid BY THE HOST'S OWNER, out of what the wheel took
    -- in (Dan 2026-09-10). Two transfer legs, one transaction; nothing is issued.
    PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,
              format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
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
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
  END IF;
  -- The window is what is bounded now, not the lifetime total, and the row for
  -- THIS spin is not written until a few lines below - so the assertion is made
  -- on the figure the gate used plus what this spin just paid. Both were read
  -- under the config lock, so no other spin on this host can have moved them.
  IF p_welcome AND v_welcome_spent + v_value_chips > cfg.welcome_budget_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: the welcome window has paid % against a budget of % - the gate was bypassed',
      v_welcome_spent + v_value_chips, cfg.welcome_budget_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The page
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_state(p_club_id uuid)
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
  v_used boolean := false;
  v_member boolean := false;
  v_reason text := NULL;
  v_owner uuid;
  v_segments jsonb;
  v_taken integer := 0;
  v_spent numeric := 0; v_top numeric := 0;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg  FROM public.wheel_configs WHERE host_id = v_host;
  SELECT * INTO pool FROM public.wheel_pools   WHERE host_id = v_host;
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);

  -- THE WELCOME SPIN IS THE REAL WHEEL (Dan 2026-09-10: "a free 100 diamond
  -- spin"), so the table it shows is the wheel's own table, not a smaller one
  -- kept beside it. What is offered is exactly what a paying player sees.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ord', g.ord, 'label', g.label, 'kind', g.kind,
                                               'amount', g.amount, 'weight', g.weight,
                                               'value_chips', CASE WHEN g.kind = 'chips' THEN g.amount::numeric
                                                                   ELSE round(g.amount::numeric / v_rate, 4) END,
                                               'probability', round(g.weight::numeric / NULLIF(t.total, 0), 6),
                                               'locked', false)
                            ORDER BY g.ord), '[]'::jsonb)
    INTO v_segments
    FROM public.wheel_segments g,
         (SELECT sum(weight) AS total FROM public.wheel_segments WHERE version = (SELECT segment_version FROM public.wheel_configs WHERE host_id = v_host)) t
   WHERE g.version = (SELECT segment_version FROM public.wheel_configs WHERE host_id = v_host);

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.welcome_spin_enabled THEN
    v_reason := 'closed';
  END IF;
  IF v_reason IS NULL AND COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
    v_reason := 'unfunded';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.wheel_spins s
                    WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) INTO v_used;
    SELECT EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = v_user
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) INTO v_member;
  END IF;
  SELECT COALESCE(pool.welcome_spins, 0) INTO v_taken;
  IF v_reason IS NULL AND v_used THEN v_reason := 'used'; END IF;
  -- The same one question the door asks: can the window still cover the biggest
  -- prize on this table? The page and the door must agree, so the figure comes
  -- from the same helper rather than from a second copy of the arithmetic.
  SELECT r.o_spent, r.o_top INTO v_spent, v_top FROM public.fn_wheel_welcome_room(v_host) r;
  IF v_reason IS NULL AND v_spent + v_top > COALESCE(cfg.welcome_budget_chips, 0) THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;
  -- The host does not welcome itself: an owner spinning their own wheel for
  -- free would spend the club's budget on the club's own account.
  IF v_reason IS NULL AND v_user IS NOT NULL AND v_user = v_owner THEN v_reason := 'owner'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.welcome_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used', v_used,
    'once_only', true,
    'spin_price_diamonds', COALESCE(cfg.spin_price_diamonds, 0),
    'budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
    'budget_period_days', COALESCE(cfg.welcome_budget_period_days, 0),
    'budget_paid_chips', v_spent,
    'budget_left_chips', GREATEST(COALESCE(cfg.welcome_budget_chips, 0) - v_spent, 0),
    'top_prize_chips', v_top,
    'lifetime_chips_paid', COALESCE(pool.welcome_chips_paid, 0),
    'welcome_spins', v_taken,
    'segments', v_segments);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The entry read, which is what four player surfaces believe
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_games_entry(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_rate integer := public.fn_ca_bridge_rate();
  v_wheel boolean := false; v_plinko boolean := false; v_crash boolean := false;
  v_price integer; v_min integer;
  v_diamonds numeric := 0; v_member boolean := false; v_member_chips numeric;
  v_free boolean := false; v_frozen boolean;
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;

  SELECT COALESCE(w.enabled, false), w.spin_price_diamonds INTO v_wheel, v_price
    FROM public.wheel_configs w WHERE w.host_id = v_host;
  SELECT COALESCE(bool_or(c.enabled AND c.game = 'plinko'), false),
         COALESCE(bool_or(c.enabled AND c.game = 'crash'), false),
         MIN(c.min_bet_diamonds) FILTER (WHERE c.enabled)
    INTO v_plinko, v_crash, v_min
    FROM public.diamond_game_configs c WHERE c.host_id = v_host AND c.game IN ('plinko', 'crash');

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;

  -- THE WELCOME SPIN IS ONCE, EVER (Dan 2026-09-10), so the door asks whether
  -- this member has ever taken one here, not whether they took one today, and
  -- whether the host has budget left to give another away.
  IF v_wheel THEN
    -- THE SAME QUESTION THE DOOR ASKS (2026-09-11). This used to say the spin
    -- was ready whenever the budget exceeded what had been spent, which is not
    -- the rule: a welcome spin is the whole wheel or it is not offered, so the
    -- window has to cover the TOP PRIZE, not merely be non-empty. A player was
    -- being shown "Welcome Spin Ready" on four surfaces and then refused at the
    -- door. One helper answers it for all three callers now.
    SELECT COALESCE(w.welcome_spin_enabled, false)
       AND (SELECT r.o_open FROM public.fn_wheel_welcome_room(v_host) r)
       AND NOT EXISTS (SELECT 1 FROM public.wheel_spins s
                        WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome)
      INTO v_free FROM public.wheel_configs w WHERE w.host_id = v_host;
  END IF;
  v_frozen := public.fn_platform_frozen();

  RETURN jsonb_build_object(
    'ok', true,
    'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'diamonds_per_chip', v_rate,
    'games', jsonb_build_object('wheel', COALESCE(v_wheel, false),
                                'plinko', COALESCE(v_plinko, false),
                                'crash', COALESCE(v_crash, false)),
    'open', COALESCE(v_wheel, false) OR COALESCE(v_plinko, false) OR COALESCE(v_crash, false),
    'available', (COALESCE(v_wheel, false) OR COALESCE(v_plinko, false) OR COALESCE(v_crash, false))
                 AND COALESCE(v_member, false) AND NOT v_frozen,
    'spin_price_diamonds', v_price,
    'min_bet_diamonds', v_min,
    'entry_diamonds', LEAST(COALESCE(v_price, 2147483647), COALESCE(v_min, 2147483647)),
    'diamonds', v_diamonds,
    'chips_from_diamonds', round(v_diamonds / v_rate, 2),
    'is_member', COALESCE(v_member, false),
    'member_chips', v_member_chips,
    'free_spin_ready', COALESCE(v_free, false),
    'welcome_spin_ready', COALESCE(v_free, false),
    'frozen', v_frozen);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. The operator console can see its own switch and its own window
-- ───────────────────────────────────────────────────────────────────────────

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
      'chips_minted', COALESCE(pool.chips_minted, 0), 'chips_paid', COALESCE(pool.chips_paid, 0),
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
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;

COMMIT;
