-- ═══════════════════════════════════════════════════════════════════════════
--  THE GAMES BELONG TO THE HOST
--
--  Dan 2026-09-10, verbatim: "make sure that the chip payouts are 100%
--  connected and wired to the 'promo wallet' and all diamonds 'taken in' get
--  credited to the union owners wallet, or the club owners wallet."
--
--  WHAT THIS CHANGES. Until today the three Diamond Games were the platform's:
--  a bet's diamonds were RETIRED (spent to revenue), the host bank was MINTED
--  0.80 chips of new supply per chip of intake through the issuance register,
--  and prizes came out of that bank (union_wallets.chip_balance or
--  clubs.chip_treasury). The host never held the diamonds and the chips it paid
--  with had just been created.
--
--  From now on the host IS the house, and no chips are created at all:
--
--    * every diamond taken in is CREDITED TO THE HOST'S OWNER - the union's
--      owner for a union host, the club's owner for a standalone club - as a
--      transfer, in the same transaction as the player's debit;
--    * every chip payout comes OUT OF THE HOST'S PROMO WALLET
--      (union_wallets.promo_wallet, or clubs.promo_balance for a standalone
--      club) into the player's club chips;
--    * every diamond prize, the free spin included, is PAID BY THE OWNER out
--      of the same wallet the intake fills;
--    * nothing is minted. fn_diamond_game_mint_leg is dropped and the wheel's
--      mint block is gone. The games no longer add a chip to supply.
--
--  THE LAW IS UNCHANGED AND ITS ARITHMETIC IS NOW SIMPLER (Dan 2026-09-07:
--  "never pay more out than we take in"). Every gate that used to read
--  chips_minted now reads what the game HAS TAKEN IN:
--
--      chips_paid + reserved  <=  intake_diamonds / rate  +  allowance
--
--  and the promo wallet must actually hold the prize before a tier is drawable
--  or a bet is capped to it. On the diamond side the wheel keeps its own bound
--  (diamond_float, seeded by the host, never negative) AND requires the owner
--  to hold the prize. A tier the host cannot pay is locked and shown as locked,
--  exactly as before; only the reason changes ('promo_wallet', 'owner_diamonds').
--
--  WHY THE FREE SPIN MOVED TOO. It was an issuance from the platform's
--  promotional budget with a per-host switch and pot - the host's promotion,
--  funded by everyone else. With the host taking the intake it pays for its own
--  generosity: the same transfer, from the same owner wallet. That also takes a
--  diamond faucet out of supply. The per-host daily pot still governs it.
--
--  ONE JOURNAL ROW PER MOVEMENT. A chip prize is written by the PROMO side, so
--  the leg names the column it left (union_wallets.promo_wallet, or
--  clubs.promo_balance) and carries the balances either side of it; the member
--  side stands down on app.ledger_autoskip_club_members, so the movement is
--  journaled once and not twice. Every payout leg therefore reads
--  <promo column> -> player_wallet and every one of them carries its round's key.
--
--  AND ONE NEW READ. fn_diamond_games_entry answers, for a club, "can this
--  player turn diamonds into chips here, and what does it cost" - the read
--  behind the club lobby's Diamonds To Chips button and behind the prompt a
--  player gets when their chips will not cover a buy-in, a rebuy or an add-on.
--
--  Every function below is the LIVE body with the named change and nothing
--  else; each was read out of production with pg_get_functiondef first.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;


-- ── 1. the host, its owner, its promo wallet, and how it pays a diamond prize ───


-- ── the host's owner: the wallet the diamonds go to ───────────────────────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_owner(p_host uuid, p_kind text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_kind = 'union' THEN (SELECT u.owner_id FROM public.unions u WHERE u.id = p_host)
              ELSE (SELECT c.owner_id FROM public.clubs c WHERE c.id = p_host) END;
$function$;

-- ── the host's promo wallet, locked for the round, and what it holds ──────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_promo_lock(p_host uuid, p_kind text)
RETURNS numeric
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_promo numeric;
BEGIN
  IF p_kind = 'union' THEN
    INSERT INTO public.union_wallets (union_id, created_at, updated_at) VALUES (p_host, now(), now())
    ON CONFLICT (union_id) DO NOTHING;
    SELECT COALESCE(w.promo_wallet, 0) INTO v_promo FROM public.union_wallets w WHERE w.union_id = p_host FOR UPDATE;
  ELSE
    SELECT COALESCE(c.promo_balance, 0) INTO v_promo FROM public.clubs c WHERE c.id = p_host FOR UPDATE;
  END IF;
  RETURN COALESCE(v_promo, 0);
END $function$;

