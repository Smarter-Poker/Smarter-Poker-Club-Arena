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
 $function$
