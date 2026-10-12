-- 20261007112751_the_cash_rake_leaves_custody_without_a_wallet_journal_row.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- THE DEFECT, READ FROM ROWS ON 2026-10-07 (11:22 UTC)
-- ============================================================================
--
-- fn_ca_diamond_sweep_cash_rake (20261005183028, scheduled hourly at :14 by
-- 20261007034146, first run 05:14 UTC) wrote ONE NEGATIVE diamond_transactions
-- row per payer per sweep:
--
--     INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,...)
--     VALUES (v_p.user_id,'cash_rake','cash_rake',-v_p.amount::integer,v_wallet, ...)
--
-- and, by its own comment, did not touch profiles.diamonds, because the rake
-- never sat in the wallet: fn_poker_diamond_settle_cash_hand takes it from the
-- payer's arena custody into ca_diamond_rake_accrual, and the player's
-- arena_withdraw (cash-out) row is smaller by exactly that rake. The rake was
-- therefore written into the player's journal TWICE: once inside the smaller
-- cash-out, and again as the cash_rake row. The wallet journal is the record
-- that explains profiles.diamonds; a row in it that moves no balance breaks
-- that, and every Spent figure read from it is overstated.
--
-- Measured: 13 wallets (all horses, CLAUDE.md 10.5: they are players and are
-- treated exactly so) whose SUM(diamond_transactions.amount) sits 4,460 below
-- profiles.diamonds, which is exactly -SUM(amount) of the 46 cash_rake rows
-- from 6 sweeps (05:14 to 10:14 UTC). That drift was 0 after 20260930055147
-- and grew every hour the sweep found rake. The same rows also allocated
-- 2,386 Diamonds of phantom spend against Lifetime VIP diamond lots
-- (trg_allocate_lifetime_vip_diamond_spend fires on every negative journal row).
--
-- ============================================================================
-- THE DESIGN (what the rake row was for, and where it belongs)
-- ============================================================================
--
-- The row existed to drive the Mint register: trg_ca_diamond_register_follows_journal
-- turns a negative journal row into a player-holder 'burn' in ca_mint_ledger,
-- and the sweep then asserts the register retired exactly the swept total from
-- the payers (design R2) before minting it to ca_diamond_house (R4). The REGISTER
-- burn is right: the register counts custody Diamonds as still the player's
-- (arena doors are not followed, fn_ca_diamond_journal_origin), so the rake has
-- to be retired from the payer there. The WALLET JOURNAL row was the wrong
-- carrier for it.
--
-- So: the sweep now writes the player-holder burn into ca_mint_ledger itself,
-- exactly as fn_ca_mint and the tournament fee write their own register rows,
-- with op_id 'poker-cash-rake-sweep:<sweep>:<user>', balance_before =
-- balance_after = the untouched wallet, and no diamond_transactions row at all.
-- Rake revenue keeps its own records where it belongs: per hand and per payer
-- in ca_diamond_rake_accrual (stamped with sweep_id), one house mint per sweep
-- in ca_mint_ledger, and ca_diamond_house's balance. The retired-from-players
-- assertion and the identity assertion are unchanged in meaning; the former now
-- reads the burns by op_id instead of through journal ids.
--
-- Rejected: splitting the cash-out into gross + rake. The rake is taken per
-- hand and swept per hour, while a cash-out happens once per session, possibly
-- before or after any given sweep; attributing an hour's rake to a cash-out row
-- that may not exist yet would re-create the timing problem in a new place.
--
-- ============================================================================
-- THE OTHER TWO DEFINITIONS IN THIS FILE
-- ============================================================================
--
-- fn_diamond_kind_bucket. 'mint' moved from 'purchases' ("Diamonds You Bought")
-- to 'bonuses'. Read 2026-10-07: 1,857 'mint' rows, 2,758,000 Diamonds, every
-- one a signup grant, a Lifetime VIP monthly benefit or a horse bankroll; no
-- purchase has ever been journalled as 'mint' (purchases write 'purchase').
-- 'cash_rake_correction' (the settlement rows of 20261007112808) is named in
-- 'adjustments' so it never falls through to Other. Nothing else changes;
-- restated byte for byte from 20261005183028 otherwise.
--
-- fn_ca_mint_wallet_attribution. register_drifts went from 0 to 29 today. Read
-- per wallet: in all 29, held = register chain end + SUM(amount) of the
-- journal rows written after the last register row, and every one of those
-- rows is an arena_deposit or arena_withdraw. The arena doors are not followed
-- BY DESIGN (fn_ca_diamond_journal_origin returns NULL for them, 2026-09-08:
-- a buy-in moves the player's own Diamonds and issues or retires none), so a
-- stale chain end after an arena leg is not a register defect; the verdict was
-- reading the design as drift. The verdict now carries the chain forward over
-- the journal rows the register does not follow by design (origin NULL), and
-- still reports a drift for any row the register SHOULD have followed. No
-- money moves to make the number tidy. Same signature, same columns.
--
-- One transaction (production DDL policy rule 1). Never inside :50-:03 UTC.
--
-- @live-proof: (SELECT position('diamond_transactions' IN pg_get_functiondef('public.fn_ca_diamond_sweep_cash_rake(text)'::regprocedure)) = 0)
-- @live-proof: (SELECT bucket = 'bonuses' FROM public.fn_diamond_kind_bucket('mint','mint','the_mint',500::bigint))

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE SWEEP RETIRES THE RAKE IN THE REGISTER, NOT IN THE WALLET JOURNAL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_sweep_cash_rake(p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_destination text;
  v_sweep uuid := gen_random_uuid();
  v_key text;
  v_total bigint := 0;
  v_rows bigint := 0;
  v_payers bigint := 0;
  v_p record;
  v_wallet bigint;
  v_label text;
  v_burned numeric;
  v_before numeric;
  v_after numeric := NULL;
  v_supply numeric;
  v_diff numeric;
  v_ids bigint[];
BEGIN
  v_destination := public.fn_ca_diamond_economic_text('cash_rake_destination','all');
  v_key := 'poker-cash-rake-sweep:'||v_sweep::text;

  -- Take the unswept rows under lock, oldest first. A second sweep running
  -- beside this one waits here and then finds nothing unswept, so the same
  -- Diamond is never swept twice.
  SELECT COALESCE(array_agg(s.id ORDER BY s.id), ARRAY[]::bigint[]) INTO v_ids FROM (
    SELECT a.id FROM public.ca_diamond_rake_accrual a
     WHERE a.swept_at IS NULL AND a.kind='rake'
     ORDER BY a.id
     FOR UPDATE OF a
  ) s;

  SELECT COALESCE(sum(amount),0), count(*), count(DISTINCT user_id)
    INTO v_total, v_rows, v_payers
    FROM public.ca_diamond_rake_accrual WHERE id = ANY(v_ids);
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok',true,'amount',0,'rows',0,'destination',v_destination,
                              'sweep_id',v_sweep,'nothing_to_sweep',true);
  END IF;

  -- ONE REGISTER BURN PER PAYER PER SWEEP, AND NO WALLET JOURNAL ROW
  -- (20261007112751). The rake never sat in profiles.diamonds: it left the
  -- payer's arena custody when the hand settled, and the payer's cash-out is
  -- smaller by exactly that much, so the wallet journal already explains it.
  -- A wallet journal row here would record it a second time and leave
  -- the journal unable to explain the balance (13 wallets, 4,460 Diamonds, the
  -- first six sweeps). The register still retires it from the payer, which is
  -- the first half of R2: the register counts custody Diamonds as the player's.
  SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply
    FROM public.ca_mint_ledger WHERE asset='diamonds';
  FOR v_p IN SELECT user_id, sum(amount) AS amount FROM public.ca_diamond_rake_accrual
              WHERE id = ANY(v_ids) GROUP BY user_id ORDER BY user_id LOOP
    SELECT COALESCE(diamonds,0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
      INTO v_wallet, v_label FROM public.profiles WHERE id=v_p.user_id;
    v_supply := v_supply - v_p.amount;
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason)
    VALUES
      (v_key||':'||v_p.user_id::text, 'burn', 'diamonds', 'player', v_p.user_id,
       COALESCE(v_label, v_p.user_id::text), v_p.amount,
       COALESCE(v_wallet,0), COALESCE(v_wallet,0), v_supply,
       'Diamond cash-game rake retired from this player''s arena custody for the house ('
       ||COALESCE(p_reason,'cash rake sweep')||'). The wallet does not move: the rake left with the table stack.');
  END LOOP;

  -- THE REGISTER MUST HAVE RETIRED EXACTLY WHAT WE SWEPT, from the players
  -- themselves. The same assertion fn_poker_diamond_tournament_settle_fee makes
  -- about its fee, for the same reason: a crossing that only half happened is a
  -- supply break, and it is cheaper to refuse the sweep than to find it later.
  SELECT COALESCE(sum(m.amount),0) INTO v_burned FROM public.ca_mint_ledger m
   WHERE m.asset='diamonds' AND m.action='burn' AND m.holder_type='player'
     AND m.op_id LIKE v_key||':%';
  IF v_burned IS DISTINCT FROM v_total::numeric THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_retired_from_players (% of %)', v_burned, v_total
      USING ERRCODE='P0404';
  END IF;

  IF v_destination = 'ca_diamond_house' THEN
    -- ONE HOUSE WRITE FOR THE WHOLE SWEEP (R4). This is the only place a
    -- Diamond cash rake locks ca_diamond_house row 1.
    INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    SELECT COALESCE(balance,0) INTO v_before FROM public.ca_diamond_house WHERE id=1 FOR UPDATE;
    UPDATE public.ca_diamond_house SET balance=COALESCE(balance,0)+v_total, updated_at=now()
      WHERE id=1 RETURNING balance INTO v_after;
    SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply
      FROM public.ca_mint_ledger WHERE asset='diamonds';
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason)
    VALUES
      (v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_total, v_before, v_after,
       v_supply+v_total,
       'Diamond cash-game rake banked to the house from the players'' contributions ('
       ||v_rows::text||' hand legs, '||v_payers::text||' payers), B11');
  ELSIF v_destination <> 'retired_from_supply' THEN
    RAISE EXCEPTION 'diamond_cash_rake_destination_has_no_storage:%', v_destination
      USING ERRCODE='22023';
  END IF;

  UPDATE public.ca_diamond_rake_accrual a
     SET swept_at=now(), sweep_id=v_sweep
   WHERE a.id = ANY(v_ids);

  -- THE IDENTITY IS WHOLE AFTERWARDS. Players unchanged, the arena float down by
  -- the swept amount, the house up by it, and the register's two legs cancel.
  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole after the cash rake sweep (difference %)', v_diff
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object('ok',true,'amount',v_total,'rows',v_rows,'payers',v_payers,
                            'destination',v_destination,'sweep_id',v_sweep,
                            'house_balance_after',v_after);
