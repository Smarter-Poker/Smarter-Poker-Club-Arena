-- 20260911052216_the_daily_free_spin_leaves_the_building.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE DAILY FREE SPIN LEAVES THE BUILDING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 2 of 6. Dan 2026-09-10 replaced the daily free spin with a one-time
-- welcome spin: "free spin should be once for a new user 100 diamonds ... All
-- paid for by the promo wallet." The replacement was built. The thing it
-- replaced was never taken out, and the 2026-09-11 audit found what was left.
--
-- THREE THINGS WERE WRONG, AND THEY COMPOUND.
--
-- 1. free_spin_daily_budget_diamonds is DEAD AND STILL SETTABLE. Not one
--    function in the database reads it. It sits at 2000 on both hosts and
--    fn_wheel_set_free_spin could still write it. An operator can type a number
--    into a field that governs nothing, and nothing tells them.
--
-- 2. free_spin_enabled is the WELCOME spin's on/off switch wearing the retired
--    feature's name. Every reader of that column is now reasoning about a
--    different feature than the name describes. That is how the next bug gets
--    written, by someone who trusts the name.
--
-- 3. THE BUDGET NEVER RESET, AND THE WHEEL GOT MEANER AS IT FILLED.
--    welcome_chips_paid only ever went up, checked against a lifetime budget,
--    and the check was made TIER BY TIER inside the segment loop: any prize
--    that would not fit in what was left got locked out of the draw. So the
--    first new member to arrive spun the whole table, and the last one spun
--    whatever was cheap enough to still fit. A welcome gift that gets worse the
--    later you join is not a welcome gift. Both halves of that are fixed here.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE BUDGET IS A WINDOW, AND THE SPIN IS THE WHOLE WHEEL OR NOTHING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- welcome_budget_period_days (default 30, 0 meaning for ever) makes the budget
-- a rolling window rather than a lifetime cap, and the window is DERIVED, not
-- reset: fn_wheel_welcome_spent sums the welcome spins inside it straight from
-- wheel_spins. There is deliberately no counter to zero and no job to zero it.
-- CLAUDE.md 10.12 forbids a cron as the resolution to anything, and a sliding
-- window needs none: it is correct at every instant by construction, it cannot
-- drift from the rows it is computed from, and it has no month-end cliff where
-- a calendar reset would put one.
--
-- The per-tier checks are gone. The budget is asked ONE question, before the
-- spin is offered at all: can what is left still cover the biggest prize on
-- this table? If it can, every tier is live and the new member spins the same
-- wheel the first one did. If it cannot, there is no welcome spin here until
-- the window turns. Up to one top prize of budget can therefore sit unspent at
-- the end of a window, and that is the price of never handing anybody a
-- hollowed-out wheel. It is the right price.
--
-- Cover and owner-diamond locks are untouched and still apply to a welcome
-- spin exactly as they do to a paid one. Those say "the host cannot pay this",
-- which is a fact about the host's money, not an artefact of the budget.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  WHAT IS RENAMED, AND WHAT IS BURIED
-- ═══════════════════════════════════════════════════════════════════════════
--
--   free_spin_enabled              -> welcome_spin_enabled
--   free_spin_daily_budget_diamonds-> dropped
--   fn_wheel_free_state            -> fn_wheel_welcome_state
--   fn_wheel_free_spin             -> fn_wheel_welcome_spin
--   fn_wheel_set_free_spin         -> fn_wheel_set_welcome_spin
--   the spin result's `free` key   -> `welcome`
--
-- And the daily free spin's own machinery is retired outright:
-- fn_wheel_free_history and fn_wheel_free_spin_result are dropped (nothing in
-- the client has called either since the welcome spin moved onto the real
-- wheel), and wheel_free_spins and wheel_free_segments go into the
-- deprecated_tables registry so check-deprecated-tables fails the build if
-- anybody reads them again. The tables keep their rows; a deprecated table is
-- retired by being unreadable from source, not by being dropped out from under
-- whatever might still want to look at the history.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The columns say what they are
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.wheel_configs DROP COLUMN IF EXISTS free_spin_daily_budget_diamonds;

ALTER TABLE public.wheel_configs RENAME COLUMN free_spin_enabled TO welcome_spin_enabled;

ALTER TABLE public.wheel_configs
  ADD COLUMN IF NOT EXISTS welcome_budget_period_days integer NOT NULL DEFAULT 30;

ALTER TABLE public.wheel_configs
  DROP CONSTRAINT IF EXISTS wheel_configs_welcome_period_nonneg;
ALTER TABLE public.wheel_configs
  ADD CONSTRAINT wheel_configs_welcome_period_nonneg
  CHECK (welcome_budget_period_days >= 0);

-- The window sums welcome spins for one host over a date range, and welcome
-- spins are at most one per member, so this stays small; the index keeps it an
-- index-only scan rather than a filter over every spin the host has ever taken.
CREATE INDEX IF NOT EXISTS wheel_spins_welcome_window
  ON public.wheel_spins (host_id, created_at) WHERE is_welcome;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. One definition of the window, so the door and the page cannot disagree
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_spent(p_host uuid, p_days integer)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(s.prize_value_chips), 0)
    FROM public.wheel_spins s
   WHERE s.host_id = p_host
     AND s.is_welcome
     AND (COALESCE(p_days, 0) <= 0 OR s.created_at >= now() - make_interval(days => p_days));
$function$;

