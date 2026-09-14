-- 20260910223856_the_bank_backs_the_promo_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE BANK BACKS THE PROMO WALLET, AND THE FREE SPIN BECOMES A WELCOME
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Dan, 2026-09-10, on 20260910192951 (the games belong to the host):
--
--   1. "the back up is the union or club main bank, if the promo pool runs
--      dry. wire that in."
--
--   2. "free spin should be once for a new user 100 diamonds, and yes its
--      funded by union or club owners, they simply 'receive no diamonds' but
--      are allowing a free 100 diamond spin for new members of the union or
--      club. All paid for by the promo wallet."
--
--  WHAT (1) CHANGES. The previous migration made the promo wallet the only
--  source of a chip payout, which meant a host whose promo wallet emptied had
--  its games close until somebody noticed. The promo wallet is still the FIRST
--  source and still where an operator is meant to keep the float; behind it
--  now stands the host's main chip bank (union_wallets.chip_balance, or
--  clubs.chip_treasury). A payout draws the promo wallet down to nothing and
--  takes the remainder from the bank, as two journal rows when it splits, so
--  the books say exactly which wallet paid which part. Every gate, cap and
--  tier lock reads the two together as COVER. Nothing is minted: the bank is a
--  wallet the host already owns, not an issuance door.
--
--  WHAT (2) CHANGES. The free spin was daily, drawn on its own small
--  diamonds-only table, and paid by the owner's diamonds. It becomes ONE spin
--  per member per host, ever, on the REAL wheel at the real spin price: the
--  same segments, the same odds, the same prizes a paying player sees. The
--  member pays nothing and the owner takes nothing in, which is the whole of
--  what the host gives up. Every chip it pays comes out of the promo wallet
--  (then the bank) exactly like any other payout.
--
--  THE BUDGET, WHICH IS THE PART DAN'S SENTENCE IMPLIES RATHER THAN STATES. A
--  paid spin funds its own payout: the intake grows and the invariant
--  "paid <= taken in + allowance" holds. A welcome spin takes nothing in, so
--  its payout cannot be charged against the intake without quietly breaking
--  that invariant one new member at a time. So it is NOT charged there. The
--  pool counts welcome payouts separately (welcome_chips_paid) against a
--  budget the host declares (welcome_budget_chips), and the two promises are
--  kept apart and are both exact:
--
--      chips_paid + reserved <= intake_diamonds / rate + exposure allowance
--      welcome_chips_paid                        <= welcome budget
--
--  A host that has not set a welcome budget offers no welcome spin. That is
--  the correct default: an acquisition cost is a decision, not an accident.
--
--  Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
--  Supabase's schema-cache reload, which takes ~28s on this database, and ten
--  loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── 1. the columns the two rulings need ────────────────────────────────────

ALTER TABLE public.wheel_configs
  ADD COLUMN IF NOT EXISTS welcome_budget_chips numeric NOT NULL DEFAULT 0;

ALTER TABLE public.wheel_pools
  ADD COLUMN IF NOT EXISTS welcome_chips_paid numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS welcome_spins integer NOT NULL DEFAULT 0;

ALTER TABLE public.wheel_spins
  ADD COLUMN IF NOT EXISTS is_welcome boolean NOT NULL DEFAULT false;

-- ONCE, EVER. Not once a day: the unique index is the promise, so two requests
-- racing on the same member cannot both find "no welcome spin yet" and both
-- write one. Partial, so it costs nothing on the paid spins that are almost
-- all of the table.
CREATE UNIQUE INDEX IF NOT EXISTS wheel_spins_one_welcome_per_member
  ON public.wheel_spins (host_id, user_id) WHERE is_welcome;

COMMENT ON COLUMN public.wheel_configs.welcome_budget_chips IS
  'Chips this host will spend welcoming new members. The welcome spin is offered only while welcome_chips_paid is below it. Separate from the exposure allowance on purpose: one bounds the paid game, this bounds the gift.';
COMMENT ON COLUMN public.wheel_pools.welcome_chips_paid IS
  'What the welcome spins have paid, in chips, including the chip value of diamond prizes. Never enters chips_paid, which is bounded by the intake.';
COMMENT ON COLUMN public.wheel_spins.is_welcome IS
  'This spin was the member''s one free welcome spin: nobody paid the price, the owner took nothing in, and the payout was charged to the welcome budget.';

-- ── 2. cover: the promo wallet first, the host's own bank behind it ────────
--
-- Dan: "the back up is the union or club main bank, if the promo pool runs
-- dry." Both wallets live on ONE row per host shape, so one FOR UPDATE locks
-- the pair and a spin cannot read a promo balance that another spin is in the
-- middle of spending.

