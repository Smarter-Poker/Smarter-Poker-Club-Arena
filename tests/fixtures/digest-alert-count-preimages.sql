-- Exact installed function definitions, read2026-10-25 before the transition.
CREATE OR REPLACE FUNCTION public.fn_sp_daily_metrics_compute(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s timestamptz := (p_day::timestamp AT TIME ZONE 'America/Chicago');
  e timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Chicago');
  us timestamptz := (p_day::timestamp AT TIME ZONE 'UTC');
  ue timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'UTC');
  v_usd numeric := public.fn_sp_setting('usd_per_diamond', 0.01);
  v_big numeric := public.fn_sp_setting('big_diamond_move', 10000);
  g jsonb; m jsonb; d jsonb; sv jsonb; pl jsonb; ag jsonb; h jsonb; en jsonb; sec jsonb; cap jsonb; fr jsonb;
BEGIN
  -- GROWTH -------------------------------------------------------------------
  WITH hu AS (SELECT * FROM smarter_private.sp_real_humans),
       fixtures AS (SELECT count(*) n FROM public.profiles p WHERE p.created_at >= s AND p.created_at < e
                      AND NOT COALESCE(p.is_horse,false) AND NOT EXISTS (SELECT 1 FROM hu WHERE hu.id = p.id))
  SELECT jsonb_build_object(
    'signups', (SELECT count(*) FROM hu WHERE created_at >= s AND created_at < e),
    'signups_email_confirmed', (SELECT count(*) FROM hu WHERE created_at >= s AND created_at < e AND email_confirmed_at IS NOT NULL),
    'signups_phone_verified', (SELECT count(*) FROM hu WHERE created_at >= s AND created_at < e AND phone_verified),
    'fixture_accounts_created', (SELECT n FROM fixtures),
    'humans_total', (SELECT count(*) FROM hu WHERE created_at < e),
    'humans_phone_verified', (SELECT count(*) FROM hu WHERE phone_verified),
    'otp_codes_sent', (SELECT count(*) FROM public.sms_otp_send_log WHERE purpose = 'phone_verify' AND outcome = 'sent' AND created_at >= s AND created_at < e),
    'otp_send_failures', (SELECT count(*) FROM public.sms_otp_send_log WHERE purpose = 'phone_verify' AND outcome = 'failed' AND created_at >= s AND created_at < e),
    /* WHO CAN STILL EARN THE WELCOME PACKAGE BY PHONE (2026-10-23): verified,
       or a US player whose package is not already in the Mint register.
       Phone verification is US only; an owner grant leaves nothing to claim. */
    'signups_phone_eligible', (SELECT count(*) FROM hu JOIN public.profiles pp ON pp.id = hu.id
                                WHERE hu.created_at >= s AND hu.created_at < e
                                  AND (hu.phone_verified
                                       OR ((pp.country IS NULL OR pp.country IN ('United States', 'US'))
                                           AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger ml WHERE ml.op_id = 'signup:' || hu.id::text)))),
    'signups_phone_skipped', (SELECT count(*) FROM hu JOIN auth.users au ON au.id = hu.id
                               WHERE hu.created_at >= s AND hu.created_at < e AND NOT hu.phone_verified
                                 AND au.raw_user_meta_data ? 'phone_prompt_dismissed_at'),
    'active_humans', (SELECT count(*) FROM hu WHERE last_seen >= s),
    'active_horses', (SELECT count(*) FROM public.profiles WHERE is_horse AND last_seen >= s),
    'vip_active_humans', (SELECT count(*) FROM hu WHERE is_vip AND (vip_expires_at IS NULL OR vip_expires_at > e)),
    'referral_signups', (SELECT count(*) FROM public.referrals WHERE created_at >= s AND created_at < e),
    'top_referrer', (SELECT jsonb_build_object('username', p.username, 'count', x.n)
                       FROM (SELECT referrer_id, count(*) n FROM public.referrals WHERE created_at >= s AND created_at < e
                              GROUP BY 1 ORDER BY 2 DESC LIMIT 1) x JOIN public.profiles p ON p.id = x.referrer_id),
    'club_joins', (SELECT count(*) FROM public.club_entry_events WHERE created_at >= s AND created_at < e
                     AND flow = 'join' AND event_name = 'completed' AND outcome = 'succeeded'
                     AND EXISTS (SELECT 1 FROM hu WHERE hu.id = club_entry_events.actor_id)),
    'clubs_created', (SELECT count(*) FROM public.club_entry_events WHERE created_at >= s AND created_at < e
                     AND flow = 'create' AND event_name = 'completed' AND outcome = 'succeeded'
                     AND EXISTS (SELECT 1 FROM hu WHERE hu.id = club_entry_events.actor_id)),
    'retention', jsonb_build_object(
       'd1', (SELECT jsonb_build_object('cohort', count(*), 'returned', count(*) FILTER (WHERE last_seen >= s))
                FROM hu WHERE created_at >= s - interval '1 day' AND created_at < s),
       'd7', (SELECT jsonb_build_object('cohort', count(*), 'returned', count(*) FILTER (WHERE last_seen >= s))
                FROM hu WHERE created_at >= s - interval '7 days' AND created_at < s - interval '6 days'),
       'd30', (SELECT jsonb_build_object('cohort', count(*), 'returned', count(*) FILTER (WHERE last_seen >= s))
                FROM hu WHERE created_at >= s - interval '30 days' AND created_at < s - interval '29 days')),
    'funnel_30d', (SELECT jsonb_build_object(
         'signed_up', count(*),
         'email_confirmed', count(*) FILTER (WHERE email_confirmed_at IS NOT NULL),
         'phone_verified', count(*) FILTER (WHERE phone_verified),
         'joined_club', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.user_id = hu.id)),
         'played_hand', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.club_member_play_totals t WHERE t.user_id = hu.id AND t.hands > 0)))
       FROM hu WHERE created_at >= e - interval '30 days' AND created_at < e)
  ) INTO g;

  -- MONEY (one pass over the day's ledger) ------------------------------------
  WITH cl AS MATERIALIZED (
    SELECT category, from_type, to_type, club_id, amount, from_entity_id, to_entity_id
      FROM public.chip_ledger WHERE created_at >= s AND created_at < e),
  ra AS MATERIALIZED (
    SELECT r.player_id, r.club_id, r.rake_amount, COALESCE(p.is_horse, false) horse
      FROM public.rake_attributions r LEFT JOIN public.profiles p ON p.id = r.player_id
     WHERE r.club_id IS NOT NULL AND r.created_at >= s AND r.created_at < e)
  SELECT jsonb_build_object(
    -- cash rake to a union wallet, plus a standalone club's cash rake, which is retired
    'cash_rake', round(COALESCE((SELECT sum(amount) FROM cl WHERE from_type = 'table_stack'
                                   AND (category = 'rake' OR (category = 'burn' AND to_type = 'chip_retirement'))),0),2),
    'tournament_rake', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'rake' AND from_type = 'prize_liability'),0),2),
    'rake_paid_by_humans', round(COALESCE((SELECT sum(rake_amount) FROM ra WHERE NOT horse),0),2),
    'rake_paid_by_horses', round(COALESCE((SELECT sum(rake_amount) FROM ra WHERE horse),0),2),
    'rakeback_paid', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'rakeback'),0),2),
    'commissions_paid', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'commission'),0),2),
    'bbj_contributions', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'bbj_contribution'),0),2),
    'minted', round(COALESCE((SELECT sum(amount) FROM cl WHERE from_type IN ('system_mint','issuance_reserve')),0),2),
    'burned', round(COALESCE((SELECT sum(amount) FROM cl WHERE to_type IN ('system_burn','chip_retirement')),0),2),
    'promo_and_leaderboard', round(COALESCE((SELECT sum(amount) FROM cl WHERE category IN ('promo_send','promo','leaderboard_payout','club_opening_allocation')),0),2),
    -- by the club each player sat in; the ledger books a union's tables under the union
    'rake_by_club', COALESCE((SELECT jsonb_agg(x ORDER BY x.rake DESC) FROM (
         SELECT COALESCE(c.name, 'Unknown') club, round(sum(ra.rake_amount),2) rake
           FROM ra LEFT JOIN public.clubs c ON c.id = ra.club_id
          GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb),
    'top_human_rakers', COALESCE((SELECT jsonb_agg(x ORDER BY x.rake DESC) FROM (
         SELECT p.username, round(sum(ra.rake_amount),2) rake FROM ra JOIN public.profiles p ON p.id = ra.player_id
          WHERE NOT ra.horse AND ra.player_id IN (SELECT id FROM smarter_private.sp_real_humans)
          GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb),
    'bbj_pool_total', (SELECT round(COALESCE(sum(COALESCE(main_balance,0)+COALESCE(backup_balance,0)+COALESCE(promo_balance,0)),0),2)
                         FROM public.bbj_pools WHERE merged_into_pool_id IS NULL),
    'supply_unexplained', (SELECT round(COALESCE(sum(unexplained),0),2) FROM public.ca_supply_snapshots
                            WHERE taken_at >= s AND taken_at < e AND unexplained IS NOT NULL),
    -- Cash rake leaves the table stack two ways: to the union wallet for a
    -- club in a union, or retired (burned) for a standalone club. The rollup
    -- counts both, so the ledger side does too.
    'ledger_rake_utc_day', (SELECT round(COALESCE(sum(amount),0),2) FROM public.chip_ledger
                            WHERE created_at >= us AND created_at < ue AND from_type = 'table_stack'
                              AND (category = 'rake' OR (category = 'burn' AND to_type = 'chip_retirement'))),
    'rollup_rake_utc_day', (SELECT round(COALESCE(sum(rake_amount),0),2) FROM public.club_rake_daily_user WHERE day = p_day)
  ) INTO m;

  -- DIAMONDS ------------------------------------------------------------------
  WITH dt AS MATERIALIZED (
    SELECT user_id,
           /* A HOUSE PAYOUT FILED AS A TRANSFER IS NOT A TRANSFER (2026-10-16).
              Diamond Spins daily net settlements and Wheel cards are booked as
              type 'transfer' with the player as their own counterparty. They
              are house movements, so they count as given out or taken in under
              their own names instead of vanishing with peer transfers. */
           CASE WHEN COALESCE(transaction_type, type) = 'transfer'
                     AND metadata->>'reference_id' LIKE 'diamond-spin-day:%' THEN 'diamond_spins_daily_net'
                WHEN COALESCE(transaction_type, type) = 'transfer'
                     AND metadata->>'reference_id' LIKE 'wheel-cards%' THEN 'wheel_cards'
                ELSE COALESCE(transaction_type, type, 'unknown') END tt, amount, created_at
      FROM public.diamond_transactions WHERE created_at >= s AND created_at < e)
  SELECT jsonb_build_object(
    'given_out', COALESCE((SELECT sum(amount) FROM dt WHERE amount > 0 AND tt NOT IN ('arena_withdraw','transfer')),0),
    'given_by_source', COALESCE((SELECT jsonb_object_agg(tt, n) FROM (SELECT tt, sum(amount) n FROM dt
         WHERE amount > 0 AND tt NOT IN ('arena_withdraw','transfer') GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x), '{}'::jsonb),
    'taken_in', COALESCE((SELECT -sum(amount) FROM dt WHERE amount < 0 AND tt NOT IN ('arena_deposit','transfer')),0),
    'taken_by_sink', COALESCE((SELECT jsonb_object_agg(tt, n) FROM (SELECT tt, -sum(amount) n FROM dt
         WHERE amount < 0 AND tt NOT IN ('arena_deposit','transfer') GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x), '{}'::jsonb),
    'into_club_arena', COALESCE((SELECT -sum(amount) FROM dt WHERE tt = 'arena_deposit'),0),
    'out_of_club_arena', COALESCE((SELECT sum(amount) FROM dt WHERE tt = 'arena_withdraw'),0),
    'transfers', COALESCE((SELECT sum(abs(amount)) FROM dt WHERE tt = 'transfer'),0),
    'circulation', (SELECT COALESCE(sum(balance),0) FROM public.user_diamond_balance),
    -- what real players hold is the liability; horse and fixture balances are house money
    'circulation_players', (SELECT COALESCE(sum(b.balance),0) FROM public.user_diamond_balance b
                             WHERE b.user_id IN (SELECT id FROM smarter_private.sp_real_humans)),
    'big_movements', COALESCE((SELECT jsonb_agg(x) FROM (
         SELECT p.username, dt.tt AS type, dt.amount, to_char(dt.created_at AT TIME ZONE 'America/Chicago','HH12:MI AM') at_ct
           FROM dt LEFT JOIN public.profiles p ON p.id = dt.user_id
          WHERE abs(dt.amount) > v_big AND dt.tt NOT IN ('arena_deposit','arena_withdraw')
          ORDER BY abs(dt.amount) DESC LIMIT 10) x), '[]'::jsonb),
    'usd_per_diamond', v_usd
  ) INTO d;
  d := d || jsonb_build_object(
    'net_issued', (d->>'given_out')::numeric - (d->>'taken_in')::numeric,
    'circulation_usd', round((d->>'circulation_players')::numeric * v_usd, 2));

  -- SALES AND VIP -------------------------------------------------------------
  SELECT jsonb_build_object(
    'diamond_packages', (SELECT jsonb_build_object('count', count(*), 'usd', COALESCE(sum(price_usd),0))
                           FROM public.diamond_purchases WHERE completed_at >= s AND completed_at < e AND status = 'completed'),
    'vip_new', (SELECT jsonb_build_object('count', count(*), 'usd', COALESCE(sum(price_usd),0))
                  FROM public.vip_subscriptions WHERE created_at >= s AND created_at < e),
    'vip_cancelled', (SELECT count(*) FROM public.vip_subscriptions WHERE canceled_at >= s AND canceled_at < e),
    'vip_plan_switches', (SELECT count(*) FROM public.vip_plan_switches WHERE created_at >= s AND created_at < e),
    'vip_lifetime', (SELECT jsonb_build_object('count', count(*), 'usd', COALESCE(sum(price_usd),0))
                       FROM public.vip_lifetime_purchases WHERE created_at >= s AND created_at < e AND status = 'completed'),
    'merch', (SELECT jsonb_build_object('count', count(*), 'usd', COALESCE(sum(total_usd),0))
                FROM public.merchandise_orders WHERE created_at >= s AND created_at < e
                 AND status NOT IN ('pending','cancelled','canceled','abandoned','expired')),
    'merch_shipped', (SELECT count(*) FROM public.merchandise_orders WHERE shipped_at >= s AND shipped_at < e),
    'merch_delivered', (SELECT count(*) FROM public.merchandise_orders WHERE delivered_at >= s AND delivered_at < e),
    'store_purchases', (SELECT jsonb_build_object('count', count(*), 'diamonds', COALESCE(sum(net),0))
                          FROM public.ca_commerce_purchases WHERE created_at >= s AND created_at < e),
    'club_shop_purchases', (SELECT count(*) FROM public.club_shop_purchases WHERE created_at >= s AND created_at < e),
    'refunds_usd', round(COALESCE((SELECT sum(refunded_amount_cents) FROM public.diamond_purchases WHERE refunded_at >= s AND refunded_at < e),0)/100.0
                       + COALESCE((SELECT sum(refunded_amount_cents) FROM public.merchandise_orders WHERE refunded_at >= s AND refunded_at < e),0)/100.0
                       + COALESCE((SELECT sum(refunded_amount_cents) FROM public.vip_lifetime_purchases WHERE reversed_at >= s AND reversed_at < e),0)/100.0, 2),
    'disputes', (SELECT count(*) FROM public.vip_lifetime_purchases WHERE dispute_id IS NOT NULL AND updated_at >= s AND updated_at < e)
              + (SELECT count(*) FROM public.diamond_purchase_disputes WHERE (to_jsonb(diamond_purchase_disputes)->>'created_at')::timestamptz >= s
                   AND (to_jsonb(diamond_purchase_disputes)->>'created_at')::timestamptz < e),
    'stripe_events', (SELECT jsonb_build_object('total', count(*), 'not_completed', count(*) FILTER (WHERE (processing_status IS NULL OR processing_status NOT IN ('done','completed'))))
                        FROM public.stripe_webhook_events WHERE processed_at >= s AND processed_at < e)
  ) INTO sv;
  sv := sv || jsonb_build_object('revenue_usd', round(
      (sv#>>'{diamond_packages,usd}')::numeric + (sv#>>'{vip_new,usd}')::numeric
    + (sv#>>'{vip_lifetime,usd}')::numeric + (sv#>>'{merch,usd}')::numeric, 2));

  -- CLUB ARENA PLAY -------------------------------------------------------------
  WITH hh AS MATERIALIZED (
    SELECT tournament_id, has_human, pot_size, big_blind, table_id FROM public.hand_history WHERE created_at >= s AND created_at < e),
  hb AS (SELECT * FROM public.ca_horse_fleet_heartbeat WHERE beat_at >= s AND beat_at < e)
  SELECT jsonb_build_object(
    'hands', (SELECT count(*) FROM hh),
    'hands_cash', (SELECT count(*) FROM hh WHERE tournament_id IS NULL),
    'hands_tournament', (SELECT count(*) FROM hh WHERE tournament_id IS NOT NULL),
    'hands_with_human', (SELECT count(*) FROM hh WHERE has_human),
    'tables_dealing', (SELECT count(DISTINCT table_id) FROM hh),
    'biggest_pot', (SELECT max(pot_size) FROM hh),
    'tournaments_started', COALESCE((SELECT jsonb_object_agg(t, n) FROM (SELECT COALESCE(tournament_type,'OTHER') t, count(*) n
         FROM public.tournaments WHERE started_at >= s AND started_at < e GROUP BY 1) x), '{}'::jsonb),
    'tournaments_completed', COALESCE((SELECT jsonb_object_agg(t, n) FROM (SELECT COALESCE(tournament_type,'OTHER') t, count(*) n
         FROM public.tournaments WHERE ended_at >= s AND ended_at < e AND status = 'COMPLETED' GROUP BY 1) x), '{}'::jsonb),
    'tournaments_cancelled', (SELECT count(*) FROM public.tournaments WHERE status = 'CANCELLED' AND updated_at >= s AND updated_at < e),
    'biggest_prize_pool', (SELECT jsonb_build_object('name', name, 'prize_pool', prize_pool) FROM public.tournaments
         WHERE ended_at >= s AND ended_at < e AND status = 'COMPLETED' ORDER BY prize_pool DESC NULLS LAST LIMIT 1),
    'lightning_hands', (SELECT count(*) FROM public.lightning_hand WHERE formed_at >= s AND formed_at < e),
    'horse_fleet', (SELECT jsonb_build_object('beats', count(*), 'degraded_beats', count(*) FILTER (WHERE degraded),
         'max_stuck', COALESCE(max(horses_stuck),0), 'avg_seated', round(avg(horses_seated)), 'max_seated', max(horses_seated)) FROM hb),
    'horse_net_bb', (SELECT round(COALESCE(sum(net_bb),0),1) FROM public.horse_daily_nets WHERE day = p_day),
    'horse_rake_bb', (SELECT round(COALESCE(sum(rake_bb),0),1) FROM public.horse_daily_nets WHERE day = p_day)
  ) INTO pl;

  -- AGENTS AND CASHOUTS ---------------------------------------------------------
  SELECT jsonb_build_object(
    'cashouts_requested', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM public.cashout_requests WHERE created_at >= s AND created_at < e),
    'cashouts_completed', (SELECT count(*) FROM public.cashout_requests WHERE completed_at >= s AND completed_at < e),
    'agent_credit_invoices', (SELECT count(*) FROM public.credit_invoices WHERE created_at >= s AND created_at < e),
    'invoices_issued', COALESCE((SELECT jsonb_object_agg(invoice_type, n) FROM (SELECT invoice_type, count(*) n FROM public.settlement_invoices
         WHERE created_at >= s AND created_at < e AND invoice_type <> 'transaction_receipt' GROUP BY 1) x), '{}'::jsonb),
    'agent_funding', round(COALESCE((SELECT sum(amount) FROM public.club_wallet_transactions WHERE created_at >= s AND created_at < e AND type ~* 'agent'),0),2),
    'commission_settlements', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount),0)) FROM public.agent_commission_settlements WHERE paid_at >= s AND paid_at < e)
  ) INTO ag;

  -- PLATFORM HEALTH -------------------------------------------------------------
  -- Resolve the original classifier once, rather than once per signal.
  WITH digest_health_humans AS MATERIALIZED (SELECT id FROM smarter_private.sp_real_humans)
  SELECT jsonb_build_object(
    'breaks', (SELECT jsonb_build_object('total', count(*) FILTER (WHERE verdict IN ('pass','fail')), 'passed', count(*) FILTER (WHERE verdict = 'pass'))
                 FROM public.ca_break_scorecards WHERE recorded_at >= s AND recorded_at < e),
    'deploys', (SELECT jsonb_build_object('attempted', count(*), 'shipped', count(*) FILTER (WHERE a.shipped OR a.superseded OR a.retried),
                                     'superseded', count(*) FILTER (WHERE a.superseded),
                                     'retried', count(*) FILTER (WHERE a.retried AND NOT a.superseded))
                  /* A RELEASE THAT STOOD DOWN FOR A NEWER ONE THAT SHIPPED DID
                     SHIP (2026-10-16). The receiver stands an older revision
                     down when protected main has moved on; the newer revision
                     contains it. Counted as shipped only when the revision it
                     names really shipped within twelve hours either side. */
                  FROM (SELECT x.shipped,
                               (NOT x.shipped AND EXISTS (
                                  SELECT 1 FROM public.ca_engine_deploy_attempts y
                                   WHERE y.shipped
                                     AND y.target_sha = substring(x.reason from 'protected main had moved to ([0-9a-f]{40})')
                                     AND y.at BETWEEN x.at - interval '12 hours' AND x.at + interval '12 hours')) AS superseded,
                               /* A REFUSED ATTEMPT THAT ITS OWN RETRY SHIPPED DID SHIP
                                  (2026-10-23): the same exact target shipped later
                                  within the same twelve-hour window. */
                               (NOT x.shipped AND EXISTS (
                                  SELECT 1 FROM public.ca_engine_deploy_attempts z
                                   WHERE z.shipped
                                     AND z.target_sha = x.target_sha
                                     AND z.at > x.at
                                     AND z.at <= x.at + interval '12 hours')) AS retried
                          FROM public.ca_engine_deploy_attempts x WHERE x.at >= s AND x.at < e) a),
    'alerts_new', (SELECT jsonb_build_object('critical', count(*) FILTER (WHERE severity = 'critical'), 'warning', count(*) FILTER (WHERE severity = 'warning'))
                     FROM public.operational_alert_events WHERE received_at >= s AND received_at < e
                      AND investigation_status IS DISTINCT FROM 'informational' AND severity IN ('critical','warning')),
    'alerts_top', COALESCE((SELECT jsonb_agg(x) FROM (SELECT alertname, severity, count(*) n FROM public.operational_alert_events
         WHERE received_at >= s AND received_at < e AND investigation_status IS DISTINCT FROM 'informational' AND severity IN ('critical','warning')
         GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8) x), '[]'::jsonb),
    'alert_names', COALESCE((SELECT jsonb_object_agg(alertname, n) FROM (SELECT COALESCE(alertname,'unknown') alertname, count(*) n FROM public.operational_alert_events
         WHERE received_at >= s AND received_at < e AND investigation_status IS DISTINCT FROM 'informational' AND severity = 'critical'
         GROUP BY 1) x), '{}'::jsonb),
    'alerts_fixed', (SELECT count(*) FROM public.operational_alert_events WHERE investigation_touched_at >= s AND investigation_touched_at < e
                       AND investigation_status = 'verified_fixed'),
    'financial_alerts_new', (SELECT jsonb_build_object('critical', count(*) FILTER (WHERE severity = 'critical'), 'warning', count(*) FILTER (WHERE severity = 'warning'))
                               FROM public.financial_alerts WHERE created_at >= s AND created_at < e),
    'financial_alerts_open', (SELECT count(*) FROM public.financial_alerts WHERE NOT resolved AND severity IN ('critical','warning')),
    'drift_open', (SELECT count(*) FROM public.ca_drift_incidents WHERE resolved_at IS NULL),
    'drift_past_deadline', (SELECT count(*) FROM public.ca_drift_incidents WHERE resolved_at IS NULL AND deadline_at < e),
    'ledger_findings', (SELECT count(*) FROM public.ca_ledger_invariant_findings WHERE found_at >= s AND found_at < e),
    'diamond_incidents_new', (SELECT count(*) FROM public.ca_diamond_incidents WHERE occurred_at >= s AND occurred_at < e AND severity <> 'info'),
    'client_errors', (SELECT COALESCE(sum(occurrences),0) FROM public.client_error_events WHERE received_at >= s AND received_at < e),
    'client_errors_top', COALESCE((SELECT jsonb_agg(x) FROM (SELECT COALESCE(NULLIF(code,''), error_name, 'unknown') k, sum(occurrences) n
         FROM public.client_error_events WHERE received_at >= s AND received_at < e GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb),
    'db_timeouts', (SELECT COALESCE(sum(occurrences),0) FROM public.client_error_events WHERE received_at >= s AND received_at < e AND code = '57014'),
    -- An app crash is an error boundary catching a render failure. The auth
    -- flow's own failure reports (boundary 'auth': a wrong password, an
    -- unconfirmed email) and delivery probes share client_crash_log but are
    -- not crashes (2026-10-16: both "app crashes" on Oct 15 were login form
    -- refusals, DailyDigest.client_crash).
    'crashes', (SELECT count(*) FROM public.client_crash_log WHERE created_at >= s AND created_at < e
                  AND boundary IS DISTINCT FROM 'auth' AND error_name IS DISTINCT FROM 'Probe'),
    'signup_errors', (SELECT count(*) FROM public.signup_errors WHERE occurred_at >= s AND occurred_at < e),
    'probe_failures', COALESCE((SELECT jsonb_object_agg(probe_name, n) FROM (SELECT COALESCE(probe_name,'unknown') probe_name, count(*) n FROM public.probe_heartbeats
         WHERE occurred_at >= s AND occurred_at < e AND status = 'failed' GROUP BY 1) x), '{}'::jsonb),
    -- signals between two horses are the house playing itself; only pairs with a real player count
    'collusion_signals', (SELECT count(*) FROM public.ca_collusion_signals c WHERE c.detected_at >= s AND c.detected_at < e AND NOT COALESCE(c.both_cert,false)
                           AND EXISTS (SELECT 1 FROM digest_health_humans hu WHERE hu.id IN (c.user_a, c.user_b))),
    'collusion_signals_horse_only', (SELECT count(*) FROM public.ca_collusion_signals c WHERE c.detected_at >= s AND c.detected_at < e AND NOT COALESCE(c.both_cert,false)
                           AND NOT EXISTS (SELECT 1 FROM digest_health_humans hu WHERE hu.id IN (c.user_a, c.user_b))),
    'beta_accounts_flagged', COALESCE((SELECT jsonb_agg(DISTINCT p.username) FROM public.ca_collusion_signals c
         JOIN public.profiles p ON p.id IN (c.user_a, c.user_b)
        WHERE c.detected_at >= s AND c.detected_at < e AND p.username ~* '^(kingfish|danimal)'), '[]'::jsonb),
    'push', (SELECT jsonb_build_object('sent', COALESCE(sum(sent),0), 'failed', COALESCE(sum(failed),0))
               FROM public.push_dispatch_runs WHERE started_at >= s AND started_at < e)
  ) INTO h;

  -- ENGAGEMENT ------------------------------------------------------------------
  SELECT jsonb_build_object(
    'challenges_claimed', (SELECT count(*) FROM public.user_daily_challenges WHERE claimed_at >= s AND claimed_at < e),
    'trivia_sessions', (SELECT count(*) FROM public.trivia_sessions WHERE submitted_at >= s AND submitted_at < e),
    'training_answers', (SELECT count(*) FROM public.training_answers WHERE answered_at >= s AND answered_at < e),
    'social_posts', (SELECT count(*) FROM public.social_posts WHERE created_at >= s AND created_at < e AND NOT COALESCE(is_deleted,false)),
    'social_comments', (SELECT count(*) FROM public.social_comments WHERE created_at >= s AND created_at < e AND NOT COALESCE(is_deleted,false)),
    'social_likes', (SELECT count(*) FROM public.social_likes WHERE created_at >= s AND created_at < e),
    'reels', (SELECT count(*) FROM public.social_reels WHERE created_at >= s AND created_at < e AND NOT COALESCE(is_deleted,false)),
    'videos_added', (SELECT count(*) FROM public.video_library_videos WHERE created_at >= s AND created_at < e)
  ) INTO en;

  -- SECURITY --------------------------------------------------------------------
  SELECT jsonb_build_object(
    'admin_ids', COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM public.profiles WHERE is_admin OR role IN ('admin','super_admin','owner')), '[]'::jsonb),
    'admins', COALESCE((SELECT jsonb_object_agg(id, COALESCE(username, 'unknown')) FROM public.profiles WHERE is_admin OR role IN ('admin','super_admin','owner')), '{}'::jsonb),
    'signup_abuse_hits', (SELECT count(*) FROM public.signup_abuse_log WHERE last_signup_at >= s AND last_signup_at < e AND abuse_flags IS NOT NULL AND abuse_flags <> '{}'::jsonb),
    'accounts_deleted', (SELECT count(*) FROM public.ca_profile_deletions WHERE deleted_at >= s AND deleted_at < e AND NOT COALESCE(is_horse,false)),
    'login_probe_failures', (SELECT count(*) FROM public.probe_heartbeats WHERE occurred_at >= s AND occurred_at < e AND status = 'failed' AND probe_name ~* 'login|recovery|auth')
  ) INTO sec;

  -- CAPACITY (instant reading at snapshot time) ----------------------------------
  SELECT jsonb_build_object(
    'db_size_gb', round(pg_database_size(current_database()) / 1073741824.0, 1),
    'connections', (SELECT count(*) FROM pg_stat_activity),
    'active_queries', (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
    'cache_hit_pct', (SELECT round(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2) FROM pg_stat_database WHERE datname = current_database()),
    'saturation_selftests_failed', (SELECT count(*) FROM public.db_saturation_selftest_log
         WHERE (to_jsonb(db_saturation_selftest_log)->>'ok') = 'false'
           AND COALESCE((to_jsonb(db_saturation_selftest_log)->>'ran_at')::timestamptz, (to_jsonb(db_saturation_selftest_log)->>'created_at')::timestamptz) >= s
           AND COALESCE((to_jsonb(db_saturation_selftest_log)->>'ran_at')::timestamptz, (to_jsonb(db_saturation_selftest_log)->>'created_at')::timestamptz) < e)
  ) INTO cap;

  -- FRESHNESS: newest row per source when computed ---------------------------------
  SELECT jsonb_build_object(
    'chip_ledger', (SELECT max(created_at) FROM public.chip_ledger WHERE created_at > now() - interval '2 days'),
    'hand_history', (SELECT max(created_at) FROM public.hand_history WHERE created_at > now() - interval '2 days'),
    'diamond_transactions', (SELECT max(created_at) FROM public.diamond_transactions WHERE created_at > now() - interval '2 days'),
    'horse_heartbeat', (SELECT max(beat_at) FROM public.ca_horse_fleet_heartbeat),
    'supply_snapshots', (SELECT max(taken_at) FROM public.ca_supply_snapshots),
    'rake_rollup', (SELECT max(computed_at) FROM public.club_rake_daily_user),
    'alert_inbox', (SELECT max(received_at) FROM public.operational_alert_events),
    'break_scorecards', (SELECT max(recorded_at) FROM public.ca_break_scorecards)
  ) INTO fr;

  RETURN jsonb_build_object('day', p_day, 'window', jsonb_build_object('start', s, 'end', e),
    'growth', g, 'money', m, 'diamonds', d, 'sales', sv, 'play', pl, 'agents', ag,
    'health', h, 'engagement', en, 'security', sec, 'capacity', cap, 'freshness', fr,
    'computed_at', clock_timestamp());
END $function$;

CREATE OR REPLACE FUNCTION public.fn_sp_digest_attention(p_day date, p_metrics jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  a jsonb := '[]'::jsonb;
  v numeric; v2 numeric; avg7 numeric; t text; r record; v_elig numeric;
  prev jsonb;
  s timestamptz := (p_day::timestamp AT TIME ZONE 'America/Chicago');
  e timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'America/Chicago');
BEGIN
  SELECT metrics INTO prev FROM public.sp_daily_metrics WHERE day = p_day - 1;

  -- Money not reconciling
  v := (p_metrics#>>'{money,supply_unexplained}')::numeric;
  IF COALESCE(v,0) <> 0 THEN
    a := a || jsonb_build_object('rule','money_not_reconciling','severity','critical',
      'title', format('Chip supply has %s unexplained chips', to_char(v,'FM999,999,999,990.00')), 'detail', jsonb_build_object('unexplained', v));
  END IF;
  v := (p_metrics#>>'{health,ledger_findings}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','ledger_findings','severity','critical',
      'title', format('%s new ledger invariant findings', v), 'detail', jsonb_build_object('count', v));
  END IF;
  v := (p_metrics#>>'{money,ledger_rake_utc_day}')::numeric; v2 := (p_metrics#>>'{money,rollup_rake_utc_day}')::numeric;
  IF v IS NOT NULL AND v2 IS NOT NULL AND abs(v - v2) > 1 THEN
    a := a || jsonb_build_object('rule','rake_rollup_mismatch','severity','warning',
      'title', format('Rake rollup (%s) does not match the ledger (%s)', v2, v), 'detail', jsonb_build_object('ledger', v, 'rollup', v2));
  END IF;

  -- Critical alert types that are brand new this week, or at least doubled and
  -- firing 10+ times. One grouped item; every one of these alerts is already
  -- in the fleet's inbox, so this item is not dispatched again.
  SELECT count(*), string_agg(format('%s (%s, %s the day before)', z.alertname, z.n, z.prior), '; ' ORDER BY z.n DESC)
    INTO v, t
    FROM (
      SELECT cur.key AS alertname, cur.value::numeric AS n, COALESCE(pd.n, 0) AS prior
        FROM jsonb_each_text(COALESCE(p_metrics#>'{health,alert_names}','{}'::jsonb)) cur
        LEFT JOIN (SELECT COALESCE(alertname,'unknown') alertname, count(*) n FROM public.operational_alert_events
                    WHERE received_at >= s - interval '1 day' AND received_at < s
                      AND investigation_status IS DISTINCT FROM 'informational' AND severity = 'critical'
                    GROUP BY 1) pd ON pd.alertname = cur.key
       WHERE NOT EXISTS (SELECT 1 FROM public.operational_alert_events o
                          WHERE o.alertname = cur.key AND o.severity = 'critical'
                            AND o.received_at >= s - interval '7 days' AND o.received_at < s)
          OR (cur.value::numeric >= 10 AND cur.value::numeric >= 2 * COALESCE(pd.n, 0))) z;
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','critical_alert_rising','severity','critical','dispatch',false,
      'title', format('%s critical alert type%s new this week or doubled: %s', v, CASE WHEN v = 1 THEN ' is' ELSE 's are' END, left(t, 400)),
      'detail', jsonb_build_object('count', v, 'alerts', t));
  END IF;

  v := (SELECT count(*) FROM public.ca_drift_incidents WHERE resolved_at IS NULL AND deadline_at < now());
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','drift_past_deadline','severity','warning','dispatch',false,
      'title', format('%s drift incidents are open past their deadline', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Stuck tournaments (live)
  FOR r IN SELECT id, name, tournament_type, started_at FROM public.tournaments
            WHERE status = 'RUNNING' AND started_at < now() - make_interval(hours => public.fn_sp_setting('stuck_tournament_hours',12)::int)
            ORDER BY started_at LIMIT 10 LOOP
    a := a || jsonb_build_object('rule','stuck_tournament','severity','critical',
      'title', format('%s "%s" has been running since %s', r.tournament_type, r.name, to_char(r.started_at AT TIME ZONE 'America/Chicago','Mon DD HH12:MI AM')),
      'detail', jsonb_build_object('tournament_id', r.id), 'key', r.id::text);
  END LOOP;

  -- Engine breaks and deploys
  v := (p_metrics#>>'{health,breaks,total}')::numeric - (p_metrics#>>'{health,breaks,passed}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','break_failed','severity','warning','title', format('%s engine maintenance breaks did not pass', v), 'detail', p_metrics#>'{health,breaks}');
  END IF;
  v := (p_metrics#>>'{health,deploys,attempted}')::numeric - (p_metrics#>>'{health,deploys,shipped}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','deploy_failed','severity','warning','title', format('%s engine deploy attempts did not ship', v), 'detail', p_metrics#>'{health,deploys}');
  END IF;

  -- Cashouts waiting (live)
  v := (SELECT count(*) FROM public.cashout_requests WHERE completed_at IS NULL AND cancelled_at IS NULL
          AND status NOT IN ('completed','cancelled','canceled','rejected','denied')
          AND created_at < now() - make_interval(hours => public.fn_sp_setting('cashout_wait_hours',24)::int));
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','cashout_waiting','severity','warning','title', format('%s cashout requests waiting over 24 hours', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Weekly invoices late (Mondays, after 9 AM Central)
  IF extract(isodow FROM (now() AT TIME ZONE 'America/Chicago')) = 1 AND (now() AT TIME ZONE 'America/Chicago')::time >= time '09:00' THEN
    v := (SELECT count(*) FROM public.settlement_invoices
           WHERE invoice_type IN ('agent_to_player','agent_to_subagent','club_to_agent','union_to_club','club_weekly_accounting')
             AND created_at > now() - interval '3 days' AND NOT COALESCE(message_sent,false));
    IF v > 0 THEN
      a := a || jsonb_build_object('rule','invoices_late','severity','warning','title', format('%s weekly invoices have not been delivered', v), 'detail', jsonb_build_object('count', v));
    END IF;
  END IF;

  v := (p_metrics#>>'{agents,agent_credit_invoices}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','agent_on_credit','severity','warning','title', format('%s agent credit invoices were created (agents are prepaid only)', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Diamond Spins and Diamond games underfunded (live)
  v := (SELECT count(*) FROM public.wheel_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor())
     + (SELECT count(*) FROM public.diamond_game_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor());
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','spins_underfunded','severity','critical','title', format('%s Diamond Spins or Diamond game hosts are funded below 2,500 diamonds', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Big diamond movements
  IF jsonb_array_length(COALESCE(p_metrics#>'{diamonds,big_movements}','[]'::jsonb)) > 0 THEN
    a := a || jsonb_build_object('rule','big_diamond_move','severity','warning',
      'title', format('%s diamond movements over %s', jsonb_array_length(p_metrics#>'{diamonds,big_movements}'), to_char(public.fn_sp_setting('big_diamond_move',10000),'FM999,999,999')),
      'detail', p_metrics#>'{diamonds,big_movements}');
  END IF;

  -- Payments
  v := COALESCE((p_metrics#>>'{sales,refunds_usd}')::numeric,0);
  v2 := COALESCE((p_metrics#>>'{sales,disputes}')::numeric,0) + COALESCE((p_metrics#>>'{sales,stripe_events,not_completed}')::numeric,0);
  IF v > 0 OR v2 > 0 THEN
    a := a || jsonb_build_object('rule','payment_problem','severity','critical',
      'title', format('Payments: %s USD refunded, %s disputes or failed Stripe events', to_char(v,'FM999,990.00'), v2), 'detail', jsonb_build_object('refunds_usd', v, 'issues', v2));
  END IF;

  -- Signups vs 7 day average (only once there is history)
  SELECT avg((metrics#>>'{growth,signups}')::numeric), count(*) INTO avg7, v2 FROM public.sp_daily_metrics WHERE day BETWEEN p_day - 7 AND p_day - 1;
  v := (p_metrics#>>'{growth,signups}')::numeric;
  IF v2 >= 3 AND avg7 >= 1 AND v < avg7 * public.fn_sp_setting('signup_drop_ratio',0.5) THEN
    a := a || jsonb_build_object('rule','signups_dropped','severity','warning',
      'title', format('%s real signups vs a 7 day average of %s', v, round(avg7,1)), 'detail', jsonb_build_object('signups', v, 'avg7', round(avg7,1)));
  END IF;
  v2 := (p_metrics#>>'{growth,signups_phone_verified}')::numeric;
  -- Measured against players who can still earn the package by phone
  -- (US, not already paid by hand); older metrics without the figure fall
  -- back to every signup.
  v_elig := COALESCE((p_metrics#>>'{growth,signups_phone_eligible}')::numeric, v);
  IF v_elig >= 2 AND v2 < v_elig * public.fn_sp_setting('phone_verify_min_rate',0.5) THEN
    a := a || jsonb_build_object('rule','phone_verification_low','severity','warning',
      'title', format('Only %s of %s eligible new players verified their phone (%s skipped the offer)', v2, v_elig,
                      COALESCE((p_metrics#>>'{growth,signups_phone_skipped}')::numeric, 0)),
      'detail', jsonb_build_object('signups', v, 'eligible', v_elig, 'verified', v2,
                                   'skipped', (p_metrics#>>'{growth,signups_phone_skipped}')::numeric,
                                   'otp_codes_sent', (p_metrics#>>'{growth,otp_codes_sent}')::numeric));
  END IF;
  IF COALESCE((p_metrics#>>'{growth,otp_send_failures}')::numeric, 0) > 0 THEN
    a := a || jsonb_build_object('rule','phone_otp_send_failed','severity','warning',
      'title', format('%s phone verification codes failed to send', (p_metrics#>>'{growth,otp_send_failures}')::numeric),
      'detail', jsonb_build_object('failed', (p_metrics#>>'{growth,otp_send_failures}')::numeric,
                                   'sent', (p_metrics#>>'{growth,otp_codes_sent}')::numeric));
  END IF;
  v := (p_metrics#>>'{health,signup_errors}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','signup_errors','severity','warning','title', format('%s signup errors', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Error spike
  SELECT avg((metrics#>>'{health,client_errors}')::numeric), count(*) INTO avg7, v2 FROM public.sp_daily_metrics WHERE day BETWEEN p_day - 7 AND p_day - 1;
  v := (p_metrics#>>'{health,client_errors}')::numeric;
  IF v2 >= 3 AND avg7 > 0 AND v > avg7 * public.fn_sp_setting('client_error_spike_ratio',2) THEN
    a := a || jsonb_build_object('rule','error_spike','severity','warning',
      'title', format('%s client errors vs a 7 day average of %s', v, round(avg7)), 'detail', jsonb_build_object('errors', v, 'avg7', round(avg7)));
  END IF;
  v := (p_metrics#>>'{health,crashes}')::numeric;
  IF COALESCE(v,0) > 0 THEN
    a := a || jsonb_build_object('rule','client_crash','severity','warning','title', format('%s app crashes', v), 'detail', jsonb_build_object('count', v));
  END IF;

  -- Beta accounts flagged
  IF jsonb_array_length(COALESCE(p_metrics#>'{health,beta_accounts_flagged}','[]'::jsonb)) > 0 THEN
    a := a || jsonb_build_object('rule','beta_accounts_flagged','severity','warning','title','KingFish or Danimal appeared in an anti-cheat signal', 'detail', p_metrics#>'{health,beta_accounts_flagged}');
  END IF;

  -- Horse fleet
  v := (p_metrics#>>'{play,horse_fleet,degraded_beats}')::numeric;
  v2 := (p_metrics#>>'{play,horse_fleet,max_stuck}')::numeric;
  IF COALESCE(v,0) > 0 OR COALESCE(v2,0) > COALESCE((p_metrics#>>'{play,horse_fleet,max_seated}')::numeric,0) * public.fn_sp_setting('horse_stuck_ratio',0.05) THEN
    a := a || jsonb_build_object('rule','horse_fleet_degraded','severity','warning',
      'title', format('Horse fleet degraded on %s heartbeats, up to %s horses stuck', COALESCE(v,0), COALESCE(v2,0)), 'detail', p_metrics#>'{play,horse_fleet}');
  END IF;

  -- New admins vs the prior day
  IF prev IS NOT NULL THEN
    FOR t IN SELECT j.x FROM jsonb_array_elements_text(COALESCE(p_metrics#>'{security,admin_ids}','[]'::jsonb)) AS j(x)
              WHERE NOT (COALESCE(prev#>'{security,admin_ids}','[]'::jsonb) ? x) LOOP
      a := a || jsonb_build_object('rule','new_admin','severity','critical',
        'title', format('New admin account: %s', COALESCE(p_metrics#>>ARRAY['security','admins',t], t)), 'detail', jsonb_build_object('user_id', t), 'key', t);
    END LOOP;
  END IF;

  -- Stale sources (only meaningful near the end of the day)
  FOR r IN SELECT key, value::timestamptz ts FROM jsonb_each_text(COALESCE(p_metrics->'freshness','{}'::jsonb))
            WHERE key IN ('chip_ledger','hand_history','horse_heartbeat','alert_inbox') LOOP
    IF r.ts IS NULL OR r.ts < LEAST(e, now()) - interval '2 hours' THEN
      a := a || jsonb_build_object('rule','stale_source','severity','warning',
        'title', format('%s has had no new rows since %s', replace(r.key,'_',' '), COALESCE(to_char(r.ts AT TIME ZONE 'America/Chicago','Mon DD HH12:MI AM'),'never')),
        'detail', jsonb_build_object('source', r.key, 'newest', r.ts), 'key', r.key);
    END IF;
  END LOOP;

  -- Previous morning's email
  -- Only once the digest was already running the day before; the first digest
  -- after launch has no previous morning to miss.
  IF NOT EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day = p_day - 1 AND status = 'sent')
     AND EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day <= p_day - 1) THEN
    a := a || jsonb_build_object('rule','digest_failed','severity','warning','title', format('The digest for %s was not delivered', to_char(p_day - 1,'Mon DD')), 'detail', '{}'::jsonb);
  END IF;

  RETURN a;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_sp_daily_digest(p_day date DEFAULT NULL::date, p_dispatch boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_day date := COALESCE(p_day, (now() AT TIME ZONE 'America/Chicago')::date - 1);
  v_row public.sp_daily_metrics%ROWTYPE;
  v_prev jsonb; v_series jsonb; v_mtd jsonb; v_week jsonb; v_att jsonb; v_live jsonb; v_status jsonb;
  v_days_in_month int; v_days_so_far int;
BEGIN
  SELECT * INTO v_row FROM public.sp_daily_metrics WHERE day = v_day;
  IF NOT FOUND THEN
    PERFORM public.fn_sp_daily_metrics_snapshot(v_day);
    SELECT * INTO v_row FROM public.sp_daily_metrics WHERE day = v_day;
  END IF;
  SELECT metrics INTO v_prev FROM public.sp_daily_metrics WHERE day = v_day - 1;

  -- 7 day series of the headline numbers, oldest first
  SELECT jsonb_object_agg(k, vals) INTO v_series FROM (
    SELECT k, jsonb_agg(jsonb_build_object('day', day, 'v', val) ORDER BY day) vals FROM (
      SELECT dm.day, x.k, (dm.metrics #>> x.path)::numeric val
        FROM public.sp_daily_metrics dm
        CROSS JOIN (VALUES
          ('signups', '{growth,signups}'::text[]), ('active_humans', '{growth,active_humans}'::text[]),
          ('cash_rake', '{money,cash_rake}'::text[]), ('tournament_rake', '{money,tournament_rake}'::text[]),
          ('revenue_usd', '{sales,revenue_usd}'::text[]), ('diamonds_given', '{diamonds,given_out}'::text[]),
          ('diamonds_taken', '{diamonds,taken_in}'::text[]), ('hands', '{play,hands}'::text[]),
          ('critical_alerts', '{health,alerts_new,critical}'::text[]), ('client_errors', '{health,client_errors}'::text[])) x(k, path)
       WHERE dm.day BETWEEN v_day - 6 AND v_day) z GROUP BY k) y;

  v_days_in_month := extract(day FROM (date_trunc('month', v_day) + interval '1 month - 1 day'))::int;
  v_days_so_far := extract(day FROM v_day)::int;
  SELECT jsonb_build_object(
    'days', count(*),
    'revenue_usd', COALESCE(sum((metrics#>>'{sales,revenue_usd}')::numeric),0),
    'cash_rake', COALESCE(sum((metrics#>>'{money,cash_rake}')::numeric),0),
    'tournament_rake', COALESCE(sum((metrics#>>'{money,tournament_rake}')::numeric),0),
    'signups', COALESCE(sum((metrics#>>'{growth,signups}')::numeric),0),
    'horse_net_bb', COALESCE(sum((metrics#>>'{play,horse_net_bb}')::numeric),0))
    INTO v_mtd FROM public.sp_daily_metrics WHERE day >= date_trunc('month', v_day)::date AND day <= v_day;
  v_mtd := v_mtd || jsonb_build_object(
    'projected_revenue_usd', round((v_mtd->>'revenue_usd')::numeric / GREATEST(v_days_so_far,1) * v_days_in_month, 2),
    'projected_rake', round(((v_mtd->>'cash_rake')::numeric + (v_mtd->>'tournament_rake')::numeric) / GREATEST(v_days_so_far,1) * v_days_in_month, 2),
    'days_in_month', v_days_in_month, 'day_of_month', v_days_so_far);

  -- Monday: the full previous Monday-Sunday week
  IF extract(isodow FROM v_day) = 7 THEN
    SELECT jsonb_build_object('from', min(day), 'to', max(day), 'days', count(*),
      'revenue_usd', COALESCE(sum((metrics#>>'{sales,revenue_usd}')::numeric),0),
      'cash_rake', COALESCE(sum((metrics#>>'{money,cash_rake}')::numeric),0),
      'tournament_rake', COALESCE(sum((metrics#>>'{money,tournament_rake}')::numeric),0),
      'rakeback_paid', COALESCE(sum((metrics#>>'{money,rakeback_paid}')::numeric),0),
      'signups', COALESCE(sum((metrics#>>'{growth,signups}')::numeric),0),
      'hands', COALESCE(sum((metrics#>>'{play,hands}')::numeric),0),
      'diamonds_given', COALESCE(sum((metrics#>>'{diamonds,given_out}')::numeric),0),
      'diamonds_taken', COALESCE(sum((metrics#>>'{diamonds,taken_in}')::numeric),0),
      'minted', COALESCE(sum((metrics#>>'{money,minted}')::numeric),0),
      'burned', COALESCE(sum((metrics#>>'{money,burned}')::numeric),0))
      INTO v_week FROM public.sp_daily_metrics WHERE day BETWEEN v_day - 6 AND v_day;
  END IF;

  -- Live rules re-read now (cashouts, stuck tournaments, funding, invoices);
  -- anything new is dispatched, then everything is read back with its status.
  v_live := public.fn_sp_digest_attention(v_day, v_row.metrics);
  IF p_dispatch THEN
    v_live := public.fn_sp_dispatch_attention(v_day, v_live);
    -- Keep what the email reported on the day's record, so the online view and
    -- any re-send show the same list. One entry per rule and key.
    UPDATE public.sp_daily_metrics m
       SET attention = COALESCE(m.attention,'[]'::jsonb) || COALESCE((
             SELECT jsonb_agg(l.x) FROM jsonb_array_elements(v_live) AS l(x)
              WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(m.attention,'[]'::jsonb)) AS o(y)
                                 WHERE o.y->>'rule' = l.x->>'rule'
                                   AND COALESCE(o.y->>'key','') = COALESCE(l.x->>'key',''))), '[]'::jsonb)
     WHERE m.day = v_day;
    v_live := '[]'::jsonb;
    SELECT * INTO v_row FROM public.sp_daily_metrics WHERE day = v_day;
  ELSE
    -- read-only callers (the online view) only see items already dispatched
    v_live := '[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) INTO v_att FROM (
    SELECT it || jsonb_build_object(
        'status', CASE WHEN NOT (it ? 'alert_event_id') THEN 'tracked'
                       WHEN o.investigation_status IN ('verified_fixed','historical') THEN 'fixed'
                       WHEN o.investigation_status = 'investigating' THEN 'in_progress'
                       ELSE 'not_picked_up' END,
        'resolution', o.investigation->>'resolution') x
      FROM jsonb_array_elements(COALESCE(v_row.attention,'[]'::jsonb) || v_live) AS j(it)
      LEFT JOIN public.operational_alert_events o ON o.id = (it->>'alert_event_id')::bigint) z;
  -- one entry per alert event
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'severity') = 'critical' DESC, x->>'rule'), '[]'::jsonb) INTO v_att FROM (
    SELECT DISTINCT ON (COALESCE(j.x->>'alert_event_id', j.x->>'title')) j.x FROM jsonb_array_elements(v_att) AS j(x)
     ORDER BY COALESCE(x->>'alert_event_id', x->>'title')) q;

  SELECT jsonb_build_object('fixed', count(*) FILTER (WHERE x->>'status' = 'fixed'),
                            'tracked', count(*) FILTER (WHERE x->>'status' = 'tracked'),
                            'in_progress', count(*) FILTER (WHERE x->>'status' = 'in_progress'),
                            'not_picked_up', count(*) FILTER (WHERE x->>'status' = 'not_picked_up'))
    INTO v_status FROM jsonb_array_elements(v_att) AS j(x);

  RETURN jsonb_build_object(
    'day', v_day,
    'day_label', to_char(v_day, 'FMDay, Mon FMDD'),
    'metrics', v_row.metrics,
    'prev', v_prev,
    'series', COALESCE(v_series, '{}'::jsonb),
    'mtd', v_mtd,
    'week', v_week,
    'attention', v_att,
    'attention_status', v_status,
    'previous_run', (SELECT jsonb_build_object('day', day, 'status', status, 'sent_at', sent_at) FROM public.sp_daily_digest_runs WHERE day = v_day - 1),
    'snapshot_computed_at', v_row.computed_at,
    'snapshot_compute_ms', v_row.compute_ms,
    'horse_roster', public.fn_ca_horse_roster_digest(v_day),
    'generated_at', clock_timestamp());
END $function$;