-- ── the same wallet, read without a lock (the state and metrics reads) ────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_promo(p_host uuid, p_kind text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(CASE WHEN p_kind = 'union' THEN (SELECT w.promo_wallet FROM public.union_wallets w WHERE w.union_id = p_host)
                       ELSE (SELECT c.promo_balance FROM public.clubs c WHERE c.id = p_host) END, 0);
$function$;

-- ── a diamond prize: the owner pays it, the player receives it ────────────
-- Both legs are transfers (issuance_class transferred): nothing is issued, nothing
-- is retired, no promotional budget or daily cap is touched, no VIP multiplier
-- applies. The owner's debit goes first; if the owner cannot pay, the round aborts
-- whole and the player is charged nothing.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_pay_diamonds(p_owner uuid, p_user uuid, p_amount integer, p_note text, p_reference text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_res jsonb;
BEGIN
  IF p_amount <= 0 THEN RETURN; END IF;
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'diamond games: no owner to pay the diamond prize %', p_reference;
  END IF;
  v_res := public.add_diamonds_to_balance(p_owner, -p_amount, 'transfer', p_note, p_reference || ':host');
  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the host owner could not pay the diamond prize %: %', p_reference, v_res->>'error';
  END IF;
  v_res := public.add_diamonds_to_balance(p_user, p_amount, 'transfer', p_note, p_reference);
  IF COALESCE((v_res->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the diamond prize could not be credited %: %', p_reference, v_res->>'error';
  END IF;
END $function$;


-- ── 2. the cap: bounded by what the game took in and what the promo wallet holds ───

CREATE OR REPLACE FUNCTION public.fn_diamond_game_cap_cents(p_cfg diamond_game_configs, p_pool diamond_game_pools, p_bank numeric, p_bet_chips numeric, p_ceiling_cents integer)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted any more: the bet's
  -- diamonds go to the host's owner, and the prize comes out of the host's PROMO
  -- wallet (p_bank is that wallet now). The law "never pay out more than taken in"
  -- is kept as arithmetic on what was taken in: paid + reserved may not exceed the
  -- chip value of every diamond the game has taken (plus this bet) plus the host's
  -- allowance, and the promo wallet must hold the prize.
  v_intake numeric := COALESCE(p_pool.intake_diamonds, 0) / public.fn_ca_bridge_rate() + p_bet_chips;
  v_headroom numeric; v_bank_room numeric; v_cap numeric;
BEGIN
  v_headroom  := v_intake + p_cfg.exposure_allowance_chips
               - COALESCE(p_pool.chips_paid, 0) - COALESCE(p_pool.reserved_chips, 0);
  v_bank_room := COALESCE(p_bank, 0) - COALESCE(p_pool.reserved_chips, 0);
  v_cap := LEAST(p_ceiling_cents::numeric,
                 floor(p_cfg.cap_fraction * v_headroom / p_bet_chips * 100),
                 floor(v_bank_room / p_bet_chips * 100));
  RETURN GREATEST(0, v_cap)::integer;
END $function$;


-- ── 3. the payout leg: out of the promo wallet, into the player ───────────

CREATE OR REPLACE FUNCTION public.fn_diamond_game_prize_leg(p_game text, p_host uuid, p_kind text, p_club uuid, p_user uuid, p_amount numeric, p_key text, p_note text, p_meta jsonb, OUT bank_after numeric, OUT member_after numeric)
 RETURNS record
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_category text := p_game || '_prize';
BEGIN
  -- THE PRIZE IS A PROMOTION, PAID FROM THE PROMO WALLET (Dan 2026-09-10: "make sure
  -- that the chip payouts are 100% connected and wired to the promo wallet"). A union
  -- host pays from union_wallets.promo_wallet, a standalone club from clubs.promo_balance,
  -- into the member's club chips. ONE journal row: the promo wallet's own trigger writes
  -- it, promo -> player_wallet, keyed on the round; the member side is skipped so the
  -- leg is not journaled twice. bank_after is the promo wallet after the prize.
  IF p_amount <= 0 THEN
    RETURN;
  END IF;
  PERFORM public.fn_ca_declare_ledger(v_category, 'player_wallet', p_user, NULL, p_key, ARRAY['club_members']);
  IF p_kind = 'union' THEN
    UPDATE public.union_wallets SET promo_wallet = COALESCE(promo_wallet, 0) - p_amount, updated_at = now()
     WHERE union_id = p_host AND COALESCE(promo_wallet, 0) >= p_amount
     RETURNING promo_wallet INTO bank_after;
  ELSE
    UPDATE public.clubs SET promo_balance = COALESCE(promo_balance, 0) - p_amount, updated_at = now()
     WHERE id = p_host AND COALESCE(promo_balance, 0) >= p_amount
     RETURNING promo_balance INTO bank_after;
  END IF;
  IF bank_after IS NULL THEN
    RAISE EXCEPTION 'diamond games: the host promo wallet refused the % payout of %', p_game, p_amount;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = p_key) THEN
    RAISE EXCEPTION 'diamond games: the promo wallet moved but no prize leg was journaled for %', p_key;
  END IF;
  UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
   WHERE club_id = p_club AND user_id = p_user
     AND COALESCE(status, 'active') IN ('active', 'approved')
   RETURNING chip_balance INTO member_after;
  IF member_after IS NULL THEN
    RAISE EXCEPTION 'diamond games: the % payout landed nowhere for % in club %', p_game, p_user, p_club;
  END IF;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  PERFORM set_config('app.ledger_autoskip_club_members', '', true);
  IF p_kind = 'union' THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES (p_host, p_club, 'promo_wallet', 'debit', p_amount, bank_after, v_category, p_note, p_user);
  END IF;
  INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES (p_club, NULL, p_user, p_amount, v_category, p_note, p_meta, member_after);
END $function$;


-- ── 4. the bet leg: the host owner is paid the diamonds ───────────────────


DROP FUNCTION IF EXISTS public.fn_diamond_game_take_bet(uuid, integer, boolean, text, text, text, jsonb);
CREATE FUNCTION public.fn_diamond_game_take_bet(p_user uuid, p_bet integer, p_purchased_only boolean, p_type text, p_description text, p_reference text, p_meta jsonb, p_owner uuid, p_owner_note text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_deduct jsonb; v_credit jsonb; v_remaining integer; v_take integer; v_lot record;
BEGIN
  -- THE BET GOES TO THE HOST'S OWNER (Dan 2026-09-10: "all diamonds 'taken in' get
  -- credited to the union owners wallet, or the club owners wallet"). Two legs, one
  -- transaction, both transfers: the player's diamonds leave as a transfer to the owner
  -- (source diamond_game, the recipient in the metadata), and the owner's wallet takes
  -- them as a transfer. Nothing is retired and nothing is minted.
  IF p_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;
  v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',
                p_meta || jsonb_build_object('recipient_id', p_owner, 'bet_type', p_type), p_reference, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN v_deduct;
  END IF;
  IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
    RETURN v_deduct;
  END IF;
  IF p_purchased_only THEN
    v_remaining := p_bet;
    FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                  WHERE l.user_id = p_user AND l.frozen_at IS NULL
                    AND (l.issued - l.consumed - l.refunded) > 0
                  ORDER BY l.created_at, l.id FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'diamond games: purchased lots could not cover the bet (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;
  v_credit := public.add_diamonds_to_balance(p_owner, p_bet, 'transfer', p_owner_note, p_reference || ':intake');
  IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the bet could not be credited to the host owner (%): %', p_reference, v_credit->>'error';
  END IF;
  RETURN v_deduct || jsonb_build_object('owner_id', p_owner, 'owner_balance', v_credit->'new_balance');
END $function$;


-- ── 5. admission: the owner, and the promo wallet as the bank ─────────────

DROP FUNCTION IF EXISTS public.fn_diamond_game_admit(text, uuid, uuid, text, integer);
CREATE FUNCTION public.fn_diamond_game_admit(p_game text, p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet integer, OUT err jsonb, OUT o_host uuid, OUT o_kind text, OUT o_cfg diamond_game_configs, OUT o_pool diamond_game_pools, OUT o_bank numeric, OUT o_rate integer, OUT o_bet_chips numeric, OUT o_owner uuid, OUT o_nonce bigint, OUT o_commit diamond_game_commits, OUT o_diamonds numeric, OUT o_fixture boolean)
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

  -- The host's PROMO wallet is the bank the prizes come from (Dan 2026-09-10), locked
  -- for the round like the config and the pool.
  o_bank := public.fn_diamond_game_promo_lock(o_host, o_kind);
END $function$;


-- ── 6. plinko ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_plinko_drop(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_table_version integer, p_bet_diamonds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  prior public.plinko_drops;
  adm record;
  t public.plinko_tables%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_hmac bytea; v_path integer := 0; v_slot integer := 0; i integer;
  v_cap integer; v_table_mult integer; v_mult integer; v_payout numeric;
  v_deduct jsonb; v_bank numeric; v_member_after numeric; v_bank_after numeric;
  v_intake_chips numeric;
  v_dia_after numeric;
  pool public.diamond_game_pools%ROWTYPE;
  d public.plinko_drops;
BEGIN
  -- A SIGNED-OUT CALLER IS NOT A PLAYER (2026-09-09).
  --
  -- This RPC is granted to `anon`, and it had no sign-in guard while its
  -- siblings (fn_wheel_commit, fn_wheel_spin, fn_wheel_set_config) all do. On
  -- its own that is only defence in depth - but the ownership check below read
  -- `user_id IS DISTINCT FROM v_user`, and with v_user NULL that comparison is NULL, which is
  -- not TRUE, so the refusal did not fire and execution fell through to return
  -- the round. A logged-out caller holding a commit_id could read another
  -- player's result. Three-valued logic, in a money game. Every such
  -- comparison in this body is now IS DISTINCT FROM as well.
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Drop');
  END IF;
  SELECT * INTO prior FROM public.plinko_drops WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Drop Belongs To Another Player');
    END IF;
    RETURN public.fn_plinko_drop_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO adm FROM public.fn_diamond_game_admit('plinko', p_club_id, p_commit_id, p_client_seed, p_bet_diamonds);
  IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;

  SELECT * INTO t FROM public.plinko_tables WHERE version = p_table_version AND activated_at IS NOT NULL;
  IF t.version IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Plinko Table Is Not Active');
  END IF;

  -- ── the cap, before the ball drops ─────────────────────────────────────────
  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, LEAST(t.max_multiplier_cents, (adm.o_cfg).max_multiplier_cents));
  IF v_cap < 101 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Club Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet',
                              'cap_cents', v_cap);
  END IF;

  -- ── the roll: sixteen bits, one per row ────────────────────────────────────
  v_hmac := extensions.hmac(convert_to(p_client_seed || ':' || adm.o_nonce::text, 'UTF8'),
                            convert_to((adm.o_commit).server_seed, 'UTF8'), 'sha256');
  FOR i IN 0..15 LOOP
    IF get_bit(v_hmac, i) = 1 THEN
      v_path := v_path | (1 << i);
      v_slot := v_slot + 1;
    END IF;
  END LOOP;
  v_table_mult := t.multipliers_cents[v_slot + 1];
  v_mult := LEAST(v_table_mult, v_cap);
  v_payout := round(adm.o_bet_chips * v_mult / 100, 2);

  -- ── 1. the bet is paid for, and the host's owner is paid it ────────────────
  v_deduct := public.fn_diamond_game_take_bet(v_user, p_bet_diamonds, (adm.o_cfg).purchased_only, 'plinko_drop',
                format('Diamond Plinko Drop (%s Diamonds, %s)', p_bet_diamonds, t.name),
                'plinko:' || v_id::text,
                jsonb_build_object('drop_id', v_id, 'club_id', p_club_id, 'host_id', adm.o_host,
                                   'commit_id', p_commit_id, 'table_version', t.version),
                adm.o_owner,
                format('Diamond Plinko Intake (%s Diamonds)', p_bet_diamonds));
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For That Bet', 'detail', v_deduct->>'error');
  END IF;

  -- ── 2. nothing is minted: the prize comes out of the promo wallet ──────────
  v_bank := adm.o_bank;

  -- ── 3. the payout ──────────────────────────────────────────────────────────
  IF v_payout > 0 THEN
    IF v_bank < v_payout THEN
      RAISE EXCEPTION 'fn_plinko_drop: host bank % below the payout % after the cap passed', v_bank, v_payout;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('plinko', adm.o_host, adm.o_kind, p_club_id, v_user, v_payout,
             'plinko-prize:' || v_id::text,
             format('Diamond Plinko: %s.%sx on %s', v_mult / 100, lpad((v_mult % 100)::text, 2, '0'), t.name),
             jsonb_build_object('drop_id', v_id, 'host_id', adm.o_host, 'host_kind', adm.o_kind,
                                'table_version', t.version, 'slot', v_slot, 'multiplier_cents', v_mult, 'capped', v_mult < v_table_mult)) x;
  ELSE
    SELECT COALESCE(cm.chip_balance, 0) INTO v_member_after FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id = v_user LIMIT 1;
  END IF;

  -- ── 4. the pool remembers ──────────────────────────────────────────────────
  UPDATE public.diamond_game_pools
     SET rounds = rounds + 1,
         intake_diamonds = intake_diamonds + p_bet_diamonds,
         chips_paid = chips_paid + v_payout,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < LEAST(t.max_multiplier_cents, (adm.o_cfg).max_multiplier_cents) THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'plinko'
   RETURNING * INTO pool;
  v_intake_chips := round(pool.intake_diamonds::numeric / adm.o_rate, 2);
  IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_plinko_drop: chips_paid % would exceed the chips taken in % + allowance % - the cap was bypassed',
      pool.chips_paid, v_intake_chips, (adm.o_cfg).exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  UPDATE public.diamond_game_commits SET consumed_by = v_id WHERE id = p_commit_id;

  INSERT INTO public.plinko_drops
    (id, host_id, host_kind, club_id, user_id, table_version, bet_diamonds, bet_chips, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, hmac_hex, path_bits, slot,
     table_multiplier_cents, cap_multiplier_cents, multiplier_cents, capped, payout_chips, chips_minted,
     pool_chips_minted_after, pool_chips_paid_after, diamonds_after, member_chips_after, is_fixture)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, t.version, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, encode(v_hmac, 'hex'), v_path, v_slot,
     v_table_mult, v_cap, v_mult, v_mult < v_table_mult, v_payout, 0,
     pool.chips_minted, pool.chips_paid, v_dia_after, v_member_after, adm.o_fixture)
  RETURNING * INTO d;
  RETURN public.fn_plinko_drop_result(d);
END $function$;


-- ── 7. crash: the round starts ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_crash_start(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet_diamonds integer, p_auto_cashout_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  prior public.crash_rounds;
  adm record;
  v_id uuid := gen_random_uuid();
  v_hmac bytea; v_roll numeric; v_crash bigint; v_cap integer;
  v_reserve numeric; v_deduct jsonb; v_dia_after numeric; v_member_chips numeric;
  v_intake_chips numeric;
  pool public.diamond_game_pools%ROWTYPE;
  r public.crash_rounds;
BEGIN
  -- A SIGNED-OUT CALLER IS NOT A PLAYER (2026-09-09).
  --
  -- This RPC is granted to `anon`, and it had no sign-in guard while its
  -- siblings (fn_wheel_commit, fn_wheel_spin, fn_wheel_set_config) all do. On
  -- its own that is only defence in depth - but the ownership check below read
  -- `user_id IS DISTINCT FROM v_user`, and with v_user NULL that comparison is NULL, which is
  -- not TRUE, so the refusal did not fire and execution fell through to return
  -- the round. A logged-out caller holding a commit_id could read another
  -- player's result. Three-valued logic, in a money game. Every such
  -- comparison in this body is now IS DISTINCT FROM as well.
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  SELECT * INTO prior FROM public.crash_rounds WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Round Belongs To Another Player');
    END IF;
    RETURN public.fn_crash_round_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO adm FROM public.fn_diamond_game_admit('crash', p_club_id, p_commit_id, p_client_seed, p_bet_diamonds);
  IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;

  -- One open round per player per host: finish it first (a refresh resumes it).
  SELECT * INTO prior FROM public.crash_rounds c WHERE c.host_id = adm.o_host AND c.user_id = v_user AND c.status = 'open'
   ORDER BY c.started_at DESC LIMIT 1;
  IF prior.id IS NOT NULL THEN
    RETURN public.fn_crash_round_result(prior) || jsonb_build_object('resumed', true);
  END IF;

  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, (adm.o_cfg).max_multiplier_cents);
  IF v_cap < 101 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Club Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet',
                              'cap_cents', v_cap);
  END IF;
  IF p_auto_cashout_cents IS NOT NULL AND (p_auto_cashout_cents < 101 OR p_auto_cashout_cents > v_cap) THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Auto Cash Out Must Be Between 1.01x And %s.%sx', v_cap / 100, lpad((v_cap % 100)::text, 2, '0')),
                              'cap_cents', v_cap);
  END IF;
  v_reserve := round(adm.o_bet_chips * v_cap / 100, 2);

  -- ── the roll: the crash point, sealed in the row ───────────────────────────
  v_hmac := extensions.hmac(convert_to(p_client_seed || ':' || adm.o_nonce::text, 'UTF8'),
                            convert_to((adm.o_commit).server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_crash := public.fn_crash_point_cents(v_roll);

  -- ── 1. the bet is paid for ─────────────────────────────────────────────────
  v_deduct := public.fn_diamond_game_take_bet(v_user, p_bet_diamonds, (adm.o_cfg).purchased_only, 'crash_bet',
                format('Diamond Crash Bet (%s Diamonds)', p_bet_diamonds),
                'crash:' || v_id::text,
                jsonb_build_object('round_id', v_id, 'club_id', p_club_id, 'host_id', adm.o_host, 'commit_id', p_commit_id),
                adm.o_owner,
                format('Diamond Crash Intake (%s Diamonds)', p_bet_diamonds));
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For That Bet', 'detail', v_deduct->>'error');
  END IF;

  -- ── 2. nothing is minted; the payout is reserved against the promo wallet ──
  UPDATE public.diamond_game_pools
     SET rounds = rounds + 1,
         intake_diamonds = intake_diamonds + p_bet_diamonds,
         reserved_chips = reserved_chips + v_reserve,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < (adm.o_cfg).max_multiplier_cents THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'crash'
   RETURNING * INTO pool;
  v_intake_chips := round(pool.intake_diamonds::numeric / adm.o_rate, 2);
  IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_crash_start: reserved % + paid % would exceed the chips taken in % + allowance % - the cap was bypassed',
      pool.reserved_chips, pool.chips_paid, v_intake_chips, (adm.o_cfg).exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  SELECT COALESCE(cm.chip_balance, 0) INTO v_member_chips FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user LIMIT 1;
  UPDATE public.diamond_game_commits SET consumed_by = v_id WHERE id = p_commit_id;

  INSERT INTO public.crash_rounds
    (id, host_id, host_kind, club_id, user_id, bet_diamonds, bet_chips, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, crash_cents, cap_cents, growth_k,
     auto_cashout_cents, reserved_chips, chips_minted, diamonds_after, member_chips_after, is_fixture, started_at)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, v_roll, v_crash, v_cap, (adm.o_cfg).growth_k,
     p_auto_cashout_cents, v_reserve, 0, v_dia_after, v_member_chips, adm.o_fixture, clock_timestamp())
  RETURNING * INTO r;
  RETURN public.fn_crash_round_result(r);
END $function$;


-- ── 8. crash: the round is decided ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_crash_decide(p_round crash_rounds, p_cashout boolean, p_by text)
 RETURNS crash_rounds
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  r public.crash_rounds := p_round;
  v_elapsed_ms bigint;
  v_now_cents integer;
  v_result text;          -- 'cashed' | 'crashed' | NULL (still open)
  v_at_cents integer;
  v_payout numeric := 0;
  v_bank_after numeric; v_member_after numeric;
  pool public.diamond_game_pools%ROWTYPE;
  cfg public.diamond_game_configs%ROWTYPE;
  v_intake_chips numeric;
BEGIN
  IF r.status <> 'open' THEN
    RETURN r;
  END IF;
  v_elapsed_ms := floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint;
  v_now_cents := public.fn_crash_multiplier_cents(r.growth_k, v_elapsed_ms, r.cap_cents);

  -- An auto target below the crash point is honoured the moment the curve
  -- passes it, whatever else happened since.
  IF r.auto_cashout_cents IS NOT NULL AND r.auto_cashout_cents < r.crash_cents AND v_now_cents >= r.auto_cashout_cents THEN
    v_result := 'cashed'; v_at_cents := r.auto_cashout_cents;
  -- The curve reached the cap before the crash point: cashed at the cap.
  ELSIF r.crash_cents >= r.cap_cents AND v_now_cents >= r.cap_cents THEN
    v_result := 'cashed'; v_at_cents := r.cap_cents;
  -- The curve reached the crash point: nothing.
  ELSIF v_now_cents >= r.crash_cents THEN
    v_result := 'crashed'; v_at_cents := NULL;
  ELSIF p_cashout THEN
    v_result := 'cashed'; v_at_cents := v_now_cents;
  ELSE
    RETURN r;
  END IF;

  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = r.host_id AND game = 'crash';
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = r.host_id AND game = 'crash' FOR UPDATE;

  IF v_result = 'cashed' THEN
    v_payout := round(r.bet_chips * v_at_cents / 100, 2);
    IF v_payout > r.reserved_chips THEN
      RAISE EXCEPTION 'fn_crash_decide: payout % exceeds the round''s reservation % (cap %)', v_payout, r.reserved_chips, r.cap_cents;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('crash', r.host_id, r.host_kind, r.club_id, r.user_id, v_payout,
             'crash-prize:' || r.id::text,
             format('Diamond Crash: cashed out at %s.%sx', v_at_cents / 100, lpad((v_at_cents % 100)::text, 2, '0')),
             jsonb_build_object('round_id', r.id, 'host_id', r.host_id, 'host_kind', r.host_kind,
                                'cashout_cents', v_at_cents, 'crash_cents', r.crash_cents, 'auto', r.auto_cashout_cents IS NOT NULL AND v_at_cents = r.auto_cashout_cents)) x;
  END IF;

  UPDATE public.diamond_game_pools
     SET chips_paid = chips_paid + v_payout,
         reserved_chips = reserved_chips - r.reserved_chips,
         updated_at = now()
   WHERE host_id = r.host_id AND game = 'crash'
   RETURNING * INTO pool;
  v_intake_chips := round(pool.intake_diamonds::numeric / public.fn_ca_bridge_rate(), 2);
  IF pool.chips_paid + pool.reserved_chips > v_intake_chips + cfg.exposure_allowance_chips + 0.000001 THEN
    RAISE EXCEPTION 'fn_crash_decide: chips_paid % + reserved % would exceed the chips taken in % + allowance % - the cap was bypassed',
      pool.chips_paid, pool.reserved_chips, v_intake_chips, cfg.exposure_allowance_chips;
  END IF;

  UPDATE public.crash_rounds
     SET status = v_result, settled_at = clock_timestamp(), settled_by = p_by,
         elapsed_ms = LEAST(v_elapsed_ms, 2147483647)::integer, cashout_cents = v_at_cents, payout_chips = v_payout,
         pool_chips_minted_after = pool.chips_minted, pool_chips_paid_after = pool.chips_paid,
         member_chips_after = COALESCE(v_member_after, member_chips_after)
   WHERE id = r.id
   RETURNING * INTO r;
  RETURN r;
END $function$;


-- ── 9. the wheel spins on the host's own money ────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
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
  v_dia_now      := v_price;
  v_intake_chips := round((pool.intake_diamonds + v_price)::numeric / v_rate, 2);
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
  IF v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's promo wallet and its owner's diamonds, locked ───────────────
  v_bank := public.fn_diamond_game_promo_lock(v_host, v_kind);
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      IF pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'promo_wallet', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
      IF v_owner_dia + v_price < seg.amount * v_mult THEN
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

  -- ── 1. the spin is paid for ────────────────────────────────────────────────
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
    RAISE EXCEPTION 'fn_wheel_spin: the spin price could not be credited to the host owner: %', v_credit->>'error';
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
      RAISE EXCEPTION 'fn_wheel_spin: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;

  -- ── 2. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin: the host promo wallet % is below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    -- THE PRIZE COMES OUT OF THE PROMO WALLET (Dan 2026-09-10). One journal row,
    -- written by the PROMO side so the leg names the column it left
    -- (union_wallets.promo_wallet, or clubs.promo_balance) and carries the
    -- balances either side of it; the member side stands down, so the movement
    -- is journaled once and not twice.
    PERFORM public.fn_ca_declare_ledger('wheel_prize', 'player_wallet',
              v_user, NULL, 'wheel-prize:' || v_spin_id::text, ARRAY['club_members']);
    IF v_kind = 'union' THEN
      UPDATE public.union_wallets SET promo_wallet = promo_wallet - v_prize_chips, updated_at = now()
       WHERE union_id = v_host AND COALESCE(promo_wallet, 0) >= v_prize_chips
       RETURNING promo_wallet INTO v_bank_after;
    ELSE
      UPDATE public.clubs SET promo_balance = promo_balance - v_prize_chips, updated_at = now()
       WHERE id = v_host AND COALESCE(promo_balance, 0) >= v_prize_chips
       RETURNING promo_balance INTO v_bank_after;
    END IF;
    IF v_bank_after IS NULL THEN
      RAISE EXCEPTION 'fn_wheel_spin: the host promo wallet refused the prize debit of %', v_prize_chips;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'wheel-prize:' || v_spin_id::text) THEN
      RAISE EXCEPTION 'fn_wheel_spin: the promo wallet moved but no prize leg was journaled for spin %', v_spin_id;
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + v_prize_chips, updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO v_member_after;
    IF v_member_after IS NULL THEN
      RAISE EXCEPTION 'fn_wheel_spin: the prize landed nowhere for % in club %', v_user, p_club_id;
    END IF;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    -- The autoskip is transaction-scoped and fn_ca_declare_ledger only sets it.
    -- Clear it here so a later balance write in the same transaction (a probe,
    -- a batch, a second spin) is journaled: left set, the next mint leg on
    -- this table would silently write no journal row (found by the rolled-back
    -- probe of 20260907233833: spin 2 in one transaction minted unjournaled).
    PERFORM set_config('app.ledger_autoskip_club_members', '', true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    IF v_kind = 'union' THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (v_host, p_club_id, 'promo_wallet', 'debit', v_prize_chips, v_bank_after, 'wheel_prize',
              format('Diamond Wheel prize, spin %s', v_spin_id), v_user);
    END IF;
    INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    VALUES (p_club_id, NULL, v_user, v_prize_chips, 'wheel_prize',
            format('Diamond Wheel: %s', v_pick.label),
            jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                               'segment_version', cfg.segment_version, 'ord', v_pick.ord),
            v_member_after);
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    -- The diamond prize is paid BY THE HOST'S OWNER, out of what the wheel took
    -- in (Dan 2026-09-10). Two transfer legs, one transaction; nothing is issued.
    PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,
              format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
  END IF;

  -- ── 4. the pool remembers ──────────────────────────────────────────────────
  UPDATE public.wheel_pools
     SET spins = spins + 1,
         intake_diamonds = intake_diamonds + v_price,
         chips_paid = chips_paid + v_prize_chips,
         diamond_float = diamond_float + v_dia_now - v_prize_dia,
         diamonds_paid = diamonds_paid + v_prize_dia,
         constrained_spins = constrained_spins + CASE WHEN jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
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
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after, is_fixture)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version, v_price, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after, v_is_fixture)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;


