-- 20260908031918_transfers_are_off_gifts_are_atomic_and_the_waivers_are_gone.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-RULINGS.md rulings 4 and 12; Diamond Accounting
-- Standard D6; docs/changelog/2026-09-08-diamond-transfers-and-gifts.md):
--
--   Ruling 4 closed the diamond loop: player-to-player wallet transfers are OFF (0 uses ever in
--   production), the stream gift stays as the one social transfer, and it goes through
--   send_stream_gift only - both legs in one transaction, journaled, capped. Ruling 12 takes the
--   hard-coded KINGFISH uuid out of the cap check: an exempt account is a row in a table Dan
--   owns, with a reason, not a literal in a function body.
--
--   1. send_wallet_diamond_transfer refuses, and is revoked from authenticated. The function is
--      kept (rather than dropped) so any caller still in flight gets a plain answer instead of a
--      42883 it cannot read.
--   2. fn_check_anti_farming_gift_cap loses the KINGFISH bypass and both waivers - the 120-day
--      account-age lift and the "purchased and waited 7 days" lift. Ruling 4 removed them
--      because they turned the anti-farming ladder off entirely for exactly the accounts a
--      farmer builds: the pair, user and burst caps now apply to every sender.
--   3. send_stream_gift is corrected in four ways, each a defect read out of the live body:
--      - its idempotency guard looked for reference_id = <ref> while it writes <ref>:sender and
--        <ref>:recipient, so a replay of the same reference was NEVER caught and gifted twice;
--      - both journal rows left counterparty and issuance_class NULL, so the classifier filled
--        them and filed DR12 against this writer on every gift;
--      - the two profile rows were locked by one ORDER BY ... FOR UPDATE, which does not
--        guarantee lock order; two players gifting each other at once could deadlock. They are
--        now locked by uuid order, explicitly;
--      - a gift could move PURCHASED diamonds out of the sender's wallet, leaving the purchase
--        lots (the refund and chargeback sub-ledger, ruling 1) pointing at diamonds that are no
--        longer there. Ruling 4's "promotional balance first" is now enforced: a player may gift
--        only the part of the balance that is not an unconsumed purchased lot.
--   4. transfer_diamonds_credit and transfer_diamonds_deduct are dropped. They were the legacy
--      unjournaled pair: the deduct wrote a journal row with no reference and no class, the
--      credit wrote none at all, and nothing in the repo or the World Hub calls either.
--
-- One transaction. Probed first in a transaction that was rolled back; the transcript is in the
-- changelog.