CREATE OR REPLACE FUNCTION public.fn_diamond_game_bank(p_host uuid, p_kind text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(CASE WHEN p_kind = 'union' THEN (SELECT w.chip_balance FROM public.union_wallets w WHERE w.union_id = p_host)
                       ELSE (SELECT c.chip_treasury FROM public.clubs c WHERE c.id = p_host) END, 0);
$function$;

-- What a payout may draw on, promo plus bank. Every gate, cap and tier lock
-- reads THIS, never the promo wallet alone.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_cover(p_host uuid, p_kind text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(public.fn_diamond_game_promo(p_host, p_kind), 0)
       + GREATEST(public.fn_diamond_game_bank(p_host, p_kind), 0);
$function$;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_cover_lock(p_host uuid, p_kind text,
                                                             OUT o_promo numeric, OUT o_bank numeric, OUT o_cover numeric)
RETURNS record
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_kind = 'union' THEN
    INSERT INTO public.union_wallets (union_id, created_at, updated_at) VALUES (p_host, now(), now())
    ON CONFLICT (union_id) DO NOTHING;
    SELECT COALESCE(w.promo_wallet, 0), COALESCE(w.chip_balance, 0)
      INTO o_promo, o_bank
      FROM public.union_wallets w WHERE w.union_id = p_host FOR UPDATE;
  ELSE
    SELECT COALESCE(c.promo_balance, 0), COALESCE(c.chip_treasury, 0)
      INTO o_promo, o_bank
      FROM public.clubs c WHERE c.id = p_host FOR UPDATE;
  END IF;
  -- A wallet that has somehow gone negative covers nothing; it does not get to
  -- eat the other wallet's headroom on the way past.
  o_promo := GREATEST(COALESCE(o_promo, 0), 0);
  o_bank  := GREATEST(COALESCE(o_bank, 0), 0);
  o_cover := o_promo + o_bank;
END $function$;

-- ── 3. one chip payer for all four games ───────────────────────────────────
--
-- Every chip a Diamond game pays now leaves through here: the wheel, plinko,
-- crash and the welcome spin. It draws the promo wallet down to nothing and
-- takes the remainder from the host's bank, writing ONE journal row per wallet
-- it actually touched, from the paying side, so each row names the column the
-- chips left (union_wallets.promo_wallet, clubs.promo_balance,
-- union_wallets.chip_balance, clubs.chip_treasury). The member side stands
-- down on both, so no movement is journaled twice.

CREATE OR REPLACE FUNCTION public.fn_diamond_game_pay_chips(p_category text, p_host uuid, p_kind text,
                                                            p_club uuid, p_user uuid, p_amount numeric,
                                                            p_key text, p_note text, p_meta jsonb,
                                                            OUT promo_after numeric, OUT bank_after numeric,
                                                            OUT cover_after numeric, OUT member_after numeric,
                                                            OUT from_promo numeric, OUT from_bank numeric)
RETURNS record
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_lock record;
BEGIN
  from_promo := 0;
  from_bank  := 0;
  IF COALESCE(p_amount, 0) <= 0 THEN
    SELECT c.o_promo, c.o_bank, c.o_cover INTO promo_after, bank_after, cover_after
      FROM public.fn_diamond_game_cover_lock(p_host, p_kind) c;
    SELECT COALESCE(m.chip_balance, 0) INTO member_after FROM public.club_members m
     WHERE m.club_id = p_club AND m.user_id = p_user LIMIT 1;
    RETURN;
  END IF;

  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_lock FROM public.fn_diamond_game_cover_lock(p_host, p_kind) c;
  from_promo := LEAST(p_amount, v_lock.o_promo);
  from_bank  := p_amount - from_promo;
  IF from_bank > v_lock.o_bank THEN
    RAISE EXCEPTION 'diamond games: cover % is below the % payout of % after the gate passed',
      v_lock.o_cover, p_category, p_amount;
  END IF;

  promo_after := v_lock.o_promo;
  bank_after  := v_lock.o_bank;

  IF from_promo > 0 THEN
    PERFORM public.fn_ca_declare_ledger(p_category, 'player_wallet', p_user, NULL, p_key, ARRAY['club_members']);
    IF p_kind = 'union' THEN
      UPDATE public.union_wallets SET promo_wallet = COALESCE(promo_wallet, 0) - from_promo, updated_at = now()
       WHERE union_id = p_host AND COALESCE(promo_wallet, 0) >= from_promo
       RETURNING promo_wallet INTO promo_after;
    ELSE
      UPDATE public.clubs SET promo_balance = COALESCE(promo_balance, 0) - from_promo, updated_at = now()
       WHERE id = p_host AND COALESCE(promo_balance, 0) >= from_promo
       RETURNING promo_balance INTO promo_after;
    END IF;
    IF promo_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the promo wallet refused the % payout of %', p_category, from_promo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = p_key) THEN
      RAISE EXCEPTION 'diamond games: the promo wallet moved but no leg was journaled for %', p_key;
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + from_promo, updated_at = now()
     WHERE club_id = p_club AND user_id = p_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO member_after;
    IF member_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the % payout landed nowhere for % in club %', p_category, p_user, p_club;
    END IF;
  END IF;

  IF from_bank > 0 THEN
    -- THE BANK BACKS IT (Dan 2026-09-10). Its own key, so the split reads as two
    -- rows that add up to the prize rather than one row that hides where half of
    -- it came from.
    PERFORM public.fn_ca_declare_ledger(p_category, 'player_wallet', p_user, NULL, p_key || ':bank', ARRAY['club_members']);
    IF p_kind = 'union' THEN
      UPDATE public.union_wallets SET chip_balance = COALESCE(chip_balance, 0) - from_bank, updated_at = now()
       WHERE union_id = p_host AND COALESCE(chip_balance, 0) >= from_bank
       RETURNING chip_balance INTO bank_after;
    ELSE
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) - from_bank, updated_at = now()
       WHERE id = p_host AND COALESCE(chip_treasury, 0) >= from_bank
       RETURNING chip_treasury INTO bank_after;
    END IF;
    IF bank_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the host bank refused the % payout of %', p_category, from_bank;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = p_key || ':bank') THEN
      RAISE EXCEPTION 'diamond games: the host bank moved but no leg was journaled for %', p_key || ':bank';
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + from_bank, updated_at = now()
     WHERE club_id = p_club AND user_id = p_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO member_after;
    IF member_after IS NULL THEN
      RAISE EXCEPTION 'diamond games: the % payout landed nowhere for % in club %', p_category, p_user, p_club;
    END IF;
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  -- The autoskip is transaction-scoped and fn_ca_declare_ledger only sets it.
  -- Cleared here so a later balance write in the same transaction is journaled:
  -- left set, the next write on this table would silently write no journal row.
  PERFORM set_config('app.ledger_autoskip_club_members', '', true);
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);

  cover_after := GREATEST(promo_after, 0) + GREATEST(bank_after, 0);

  IF p_kind = 'union' THEN
    IF from_promo > 0 THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (p_host, p_club, 'promo_wallet', 'debit', from_promo, promo_after, p_category, p_note, p_user);
    END IF;
    IF from_bank > 0 THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (p_host, p_club, 'chip_balance', 'debit', from_bank, bank_after, p_category,
              p_note || ' (promo wallet was short, the bank covered it)', p_user);
    END IF;
  END IF;

  INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES (p_club, NULL, p_user, p_amount, p_category, p_note,
          COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('from_promo', from_promo, 'from_bank', from_bank),
          member_after);