END $function$;

COMMENT ON FUNCTION public.fn_ca_diamond_sweep_cash_rake(text) IS
  'Sweeps unswept Diamond cash rake (ca_diamond_rake_accrual) to its destination: one player-holder register burn per payer (no wallet journal row: the rake left with the table stack and the cash-out already reflects it), one house mint for the whole sweep, rows stamped, identity asserted. 20261007112751.';

REVOKE ALL ON FUNCTION public.fn_ca_diamond_sweep_cash_rake(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_sweep_cash_rake(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. THE ATTRIBUTION VERDICT CARRIES THE CHAIN OVER WHAT THE REGISTER DOES NOT
--    FOLLOW BY DESIGN.
--
--    Byte-identical to the live definition except base.carried and the
--    agreeing_end test, marked CHANGED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_mint_wallet_attribution(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(user_id uuid, held numeric, register_net numeric, unattributed_opening_stock numeric, register_chain_end numeric, journal_rows_since_last_register bigint, verdict text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH scope AS (
    SELECT p.id, COALESCE(p.diamonds, 0)::numeric AS held
      FROM public.profiles p
     WHERE p_user_id IS NULL OR p.id = p_user_id
  ),
  last_reg AS (
    SELECT m.holder_id, max(m.created_at) AS at
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id
  ),
  net AS (
    SELECT m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS n
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id
  ),
  pre AS (
    SELECT s.id, s.held, COALESCE(n.n, 0) AS register_net,
           (lr.holder_id IS NOT NULL) AS tracked, lr.at AS last_reg_at,
           -- CHANGED 20261007112751. The journal movement after the chain's
           -- last instant that the register does not follow BY DESIGN
           -- (fn_ca_diamond_journal_origin returns NULL: the arena doors,
           -- player-to-player transfers, journal backfills, the Mint's and the
           -- seed door's own rows). A buy-in after a wallet's last register
           -- row moved its balance and was never meant to move its chain.
           -- Computed only when the chain does not already end at holdings.
           CASE WHEN lr.holder_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                                  WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
                                    AND m.holder_id = s.id AND m.created_at = lr.at
                                    AND m.balance_after = s.held)
                THEN (SELECT COALESCE(SUM(t.amount), 0) FROM public.diamond_transactions t
                       WHERE t.user_id = s.id AND t.created_at > lr.at
                         AND public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source,
                                                                 t.issuance_class, t.amount) IS NULL)
                ELSE 0 END AS carried
      FROM scope s
      LEFT JOIN last_reg lr ON lr.holder_id = s.id
      LEFT JOIN net n ON n.holder_id = s.id
  ),
  base AS (
    SELECT p.id, p.held, p.register_net, p.tracked, p.last_reg_at,
           -- The reading at the wallet's latest register instant that AGREES
           -- with holdings, if there is one. Several rows can share one
           -- created_at (one transaction claiming many rewards), so
           -- ORDER BY created_at DESC LIMIT 1 picks arbitrarily among them,
           -- and that is what made an earlier reading of this report 38 false
           -- drifts. Read the chain by value. CHANGED 20261007112751: the
           -- chain is carried forward over the unfollowed-by-design movement.
           (SELECT m.balance_after FROM public.ca_mint_ledger m
             WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND m.holder_id = p.id
               AND m.created_at = p.last_reg_at AND m.balance_after + p.carried = p.held LIMIT 1) AS agreeing_end
      FROM pre p
  )
  SELECT b.id,
         b.held,
         b.register_net,
         b.held - b.register_net,
         CASE WHEN NOT b.tracked THEN NULL
              ELSE COALESCE(b.agreeing_end,
                     (SELECT max(m.balance_after) FROM public.ca_mint_ledger m
                       WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
                         AND m.holder_id = b.id AND m.created_at = b.last_reg_at)) END,
         -- Counted ONLY where it is diagnostic, which is a drifting wallet.
         -- Counting it for all 1,427 cost 5.1 of this read's 5.6 seconds and
         -- told nobody anything: a wallet whose chain already ends at its
         -- holdings has no unfollowed movement to find. NULL means not
         -- counted, not zero.
         CASE WHEN b.tracked AND b.agreeing_end IS NULL
              THEN (SELECT count(*) FROM public.diamond_transactions t
                     WHERE t.user_id = b.id AND t.created_at > b.last_reg_at) END,
         CASE WHEN NOT b.tracked THEN 'opening_stock_only'
              WHEN b.agreeing_end IS NOT NULL THEN 'register_agrees'
              ELSE 'register_drifts' END
    FROM base b;
$function$;

-- Operator telemetry: exactly the grants production already has.
REVOKE ALL ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_wallet_attribution(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. A MINT GRANT IS NOT A PURCHASE. Restated from 20261005183028 with the
--    three lines marked 20261007112751/20261007112808 changed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket(
    p_type             text,
    p_transaction_type text,
    p_source           text,
    p_amount           bigint
)
RETURNS TABLE (kind text, bucket text, label text)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
    WITH resolved AS (
        SELECT LOWER(COALESCE(
            NULLIF(BTRIM(p_transaction_type), ''),
            CASE WHEN LOWER(COALESCE(p_type, '')) IN ('spend', 'earn', 'credit', 'debit')
                 THEN NULLIF(BTRIM(p_source), '') END,
            NULLIF(BTRIM(p_type), ''),
            ''
        )) AS k
    ),
    bucketed AS (
        SELECT k, CASE
            -- ── SPENT (amount < 0): exact kinds first ──────────────────────
            WHEN p_amount < 0 AND k IN ('arena_deposit', 'tournament_fee')                 THEN 'arena'
            WHEN p_amount < 0 AND k = 'cash_rake'                                          THEN 'arena_rake'
            WHEN p_amount < 0 AND k IN ('diamond_gift_sent', 'live_gift_sent')             THEN 'gifts_sent'
            WHEN p_amount < 0 AND k = 'transfer'                                           THEN 'transfers'
            WHEN p_amount < 0 AND k IN ('chip_purchase', 'chip_mint')                      THEN 'club_chips'
            WHEN p_amount < 0 AND k IN ('plinko_drop', 'crash_bet', 'wheel_spin', 'pvp_stake',
                                        'game_cost', 'arcade_entry', 'memory_game', 'trivia_entry',
                                        'trivia_arcade', 'trivia_lifeline', 'training_entry',
                                        'tournament_entry', 'daily_challenge_reroll',
                                        'diamond_game', 'daily_bonus_spin')                THEN 'games'
            WHEN p_amount < 0 AND k IN ('feature_purchase', 'feature_unlock', 'video_unlock',
                                        'streak_freeze', 'throwable_purchase', 'cosmetic_purchase',
                                        'card_slide_purchase', 'deduction')                THEN 'store'
            WHEN p_amount < 0 AND k IN ('refund', 'stripe_refund', 'chargeback', 'debt_settlement') THEN 'purchase_refunds'
            WHEN p_amount < 0 AND k IN ('adjustment', 'reconciliation', 'burn', 'admin', 'admin_grant',
                                        'seeded', 'bridge', 'house')                       THEN 'adjustments'
            -- ── SPENT: patterns second ─────────────────────────────────────
            WHEN p_amount < 0 AND k LIKE '%vip%'                                           THEN 'vip'
            WHEN p_amount < 0 AND k LIKE '%arena%'                                         THEN 'arena'
            WHEN p_amount < 0 AND k LIKE '%gift%'                                          THEN 'gifts_sent'
            WHEN p_amount < 0 AND k LIKE '%chip%'                                          THEN 'club_chips'
            WHEN p_amount < 0 AND (k LIKE '%refund%' OR k LIKE '%chargeback%' OR k LIKE '%debt%') THEN 'purchase_refunds'
            WHEN p_amount < 0 AND (k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%burn%'
                                   OR k LIKE '%admin%')                                    THEN 'adjustments'
            WHEN p_amount < 0 AND (k LIKE '%purchase%' OR k LIKE '%unlock%' OR k LIKE '%feature%'
                                   OR k LIKE '%throwable%' OR k LIKE '%cosmetic%' OR k LIKE '%avatar%'
                                   OR k LIKE '%theme%' OR k LIKE '%video%' OR k LIKE '%freeze%'
                                   OR k LIKE '%slide%')                                    THEN 'store'
            WHEN p_amount < 0 AND (k LIKE '%bet%' OR k LIKE '%spin%' OR k LIKE '%stake%'
                                   OR k LIKE '%game%' OR k LIKE '%arcade%' OR k LIKE '%trivia%'
                                   OR k LIKE '%training%' OR k LIKE '%entry%' OR k LIKE '%reroll%') THEN 'games'
            WHEN p_amount < 0                                                              THEN 'other_spent'
            -- ── EARNED (amount > 0): exact kinds first ─────────────────────
            WHEN k IN ('arena_withdraw', 'arena')                                          THEN 'arena_cash_outs'
            WHEN k IN ('diamond_gift_received', 'live_gift_received')                      THEN 'gifts_received'
            WHEN k = 'transfer'                                                            THEN 'transfers'
            WHEN k IN ('union_grant', 'club_grant')                                        THEN 'grants'
            WHEN k IN ('diamond_purchase', 'purchase', 'purchased', 'stripe_purchase',
                       'store_purchase', 'purchase_clearing')                              THEN 'purchases'
            WHEN k IN ('daily_login', 'daily_bonus', 'daily_bonus_boost', 'daily_challenge_claim',
                       'daily_mission_milestone', 'daily_trivia_challenge', 'daily_trivia',
                       'streak_reward', 'streak_diamonds', 'challenge', 'achievement',
                       'hand_of_the_day', 'gto_chart_study', 'training_reward',
                       'training_level_complete', 'first_training_session', 'trivia_run',
                       'trivia_reward', 'trivia_daily_bonus',
                       'game_reward', 'reward_diamonds', 'bonus_diamonds', 'prize_diamonds') THEN 'rewards'
            WHEN k IN ('signup_bonus', 'bonus', 'promotional', 'promo', 'promo_code',
                       'promo_purchased', 'easter_egg', 'birthday', 'first_purchase',
                       'referral', 'referral_bonus', 'referral_qualified', 'referral_referee',
                       'referral_vip_conversion', 'welcome_spin',
                       -- A Mint grant is never a purchase (20261007112751): every
                       -- 'mint' journal row is a signup grant, a Lifetime VIP
                       -- monthly benefit or a horse bankroll. A purchase writes
                       -- 'purchase'.
                       'mint')                                                             THEN 'bonuses'
            WHEN k IN ('tournament_prize', 'pvp_win', 'pvp_prize', 'pvp_match_win', 'crash_win',
                       'plinko_win', 'trivia_pvp_match', 'wheel_prize', 'trivia_prize_wheel',
                       'diamond_game_prize')                                              THEN 'winnings'
            WHEN k IN ('vip_reward', 'vip_stipend', 'vip_daily', 'vip_monthly', 'vip_bonus') THEN 'vip_bonuses'
            WHEN k IN ('social_post', 'follow', 'reaction', 'comment', 'strategy_comment', 'share',
                       'share_content', 'profile_complete', 'profile_pic', 'video_watch',
                       'video_favorite', 'hendonmob_link', 'venue_review', 'email_verified',
                       'phone_verified')                                                   THEN 'social'
            WHEN k IN ('refund', 'pvp_refund', 'pvp_tie_refund', 'diamond_gift_refund', 'diamond_refund',
                       'tournament_cancel_refund', 'tournament_entry_refund')              THEN 'refunds'
            WHEN k IN ('adjustment', 'reconciliation', 'admin', 'admin_grant', 'seeded', 'bridge',
                       'house',
                       -- The settlement of the 46 cash_rake rows that moved no
                       -- wallet (20261007112808).
                       'cash_rake_correction')                                             THEN 'adjustments'
            -- ── EARNED: patterns second ────────────────────────────────────
            WHEN k LIKE '%refund%'                                                         THEN 'refunds'
            WHEN k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%admin%'              THEN 'adjustments'
            WHEN k LIKE '%arena%'                                                          THEN 'arena_cash_outs'
            WHEN k LIKE '%gift%'                                                           THEN 'gifts_received'
            WHEN k LIKE '%grant%'                                                          THEN 'grants'
            WHEN k LIKE '%vip%'                                                            THEN 'vip_bonuses'
            WHEN k LIKE '%purchase%'                                                       THEN 'purchases'
            WHEN k LIKE '%prize%' OR k LIKE '%win%'                                        THEN 'winnings'
            WHEN k LIKE '%promo%' OR k LIKE '%referral%' OR k LIKE '%bonus%'               THEN 'bonuses'
            WHEN k LIKE '%daily%' OR k LIKE '%reward%' OR k LIKE '%challenge%'
                 OR k LIKE '%mission%' OR k LIKE '%streak%' OR k LIKE '%training%'
                 OR k LIKE '%trivia%'                                                      THEN 'rewards'
            WHEN k LIKE '%social%' OR k LIKE '%profile%' OR k LIKE '%video%'
                 OR k LIKE '%verified%' OR k LIKE '%share%' OR k LIKE '%comment%'          THEN 'social'
            ELSE 'other_earned'
        END AS bucket
        FROM resolved
    )
    SELECT k AS kind, bucket, CASE bucket
            WHEN 'arena'            THEN 'Diamond Arena Seats'
            WHEN 'arena_rake'       THEN 'Diamond Arena Rake'
            WHEN 'gifts_sent'       THEN 'Gifts To Friends'
            WHEN 'transfers'        THEN 'Transfers'
            WHEN 'vip'              THEN 'VIP Membership'
            WHEN 'club_chips'       THEN 'Club Chip Purchases'
            WHEN 'games'            THEN 'Games And Arcade'
            WHEN 'store'            THEN 'Store Items And Perks'
            WHEN 'purchase_refunds' THEN 'Refunded Purchases'
            WHEN 'adjustments'      THEN 'Adjustments'
            WHEN 'other_spent'      THEN 'Other'
            WHEN 'arena_cash_outs'  THEN 'Diamond Arena Cash-Outs'
            WHEN 'gifts_received'   THEN 'Gifts From Friends'
            WHEN 'grants'           THEN 'Union And Club Grants'
            WHEN 'purchases'        THEN 'Diamonds You Bought'
            WHEN 'rewards'          THEN 'Daily Rewards And Challenges'
            WHEN 'bonuses'          THEN 'Bonuses And Promotions'
            WHEN 'winnings'         THEN 'Prizes And Winnings'
            WHEN 'vip_bonuses'      THEN 'VIP Bonuses'
            WHEN 'social'           THEN 'Social And Community'
            WHEN 'refunds'          THEN 'Refunds'
            ELSE 'Other'
        END AS label
    FROM bucketed;
$fn$;


COMMENT ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) IS
  'Resolves a diamond_transactions row (type, transaction_type, source, amount) to its kind, a spend/earn bucket and a player-facing label. Every kind a writer can produce is named exactly (2026-09-14 inventory of 24 writers, the reward catalog and the Mint register; 2026-09-20 the Diamond Games: diamond_game, daily_bonus_spin, the transfer kind their payouts and host intakes carry, and the bare deduction kind the Diamond Spins perks - throwables, time bank, rabbit hunt - are charged under; 2026-10-07 mint is a bonus, never a purchase); patterns second, Other last, so no row vanishes. ONE place, so both wallets bucket identically. DIAMONDS ONLY: club_chips is a chip purchase in a member club; the Diamond Arena has no chips.';

REVOKE ALL ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. PROOF, IN THIS TRANSACTION.
-- ---------------------------------------------------------------------------
DO $proof$
DECLARE r record; v_src text; v_diff numeric;
BEGIN
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('mint','mint','the_mint',500::bigint);
  IF r.bucket IS DISTINCT FROM 'bonuses' THEN
    RAISE EXCEPTION 'a Mint grant buckets as %, not bonuses', r.bucket;
  END IF;
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('purchase','purchase','stripe',500::bigint);
  IF r.bucket IS DISTINCT FROM 'purchases' THEN
    RAISE EXCEPTION 'a purchase buckets as %, not purchases', r.bucket;
  END IF;
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('cash_rake','cash_rake','poker_arena',-10::bigint);
  IF r.bucket IS DISTINCT FROM 'arena_rake' THEN
    RAISE EXCEPTION 'a cash_rake row buckets as %, not arena_rake', r.bucket;
  END IF;
  SELECT * INTO r FROM public.fn_diamond_kind_bucket('cash_rake_correction','cash_rake_correction','journal_backfill',10::bigint);
  IF r.bucket IS DISTINCT FROM 'adjustments' THEN
    RAISE EXCEPTION 'a cash rake correction buckets as %, not adjustments', r.bucket;
  END IF;

  v_src := pg_get_functiondef('public.fn_ca_diamond_sweep_cash_rake(text)'::regprocedure);
  IF position('diamond_transactions' IN v_src) > 0 THEN
    RAISE EXCEPTION 'the sweep still names diamond_transactions';
  END IF;

  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole (difference %)', v_diff;
  END IF;
  RAISE NOTICE 'sweep journals nothing; mint is a bonus; identity 0';
END
$proof$;

COMMIT;