BEGIN;

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN RAISE EXCEPTION 'ca_patch: % has % overloads (expected 1)', p_fn, v_procs; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Player-to-player wallet transfers are off (ruling 4).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_wallet_diamond_transfer(
  p_recipient_id uuid, p_amount integer, p_message text DEFAULT NULL, p_reference_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- DIAMOND-RULINGS 4: the diamond economy is a closed loop. Player-to-player wallet transfers
  -- are off; the stream gift is the one social transfer and it goes through send_stream_gift.
  -- This path had 0 uses in production when the ruling was written.
  RETURN jsonb_build_object(
    'success', false,
    'error', 'Diamond Transfers Between Players Are Not Available',
    'code', 'p2p_transfers_disabled',
    'title', 'Transfers Are Off',
    'popup_message', 'Diamonds Cannot Be Sent Directly To Another Player',
    'popup_explanation', 'You Can Still Send Gifts During A Live Stream');
END $$;
REVOKE ALL ON FUNCTION public.send_wallet_diamond_transfer(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_wallet_diamond_transfer(uuid, integer, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The cap check loses the hard-coded account and both waivers (rulings 4, 12).
-- ---------------------------------------------------------------------------
-- TWO POLICIES WERE LIVE UNDER ONE NAME. Alongside the three-argument ladder that
-- send_stream_gift calls, a two-argument overload carried an older and different policy - a
-- 30-day new-account block, a flat 500 a day, and a blanket VIP exemption - and it was granted
-- to authenticated. Nothing calls it (the two World Hub routes mirror the ladder in JavaScript),
-- and a second answer to "may this player gift" is a coin flip decided by which signature the
-- caller happens to use. It goes.
DROP FUNCTION IF EXISTS public.fn_check_anti_farming_gift_cap(uuid, integer);

-- The ladder itself is rewritten whole rather than patched: its live body carries trailing
-- whitespace on every line, so a marker typed by hand never matches, and a patch that cannot
-- match is a patch that silently does nothing. This body is the live one with three blocks
-- removed and nothing else changed - diff it against pg_get_functiondef before this migration.
CREATE OR REPLACE FUNCTION public.fn_check_anti_farming_gift_cap(p_sender_id uuid, p_recipient_id uuid, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 DECLARE
   v_pair_24h              bigint;
   v_total_24h             bigint;
   v_burst_60s             bigint;
   v_fresh_paid_24h        bigint;
   v_active_ban            boolean;
   v_is_flagged            boolean;
   v_created_at            timestamptz;
   v_first_purchase_at     timestamptz;
   v_account_age_days      numeric;
   v_days_since_purchase   numeric;
   v_lift_via_age          timestamptz;
   v_lift_via_purchase     timestamptz;
   v_lift_at               timestamptz;
   v_lift_date_str         text;
   v_lift_msg              text;
   CAP_PER_PAIR_24H        constant integer := 5000;
   CAP_PER_USER_24H        constant integer := 50000;
   CAP_BURST_60S           constant integer := 2000;
   CAP_FRESH_PAID_24H      constant integer := 500;
   TRUST_AGE_DAYS          constant integer := 120;
   NEW_USER_DAYS           constant integer := 30;
   PURCHASE_COOLDOWN_DAYS  constant integer := 7;
 BEGIN
   -- ── Argument validation ─────────────────────────────────────────────────
   IF p_sender_id IS NULL OR p_recipient_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', 'Invalid Arguments',
       'code', 'invalid_args',
       'title', 'Invalid Request',
       'popup_message', 'The Request Is Missing Required Information',
       'popup_explanation', 'Please Refresh The Page And Try Again'
     );
   END IF;
   IF p_sender_id = p_recipient_id THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', 'Cannot Send To Self',
       'code', 'self_transfer',
       'title', 'Cannot Send To Yourself',
       'popup_message', 'You Cannot Send Diamonds To Your Own Account',
       'popup_explanation', 'Please Choose A Different Recipient'
     );
   END IF;

   -- DIAMOND-RULINGS 12: the hard-coded exempt account is gone. An account that is to be
   -- exempt from this ladder is a row in a table Dan owns, with a reason, never a literal
   -- in a function body that nothing outside it can see.

   -- ── Banned-by-recipient ─────────────────────────────────────────────────
   SELECT EXISTS (
     SELECT 1 FROM live_bans lb
       JOIN live_streams ls ON ls.id = lb.stream_id
      WHERE lb.banned_user_id = p_sender_id
        AND ls.broadcaster_id = p_recipient_id
   ) INTO v_active_ban;
   IF v_active_ban THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', 'You Are Banned From This Broadcaster',
       'code', 'banned_by_recipient',
       'title', 'You Are Banned',
       'popup_message', 'This Broadcaster Has Banned You From Sending Gifts',
       'popup_explanation', 'You Will Need To Contact The Broadcaster Directly To Request An Unban'
     );
   END IF;

   -- ── Load sender state ───────────────────────────────────────────────────
   SELECT COALESCE(is_farming_flagged, false), created_at
     INTO v_is_flagged, v_created_at
     FROM profiles WHERE id = p_sender_id;

   -- ── Compute lift timestamps (used by any blocked path below) ────────────
   IF v_is_flagged IS NOT TRUE THEN
     SELECT MIN(completed_at) INTO v_first_purchase_at
       FROM diamond_purchases
       WHERE user_id = p_sender_id
         AND status = 'completed'
         AND refunded_at IS NULL;

     v_account_age_days := CASE
       WHEN v_created_at IS NULL THEN 0
       ELSE EXTRACT(epoch FROM (now() - v_created_at)) / 86400
     END;
     v_days_since_purchase := CASE
       WHEN v_first_purchase_at IS NULL THEN NULL
       ELSE EXTRACT(epoch FROM (now() - v_first_purchase_at)) / 86400
     END;

     v_lift_via_age := CASE
       WHEN v_created_at IS NULL THEN NULL
       ELSE v_created_at + make_interval(days => TRUST_AGE_DAYS)
     END;
     v_lift_via_purchase := CASE
       WHEN v_first_purchase_at IS NULL THEN NULL
       ELSE v_first_purchase_at + make_interval(days => PURCHASE_COOLDOWN_DAYS)
     END;
     v_lift_at := CASE
       WHEN v_lift_via_age IS NOT NULL AND v_lift_via_purchase IS NOT NULL THEN LEAST(v_lift_via_age, v_lift_via_purchase)
       WHEN v_lift_via_purchase IS NOT NULL THEN v_lift_via_purchase
       WHEN v_lift_via_age IS NOT NULL THEN v_lift_via_age
       ELSE NULL
     END;
   ELSE
     v_lift_at := NULL;  -- flagged: requires admin action
   END IF;

   -- DIAMOND-RULINGS 4, with CLAUDE.md 10.86: there is no lift any more, so this stops
   -- answering with a date. A field that names a day nothing will happen on is worse than an
   -- empty one - it is the shape of a signal that answers when it does not know.
   v_lift_at := NULL;

   -- Title-Cased lift date string ("Your Limits Are Fully Lifted On May 19, 2026")
   v_lift_msg := CASE
     WHEN v_is_flagged THEN 'Your Account Has Restrictions That Require Admin Review To Lift'
     WHEN false THEN ''
     ELSE
       'Your Sending Limits Are Per Recipient, Per Day And Per Minute, And They Apply To Every Account'
   END;

   -- ── Trust ladder (only for unflagged senders) ───────────────────────────
   IF v_is_flagged IS NOT TRUE THEN
     -- DIAMOND-RULINGS 4: the two waivers are removed. Tier 4 lifted every cap seven days
     -- after the cheapest purchase a farmer can make, and tier 5 lifted them for any account
     -- that had simply existed for 120 days. Age is not trust and a receipt is not trust; the
     -- pair, user and burst caps below are what this ladder is for, and they cost a real
     -- player nothing.

     -- Tier 6: <30d + paid + <7d since purchase → 500/24h cap (with popup)
     IF v_account_age_days < NEW_USER_DAYS
        AND v_first_purchase_at IS NOT NULL THEN
       SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_fresh_paid_24h
         FROM diamond_transactions
        WHERE user_id = p_sender_id
          AND amount  < 0
          AND created_at > now() - interval '24 hours'
          AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
            OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));

       IF v_fresh_paid_24h + p_amount > CAP_FRESH_PAID_24H THEN
         RETURN jsonb_build_object(
           'allowed', false,
           'reason',  format('Fresh-Paid Users Are Capped At %s Diamonds / 24h For The First 7 Days After Purchase', CAP_FRESH_PAID_24H),
           'code',    'fresh_paid_24h_cap',
           'title',   'Daily Limit Reached',
           'popup_message', format('You Have Reached Your Daily %s Diamond Sending Limit', CAP_FRESH_PAID_24H),
           'popup_explanation', format('New Paid Accounts Are Limited To %s Diamonds Per Day During The First 7 Days After Your First Purchase To Protect Against Fraud', CAP_FRESH_PAID_24H),
           'next_send_message', 'You Can Send More Diamonds Tomorrow',
           'limits_lift_at', v_lift_at,
           'limits_lift_message', v_lift_msg,
           'amount_sent_24h', v_fresh_paid_24h,
           'amount_cap_24h', CAP_FRESH_PAID_24H
         );
       END IF;

       RETURN jsonb_build_object(
         'allowed', true,
         'reason',  'fresh_paid_within_500_per_day',
         'code',    'ok'
       );
     END IF;
   END IF;

   -- ── Tier 7: standard pair/user/burst caps (with popups) ─────────────────

   SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_pair_24h
     FROM diamond_transactions
    WHERE user_id = p_sender_id
      AND amount  < 0
      AND created_at > now() - interval '24 hours'
      AND metadata->>'recipient_id' = p_recipient_id::text
      AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
        OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
   IF v_pair_24h + p_amount > CAP_PER_PAIR_24H THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', format('Pair Limit Hit (%s Diamonds / 24h To This User)', CAP_PER_PAIR_24H),
       'code', 'pair_24h_cap',
       'title', 'Pair Limit Reached',
       'popup_message', format('You Have Sent %s Diamonds To This User In The Last 24 Hours', CAP_PER_PAIR_24H),
       'popup_explanation', format('You Can Send Up To %s Diamonds Per User Per Day While Your Account Is Not Yet Fully Trusted', CAP_PER_PAIR_24H),
       'next_send_message', 'You Can Send More Diamonds To This User Tomorrow',
       'limits_lift_at', v_lift_at,
       'limits_lift_message', v_lift_msg,
       'amount_sent_24h', v_pair_24h,
       'amount_cap_24h', CAP_PER_PAIR_24H
     );
   END IF;

   SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_24h
     FROM diamond_transactions
    WHERE user_id = p_sender_id
      AND amount  < 0
      AND created_at > now() - interval '24 hours'
      AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
        OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
   IF v_total_24h + p_amount > CAP_PER_USER_24H THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', format('Daily Limit Hit (%s Diamonds / 24h)', CAP_PER_USER_24H),
       'code', 'user_24h_cap',
       'title', 'Daily Limit Reached',
       'popup_message', format('You Have Sent %s Diamonds Total In The Last 24 Hours', CAP_PER_USER_24H),
       'popup_explanation', format('Your Account Can Send Up To %s Diamonds Per Day Until It Is Fully Trusted', CAP_PER_USER_24H),
       'next_send_message', 'You Can Send More Diamonds Tomorrow',
       'limits_lift_at', v_lift_at,
       'limits_lift_message', v_lift_msg,
       'amount_sent_24h', v_total_24h,
       'amount_cap_24h', CAP_PER_USER_24H
     );
   END IF;

   SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_burst_60s
     FROM diamond_transactions
    WHERE user_id = p_sender_id
      AND amount  < 0
      AND created_at > now() - interval '60 seconds'
      AND (transaction_type IN ('live_gift_sent','diamond_gift_sent')
        OR source IN ('stream_gift','wallet_transfer','wallet_diamond_transfer'));
   IF v_burst_60s + p_amount > CAP_BURST_60S THEN
     RETURN jsonb_build_object(
       'allowed', false,
       'reason', format('Slow Down - %s Diamonds In 60s Is Too Fast', CAP_BURST_60S),
       'code', 'burst_cap',
       'title', 'Sending Too Fast',
       'popup_message', format('You Have Sent %s Diamonds In The Last 60 Seconds', CAP_BURST_60S),
       'popup_explanation', format('Please Wait A Few Seconds Between Gifts To Avoid Hitting The %s Diamond Burst Limit', CAP_BURST_60S),
       'next_send_message', 'You Can Send More In About A Minute',
       'limits_lift_at', v_lift_at,
       'limits_lift_message', v_lift_msg,
       'amount_sent_60s', v_burst_60s,
       'amount_cap_60s', CAP_BURST_60S
     );
   END IF;

   RETURN jsonb_build_object('allowed', true, 'reason', 'within_caps', 'code', 'ok');
 END;
 $function$;

