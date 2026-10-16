-- Smarter.Poker Daily Operations Digest (owner request 2026-10-15).
--
-- One email at 7:00 AM Central covering the previous Central day, plus a
-- 5 minute pager for money-critical conditions. The database side is here:
--   * smarter_private.sp_real_humans   - the one "real human" filter (no horses,
--     no certification fixtures, no probes, no anonymous sessions)
--   * public.sp_digest_settings        - tunable thresholds
--   * public.sp_daily_metrics          - one snapshot row per Central day
--   * public.sp_daily_digest_runs      - idempotent send log, one row per day
--   * public.sp_critical_pages         - instant pages, deduped
--   * fn_sp_daily_metrics_compute      - every metric for one Central day
--   * fn_sp_daily_metrics_snapshot     - writes the row, dispatches attention
--   * fn_sp_digest_attention           - the Needs Your Attention rules
--   * fn_sp_daily_digest               - what the email renders (with trends)
--   * fn_sp_digest_claim / _finish     - send log for the World Hub route
--   * fn_sp_critical_scan / _mark      - the 5 minute pager feed
--   * fn_sp_digest_watchdog            - pages if the morning email did not go
-- The World Hub routes /api/cron/daily-digest and /api/cron/critical-pager
-- render and send; they call only these service_role functions.
BEGIN;

CREATE OR REPLACE VIEW smarter_private.sp_real_humans WITH (security_barrier) AS
SELECT p.id, p.created_at, p.last_seen, p.phone_verified, p.is_vip, p.vip_tier,
       p.vip_expires_at, p.referred_by, p.username, u.email_confirmed_at
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
 WHERE NOT COALESCE(p.is_horse, false)
   AND NOT COALESCE(u.is_anonymous, false)
   AND p.id::text NOT LIKE '00000000-0000-0000-0000-%'
   AND COALESCE(u.email, '') !~* '(\.invalid|\.local|\.test|@horses\.smarter\.poker)$'
   AND NOT EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p.id AND c.active);
REVOKE ALL ON smarter_private.sp_real_humans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON smarter_private.sp_real_humans TO service_role;

CREATE TABLE IF NOT EXISTS public.sp_digest_settings (
  key text PRIMARY KEY,
  value numeric NOT NULL,
  note text NOT NULL
);
INSERT INTO public.sp_digest_settings(key, value, note) VALUES
 ('signup_drop_ratio', 0.5, 'Signups below this share of the 7 day average fire Signups Dropped'),
 ('phone_verify_min_rate', 0.5, 'Share of new humans who verified phone below this fires the rule (only with 2+ signups)'),
 ('client_error_spike_ratio', 2, 'Client errors above this multiple of the 7 day average fire Error Spike'),
 ('big_diamond_move', 10000, 'Single diamond movement (outside arena deposits/withdrawals) above this is named'),
 ('cashout_wait_hours', 24, 'Cashout requests pending longer than this fire Cashout Waiting'),
 ('stuck_tournament_hours', 12, 'RUNNING tournaments older than this fire Stuck Tournament'),
 ('horse_stuck_ratio', 0.05, 'Stuck horses above this share of seated fire Horse Fleet Degraded'),
 ('usd_per_diamond', 0.01, 'Diamond package price used for the dollar view'),
 ('critical_lookback_minutes', 30, 'Event-based critical pages only consider rows this recent')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sp_daily_metrics (
  day date PRIMARY KEY,
  metrics jsonb NOT NULL,
  attention jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  compute_ms integer
);

CREATE TABLE IF NOT EXISTS public.sp_daily_digest_runs (
  day date PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('claimed','sent','failed')),
  attempts integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  resend_id text,
  recipients text[],
  subject text,
  ai_summary text,
  digest jsonb,
  error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.sp_critical_pages (
  id bigserial PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  rule text NOT NULL,
  title text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  emailed_at timestamptz,
  sms_at timestamptz,
  alert_event_id bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS sp_critical_pages_unsent ON public.sp_critical_pages (detected_at) WHERE emailed_at IS NULL;

ALTER TABLE public.sp_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_daily_digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_critical_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sp_digest_settings, public.sp_daily_metrics, public.sp_daily_digest_runs, public.sp_critical_pages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sp_digest_settings, public.sp_daily_metrics, public.sp_daily_digest_runs, public.sp_critical_pages TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sp_setting(p_key text, p_default numeric)
RETURNS numeric LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT value FROM public.sp_digest_settings WHERE key = p_key), p_default)
$$;