END $function$;

-- ── 4. the prize leg every game already calls, now paying through cover ────
--
-- The signature is unchanged, so plinko and crash keep calling it exactly as
-- they did; what moved is where the chips come from. bank_after is the COVER
-- after the payout, which is what those callers use it for.

CREATE OR REPLACE FUNCTION public.fn_diamond_game_prize_leg(p_game text, p_host uuid, p_kind text, p_club uuid, p_user uuid, p_amount numeric, p_key text, p_note text, p_meta jsonb, OUT bank_after numeric, OUT member_after numeric)
RETURNS record
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_pay record;
BEGIN
  IF COALESCE(p_amount, 0) <= 0 THEN
    RETURN;
  END IF;
  SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
    p_game || '_prize', p_host, p_kind, p_club, p_user, p_amount, p_key, p_note, p_meta);
  bank_after   := v_pay.cover_after;
  member_after := v_pay.member_after;
END $function$;

-- ── 5. admission: the bank a round is measured against is now the cover ────

DROP FUNCTION IF EXISTS public.fn_diamond_game_admit(text, uuid, uuid, text, integer);
CREATE FUNCTION public.fn_diamond_game_admit(p_game text, p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet integer, OUT err jsonb, OUT o_host uuid, OUT o_kind text, OUT o_cfg diamond_game_configs, OUT o_pool diamond_game_pools, OUT o_bank numeric, OUT o_promo numeric, OUT o_bank_only numeric, OUT o_rate integer, OUT o_bet_chips numeric, OUT o_owner uuid, OUT o_nonce bigint, OUT o_commit diamond_game_commits, OUT o_diamonds numeric, OUT o_fixture boolean)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today integer; v_last timestamptz;
  v_purchased integer; v_spendable integer;
  v_label text := CASE p_game WHEN 'plinko' THEN 'Diamond Plinko' ELSE 'Diamond Crash' END;
BEGIN
  err := NULL;
  IF v_user IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'Sign In To Play'); RETURN;
  END IF;
  SELECT h.host_id, h.host_kind INTO o_host, o_kind FROM public.fn_wheel_host(p_club_id) h;
  IF o_host IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); RETURN;
  END IF;
  o_rate := public.fn_ca_bridge_rate();
  IF o_rate IS NULL OR o_rate <= 0 THEN
    err := jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set'); RETURN;
  END IF;
  IF length(COALESCE(p_client_seed, '')) < 1 THEN
    err := jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required'); RETURN;
  END IF;
  IF public.fn_platform_frozen() THEN
    err := jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Play Again In A Few Minutes'); RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL) THEN
    err := jsonb_build_object('ok', false, 'error', v_label || ' Is Paused'); RETURN;
  END IF;

  SELECT * INTO o_cfg FROM public.diamond_game_configs c WHERE c.host_id = o_host AND c.game = p_game FOR UPDATE;
  IF o_cfg.host_id IS NULL OR NOT o_cfg.enabled THEN
    err := jsonb_build_object('ok', false, 'error', v_label || ' Is Not Open Here'); RETURN;
  END IF;
  INSERT INTO public.diamond_game_pools (host_id, game) VALUES (o_host, p_game) ON CONFLICT (host_id, game) DO NOTHING;
  IF p_game = 'crash' THEN
    PERFORM public.fn_crash_settle_decided(o_host);
  END IF;
  SELECT * INTO o_pool FROM public.diamond_game_pools p WHERE p.host_id = o_host AND p.game = p_game FOR UPDATE;

  IF p_bet IS NULL OR p_bet < o_cfg.min_bet_diamonds OR p_bet > o_cfg.max_bet_diamonds OR p_bet % o_rate <> 0 THEN
    err := jsonb_build_object('ok', false, 'error',
      format('Bets Are Whole Chips Between %s And %s Diamonds', o_cfg.min_bet_diamonds, o_cfg.max_bet_diamonds)); RETURN;
  END IF;
  o_bet_chips := round(p_bet::numeric / o_rate, 2);
  o_owner := public.fn_diamond_game_owner(o_host, o_kind);
  IF o_owner IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay'); RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    err := jsonb_build_object('ok', false, 'error', 'Join The Club Before You Play'); RETURN;
  END IF;
  o_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF o_fixture AND NOT o_cfg.allow_fixture_accounts THEN
    err := jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Play This Game'); RETURN;
  END IF;
  SELECT * INTO o_commit FROM public.diamond_game_commits c
   WHERE c.id = p_commit_id AND c.user_id = v_user AND c.game = p_game AND c.consumed_by IS NULL FOR UPDATE;
  IF o_commit.id IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'That Ticket Is Not Yours Or Was Already Used. Open The Game Again'); RETURN;
  END IF;
  IF o_commit.expires_at < now() THEN
    err := jsonb_build_object('ok', false, 'error', 'That Ticket Expired. Open The Game Again'); RETURN;
  END IF;

  IF p_game = 'plinko' THEN
    SELECT count(*)::integer, max(d.created_at) INTO v_today, v_last
      FROM public.plinko_drops d
     WHERE d.user_id = v_user AND d.host_id = o_host
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*) + 1 INTO o_nonce FROM public.plinko_drops d WHERE d.user_id = v_user;
  ELSE
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.crash_rounds c
     WHERE c.user_id = v_user AND c.host_id = o_host
       AND (c.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*) + 1 INTO o_nonce FROM public.crash_rounds c WHERE c.user_id = v_user;
  END IF;
  IF v_today >= o_cfg.max_rounds_per_player_per_day THEN
    err := jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Rounds', o_cfg.max_rounds_per_player_per_day)); RETURN;
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => o_cfg.min_seconds_between_rounds) THEN
    err := jsonb_build_object('ok', false, 'error', 'One Moment Between Rounds'); RETURN;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO o_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN o_cfg.purchased_only THEN LEAST(o_diamonds, v_purchased)::integer ELSE o_diamonds::integer END;
  IF v_spendable < p_bet THEN
    err := jsonb_build_object('ok', false,
      'error', CASE WHEN o_cfg.purchased_only AND o_diamonds >= p_bet
                    THEN 'This Game Takes Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For That Bet' END,
      'diamonds', o_diamonds, 'spendable', v_spendable, 'bet_diamonds', p_bet); RETURN;
  END IF;

  -- The host's PROMO wallet pays first and its own chip bank stands behind it
  -- (Dan 2026-09-10: "the back up is the union or club main bank, if the promo
  -- pool runs dry"). Both are on one row per host shape, so one lock takes the
  -- pair, and o_bank - the figure every cap and gate in these games is measured
  -- against - is the two together.
  SELECT c.o_promo, c.o_bank, c.o_cover
    INTO o_promo, o_bank_only, o_bank
    FROM public.fn_diamond_game_cover_lock(o_host, o_kind) c;
END $function$;

-- ── 6. the wheel: one core, two doors ─────────────────────────────────────
--
-- A paid spin and a welcome spin are the SAME wheel: the same segments, the
-- same odds, the same gates, the same journal. The only differences are that
-- nobody pays for the welcome one and its payout is charged to the welcome
-- budget. So there is one body, not two, and the welcome flag is an argument
-- the core takes and the browser cannot: fn_wheel_spin_core is never granted
-- to authenticated, only the two wrappers below are.

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
    IF NOT cfg.free_spin_enabled THEN
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
    IF COALESCE(pool.welcome_chips_paid, 0) >= cfg.welcome_budget_chips THEN
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
      IF p_welcome THEN
        -- A welcome spin is bounded by the host's declared welcome budget, never
        -- by the intake: it took nothing in, so it may not lean on what the paid
        -- game took in either.
        IF COALESCE(pool.welcome_chips_paid, 0) + seg.amount * v_mult > cfg.welcome_budget_chips THEN
          v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'welcome_budget',
                        'unlocks_at', round(seg.amount * v_mult, 2));
          CONTINUE;
        END IF;
      ELSIF pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'cover', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      IF p_welcome AND COALESCE(pool.welcome_chips_paid, 0)
                       + round((seg.amount * v_mult)::numeric / v_rate, 4) > cfg.welcome_budget_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'welcome_budget',
                      'unlocks_at', round((seg.amount * v_mult)::numeric / v_rate, 2));
        CONTINUE;
      END IF;
      IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
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
         diamond_float = diamond_float + v_dia_now - v_prize_dia,
         diamonds_paid = diamonds_paid + v_prize_dia,
         constrained_spins = constrained_spins + CASE WHEN jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
  END IF;
  IF pool.welcome_chips_paid > cfg.welcome_budget_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: the welcome spins have paid % against a budget of % - the gate was bypassed',
      pool.welcome_chips_paid, cfg.welcome_budget_chips;
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