-- ── 10. the free spin is the host's to give ───────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wheel_free_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
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
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_free_spins%ROWTYPE;
  seg record; v_pick record; v_found boolean := false;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer; v_acc integer := 0;
  v_paid_today integer;
  v_credit jsonb; v_dia_after numeric; v_owner uuid;
  v_is_fixture boolean := false;
  v_spin_id uuid := gen_random_uuid();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- replay: a commit is spent once; the second call returns the first spin
  SELECT * INTO prior FROM public.wheel_free_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    RETURN public.fn_wheel_free_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- the host, locked: the day's pot is counted under this lock, so two spins
  -- cannot both squeeze through the last of it
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.free_spin_enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'There Is No Free Spin Here Today');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;
  IF EXISTS (SELECT 1 FROM public.wheel_free_spins f
              WHERE f.host_id = v_host AND f.user_id = v_user AND f.day = v_day) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You Have Had Today''s Free Spin. Another Comes Tomorrow');
  END IF;
  SELECT COALESCE(sum(f.outcome_amount), 0)::integer INTO v_paid_today
    FROM public.wheel_free_spins f WHERE f.host_id = v_host AND f.day = v_day AND NOT f.is_fixture;
  IF v_paid_today >= cfg.free_spin_daily_budget_diamonds THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Today''s Free Spins Are Gone. They Return Tomorrow');
  END IF;

  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;

  -- the roll: the same derivation as a paid spin, over the free table's weights
  SELECT sum(g.weight)::integer INTO v_total FROM public.wheel_free_segments g;
  IF COALESCE(v_total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Free Table Is Empty');
  END IF;
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_free_spins f WHERE f.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  FOR seg IN SELECT * FROM public.wheel_free_segments g ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_free_segments g ORDER BY g.ord DESC LIMIT 1;
  END IF;

  -- THE HOST PAYS FOR ITS OWN GENEROSITY (Dan 2026-09-10, the same ruling that
  -- gave the host the intake). A free spin used to mint promotional diamonds out
  -- of the platform's budget; now the host's owner pays it, as a transfer, from
  -- the same wallet the paid spins fill. Nothing is issued.
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;
  IF v_owner = v_user THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Free Spin');
  END IF;
  IF (SELECT COALESCE(p.diamonds, 0) FROM public.profiles p WHERE p.id = v_owner) < v_pick.amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Today''s Free Spins Are Gone. They Return Tomorrow');
  END IF;
  PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_pick.amount,
            format('Diamond Wheel: free spin, %s', v_pick.label), 'wheel:' || v_spin_id::text || ':free');
  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;

  INSERT INTO public.wheel_free_spins
    (id, host_id, host_kind, club_id, user_id, day, commit_id, server_seed_hash, server_seed, client_seed,
     nonce, roll, weight_total, outcome_ord, outcome_amount, diamonds_after, is_fixture)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, v_day, cm.id, cm.server_seed_hash, cm.server_seed, v_client,
     v_nonce, v_roll, v_total, v_pick.ord, v_pick.amount, v_dia_after, v_is_fixture)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_free_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;