REVOKE ALL ON FUNCTION public.fn_check_anti_farming_gift_cap(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_check_anti_farming_gift_cap(uuid, uuid, integer) TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The stream gift: four corrections read out of the live body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_giftable_balance(p_user_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- DIAMOND-RULINGS 4 ("promotional balance first") read against ruling 1: purchased diamonds
  -- are the collateral of the refund and chargeback sub-ledger, so they do not leave the wallet
  -- as a gift. What a player may gift is the balance minus every unconsumed purchased lot.
  SELECT GREATEST(
    COALESCE((SELECT p.diamonds FROM public.profiles p WHERE p.id = p_user_id), 0)
      - COALESCE((SELECT sum(l.issued - l.consumed - l.refunded)
                    FROM public.diamond_purchase_lots l
                   WHERE l.user_id = p_user_id AND (l.issued - l.consumed - l.refunded) > 0), 0),
    0)::bigint;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_giftable_balance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_giftable_balance(uuid) TO service_role, authenticated;

SELECT pg_temp.ca_patch('send_stream_gift',
$ca_from$  -- ── Idempotency guard ────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM diamond_transactions WHERE reference_id = v_ref) THEN$ca_from$,
$ca_to$  -- ── Idempotency guard ────────────────────────────────────────────────────
  -- The rows this function writes are <ref>:sender and <ref>:recipient. Looking for the bare
  -- <ref> found nothing, ever, so a retry with the same reference gifted a second time.
  IF EXISTS (SELECT 1 FROM diamond_transactions WHERE reference_id IN (v_ref, v_ref || ':sender', v_ref || ':recipient')) THEN$ca_to$);

SELECT pg_temp.ca_patch('send_stream_gift',
$ca_from$  -- ── Lock both profile rows ───────────────────────────────────────────────
  PERFORM 1 FROM profiles
   WHERE id IN (v_sender, v_recipient)
   ORDER BY id
   FOR UPDATE;
$ca_from$,
$ca_to$  -- ── What may be gifted (ruling 4 with ruling 1) ──────────────────────────
  IF public.fn_ca_giftable_balance(v_sender) < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Purchased Diamonds Cannot Be Sent As A Gift',
      'code', 'purchased_diamonds_not_giftable',
      'giftable', public.fn_ca_giftable_balance(v_sender));
  END IF;

  -- ── Lock both profile rows, in uuid order ────────────────────────────────
  -- ORDER BY does not fix the order locks are TAKEN in, so two players gifting each other at
  -- the same moment could deadlock. Locking the lower uuid first is deterministic.
  PERFORM 1 FROM profiles WHERE id = LEAST(v_sender, v_recipient) FOR UPDATE;
  PERFORM 1 FROM profiles WHERE id = GREATEST(v_sender, v_recipient) FOR UPDATE;
$ca_to$);