REVOKE ALL ON FUNCTION public.fn_wheel_welcome_spent(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_spent(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_spent(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_spent(uuid, integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The daily free spin's own machinery is buried
-- ───────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_wheel_free_history(uuid, integer);
DROP FUNCTION IF EXISTS public.fn_wheel_free_spin_result(public.wheel_free_spins);

INSERT INTO public.deprecated_tables (table_name, reason, replacement, deprecated_at)
VALUES
  ('wheel_free_spins',
   'The daily free spin it recorded was replaced by the one-time welcome spin (Dan 2026-09-10), which is the real wheel and lives in wheel_spins with is_welcome. Two rows, no writer, and its two readers are dropped in this migration.',
   'wheel_spins WHERE is_welcome', now()),
  ('wheel_free_segments',
   'The smaller prize table the daily free spin drew from. The welcome spin draws the real wheel_segments, so nothing selects from this.',
   'wheel_segments', now())
ON CONFLICT (table_name) DO UPDATE
  SET reason = EXCLUDED.reason,
      replacement = EXCLUDED.replacement,
      deprecated_at = COALESCE(public.deprecated_tables.deprecated_at, EXCLUDED.deprecated_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The core: the window gate, and no tier locked for being expensive
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
    SELECT COALESCE(max(CASE WHEN g.kind = 'chips'    THEN g.amount::numeric * v_mult
                             WHEN g.kind = 'diamonds' THEN round((g.amount * v_mult)::numeric / v_rate, 4)
                             ELSE 0 END), 0)
      INTO v_welcome_top
      FROM public.wheel_segments g WHERE g.version = cfg.segment_version;
    v_welcome_spent := public.fn_wheel_welcome_spent(v_host, cfg.welcome_budget_period_days);
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
-- 5. The result says `welcome`, not `free`
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_spin_result(s wheel_spins)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'welcome', COALESCE(s.is_welcome, false),
    'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', s.segment_version, 'spin_price_diamonds', s.spin_price_diamonds,
    'diamonds_per_chip', s.diamonds_per_chip,
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', s.outcome_kind, 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_segments g
                                             WHERE g.version = s.segment_version AND g.ord = s.outcome_ord),
                                  'value_chips', s.prize_value_chips),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', to_jsonb(s.eligible_ords), 'locked', s.locked),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', s.member_chips_after),
    'pool', jsonb_build_object('chips_minted', s.pool_chips_minted_after, 'chips_paid', s.pool_chips_paid_after,
                               'diamond_float', s.pool_diamond_float_after),
    'created_at', s.created_at);
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. The page asks the same one question the door asks
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
  v_spent numeric := 0; v_top numeric := 0; v_mult integer := 1;
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
  SELECT COALESCE(cfg.spin_price_diamonds / v.spin_price_diamonds, 1) INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  SELECT COALESCE(max(CASE WHEN g.kind = 'chips'    THEN g.amount::numeric * COALESCE(v_mult, 1)
                           WHEN g.kind = 'diamonds' THEN round((g.amount * COALESCE(v_mult, 1))::numeric / v_rate, 4)
                           ELSE 0 END), 0)
    INTO v_top
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;
  v_spent := public.fn_wheel_welcome_spent(v_host, cfg.welcome_budget_period_days);
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
-- 7. The player's door, renamed
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_welcome_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. The operator's door, renamed, and it can set the period
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_set_welcome_spin(p_club_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_enabled boolean; v_budget numeric; v_days integer;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Run The Wheel');
  END IF;
  v_enabled := CASE WHEN p_patch ? 'welcome_spin_enabled' THEN (p_patch->>'welcome_spin_enabled')::boolean END;
  v_days    := CASE WHEN p_patch ? 'welcome_budget_period_days' THEN (p_patch->>'welcome_budget_period_days')::integer END;
  IF v_days IS NOT NULL AND v_days < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Budget Period Cannot Be Negative');
  END IF;
  v_budget  := CASE WHEN p_patch ? 'welcome_budget_chips' THEN (p_patch->>'welcome_budget_chips')::numeric END;
  IF v_budget IS NOT NULL AND v_budget < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Budget Must Be Zero Or More Chips');
  END IF;
  UPDATE public.wheel_configs
     SET welcome_spin_enabled = COALESCE(v_enabled, welcome_spin_enabled),
         welcome_budget_period_days = COALESCE(v_days, welcome_budget_period_days),
         welcome_budget_chips = COALESCE(v_budget, welcome_budget_chips),
         updated_by = v_user, updated_at = now()
   WHERE host_id = v_host;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Wheel Is Not Configured Here');
  END IF;
  RETURN jsonb_build_object('ok', true);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. The entry read, on the same window
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
    SELECT COALESCE(w.welcome_spin_enabled, false)
       AND COALESCE(w.welcome_budget_chips, 0)
           > public.fn_wheel_welcome_spent(v_host, w.welcome_budget_period_days)
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
-- 10. The doors say who may knock. CREATE FUNCTION grants EXECUTE to PUBLIC by
--     default, and a migration that only GRANTs never takes it away.
-- ───────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.fn_wheel_welcome_state(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_state(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_state(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.fn_wheel_welcome_spin(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wheel_welcome_spin(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_spin(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_welcome_spin(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_wheel_set_welcome_spin(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wheel_set_welcome_spin(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_welcome_spin(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_welcome_spin(uuid, jsonb) TO service_role;

-- The old names are removed, not left answering beside the new ones.
DROP FUNCTION IF EXISTS public.fn_wheel_free_state(uuid);
DROP FUNCTION IF EXISTS public.fn_wheel_free_spin(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.fn_wheel_set_free_spin(uuid, jsonb);

COMMIT;