-- The paid door. Unchanged signature, unchanged behaviour, and it cannot ask
-- for a free spin: it passes false and nothing a caller sends can change that.
CREATE OR REPLACE FUNCTION public.fn_wheel_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, false);
$function$;

-- The welcome door. Kept under the name the page already calls so nothing on
-- the client has to know the free spin changed shape underneath it.
CREATE OR REPLACE FUNCTION public.fn_wheel_free_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);
$function$;


-- ── 7. what the page is told about the welcome spin ───────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_free_state(p_club_id uuid)
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

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.free_spin_enabled THEN
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
  IF v_reason IS NULL AND COALESCE(pool.welcome_chips_paid, 0) >= cfg.welcome_budget_chips THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;
  -- The host does not welcome itself: an owner spinning their own wheel for
  -- free would spend the club's budget on the club's own account.
  IF v_reason IS NULL AND v_user IS NOT NULL AND v_user = v_owner THEN v_reason := 'owner'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.free_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used', v_used,
    'once_only', true,
    'spin_price_diamonds', COALESCE(cfg.spin_price_diamonds, 0),
    'budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
    'budget_paid_chips', COALESCE(pool.welcome_chips_paid, 0),
    'budget_left_chips', GREATEST(COALESCE(cfg.welcome_budget_chips, 0) - COALESCE(pool.welcome_chips_paid, 0), 0),
    'welcome_spins', v_taken,
    'segments', v_segments);
END $function$;


-- ── 8. the operator's dial for it ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_set_free_spin(p_club_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_enabled boolean; v_budget numeric;
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
  v_enabled := CASE WHEN p_patch ? 'free_spin_enabled' THEN (p_patch->>'free_spin_enabled')::boolean END;
  v_budget  := CASE WHEN p_patch ? 'welcome_budget_chips' THEN (p_patch->>'welcome_budget_chips')::numeric END;
  IF v_budget IS NOT NULL AND v_budget < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Budget Must Be Zero Or More Chips');
  END IF;
  UPDATE public.wheel_configs
     SET free_spin_enabled = COALESCE(v_enabled, free_spin_enabled),
         welcome_budget_chips = COALESCE(v_budget, welcome_budget_chips),
         updated_by = v_user, updated_at = now()
   WHERE host_id = v_host;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Wheel Is Not Configured Here');
  END IF;
  RETURN jsonb_build_object('ok', true);
END $function$;


-- ── 9. moving chips from the bank into the promo wallet, on purpose ───────
--
-- The bank backs the promo wallet automatically now, but an operator who wants
-- the float where it belongs should not have to go looking for another screen.
-- One door, both host shapes, the same people who may run the wheel.