-- ── 10b. and the free state says so before the plate is pressed ───────────
CREATE OR REPLACE FUNCTION public.fn_wheel_free_state(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_used boolean := false;
  v_paid_today integer := 0;
  v_spins_today integer := 0;
  v_segments jsonb;
  v_reason text := NULL;
  v_member boolean := false;
  v_owner uuid;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ord', g.ord, 'label', g.label, 'kind', 'diamonds',
                                               'amount', g.amount, 'weight', g.weight,
                                               'value_chips', round(g.amount::numeric / public.fn_ca_bridge_rate(), 4),
                                               'probability', round(g.weight::numeric / t.total, 6),
                                               'locked', false)
                            ORDER BY g.ord), '[]'::jsonb)
    INTO v_segments
    FROM public.wheel_free_segments g, (SELECT sum(weight) AS total FROM public.wheel_free_segments) t;

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.free_spin_enabled THEN
    v_reason := 'closed';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.wheel_free_spins f
                    WHERE f.host_id = v_host AND f.user_id = v_user AND f.day = v_day) INTO v_used;
    SELECT EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = v_user
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) INTO v_member;
  END IF;
  SELECT COALESCE(sum(f.outcome_amount), 0)::integer, count(*)::integer INTO v_paid_today, v_spins_today
    FROM public.wheel_free_spins f WHERE f.host_id = v_host AND f.day = v_day AND NOT f.is_fixture;
  IF v_reason IS NULL AND v_used THEN v_reason := 'used'; END IF;
  IF v_reason IS NULL AND v_paid_today >= COALESCE(cfg.free_spin_daily_budget_diamonds, 0) THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;
  -- THE HOST DOES NOT GIVE ITSELF A GIFT (2026-09-10). The free spin is paid by
  -- the host's owner now, so an owner spinning their own wheel would move nothing
  -- and still spend the day's spin. The page is told before the plate is offered.
  IF v_reason IS NULL AND v_user IS NOT NULL AND v_user = v_owner THEN v_reason := 'owner'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.free_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used_today', v_used,
    'pot_diamonds', COALESCE(cfg.free_spin_daily_budget_diamonds, 0),
    'pot_paid_today', v_paid_today,
    'spins_today', v_spins_today,
    'segments', v_segments,
    'day', v_day);
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_free_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_state(uuid) TO authenticated, service_role;