-- ---------------------------------------------------------------------------
-- Every metric for one Central day. Read only.
-- ---------------------------------------------------------------------------
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
    SELECT r.player_id, r.rake_amount, COALESCE(p.is_horse, false) horse
      FROM public.rake_attributions r LEFT JOIN public.profiles p ON p.id = r.player_id
     WHERE r.club_id IS NOT NULL AND r.created_at >= s AND r.created_at < e)
  SELECT jsonb_build_object(
    'cash_rake', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'rake' AND from_type = 'table_stack'),0),2),
    'tournament_rake', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'rake' AND from_type = 'prize_liability'),0),2),
    'rake_paid_by_humans', round(COALESCE((SELECT sum(rake_amount) FROM ra WHERE NOT horse),0),2),
    'rake_paid_by_horses', round(COALESCE((SELECT sum(rake_amount) FROM ra WHERE horse),0),2),
    'rakeback_paid', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'rakeback'),0),2),
    'commissions_paid', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'commission'),0),2),
    'bbj_contributions', round(COALESCE((SELECT sum(amount) FROM cl WHERE category = 'bbj_contribution'),0),2),
    'minted', round(COALESCE((SELECT sum(amount) FROM cl WHERE from_type IN ('system_mint','issuance_reserve')),0),2),
    'burned', round(COALESCE((SELECT sum(amount) FROM cl WHERE to_type IN ('system_burn','chip_retirement')),0),2),
    'promo_and_leaderboard', round(COALESCE((SELECT sum(amount) FROM cl WHERE category IN ('promo_send','promo','leaderboard_payout','club_opening_allocation')),0),2),
    'rake_by_club', COALESCE((SELECT jsonb_agg(x ORDER BY x.rake DESC) FROM (
         SELECT COALESCE(c.name, 'Unknown') club, round(sum(cl.amount),2) rake
           FROM cl LEFT JOIN public.clubs c ON c.id = cl.club_id
          WHERE cl.category = 'rake' GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb),
    'top_human_rakers', COALESCE((SELECT jsonb_agg(x ORDER BY x.rake DESC) FROM (
         SELECT p.username, round(sum(ra.rake_amount),2) rake FROM ra JOIN public.profiles p ON p.id = ra.player_id
          WHERE NOT ra.horse AND ra.player_id IN (SELECT id FROM smarter_private.sp_real_humans)
          GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb),
    'bbj_pool_total', (SELECT round(COALESCE(sum(COALESCE(main_balance,0)+COALESCE(backup_balance,0)+COALESCE(promo_balance,0)),0),2)
                         FROM public.bbj_pools WHERE merged_into_pool_id IS NULL),
    'supply_unexplained', (SELECT round(COALESCE(sum(unexplained),0),2) FROM public.ca_supply_snapshots
                            WHERE taken_at >= s AND taken_at < e AND unexplained IS NOT NULL),
    'ledger_rake_utc_day', (SELECT round(COALESCE(sum(amount),0),2) FROM public.chip_ledger
                            WHERE created_at >= us AND created_at < ue AND category = 'rake' AND from_type = 'table_stack'),
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
    'big_movements', COALESCE((SELECT jsonb_agg(x) FROM (
         SELECT p.username, dt.tt AS type, dt.amount, to_char(dt.created_at AT TIME ZONE 'America/Chicago','HH12:MI AM') at_ct
           FROM dt LEFT JOIN public.profiles p ON p.id = dt.user_id
          WHERE abs(dt.amount) > v_big AND dt.tt NOT IN ('arena_deposit','arena_withdraw')
          ORDER BY abs(dt.amount) DESC LIMIT 10) x), '[]'::jsonb),
    'usd_per_diamond', v_usd
  ) INTO d;
  d := d || jsonb_build_object(
    'net_issued', (d->>'given_out')::numeric - (d->>'taken_in')::numeric,
    'circulation_usd', round((d->>'circulation')::numeric * v_usd, 2));

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
    'collusion_signals', (SELECT count(*) FROM public.ca_collusion_signals WHERE detected_at >= s AND detected_at < e AND NOT COALESCE(both_cert,false)),
    'beta_accounts_flagged', COALESCE((SELECT jsonb_agg(DISTINCT p.username) FROM public.ca_collusion_signals c
         JOIN public.profiles p ON p.id IN (c.user_a, c.user_b)
        WHERE c.detected_at >= s AND c.detected_at < e AND lower(p.username) IN ('kingfish','danimal')), '[]'::jsonb),
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

-- ---------------------------------------------------------------------------
-- Needs Your Attention. p_live adds conditions read at call time.
-- Each item: rule, severity, title, detail, key (dedupe within the day).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sp_digest_attention(p_day date, p_metrics jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  a jsonb := '[]'::jsonb;
  v numeric; v2 numeric; avg7 numeric; t text; r record;
  prev jsonb;
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

  -- Critical alert names new or doubled vs the prior day
  FOR r IN SELECT key, value::numeric n FROM jsonb_each_text(COALESCE(p_metrics#>'{health,alert_names}','{}'::jsonb)) LOOP
    v2 := COALESCE((prev#>>ARRAY['health','alert_names',r.key])::numeric, 0);
    IF v2 = 0 OR r.n >= 2 * v2 THEN
      a := a || jsonb_build_object('rule','critical_alert_rising','severity','critical',
        'title', format('%s fired %s times (%s the day before)', r.key, r.n, v2), 'detail', jsonb_build_object('alertname', r.key, 'count', r.n, 'prior', v2), 'key', r.key);
    END IF;
  END LOOP;

  v := (SELECT count(*) FROM public.ca_drift_incidents WHERE resolved_at IS NULL AND deadline_at < now());
  IF v > 0 THEN
    a := a || jsonb_build_object('rule','drift_past_deadline','severity','warning',
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
  IF v >= 2 AND v2 < v * public.fn_sp_setting('phone_verify_min_rate',0.5) THEN
    a := a || jsonb_build_object('rule','phone_verification_low','severity','warning',
      'title', format('Only %s of %s new players verified their phone', v2, v), 'detail', jsonb_build_object('signups', v, 'verified', v2));
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
  IF NOT EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day = p_day - 1 AND status = 'sent')
     AND EXISTS (SELECT 1 FROM public.sp_daily_digest_runs) THEN
    a := a || jsonb_build_object('rule','digest_failed','severity','warning','title', format('The digest for %s was not delivered', to_char(p_day - 1,'Mon DD')), 'detail', '{}'::jsonb);
  END IF;

  RETURN a;
END $fn$;

-- ---------------------------------------------------------------------------
-- Write the day's row and hand each attention item to the alert fleet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sp_daily_metrics_snapshot(p_day date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  v_day date := COALESCE(p_day, (now() AT TIME ZONE 'America/Chicago')::date - 1);
  t0 timestamptz := clock_timestamp();
  v_m jsonb; v_a jsonb; it jsonb;
BEGIN
  v_m := public.fn_sp_daily_metrics_compute(v_day);
  INSERT INTO public.sp_daily_metrics(day, metrics, computed_at, compute_ms)
  VALUES (v_day, v_m, clock_timestamp(), (extract(epoch FROM clock_timestamp() - t0) * 1000)::int)
  ON CONFLICT (day) DO UPDATE SET metrics = EXCLUDED.metrics, computed_at = EXCLUDED.computed_at, compute_ms = EXCLUDED.compute_ms;

  v_a := public.fn_sp_digest_attention(v_day, v_m);
  v_a := public.fn_sp_dispatch_attention(v_day, v_a);
  UPDATE public.sp_daily_metrics SET attention = v_a WHERE day = v_day;
  RETURN jsonb_build_object('day', v_day, 'compute_ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::int, 'attention', jsonb_array_length(v_a));
END $fn$;

-- Each attention item becomes (or re-touches) one alert-fleet inbox row; the
-- returned items carry alert_event_id so the email can report its status.
CREATE OR REPLACE FUNCTION public.fn_sp_dispatch_attention(p_day date, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE it jsonb; out jsonb := '[]'::jsonb; v_id bigint;
BEGIN
  FOR it IN SELECT j.x FROM jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) AS j(x) LOOP
    v_id := public.fn_record_operational_alert(
      'sp-daily-digest',
      'sp-digest:' || p_day || ':' || (it->>'rule') || ':' || COALESCE(it->>'key',''),
      'DailyDigest.' || (it->>'rule'),
      'firing',
      it->>'severity',
      jsonb_build_object('target_task_id', '01a09b86-5ba8-7290-8657-1041f13dd3ca',
                         'summary', it->>'title', 'day', p_day, 'detail', it->'detail',
                         'origin', 'Smarter.Poker Daily Digest attention rule'));
    out := out || (it || jsonb_build_object('alert_event_id', v_id));
  END LOOP;
  RETURN out;
END $fn$;

-- ---------------------------------------------------------------------------
-- What the email renders: the day, its trends, and the fleet's progress.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sp_daily_digest(p_day date DEFAULT NULL, p_dispatch boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
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
  ELSE
    -- read-only callers (the online view) only see items already dispatched
    v_live := '[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) INTO v_att FROM (
    SELECT it || jsonb_build_object(
        'status', CASE o.investigation_status
                    WHEN 'verified_fixed' THEN 'fixed' WHEN 'historical' THEN 'fixed'
                    WHEN 'investigating' THEN 'in_progress' ELSE 'not_picked_up' END,
        'resolution', o.investigation->>'resolution') x
      FROM jsonb_array_elements(COALESCE(v_row.attention,'[]'::jsonb) || v_live) AS j(it)
      LEFT JOIN public.operational_alert_events o ON o.id = (it->>'alert_event_id')::bigint) z;
  -- one entry per alert event
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'severity') = 'critical' DESC, x->>'rule'), '[]'::jsonb) INTO v_att FROM (
    SELECT DISTINCT ON (COALESCE(j.x->>'alert_event_id', j.x->>'title')) j.x FROM jsonb_array_elements(v_att) AS j(x)
     ORDER BY COALESCE(x->>'alert_event_id', x->>'title')) q;

  SELECT jsonb_build_object('fixed', count(*) FILTER (WHERE x->>'status' = 'fixed'),
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
    'generated_at', clock_timestamp());
END $fn$;

-- ---------------------------------------------------------------------------
-- Send log: claim once per day; a failed or stale claim may be retried.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sp_digest_claim(p_day date, p_force boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_ok boolean := false;
BEGIN
  INSERT INTO public.sp_daily_digest_runs(day, status) VALUES (p_day, 'claimed')
  ON CONFLICT (day) DO UPDATE SET status = 'claimed', attempts = sp_daily_digest_runs.attempts + 1,
         claimed_at = clock_timestamp(), updated_at = clock_timestamp(), error = NULL
   WHERE p_force
      OR (sp_daily_digest_runs.status = 'failed' AND sp_daily_digest_runs.attempts < 6)
      OR (sp_daily_digest_runs.status = 'claimed' AND sp_daily_digest_runs.claimed_at < clock_timestamp() - interval '15 minutes')
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_sp_digest_finish(p_day date, p_status text, p_resend_id text, p_recipients text[],
                                                       p_subject text, p_ai_summary text, p_digest jsonb, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  UPDATE public.sp_daily_digest_runs
     SET status = p_status, resend_id = p_resend_id, recipients = p_recipients, subject = p_subject,
         ai_summary = p_ai_summary, digest = p_digest, error = left(p_error, 2000),
         sent_at = CASE WHEN p_status = 'sent' THEN clock_timestamp() ELSE sent_at END,
         updated_at = clock_timestamp()
   WHERE day = p_day;
$fn$;

-- ---------------------------------------------------------------------------
-- Instant pager: money-critical conditions found now, deduped, also sent to
-- the alert fleet. Returns pages that still need an email.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sp_critical_scan()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  lb timestamptz := now() - make_interval(mins => public.fn_sp_setting('critical_lookback_minutes',30)::int);
  r record; v_id bigint; v_new int := 0;
BEGIN
  FOR r IN
    WITH pages(dedupe_key, rule, title, detail) AS (
      SELECT 'ledger:' || txid::text || ':' || account_key, 'ledger_findings',
             'Ledger invariant broken on ' || account_key,
             jsonb_build_object('delta', balance_delta, 'ledger_net', ledger_net, 'actor', actor_service, 'found_at', found_at)
        FROM public.ca_ledger_invariant_findings WHERE found_at >= lb
      UNION ALL
      SELECT 'supply:' || id, 'money_not_reconciling', 'Chip supply has ' || round(unexplained,2) || ' unexplained chips',
             jsonb_build_object('snapshot_id', id, 'taken_at', taken_at, 'unexplained', unexplained)
        FROM public.ca_supply_snapshots WHERE taken_at >= lb AND COALESCE(unexplained,0) <> 0
      UNION ALL
      SELECT 'stuck:' || id, 'stuck_tournament',
             tournament_type || ' "' || name || '" is stuck RUNNING since ' || to_char(started_at AT TIME ZONE 'America/Chicago','Mon DD HH12:MI AM'),
             jsonb_build_object('tournament_id', id, 'players', current_players)
        FROM public.tournaments
       WHERE status = 'RUNNING' AND started_at < now() - make_interval(hours => public.fn_sp_setting('stuck_tournament_hours',12)::int)
      UNION ALL
      SELECT 'stripe:' || event_id, 'payment_problem',
             'Stripe webhook ' || COALESCE(event_type,'event') || ' did not complete (' || COALESCE(processing_status,'unknown') || ')',
             jsonb_build_object('event_id', event_id)
        FROM public.stripe_webhook_events
       WHERE processed_at >= lb AND processing_status IN ('failed','error','dead_letter')
      UNION ALL
      SELECT 'dispute:' || id, 'payment_problem', 'Lifetime VIP payment disputed (' || COALESCE(dispute_status,'open') || ')',
             jsonb_build_object('purchase_id', id, 'usd', price_usd)
        FROM public.vip_lifetime_purchases WHERE dispute_id IS NOT NULL AND updated_at >= lb
      UNION ALL
      SELECT 'spins:' || (now() AT TIME ZONE 'America/Chicago')::date, 'spins_underfunded',
             count(*) || ' Diamond Spins or Diamond game hosts are funded below 2,500 diamonds',
             jsonb_build_object('hosts', count(*), 'floor_chips', public.fn_diamond_spins_allowance_floor())
        FROM (SELECT host_id FROM public.wheel_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor()
              UNION ALL
              SELECT host_id FROM public.diamond_game_configs WHERE enabled AND exposure_allowance_chips < public.fn_diamond_spins_allowance_floor()) u
      HAVING count(*) > 0)
    SELECT p.* FROM pages p WHERE NOT EXISTS (SELECT 1 FROM public.sp_critical_pages c WHERE c.dedupe_key = p.dedupe_key)
  LOOP
    v_id := public.fn_record_operational_alert('sp-critical-pager', r.dedupe_key, 'CriticalPage.' || r.rule, 'firing', 'critical',
              jsonb_build_object('target_task_id', '01a09b86-5ba8-7290-8657-1041f13dd3ca', 'summary', r.title, 'detail', r.detail));
    INSERT INTO public.sp_critical_pages(dedupe_key, rule, title, detail, alert_event_id)
    VALUES (r.dedupe_key, r.rule, r.title, r.detail, v_id) ON CONFLICT (dedupe_key) DO NOTHING;
    v_new := v_new + 1;
  END LOOP;

  RETURN jsonb_build_object('new', v_new,
    'pending', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'rule', rule, 'title', title, 'detail', detail,
                                   'detected_at', detected_at, 'attempts', attempts, 'need_email', emailed_at IS NULL, 'need_sms', sms_at IS NULL) ORDER BY id)
                          FROM public.sp_critical_pages WHERE (emailed_at IS NULL OR sms_at IS NULL) AND attempts < 5
                           AND detected_at > now() - interval '1 day'), '[]'::jsonb));
END $fn$;

CREATE OR REPLACE FUNCTION public.fn_sp_critical_mark(p_id bigint, p_emailed boolean, p_sms boolean, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
  UPDATE public.sp_critical_pages
     SET emailed_at = CASE WHEN p_emailed THEN COALESCE(emailed_at, clock_timestamp()) ELSE emailed_at END,
         sms_at = CASE WHEN p_sms THEN COALESCE(sms_at, clock_timestamp()) ELSE sms_at END,
         attempts = attempts + CASE WHEN p_error IS NULL THEN 0 ELSE 1 END,
         last_error = COALESCE(left(p_error, 1000), last_error)
   WHERE id = p_id;
$fn$;

-- Watchdog: 8:15 AM Central, the morning email must have gone out.
CREATE OR REPLACE FUNCTION public.fn_sp_digest_watchdog()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE v_day date := (now() AT TIME ZONE 'America/Chicago')::date - 1; v_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM public.sp_daily_digest_runs WHERE day = v_day AND status = 'sent') THEN
    RETURN 'sent';
  END IF;
  v_id := public.fn_record_operational_alert('sp-daily-digest', 'sp-digest-missing:' || v_day, 'DailyDigest.not_delivered', 'firing', 'critical',
            jsonb_build_object('target_task_id', '01a09b86-5ba8-7290-8657-1041f13dd3ca',
                               'summary', 'The Smarter.Poker daily digest for ' || v_day || ' was not delivered by 8:15 AM Central',
                               'run', (SELECT to_jsonb(r) - 'digest' FROM public.sp_daily_digest_runs r WHERE day = v_day)));
  INSERT INTO public.sp_critical_pages(dedupe_key, rule, title, detail, alert_event_id)
  VALUES ('digest-missing:' || v_day, 'digest_failed', 'The daily digest for ' || to_char(v_day,'Mon DD') || ' was not delivered',
          jsonb_build_object('day', v_day), v_id)
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN 'paged';
END $fn$;

DO $g$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.fn_sp_setting(text,numeric)',
    'public.fn_sp_daily_metrics_compute(date)',
    'public.fn_sp_digest_attention(date,jsonb)',
    'public.fn_sp_dispatch_attention(date,jsonb)',
    'public.fn_sp_daily_metrics_snapshot(date)',
    'public.fn_sp_daily_digest(date,boolean)',
    'public.fn_sp_digest_claim(date,boolean)',
    'public.fn_sp_digest_finish(date,text,text,text[],text,text,jsonb,text)',
    'public.fn_sp_critical_scan()',
    'public.fn_sp_critical_mark(bigint,boolean,boolean,text)',
    'public.fn_sp_digest_watchdog()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $g$;

-- periodic-work: the daily digest is a report, not compensation. The snapshot
-- records the finished Central day at 12:15 AM (retried at 12:45 and 1:15 AM
-- only if that row is missing); the watchdog checks at
-- 8:15 AM Central that the morning email went out. Both run at two UTC hours
-- and act only on the Central-time match so daylight saving cannot move them.
SELECT cron.schedule('sp-daily-metrics-snapshot', '15,45 5,6 * * *',
  $c$SET statement_timeout = '600s'; SELECT public.fn_sp_daily_metrics_snapshot()
     WHERE to_char(clock_timestamp() AT TIME ZONE 'America/Chicago','HH24:MI') = '00:15'
        OR (to_char(clock_timestamp() AT TIME ZONE 'America/Chicago','HH24:MI') IN ('00:45','01:15')
            AND NOT EXISTS (SELECT 1 FROM public.sp_daily_metrics WHERE day = (clock_timestamp() AT TIME ZONE 'America/Chicago')::date - 1));$c$);
SELECT cron.schedule('sp-daily-digest-watchdog', '15 13,14 * * *',
  $c$SELECT public.fn_sp_digest_watchdog() WHERE to_char(clock_timestamp() AT TIME ZONE 'America/Chicago','HH24:MI') = '08:15';$c$);

COMMIT;