CREATE OR REPLACE FUNCTION public.fn_diamond_game_fund_promo(p_club_id uuid, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_lock record;
  v_promo_after numeric; v_bank_after numeric;
  v_key text := 'diamond-games-fund:' || gen_random_uuid()::text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Move This Money');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Enter How Many Chips To Move');
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Try Again In A Few Minutes');
  END IF;

  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_lock FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  IF v_lock.o_bank < p_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Does Not Hold That Many Chips',
                              'bank_chips', v_lock.o_bank);
  END IF;

  -- treasury_transfer is the vocabulary's word for chips moving between a host's
  -- own wallets; the journal refuses a category it does not know, and inventing
  -- one here would mean widening chip_ledger_category_check for a button.
  PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'promo_wallet', v_host, NULL, v_key, ARRAY[]::text[]);
  IF v_kind = 'union' THEN
    UPDATE public.union_wallets
       SET chip_balance = chip_balance - p_amount,
           promo_wallet = COALESCE(promo_wallet, 0) + p_amount,
           updated_at = now()
     WHERE union_id = v_host AND chip_balance >= p_amount
     RETURNING promo_wallet, chip_balance INTO v_promo_after, v_bank_after;
  ELSE
    UPDATE public.clubs
       SET chip_treasury = chip_treasury - p_amount,
           promo_balance = COALESCE(promo_balance, 0) + p_amount,
           updated_at = now()
     WHERE id = v_host AND chip_treasury >= p_amount
     RETURNING promo_balance, chip_treasury INTO v_promo_after, v_bank_after;
  END IF;
  IF v_promo_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Does Not Hold That Many Chips');
  END IF;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  IF v_kind = 'union' THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES (v_host, NULL, 'promo_wallet', 'credit', p_amount, v_promo_after, 'treasury_transfer',
            'Moved Into The Promo Wallet For The Diamond Games', v_user);
  END IF;

  RETURN jsonb_build_object('ok', true, 'promo_chips', v_promo_after, 'bank_chips', v_bank_after,
                            'cover_chips', GREATEST(v_promo_after, 0) + GREATEST(v_bank_after, 0));
END $function$;

-- ── 10. the reads: cover, its two halves, and the welcome budget ─────────

--
-- Every one of these used to read the promo wallet alone. They read COVER now
-- (promo + the host bank behind it), and each returns the split as well, so a
-- page can say which wallet is actually carrying the game.


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