-- ── 11. what the player sees: the wheel ───────────────────────────────────

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
  -- The prizes come out of the host's PROMO WALLET and its owner's diamonds.
  v_bank  := public.fn_diamond_game_promo(v_host, v_kind);
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
      'promo_wallet_chips', v_bank, 'intake_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2),
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


-- ── 12. what the player sees: plinko and crash ────────────────────────────

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
  v_bank := public.fn_diamond_game_promo(v_host, v_kind);

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
      'promo_wallet_chips', v_bank,
      'headroom_chips', round(COALESCE(pool.intake_diamonds, 0)::numeric / v_rate, 2) + cfg.exposure_allowance_chips - COALESCE(pool.chips_paid, 0) - COALESCE(pool.reserved_chips, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round(COALESCE(pool.chips_paid, 0) / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'rounds_today', v_today, 'seconds_until_next', v_wait,
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;


-- ── 13. what the operator sees: the wheel ─────────────────────────────────

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
  v_bank := public.fn_diamond_game_promo(v_host, v_kind);

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
    'bank_chips', COALESCE(v_bank, 0),
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


-- ── 14. what the operator sees: plinko and crash ──────────────────────────

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
  v_bank := public.fn_diamond_game_promo(v_host, v_kind);

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
    'bank_chips', COALESCE(v_bank, 0),
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


-- ── 16. the door: diamonds to chips, from anywhere in the club ────────────


-- ── the one door: can this player turn diamonds into chips at this club? ──
--
-- Dan 2026-09-10: "when a player is out of chips or doesn't have enough to rebuy
-- into a tournament or rebuy into a cash game, they be prompted to play diamonds
-- to chips. there also needs to be a button for this inside the club lobby."
--
-- One read, cheap enough to sit behind a buy-in modal: which of the three games
-- this host has open, what a spin or a bet costs, what the player holds, and
-- whether today's free spin is still there. It answers for a union host and for
-- a standalone club alike, because fn_wheel_host already resolves both.
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

  IF v_wheel THEN
    SELECT COALESCE(w.free_spin_enabled, false)
       AND NOT EXISTS (SELECT 1 FROM public.wheel_free_spins f
                        WHERE f.host_id = v_host AND f.user_id = v_user AND f.day = v_day)
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
    'frozen', v_frozen);
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_games_entry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_games_entry(uuid) TO authenticated, service_role;


-- ── 16b. the profile guard admits the two doors that now pay an owner ─────
--
-- fn_guard_profile_privileged_columns allowlists the CALLER of a balance write,
-- by call stack. fn_wheel_spin and fn_wheel_free_spin are already named there.
-- Plinko and Crash were not, because until today they only DEDUCTED (through
-- deduct_diamonds, which is named) and never credited. They credit the host's
-- owner now, so they join the list the way the wheel and the arena doors did:
-- the live body patched in place, two lines added, nothing else touched.
CREATE FUNCTION pg_temp.hh_patch(p_fn text, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $hh$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'hh_patch: marker in % found % times', p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $hh$;
SELECT pg_temp.hh_patch('fn_guard_profile_privileged_columns',
$hh_from$     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'$hh_from$,
$hh_to$     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_plinko_drop[(]'
     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'$hh_to$);
DROP FUNCTION pg_temp.hh_patch(text, text, text);


-- ── 17. nothing mints any more ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.fn_diamond_game_mint_leg(uuid, text, numeric, text);

-- The two helpers that were dropped and recreated lose their grants with them.
REVOKE ALL ON FUNCTION public.fn_diamond_game_admit(text, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_admit(text, uuid, uuid, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_take_bet(uuid, integer, boolean, text, text, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_take_bet(uuid, integer, boolean, text, text, text, jsonb, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_owner(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_owner(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_promo(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_promo(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_promo_lock(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_promo_lock(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_game_pay_diamonds(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_pay_diamonds(uuid, uuid, integer, text, text) TO service_role;

-- Every door this migration re-created states its own grants, so nothing here
-- depends on a CREATE OR REPLACE preserving an ACL. The platform's autorevoke
-- trigger strips PUBLIC and anon from each of them on the way past, which is a
-- tightening: every one of these bodies already refuses a caller with no
-- account on its first line.
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_metrics(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_spin(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_plinko_drop(uuid, uuid, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_crash_start(uuid, uuid, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_metrics(uuid, text) TO authenticated, service_role;

-- ── 18. the migration refuses to commit unless the shape is what it says ───
DO $$
DECLARE v_res jsonb; v_def text;
BEGIN
  -- Nothing mints.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_diamond_game_mint_leg') THEN
    RAISE EXCEPTION 'the host is the house: fn_diamond_game_mint_leg is still here';
  END IF;
  FOR v_def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN ('fn_wheel_spin', 'fn_plinko_drop', 'fn_crash_start') LOOP
    IF v_def LIKE '%issuance_reserve%' OR v_def LIKE '%fn_diamond_game_mint_leg%' THEN
      RAISE EXCEPTION 'the host is the house: a game still mints';
    END IF;
    IF v_def LIKE '%chip_treasury = chip_treasury -%' OR v_def LIKE '%chip_balance = chip_balance -%' THEN
      RAISE EXCEPTION 'the host is the house: a game still pays out of the host bank';
    END IF;
  END LOOP;

  -- Every payout names the promo wallet.
  IF pg_get_functiondef('public.fn_diamond_game_prize_leg(text,uuid,text,uuid,uuid,numeric,text,text,jsonb)'::regprocedure)
       NOT LIKE '%promo_balance = COALESCE(promo_balance, 0) - p_amount%' THEN
    RAISE EXCEPTION 'the host is the house: the payout leg does not spend the club promo wallet';
  END IF;
  IF pg_get_functiondef('public.fn_diamond_game_prize_leg(text,uuid,text,uuid,uuid,numeric,text,text,jsonb)'::regprocedure)
       NOT LIKE '%promo_wallet = COALESCE(promo_wallet, 0) - p_amount%' THEN
    RAISE EXCEPTION 'the host is the house: the payout leg does not spend the union promo wallet';
  END IF;

  -- Every intake names the owner.
  IF pg_get_functiondef('public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)'::regprocedure)
       NOT LIKE '%add_diamonds_to_balance(p_owner, p_bet%' THEN
    RAISE EXCEPTION 'the host is the house: the bet leg does not pay the owner';
  END IF;

  -- The guard names every door that now pays an owner.
  v_def := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  IF v_def NOT LIKE '%fn_plinko_drop[(]%' OR v_def NOT LIKE '%fn_crash_start[(]%'
     OR v_def NOT LIKE '%fn_wheel_spin[(]%' OR v_def NOT LIKE '%fn_wheel_free_spin[(]%' THEN
    RAISE EXCEPTION 'the host is the house: the profile guard does not name every door';
  END IF;

  -- Both new doors refuse a caller with no account.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_res := public.fn_diamond_games_entry('00000000-0000-0000-0000-000000000000'::uuid);
  IF (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION 'the host is the house: the entry read answered a caller with no account: %', v_res;
  END IF;
END $$;

COMMIT;
