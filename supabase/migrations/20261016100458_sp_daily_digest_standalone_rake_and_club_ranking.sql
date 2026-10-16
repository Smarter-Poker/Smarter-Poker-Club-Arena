-- Daily digest: cash rake and the rake reconciliation count a standalone
-- club's retired cash rake (the Lightning pilot), and rake by club ranks the
-- clubs players sat in instead of the union the ledger books them under.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_sp_daily_metrics_compute(p_day date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
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
    'otp_codes_sent', (SELECT count(*) FROM public.sms_otp_codes WHERE created_at >= s AND created_at < e),
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
    SELECT user_id, COALESCE(transaction_type, type, 'unknown') tt, amount, created_at
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
    'stripe_events', (SELECT jsonb_build_object('total', count(*), 'not_completed', count(*) FILTER (WHERE processing_status IS DISTINCT FROM 'completed'))
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
  SELECT jsonb_build_object(
    'breaks', (SELECT jsonb_build_object('total', count(*), 'passed', count(*) FILTER (WHERE verdict = 'pass'))
                 FROM public.ca_break_scorecards WHERE recorded_at >= s AND recorded_at < e),
    'deploys', (SELECT jsonb_build_object('attempted', count(*), 'shipped', count(*) FILTER (WHERE shipped))
                  FROM public.ca_engine_deploy_attempts WHERE at >= s AND at < e),
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
    'crashes', (SELECT count(*) FROM public.client_crash_log WHERE created_at >= s AND created_at < e),
    'signup_errors', (SELECT count(*) FROM public.signup_errors WHERE occurred_at >= s AND occurred_at < e),
    'probe_failures', COALESCE((SELECT jsonb_object_agg(probe_name, n) FROM (SELECT COALESCE(probe_name,'unknown') probe_name, count(*) n FROM public.probe_heartbeats
         WHERE occurred_at >= s AND occurred_at < e AND status = 'failed' GROUP BY 1) x), '{}'::jsonb),
    -- signals between two horses are the house playing itself; only pairs with a real player count
    'collusion_signals', (SELECT count(*) FROM public.ca_collusion_signals c WHERE c.detected_at >= s AND c.detected_at < e AND NOT COALESCE(c.both_cert,false)
                           AND EXISTS (SELECT 1 FROM smarter_private.sp_real_humans hu WHERE hu.id IN (c.user_a, c.user_b))),
    'collusion_signals_horse_only', (SELECT count(*) FROM public.ca_collusion_signals c WHERE c.detected_at >= s AND c.detected_at < e AND NOT COALESCE(c.both_cert,false)
                           AND NOT EXISTS (SELECT 1 FROM smarter_private.sp_real_humans hu WHERE hu.id IN (c.user_a, c.user_b))),
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
END $fn$;

REVOKE ALL ON FUNCTION public.fn_sp_daily_metrics_compute(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sp_daily_metrics_compute(date) TO service_role;

COMMIT;