CREATE OR REPLACE FUNCTION public.fn_diamond_game_state(p_club_id uuid, p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bank numeric := 0;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  v_bets jsonb; v_tables jsonb; v_open jsonb;
  r public.crash_rounds;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;

  -- Time settles what it has decided before anybody reads the headroom.
  IF p_game = 'crash' THEN
    PERFORM 1 FROM public.diamond_game_configs WHERE host_id = v_host AND game = 'crash' FOR UPDATE;
    PERFORM public.fn_crash_settle_decided(v_host);
    SELECT * INTO r FROM public.crash_rounds c WHERE c.host_id = v_host AND c.user_id = v_user AND c.status = 'open'
     ORDER BY c.started_at DESC LIMIT 1;
    IF r.id IS NOT NULL THEN
      v_open := public.fn_crash_round_result(r);
    END IF;
  END IF;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;

  -- The bank a prize comes out of is the host's PROMO WALLET (Dan 2026-09-10).
  -- Cover: the promo wallet the payouts come out of first, and the host's own
  -- chip bank standing behind it (Dan 2026-09-10).
  v_bank := public.fn_diamond_game_cover(v_host, v_kind);

  -- Every bet option with the cap the pool can promise on it right now.
  SELECT jsonb_agg(jsonb_build_object(
           'bet_diamonds', b, 'bet_chips', round(b::numeric / v_rate, 2),
           'cap_cents', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents),
           'playable', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents) >= 101)
         ORDER BY b)
    INTO v_bets
    FROM unnest(cfg.bet_options) b
   WHERE b BETWEEN cfg.min_bet_diamonds AND cfg.max_bet_diamonds AND b % v_rate = 0;

  IF p_game = 'plinko' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'version', t.version, 'name', t.name, 'rows', t.board_rows,
             'multipliers_cents', to_jsonb(t.multipliers_cents),
             'max_multiplier_cents', t.max_multiplier_cents,
             'spec_rtp', t.spec_rtp, 'sd_chips', t.sd_chips, 'hit_rate', t.hit_rate, 'note', t.note)
           ORDER BY t.version)
      INTO v_tables
      FROM public.plinko_tables t WHERE t.activated_at IS NOT NULL;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  IF p_game = 'plinko' THEN
    SELECT count(*)::integer, max(d.created_at) INTO v_today, v_last
      FROM public.plinko_drops d
     WHERE d.user_id = v_user AND d.host_id = v_host
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  ELSE
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.crash_rounds c
     WHERE c.user_id = v_user AND c.host_id = v_host
       AND (c.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  END IF;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_rounds - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'diamonds_per_chip', v_rate, 'min_bet_diamonds', cfg.min_bet_diamonds, 'max_bet_diamonds', cfg.max_bet_diamonds,
      'exposure_allowance_chips', cfg.exposure_allowance_chips, 'cap_fraction', cfg.cap_fraction,
      'max_multiplier_cents', cfg.max_multiplier_cents, 'growth_k', cfg.growth_k,
      'purchased_only', cfg.purchased_only, 'max_rounds_per_player_per_day', cfg.max_rounds_per_player_per_day,
      'min_seconds_between_rounds', cfg.min_seconds_between_rounds, 'spec_rtp', 0.800000, 'house_share', 0.200000),
    'bets', COALESCE(v_bets, '[]'::jsonb),
    'tables', COALESCE(v_tables, '[]'::jsonb),
    'open_round', v_open,
    'pool', jsonb_build_object(
      'rounds', COALESCE(pool.rounds, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_minted', COALESCE(pool.chips_minted, 0), 'chips_paid', COALESCE(pool.chips_paid, 0),
      'reserved_chips', COALESCE(pool.reserved_chips, 0),
      'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
      'promo_wallet_chips', public.fn_diamond_game_promo(v_host, v_kind),
      'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
      'cover_chips', v_bank,
      'headroom_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2) + cfg.exposure_allowance_chips - COALESCE(pool.chips_paid, 0) - COALESCE(pool.reserved_chips, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round(COALESCE(pool.chips_paid, 0) / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'rounds_today', v_today, 'seconds_until_next', v_wait,
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;


CREATE OR REPLACE FUNCTION public.fn_wheel_metrics(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_sd numeric; v_windows jsonb; v_bank numeric;
  v_invariant_ok boolean;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Read The Wheel Metrics');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'configured', false, 'host_id', v_host, 'host_kind', v_kind);
  END IF;
  SELECT v.sd_chips INTO v_sd FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  -- The bank behind the prizes is the host's PROMO WALLET (Dan 2026-09-10).
  v_bank := public.fn_diamond_game_cover(v_host, v_kind);

  -- Realised return against the 80 percent spec, per window, as a z-score on
  -- the table's own standard deviation: the spin fairness view's method.
  SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
    FROM (
      SELECT jsonb_build_object(
               'window', lbl,
               'spins', n,
               'intake_chips', round(intake, 2),
               'paid_chips', round(paid, 4),
               'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
               'z', CASE WHEN n >= 30 AND v_sd > 0
                         THEN round((paid / n - 0.80 * intake / n) / (v_sd / sqrt(n::numeric)), 2) END,
               'constrained', constrained,
               'drift', CASE WHEN n >= 2000 AND v_sd > 0
                             THEN abs((paid / n - 0.80 * intake / n) / (v_sd / sqrt(n::numeric))) >= 4 ELSE false END)
             AS w
        FROM (
          SELECT lbl,
                 count(s.id) AS n,
                 COALESCE(SUM(s.spin_price_diamonds::numeric / s.diamonds_per_chip), 0) AS intake,
                 COALESCE(SUM(s.prize_value_chips), 0) AS paid,
                 COALESCE(SUM(CASE WHEN jsonb_array_length(s.locked) > 0 THEN 1 ELSE 0 END), 0) AS constrained
            FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
            LEFT JOIN public.wheel_spins s
              ON s.host_id = v_host AND NOT s.is_fixture AND s.created_at >= now() - win.span
           GROUP BY lbl
        ) x
    ) y;

  -- The invariant, in value: chips paid within minted + allowance, and diamonds
  -- paid within the accrued diamond share + the seed (diamond_float >= 0).
  v_invariant_ok := pool.host_id IS NULL
                 OR (pool.chips_paid <= round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips
                     AND pool.diamond_float >= 0);
  IF NOT v_invariant_ok THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source => 'wheel_invariant', p_classification => 'unauthorized_adjustment', p_severity => 'critical',
        p_dedupe_key => 'wheel:invariant:' || v_host::text,
        p_discrepancy => pool.chips_paid - round(pool.intake_diamonds::numeric / v_rate, 2) - cfg.exposure_allowance_chips,
        p_expected => round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips, p_actual => pool.chips_paid,
        p_layer => 'settlement', p_entity_type => 'wheel_pool', p_entity_id => v_host,
        p_union_id => CASE WHEN v_kind = 'union' THEN v_host END,
        p_club_id => CASE WHEN v_kind = 'club' THEN v_host END,
        p_suspected_cause => 'Diamond Wheel paid more chips than it took in plus the allowance; the per-spin gate was bypassed',
        p_metadata => to_jsonb(pool));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'configured', true, 'host_id', v_host, 'host_kind', v_kind,
    'config', to_jsonb(cfg),
    'pool', to_jsonb(pool),
    'cover_chips', COALESCE(v_bank, 0),
    'promo_chips', public.fn_diamond_game_promo(v_host, v_kind),
    'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
    'welcome_budget_chips', COALESCE(cfg.welcome_budget_chips, 0),
    'welcome_chips_paid', COALESCE(pool.welcome_chips_paid, 0),
    'welcome_budget_left_chips', GREATEST(COALESCE(cfg.welcome_budget_chips, 0) - COALESCE(pool.welcome_chips_paid, 0), 0),
    'welcome_spins', COALESCE(pool.welcome_spins, 0),
    'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
    'owner_id', public.fn_diamond_game_owner(v_host, v_kind),
    'owner_diamonds', (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = public.fn_diamond_game_owner(v_host, v_kind)),
    'exposure_chips', COALESCE(pool.chips_paid, 0) - round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
    'exposure_headroom_chips', cfg.exposure_allowance_chips - (COALESCE(pool.chips_paid, 0) - round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2)),
    'diamond_headroom', COALESCE(pool.diamond_float, 0),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round((pool.chips_paid + pool.diamonds_paid::numeric / v_rate) / (pool.intake_diamonds::numeric / v_rate), 4) END,
    -- What the host kept: every diamond taken in, less the chips and the diamonds
    -- it paid back out. Nothing is minted any more, so this is the whole of it.
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_paid
                   - pool.diamonds_paid::numeric / v_rate, 4) END,
    'lock_rate', CASE WHEN COALESCE(pool.spins, 0) > 0 THEN round(pool.constrained_spins::numeric / pool.spins, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'audit', (SELECT to_jsonb(x) FROM public.fn_wheel_segments_audit(cfg.segment_version) x));
END $function$;