SELECT pg_temp.ca_patch('send_stream_gift',
$ca_from$  INSERT INTO diamond_transactions (
    user_id, amount, transaction_type, type, source, description,
    balance_after, reference_id, metadata
  ) VALUES (
    v_sender, -p_amount, 'spend', 'spend', 'stream_gift',
    'Gift sent in live stream',
    v_sender_balance, v_ref || ':sender',$ca_from$,
$ca_to$  INSERT INTO diamond_transactions (
    user_id, amount, transaction_type, type, source, description,
    balance_after, reference_id, counterparty, issuance_class, metadata
  ) VALUES (
    v_sender, -p_amount, 'spend', 'spend', 'stream_gift',
    'Gift sent in live stream',
    v_sender_balance, v_ref || ':sender',
    'player:' || v_recipient::text, 'transferred',$ca_to$);

SELECT pg_temp.ca_patch('send_stream_gift',
$ca_from$  INSERT INTO diamond_transactions (
    user_id, amount, transaction_type, type, source, description,
    balance_after, reference_id, metadata
  ) VALUES (
    v_recipient, p_amount, 'earn', 'earn', 'stream_gift',
    'Gift received in live stream',
    v_recipient_balance, v_ref || ':recipient',$ca_from$,
$ca_to$  INSERT INTO diamond_transactions (
    user_id, amount, transaction_type, type, source, description,
    balance_after, reference_id, counterparty, issuance_class, metadata
  ) VALUES (
    v_recipient, p_amount, 'earn', 'earn', 'stream_gift',
    'Gift received in live stream',
    v_recipient_balance, v_ref || ':recipient',
    'player:' || v_sender::text, 'transferred',$ca_to$);

-- ---------------------------------------------------------------------------
-- 3b. The gift path is allowed to move the balance it is the sanctioned door for.
-- ---------------------------------------------------------------------------
-- fn_guard_profile_privileged_columns refuses any write to profiles.diamonds that is not inside
-- a named money path. send_stream_gift is granted to authenticated and is the one social
-- transfer ruling 4 keeps - and it was NOT on that list, so a player calling it got 42501
-- "profiles.diamonds is server-managed". Nobody had noticed because the World Hub route does its
-- own two-call debit and credit as service_role and never reaches the RPC; making that route
-- delegate (this branch) would have failed on the first real gift.
SELECT pg_temp.ca_patch('fn_guard_profile_privileged_columns',
$ca_from$     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'$ca_from$,
$ca_to$     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'
     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'$ca_to$);

-- ---------------------------------------------------------------------------
-- 4. The legacy pair goes (ruling 4).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.transfer_diamonds_deduct(uuid, integer);
DROP FUNCTION IF EXISTS public.transfer_diamonds_credit(uuid, integer);

-- ---------------------------------------------------------------------------
-- 5. Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_body text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('transfer_diamonds_credit', 'transfer_diamonds_deduct')) THEN
    RAISE EXCEPTION 'the legacy transfer pair is still here';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'send_wallet_diamond_transfer';
  IF v_body NOT LIKE '%p2p_transfers_disabled%' OR v_body LIKE '%UPDATE profiles%' THEN
    RAISE EXCEPTION 'send_wallet_diamond_transfer still moves money';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                  LATERAL aclexplode(p.proacl) a
              WHERE n.nspname = 'public' AND p.proname = 'send_wallet_diamond_transfer'
                AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'send_wallet_diamond_transfer is still granted to authenticated';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_check_anti_farming_gift_cap';
  IF v_body LIKE '%47965354-0e56-43ef-931c-ddaab82af765%' OR v_body LIKE '%kingfish_sender_bypass%' THEN
    RAISE EXCEPTION 'the hard-coded exemption is still in the cap check';
  END IF;
  IF v_body LIKE '%trusted_purchaser_7d_bypass%' OR v_body LIKE '%trusted_age_120d%'
     OR v_body LIKE '%v_account_age_days >= TRUST_AGE_DAYS THEN%' THEN
    RAISE EXCEPTION 'a waiver survived in the cap check';
  END IF;
  IF v_body NOT LIKE '%CAP_PER_PAIR_24H%' OR v_body NOT LIKE '%CAP_BURST_60S%' THEN
    RAISE EXCEPTION 'the caps themselves were lost';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_check_anti_farming_gift_cap') <> 1 THEN
    RAISE EXCEPTION 'there is still more than one gift cap policy under one name';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'send_stream_gift';
  IF v_body NOT LIKE '%v_ref || '':sender'', v_ref || '':recipient''%' THEN
    RAISE EXCEPTION 'the gift idempotency guard still looks for the wrong key';
  END IF;
  IF v_body NOT LIKE '%fn_ca_giftable_balance(v_sender) < p_amount%' THEN
    RAISE EXCEPTION 'a gift can still move purchased diamonds';
  END IF;
  IF v_body NOT LIKE '%LEAST(v_sender, v_recipient)%' OR v_body NOT LIKE '%GREATEST(v_sender, v_recipient)%' THEN
    RAISE EXCEPTION 'the gift still locks in an undefined order';
  END IF;
  IF (length(v_body) - length(replace(v_body, '''transferred''', ''))) / length('''transferred''') <> 2 THEN
    RAISE EXCEPTION 'both gift legs must be classified as transferred';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_guard_profile_privileged_columns';
  IF v_body NOT LIKE '%send_stream_gift[(]%' THEN
    RAISE EXCEPTION 'the gift path is still refused by the privileged-column guard';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_check_anti_farming_gift_cap';
  IF v_body NOT LIKE '%v_lift_at := NULL;%' THEN
    RAISE EXCEPTION 'the cap check still promises a lift date';
  END IF;
END $$;

COMMIT;