CREATE OR REPLACE FUNCTION public.fn_diamond_game_metrics(p_club_id uuid, p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_windows jsonb; v_bank numeric; v_open integer := 0;
  v_invariant_ok boolean;
BEGIN
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Read These Metrics');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'configured', false, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;
  -- The bank behind the payouts is the host's PROMO WALLET (Dan 2026-09-10).
  v_bank := public.fn_diamond_game_cover(v_host, v_kind);

  IF p_game = 'plinko' THEN
    SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
      FROM (
        SELECT jsonb_build_object(
                 'window', lbl, 'rounds', n,
                 'intake_chips', round(intake, 2), 'paid_chips', round(paid, 2),
                 'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
                 'z', CASE WHEN n >= 30 AND var > 0 THEN round((paid - 0.80 * intake) / sqrt(var), 2) END,
                 'constrained', constrained,
                 'drift', CASE WHEN n >= 2000 AND var > 0 THEN abs((paid - 0.80 * intake) / sqrt(var)) >= 4 ELSE false END) AS w
          FROM (
            SELECT lbl, count(d.id) AS n,
                   COALESCE(SUM(d.bet_chips), 0) AS intake,
                   COALESCE(SUM(d.payout_chips), 0) AS paid,
                   COALESCE(SUM(power(d.bet_chips * COALESCE(t.sd_chips, 0), 2)), 0) AS var,
                   COALESCE(SUM(CASE WHEN d.capped THEN 1 ELSE 0 END), 0) AS constrained
              FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
              LEFT JOIN public.plinko_drops d ON d.host_id = v_host AND NOT d.is_fixture AND d.created_at >= now() - win.span
              LEFT JOIN public.plinko_tables t ON t.version = d.table_version
             GROUP BY lbl) x) y;
  ELSE
    SELECT count(*) INTO v_open FROM public.crash_rounds c WHERE c.host_id = v_host AND c.status = 'open';
    SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
      FROM (
        SELECT jsonb_build_object(
                 'window', lbl, 'rounds', n,
                 'intake_chips', round(intake, 2), 'paid_chips', round(paid, 2),
                 'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
                 'z', CASE WHEN n >= 30 AND var > 0 THEN round((paid - 0.80 * intake) / sqrt(var), 2) END,
                 'constrained', constrained,
                 'instant_crashes', instant,
                 'drift', CASE WHEN n >= 2000 AND var > 0 THEN abs((paid - 0.80 * intake) / sqrt(var)) >= 4 ELSE false END) AS w
          FROM (
            -- Variance per round at the target the player actually took: a
            -- payout of bet*x with probability 0.8/x has variance
            -- bet^2 * (0.8 x - 0.64). A crashed round's target is unknown; it
            -- is scored at its own crash point, the most it could have asked.
            SELECT lbl, count(c.id) AS n,
                   COALESCE(SUM(c.bet_chips), 0) AS intake,
                   COALESCE(SUM(c.payout_chips), 0) AS paid,
                   COALESCE(SUM(power(c.bet_chips, 2) * (0.8 * LEAST(COALESCE(c.cashout_cents, c.crash_cents), c.cap_cents)::numeric / 100 - 0.64)), 0) AS var,
                   COALESCE(SUM(CASE WHEN c.cap_cents < cfg.max_multiplier_cents THEN 1 ELSE 0 END), 0) AS constrained,
                   COALESCE(SUM(CASE WHEN c.crash_cents = 100 THEN 1 ELSE 0 END), 0) AS instant
              FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
              LEFT JOIN public.crash_rounds c ON c.host_id = v_host AND NOT c.is_fixture AND c.status <> 'open' AND c.created_at >= now() - win.span
             GROUP BY lbl) x) y;
  END IF;

  v_invariant_ok := pool.host_id IS NULL
                 OR (pool.chips_paid + pool.reserved_chips
                       <= round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips);
  IF NOT v_invariant_ok THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source => p_game || '_invariant', p_classification => 'unauthorized_adjustment', p_severity => 'critical',
        p_dedupe_key => p_game || ':invariant:' || v_host::text,
        p_discrepancy => pool.chips_paid + pool.reserved_chips - round(pool.intake_diamonds::numeric / v_rate, 2) - cfg.exposure_allowance_chips,
        p_expected => round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips, p_actual => pool.chips_paid + pool.reserved_chips,
        p_layer => 'settlement', p_entity_type => 'diamond_game_pool', p_entity_id => v_host,
        p_union_id => CASE WHEN v_kind = 'union' THEN v_host END,
        p_club_id => CASE WHEN v_kind = 'club' THEN v_host END,
        p_suspected_cause => 'Diamond ' || p_game || ' paid or reserved more chips than it took in plus the allowance; the per-round cap was bypassed',
        p_metadata => to_jsonb(pool));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'configured', true, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind,
    'config', to_jsonb(cfg),
    'pool', to_jsonb(pool),
    'cover_chips', COALESCE(v_bank, 0),
    'promo_chips', public.fn_diamond_game_promo(v_host, v_kind),
    'bank_chips', public.fn_diamond_game_bank(v_host, v_kind),
    'open_rounds', v_open,
    'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
    'owner_id', public.fn_diamond_game_owner(v_host, v_kind),
    'owner_diamonds', (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = public.fn_diamond_game_owner(v_host, v_kind)),
    'exposure_chips', COALESCE(pool.chips_paid, 0) + COALESCE(pool.reserved_chips, 0) - round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
    'exposure_headroom_chips', cfg.exposure_allowance_chips - (COALESCE(pool.chips_paid, 0) + COALESCE(pool.reserved_chips, 0) - round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2)),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round(pool.chips_paid / (pool.intake_diamonds::numeric / v_rate), 4) END,
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_paid, 2) END,
    'constrained_rate', CASE WHEN COALESCE(pool.rounds, 0) > 0 THEN round(pool.constrained_rounds::numeric / pool.rounds, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'tables', CASE WHEN p_game = 'plinko' THEN
        (SELECT jsonb_agg(jsonb_build_object('version', t.version, 'name', t.name, 'spec_rtp', t.spec_rtp,
                                             'sd_chips', t.sd_chips, 'hit_rate', t.hit_rate, 'max_multiplier_cents', t.max_multiplier_cents,
                                             'activated_at', t.activated_at) ORDER BY t.version)
           FROM public.plinko_tables t) END);
END $function$;

-- ── 11. the door knows about the welcome spin ────────────────────────────

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
    SELECT COALESCE(w.free_spin_enabled, false)
       AND COALESCE(w.welcome_budget_chips, 0) > COALESCE((SELECT p.welcome_chips_paid FROM public.wheel_pools p WHERE p.host_id = v_host), 0)
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


-- ── 11b. the profile guard admits the core ────────────────────────────────
--
-- fn_guard_profile_privileged_columns allowlists the CALLER of a balance write
-- by call stack, and fn_wheel_spin and fn_wheel_free_spin are named there. Both
-- are thin SQL wrappers now, and a SQL function appears in the stack as
--   SQL function "fn_wheel_free_spin" statement 1
-- which those patterns do not match, so a diamond prize was refused the moment
-- the wheel was refactored. The core is what actually pays, so the core is what
-- the guard should name; the two wrapper entries stay where they are and cost
-- nothing.
CREATE FUNCTION pg_temp.bb_patch(p_fn text, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $bb$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'bb_patch: marker in % found % times', p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $bb$;
SELECT pg_temp.bb_patch('fn_guard_profile_privileged_columns',
$bb_from$     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'$bb_from$,
$bb_to$     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'$bb_to$);
DROP FUNCTION pg_temp.bb_patch(text, text, text);


-- ── 12. grants ────────────────────────────────────────────────────────────
--
-- The autorevoke event trigger strips PUBLIC and anon from every function
-- above on the way past, so what is left is what is stated here.

-- The helpers. None of these is a door: they are called from inside the games
-- and from nowhere else, and fn_wheel_spin_core in particular MUST NOT be
-- reachable by a browser, because its fourth argument is the free spin.
REVOKE ALL ON FUNCTION public.fn_diamond_game_bank(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_bank(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_cover(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_cover(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_cover_lock(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_cover_lock(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_pay_chips(text, uuid, text, uuid, uuid, numeric, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_pay_chips(text, uuid, text, uuid, uuid, numeric, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_prize_leg(text, uuid, text, uuid, uuid, numeric, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_prize_leg(text, uuid, text, uuid, uuid, numeric, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_admit(text, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_admit(text, uuid, uuid, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid, uuid, text, boolean) TO service_role;

-- The doors.
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_spin(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_free_spin(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_fund_promo(uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_metrics(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_metrics(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_games_entry(uuid) TO authenticated, service_role;


-- ── 13. the migration refuses to commit unless the shape is what it says ──

DO $$
DECLARE v_def text; v_n integer;
BEGIN
  -- The columns the two rulings need.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'wheel_configs' AND column_name = 'welcome_budget_chips') THEN
    RAISE EXCEPTION 'the bank backs the promo wallet: wheel_configs.welcome_budget_chips is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'wheel_pools' AND column_name = 'welcome_chips_paid') THEN
    RAISE EXCEPTION 'the bank backs the promo wallet: wheel_pools.welcome_chips_paid is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE tablename = 'wheel_spins' AND indexname = 'wheel_spins_one_welcome_per_member') THEN
    RAISE EXCEPTION 'the welcome spin: the once-per-member index is missing, so it is not once per member';
  END IF;

  -- The browser may not ask for a free spin by argument.
  IF has_function_privilege('authenticated', 'public.fn_wheel_spin_core(uuid, uuid, text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the welcome spin: fn_wheel_spin_core is reachable by authenticated, so a browser can ask for a free spin';
  END IF;

  -- Every chip a game pays leaves through the one payer. No game function may
  -- debit a wallet itself any more; if one does, the split and its two journal
  -- rows are being bypassed.
  FOR v_def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN ('fn_wheel_spin_core', 'fn_plinko_drop', 'fn_crash_start', 'fn_crash_decide')
  LOOP
    IF v_def LIKE '%promo_wallet = %' OR v_def LIKE '%promo_balance = %'
       OR v_def LIKE '%chip_treasury = %' OR v_def LIKE '%chip_balance = chip_balance%' THEN
      RAISE EXCEPTION 'a diamond game still moves a host wallet itself instead of calling fn_diamond_game_pay_chips';
    END IF;
  END LOOP;

  -- And the payer really does draw the promo wallet first.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_pay_chips';
  IF v_def NOT LIKE '%from_promo := LEAST(p_amount, v_lock.o_promo);%' THEN
    RAISE EXCEPTION 'the bank backs the promo wallet: the payer does not draw the promo wallet first';
  END IF;
  IF v_def NOT LIKE '%p_key || '':bank''%' THEN
    RAISE EXCEPTION 'the bank backs the promo wallet: the bank half of a split payout has no key of its own';
  END IF;

  -- The welcome spin never charges the paid game's books.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_wheel_spin_core';
  IF v_def NOT LIKE '%chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END%' THEN
    RAISE EXCEPTION 'the welcome spin: its payout is still being charged to chips_paid';
  END IF;
  IF v_def NOT LIKE '%welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END%' THEN
    RAISE EXCEPTION 'the welcome spin: its payout is not charged to the welcome budget';
  END IF;
  IF v_def NOT LIKE '%v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;%' THEN
    RAISE EXCEPTION 'the welcome spin: the owner is still taking diamonds in on it';
  END IF;

  -- The two doors pass the flag they are supposed to, and only that.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_wheel_spin' AND p.pronargs = 3;
  IF v_def NOT LIKE '%p_client_seed, false)%' THEN
    RAISE EXCEPTION 'the paid door does not pass false to the core';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_wheel_free_spin';
  IF v_def NOT LIKE '%p_client_seed, true)%' THEN
    RAISE EXCEPTION 'the welcome door does not pass true to the core';
  END IF;

  -- The guard lets the core pay an owner's diamonds out.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_guard_profile_privileged_columns';
  IF v_def NOT LIKE '%fn_wheel_spin_core[(]%' THEN
    RAISE EXCEPTION 'the profile guard does not name fn_wheel_spin_core, so a diamond prize will be refused';
  END IF;

  -- The reads answer on cover, not on the promo wallet alone.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_wheel_state', 'fn_diamond_game_state', 'fn_wheel_metrics', 'fn_diamond_game_metrics')
     AND pg_get_functiondef(p.oid) LIKE '%fn_diamond_game_cover(%';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'only % of the four reads were moved onto cover', v_n;
  END IF;
END $$;

COMMIT;
