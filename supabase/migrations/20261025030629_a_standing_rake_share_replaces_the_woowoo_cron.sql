-- 20261025030629_a_standing_rake_share_replaces_the_woowoo_cron.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.11 and 10.12):
--
-- Owner ruling, Dan 2026-10-24: from 2026-10-24 22:21:59.97593 UTC, half of
-- WooWoo's (69f2cefa) earned rake in KINGS CLUB (a41434bb) is reported as
-- KingFish's (47965354). Reporting only: no chips move, and no settled hand,
-- rake attribution, commission, rakeback or wallet row is touched.
--
-- It reached production out of band, as migration 20261024223153
-- (woowoo_half_earned_rake_credited_to_kingfish, recorded byte-exact beside
-- this file) plus one hand-written row:
--   * the CHECK on smarter_private.player_fee_redemptions.amount_cents was
--     widened from > 0 to <> 0, so a row can credit a player;
--   * 'woowoo-half-earned-rake-20261024' (+520.52, written with no migration)
--     and 'kingfish-from-woowoo-half-earned-rake-20261024' (-520.52) moved the
--     half of the rake WooWoo had already earned;
--   * smarter_private.fn_woowoo_half_rake_to_kingfish_sync(), run by pg_cron
--     job 'woowoo-half-rake-to-kingfish' every five minutes, regrouped
--     WooWoo's later cash hands by UTC day and upserted a
--     'woowoo-half-split-<day>' / 'kingfish-from-woowoo-split-<day>' pair.
--
-- The cron is a compensating write (10.12): the reported figures trail the
-- hands by up to five minutes, and the rule exists only as constants inside a
-- function body. The root fix is a declared rule that the three readers apply
-- at read time, from the same rows they already count:
--
--   smarter_private.player_rake_share_rules   one row per standing share
--   public.ca_club_member_fee_totals          Cash Fees, member statistics,
--                                             roster and exports; applies the
--                                             share to the rake_attributions
--                                             rows its daily rollup is built
--                                             from (same day, same filters)
--   public.ca_player_rake_stats               player rake statistics; applies
--   public.ca_player_rake_stats_by_club       it to the cash hand facts they
--                                             read, attributed to the funded
--                                             club exactly as by_club resolves it
--
-- Rounding is the cron's: per rule and UTC day, round(rake * share), so the
-- player who gives and the player who receives move by the same cents.
--
-- In the same transaction the cron job is unscheduled, the sync function is
-- dropped, and only the '*-split-<day>' rows it wrote are deleted. The two
-- fixed 520.52 rows and the October 23 lifetime-VIP row stay as declared
-- one-off events.
--
-- ASSERTED BEFORE COMMIT, against one REPEATABLE READ snapshot, so the board
-- cannot move between the before and after reads:
--   * each reader body and the sync body are the exact ones this replaces;
--   * the fixed rows hold their declared figures; a split row for the closed
--     day 2026-10-24 is exactly 44.74 each way, and every closed day's split
--     equals the rule's share of that day to the cent;
--   * for WooWoo and KingFish, lifetime and 7-day, each reader's new figure is
--     its old figure moved by exactly the lag the cron had not yet written
--     (WooWoo down, KingFish up by the same cents), and that lag is never
--     negative.
--
-- Not a hot-table migration: it locks only the service-only redemption table,
-- the new rule table and three reporting functions.

BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

-- 1. Refuse anything but the exact bodies this was written against. ----------
DO $guard$
DECLARE
  v_fee  text := (SELECT md5(prosrc) FROM pg_proc
                   WHERE oid = 'public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure);
  v_all  text := (SELECT md5(prosrc) FROM pg_proc
                   WHERE oid = 'public.ca_player_rake_stats(uuid,integer,text)'::regprocedure);
  v_club text := (SELECT md5(prosrc) FROM pg_proc
                   WHERE oid = 'public.ca_player_rake_stats_by_club(uuid,integer,text,uuid)'::regprocedure);
  v_sync text := (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'smarter_private'
                     AND p.proname = 'fn_woowoo_half_rake_to_kingfish_sync');
BEGIN
  IF v_fee IS DISTINCT FROM '880e4cb61670362810c397980e763abc' THEN
    RAISE EXCEPTION 'ca_club_member_fee_totals changed (%); nothing changed', v_fee;
  END IF;
  IF v_all IS DISTINCT FROM '58d29df1098c97800ea79759b6f67dd5' THEN
    RAISE EXCEPTION 'ca_player_rake_stats changed (%); nothing changed', v_all;
  END IF;
  IF v_club IS DISTINCT FROM '28ef1947a0bf2b455ea3addb95d5589a' THEN
    RAISE EXCEPTION 'ca_player_rake_stats_by_club changed (%); nothing changed', v_club;
  END IF;
  IF v_sync IS DISTINCT FROM '07856466d30eb04ce34698e82110c1f7' THEN
    RAISE EXCEPTION 'fn_woowoo_half_rake_to_kingfish_sync is not the recorded body (%); nothing changed', v_sync;
  END IF;
  IF to_regclass('smarter_private.player_rake_share_rules') IS NOT NULL THEN
    RAISE EXCEPTION 'player_rake_share_rules already exists; nothing changed';
  END IF;
  -- One retirement of the cron, not two. A write-time split (PR #7995:
  -- smarter_private.tr_woowoo_half_rake_split on public.ca_hand_facts) writes
  -- the same split rows this removes; with both, the share would count twice.
  IF to_regprocedure('smarter_private.tr_woowoo_half_rake_split()') IS NOT NULL
     OR to_regprocedure('smarter_private.fn_woowoo_half_rake_day_cents(date)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t
                 WHERE t.tgrelid = 'public.ca_hand_facts'::regclass AND NOT t.tgisinternal
                   AND t.tgfoid::regproc::text ILIKE '%woowoo%') THEN
    RAISE EXCEPTION 'a write-time WooWoo split is installed; one retirement of the cron only; nothing changed';
  END IF;
END
$guard$;

-- 2. Record the out-of-band state as declared one-off events. ---------------
DO $check$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'smarter_private.player_fee_redemptions'::regclass
         AND c.conname = 'player_fee_redemptions_amount_cents_check')
     IS DISTINCT FROM 'CHECK ((amount_cents <> 0))' THEN
    ALTER TABLE smarter_private.player_fee_redemptions
      DROP CONSTRAINT IF EXISTS player_fee_redemptions_amount_cents_check;
    ALTER TABLE smarter_private.player_fee_redemptions
      ADD CONSTRAINT player_fee_redemptions_amount_cents_check CHECK (amount_cents <> 0);
  END IF;
END
$check$;

INSERT INTO smarter_private.player_fee_redemptions
  (operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
VALUES
  ('woowoo-half-earned-rake-20261024',
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4', '69f2cefa-017d-49f3-ac3e-61505633747c',
   '2026-10-24', 52052,
   'Owner-directed (Dan, 2026-10-24): remove 50% of WooWoo''s current earned rake (1041.03 net after the Oct 23 redemption -> 520.52 removed) and stop crediting him for half of his fees. Reporting redemption only; no refund and no change to settled financial records.',
   '2026-10-24 22:21:59.97593+00'),
  ('kingfish-from-woowoo-half-earned-rake-20261024',
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4', '47965354-0e56-43ef-931c-ddaab82af765',
   '2026-10-24', -52052,
   'Owner-directed (Dan, 2026-10-24): the 520.52 of earned rake removed from WooWoo is credited to KingFish. Reporting credit only; no chip movement.',
   '2026-10-24 22:31:53.236984+00')
ON CONFLICT (operation_key) DO NOTHING;

DO $fixed$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM smarter_private.player_fee_redemptions r
   WHERE (r.operation_key, r.club_id, r.user_id, r.effective_on, r.amount_cents) IN (
     ('woowoo-lifetime-vip-20261023', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
      '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid, '2026-10-23'::date, 32233::bigint),
     ('woowoo-half-earned-rake-20261024', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
      '69f2cefa-017d-49f3-ac3e-61505633747c'::uuid, '2026-10-24'::date, 52052::bigint),
     ('kingfish-from-woowoo-half-earned-rake-20261024', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
      '47965354-0e56-43ef-931c-ddaab82af765'::uuid, '2026-10-24'::date, -52052::bigint));
  IF n <> 3 THEN
    RAISE EXCEPTION 'the three declared fee events do not hold their figures (% of 3); nothing changed', n;
  END IF;
  -- Every other row must be a split row the cron wrote, or a row this was not
  -- written against is about to be read differently.
  IF EXISTS (SELECT 1 FROM smarter_private.player_fee_redemptions r
              WHERE r.operation_key NOT IN ('woowoo-lifetime-vip-20261023',
                                            'woowoo-half-earned-rake-20261024',
                                            'kingfish-from-woowoo-half-earned-rake-20261024')
                AND NOT (r.club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
                         AND ((r.operation_key = 'woowoo-half-split-' || r.effective_on
                               AND r.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c' AND r.amount_cents > 0)
                           OR (r.operation_key = 'kingfish-from-woowoo-split-' || r.effective_on
                               AND r.user_id = '47965354-0e56-43ef-931c-ddaab82af765' AND r.amount_cents < 0)))) THEN
    RAISE EXCEPTION 'an unexpected fee redemption row exists; nothing changed';
  END IF;
  -- The cron always wrote both halves of a day with the same cents.
  IF EXISTS (SELECT 1
               FROM (SELECT * FROM smarter_private.player_fee_redemptions
                      WHERE operation_key LIKE 'woowoo-half-split-%') w
               FULL JOIN (SELECT * FROM smarter_private.player_fee_redemptions
                           WHERE operation_key LIKE 'kingfish-from-woowoo-split-%') k
                 ON k.effective_on = w.effective_on
              WHERE w.operation_key IS NULL OR k.operation_key IS NULL
                 OR w.amount_cents <> -k.amount_cents) THEN
    RAISE EXCEPTION 'split rows are not paired; nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM smarter_private.player_fee_redemptions r
              WHERE r.operation_key = 'woowoo-half-split-2026-10-24' AND r.amount_cents <> 4474) THEN
    RAISE EXCEPTION 'the closed 2026-10-24 split is not 44.74; nothing changed';
  END IF;
END
$fixed$;

-- 3. Read every figure the readers report today, before anything changes. ----
CREATE TEMP TABLE rake_share_cutover (
  probe text NOT NULL, user_id uuid NOT NULL, before_value numeric, after_value numeric,
  PRIMARY KEY (probe, user_id)
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.rake_share_cutover_read(p_user uuid)
RETURNS TABLE(probe text, value numeric) LANGUAGE plpgsql AS $read$
DECLARE c constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  v_claims constant text := coalesce(current_setting('request.jwt.claims', true), '{}');
BEGIN
  -- by_club checks the caller; read as the service role, then restore.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  probe := 'fee_totals'; value := coalesce((SELECT t.cash_fees FROM public.ca_club_member_fee_totals(c, NULL, NULL, p_user) t), 0); RETURN NEXT;
  probe := 'rake_stats_all'; value := (public.ca_player_rake_stats(p_user, NULL, 'chips')->>'rake_paid')::numeric; RETURN NEXT;
  probe := 'rake_stats_7'; value := (public.ca_player_rake_stats(p_user, 7, 'chips')->>'rake_paid')::numeric; RETURN NEXT;
  probe := 'by_club_all'; value := (public.ca_player_rake_stats_by_club(p_user, NULL, 'chips', c)->>'rake_paid')::numeric; RETURN NEXT;
  probe := 'by_club_7'; value := (public.ca_player_rake_stats_by_club(p_user, 7, 'chips', c)->>'rake_paid')::numeric; RETURN NEXT;
  PERFORM set_config('request.jwt.claims', v_claims, true);
END
$read$;

INSERT INTO rake_share_cutover (probe, user_id, before_value)
SELECT r.probe, u.id, r.value
  FROM (VALUES ('69f2cefa-017d-49f3-ac3e-61505633747c'::uuid),
               ('47965354-0e56-43ef-931c-ddaab82af765'::uuid)) u(id),
       LATERAL pg_temp.rake_share_cutover_read(u.id) r;

-- 4. The declared rule. --------------------------------------------------------
CREATE TABLE smarter_private.player_rake_share_rules (
  rule_key text PRIMARY KEY,
  club_id uuid NOT NULL,
  from_user uuid NOT NULL,
  to_user uuid NOT NULL,
  -- Basis points of from_user's rake reported as to_user's: 5000 is half.
  share_bps integer NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  -- Inclusive: hands from this instant. effective_until is exclusive, and NULL
  -- means the rule stands. End a rule by setting it, never by deleting it.
  effective_from timestamptz NOT NULL CHECK (isfinite(effective_from)),
  effective_until timestamptz CHECK (effective_until IS NULL OR effective_until > effective_from),
  reason text NOT NULL CHECK (length(reason) >= 40),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user <> to_user)
);
ALTER TABLE smarter_private.player_rake_share_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.player_rake_share_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON smarter_private.player_rake_share_rules TO service_role;

INSERT INTO smarter_private.player_rake_share_rules
  (rule_key, club_id, from_user, to_user, share_bps, effective_from, reason, recorded_at)
VALUES
  ('woowoo-half-rake-to-kingfish-20261024',
   'a41434bb-8d0c-400a-8f0d-e8b3d65afed4', '69f2cefa-017d-49f3-ac3e-61505633747c',
   '47965354-0e56-43ef-931c-ddaab82af765', 5000, '2026-10-24 22:21:59.97593+00',
   'Owner ruling (Dan, 2026-10-24): half of WooWoo''s earned rake in KINGS CLUB from the first cut onward is reported as KingFish''s. Reporting only; no chip movement and no settled record changes.',
   '2026-10-24 22:31:53.236984+00');

-- 5. The share of one player's cash hand facts, by funded club and UTC day. ---
-- Signed for p_user: negative where p_user gives, positive where p_user
-- receives. The funded club is resolved exactly as ca_player_rake_stats_by_club
-- resolves it for a cash hand: buy-in receipt, then rake attribution, then the
-- table's club. Rounded per rule and day, as the cron rounded it.
CREATE FUNCTION smarter_private.fn_player_rake_share_hand_cents(
  p_user uuid, p_since timestamptz, p_asset text)
RETURNS TABLE(share_club_id uuid, share_day date, share_cents bigint)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH rules AS MATERIALIZED (
    SELECT r.rule_key, r.club_id, r.from_user, r.to_user, r.share_bps,
           greatest(r.effective_from, coalesce(p_since, '-infinity'::timestamptz)) AS from_at,
           r.effective_until
      FROM smarter_private.player_rake_share_rules r
      JOIN public.clubs c ON c.id = r.club_id
     WHERE p_user IN (r.from_user, r.to_user)
       AND coalesce(c.asset, 'chips') = p_asset
  ), receipts AS MATERIALIZED (
    SELECT DISTINCT ON (fr.table_id, fr.account_entity_id, fr.seat_joined_at)
           fr.table_id, fr.account_entity_id, fr.seat_joined_at, fr.funding_club_id
      FROM public.cash_participant_funding_receipts fr
     WHERE fr.account_entity_id IN (SELECT rules.from_user FROM rules)
       AND fr.operation_kind = 'buyin'
     ORDER BY fr.table_id, fr.account_entity_id, fr.seat_joined_at, fr.recorded_at DESC, fr.id DESC
  ), funding AS MATERIALIZED (
    SELECT x.*, lead(x.seat_joined_at) OVER (
             PARTITION BY x.table_id, x.account_entity_id ORDER BY x.seat_joined_at) AS until_at
      FROM receipts x
  ), shared AS (
    SELECT r.rule_key, r.club_id, r.from_user, r.share_bps,
           (f.played_at AT TIME ZONE 'UTC')::date AS day,
           sum(coalesce(f.rake_paid, 0)) AS rake
      FROM rules r
      JOIN public.ca_hand_facts f
        ON f.user_id = r.from_user AND f.tournament_id IS NULL
       AND f.played_at >= r.from_at
       AND (r.effective_until IS NULL OR f.played_at < r.effective_until)
      LEFT JOIN funding x
        ON x.account_entity_id = f.user_id AND x.table_id = f.table_id
       AND f.played_at >= x.seat_joined_at AND (x.until_at IS NULL OR f.played_at < x.until_at)
      LEFT JOIN public.rake_attributions ra
        ON x.funding_club_id IS NULL AND ra.hand_id = f.hand_id AND ra.player_id = f.user_id
     WHERE coalesce(x.funding_club_id, ra.club_id, f.club_id) = r.club_id
     GROUP BY r.rule_key, r.club_id, r.from_user, r.share_bps, 5
  )
  SELECT s.club_id, s.day,
         (CASE WHEN s.from_user = p_user THEN -1 ELSE 1 END)
           * round(s.rake * s.share_bps / 100)::bigint
    FROM shared s;
$function$;
REVOKE ALL ON FUNCTION smarter_private.fn_player_rake_share_hand_cents(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION smarter_private.fn_player_rake_share_hand_cents(uuid, timestamptz, text) TO service_role;

-- 6. The three readers apply the rule at read time. ---------------------------
CREATE OR REPLACE FUNCTION public.ca_club_member_fee_totals(p_club_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(user_id uuid, cash_fees numeric, tournament_fees numeric, total_fees numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT greatest(coalesce(p_from, public.fn_ca_fee_counting_start()),
                    public.fn_ca_fee_counting_start()) AS from_day
  ), share AS (
    -- A standing rake share, from the rake_attributions rows the daily rollup
    -- counts (same day key, same filters), rounded per rule and day.
    SELECT r.club_id, r.from_user, r.to_user,
           (ra.created_at AT TIME ZONE 'UTC')::date AS day,
           round(sum(round(ra.rake_amount * 100)) * r.share_bps / 10000.0)::bigint AS cents
      FROM smarter_private.player_rake_share_rules r
      JOIN public.rake_attributions ra
        ON ra.club_id = r.club_id AND ra.player_id = r.from_user
       AND ra.created_at >= r.effective_from
       AND (r.effective_until IS NULL OR ra.created_at < r.effective_until)
     WHERE r.club_id = p_club_id
       AND ra.rake_amount > 0
       AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
     GROUP BY r.rule_key, r.club_id, r.from_user, r.to_user, r.share_bps, 4
  ), cash AS (
    SELECT d.user_id AS uid, sum(d.rake_cents)::numeric / 100 AS fees
      FROM (SELECT club_id,user_id,day,rake_cents FROM public.ca_club_rake_daily_user
       UNION ALL
       SELECT club_id,user_id,effective_on,-amount_cents
         FROM smarter_private.player_fee_redemptions
       UNION ALL
       SELECT club_id,from_user,day,-cents FROM share
       UNION ALL
       SELECT club_id,to_user,day,cents FROM share) d, bounds b
     WHERE d.club_id = p_club_id
       AND (p_user_id IS NULL OR d.user_id = p_user_id)
       AND d.day >= b.from_day
       AND (p_to IS NULL OR d.day <= p_to)
     GROUP BY d.user_id
  ), mtt AS (
    SELECT t.user_id AS uid, sum(t.fees) AS fees
      FROM public.ca_club_member_tournament_fee_daily t, bounds b
     WHERE t.club_id = p_club_id
       AND (p_user_id IS NULL OR t.user_id = p_user_id)
       AND t.day >= b.from_day
       AND (p_to IS NULL OR t.day <= p_to)
     GROUP BY t.user_id
  )
  SELECT coalesce(c.uid, m.uid),
         round(coalesce(c.fees, 0), 2),
         round(coalesce(m.fees, 0), 2),
         round(coalesce(c.fees, 0) + coalesce(m.fees, 0), 2)
    FROM cash c
    FULL JOIN mtt m ON m.uid = c.uid;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_rake_stats(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee_redemption numeric := 0;
  v_rake_share numeric := 0;
  v_uid uuid;
  v_since timestamptz;
  v_hands bigint := 0;
  v_raked_hands bigint := 0;
  v_rake numeric := 0;
  v_bb numeric := 0;
  v_first timestamptz;
  v_last timestamptz;
BEGIN
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  IF public.fn_caller_is_engine() THEN
    v_uid := coalesce(p_user, auth.uid());
  ELSE
    v_uid := auth.uid();
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'hands', 0, 'raked_hands', 0, 'rake_paid', 0,
      'rake_per_100', 0, 'rake_in_bb', 0, 'days', p_days
    );
  END IF;

  v_since := CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz
                  ELSE now() - make_interval(days => greatest(p_days, 1)) END;

  SELECT count(*),
         count(*) FILTER (WHERE coalesce(f.rake_paid, 0) > 0),
         coalesce(sum(f.rake_paid), 0),
         coalesce(sum(CASE WHEN f.big_blind > 0 THEN f.rake_paid / f.big_blind ELSE 0 END), 0),
         min(f.played_at),
         max(f.played_at)
  INTO v_hands, v_raked_hands, v_rake, v_bb, v_first, v_last
  FROM public.ca_hand_facts f
  WHERE f.user_id = v_uid
    AND f.played_at >= v_since
    AND f.tournament_id IS NULL
    AND coalesce(f.club_id IN (SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds'), false) = (p_asset = 'diamonds');


  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (p_days IS NULL OR r.effective_on >=
       (now()-make_interval(days=>greatest(p_days,1)))::date)
     ;
  -- A standing rake share (smarter_private.player_rake_share_rules), from the
  -- same hands: negative where this player gives, positive where it receives.
  SELECT coalesce(sum(s.share_cents),0)::numeric / 100
    INTO v_rake_share
    FROM smarter_private.fn_player_rake_share_hand_cents(v_uid, v_since, p_asset) s;
  v_fee_redemption := v_fee_redemption - v_rake_share;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('fee_redemption',v_fee_redemption,
    'rake_share',v_rake_share,
    'gross_rake_paid',round(v_rake + v_fee_redemption,2),
    'hands', v_hands,
    'raked_hands', v_raked_hands,
    'rake_paid', round(v_rake, 2),
    'rake_per_100', CASE WHEN v_hands > 0 THEN round(v_rake * 100.0 / v_hands, 2) ELSE 0 END,
    'rake_in_bb', round(v_bb, 2),
    'bb_per_100', CASE WHEN v_hands > 0 THEN round(v_bb * 100.0 / v_hands, 2) ELSE 0 END,
    'avg_rake_per_raked_hand',
      CASE WHEN v_raked_hands > 0 THEN round(v_rake / v_raked_hands, 4) ELSE 0 END,
    'first_hand_at', v_first,
    'last_hand_at', v_last,
    'days', p_days
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_player_rake_stats_by_club(p_user uuid DEFAULT NULL::uuid, p_days integer DEFAULT NULL::integer, p_asset text DEFAULT 'chips'::text, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fee_redemption numeric := 0; v_rake_share numeric := 0; v_uid uuid:=coalesce(p_user,auth.uid()); v_hands bigint;
  v_raked bigint; v_rake numeric; v_bb numeric; v_first timestamptz; v_last timestamptz;
BEGIN
  -- funded_stats_scope: historical funding, original caller gates.
  PERFORM public.ca_assert_player_stats_club(v_uid,p_club_id,p_asset);
  SELECT count(*),count(*) FILTER(WHERE coalesce(rake_paid,0)>0),coalesce(sum(rake_paid),0),
    coalesce(sum(CASE WHEN big_blind>0 THEN rake_paid/big_blind ELSE 0 END),0),
    min(played_at),max(played_at) INTO v_hands,v_raked,v_rake,v_bb,v_first,v_last
  FROM (
 WITH receipts AS MATERIALIZED (
  SELECT DISTINCT ON(table_id,account_entity_id,seat_joined_at)
   table_id,account_entity_id,seat_joined_at,funding_club_id
  FROM public.cash_participant_funding_receipts
  WHERE account_entity_id=v_uid AND operation_kind='buyin'
  ORDER BY table_id,account_entity_id,seat_joined_at,recorded_at DESC,id DESC
 ), funding AS MATERIALIZED (
  SELECT *,lead(seat_joined_at) OVER(PARTITION BY table_id,account_entity_id ORDER BY seat_joined_at) until_at
  FROM receipts
 )
 SELECT fact.*,coalesce(x.funding_club_id,tp.club_id,ra.club_id,fact.club_id) funded_club
 FROM public.ca_hand_facts fact
 LEFT JOIN funding x ON fact.tournament_id IS NULL AND x.table_id=fact.table_id
  AND fact.played_at>=x.seat_joined_at AND (x.until_at IS NULL OR fact.played_at<x.until_at)
 LEFT JOIN public.tournament_players tp ON tp.tournament_id=fact.tournament_id AND tp.user_id=fact.user_id
 LEFT JOIN public.rake_attributions ra ON x.funding_club_id IS NULL AND tp.club_id IS NULL
  AND ra.hand_id=fact.hand_id AND ra.player_id=fact.user_id
 WHERE fact.user_id=v_uid
 ) funded_stats_scope WHERE user_id=v_uid AND funded_club=p_club_id AND tournament_id IS NULL
    AND (p_days IS NULL OR played_at>=now()-make_interval(days=>least(greatest(p_days,1),3650)));

  SELECT coalesce(sum(r.amount_cents),0)::numeric / 100
    INTO v_fee_redemption
    FROM smarter_private.player_fee_redemptions r
   WHERE r.user_id=v_uid AND p_asset='chips'
     AND (p_days IS NULL OR r.effective_on >=
       (now()-make_interval(days=>least(greatest(p_days,1),3650)))::date)
     AND r.club_id=p_club_id;
  -- A standing rake share (smarter_private.player_rake_share_rules), from the
  -- same funded hands: negative where this player gives, positive where it receives.
  SELECT coalesce(sum(s.share_cents),0)::numeric / 100
    INTO v_rake_share
    FROM smarter_private.fn_player_rake_share_hand_cents(v_uid,
           CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz
                ELSE now()-make_interval(days=>least(greatest(p_days,1),3650)) END,
           p_asset) s
   WHERE s.share_club_id=p_club_id;
  v_fee_redemption := v_fee_redemption - v_rake_share;
  v_rake := v_rake - v_fee_redemption;
  RETURN jsonb_build_object('fee_redemption',v_fee_redemption,'rake_share',v_rake_share,
    'gross_rake_paid',round(v_rake + v_fee_redemption,2),'contract_version',2,
    'scope',jsonb_build_object('target_user_id',v_uid,'club_id',p_club_id,'asset',p_asset,
      'range_days',CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END,'visibility','owner'),
    'hands',v_hands,'raked_hands',v_raked,'rake_paid',round(v_rake,2),
    'rake_per_100',CASE WHEN v_hands>0 THEN round(v_rake*100/v_hands,2) ELSE 0 END,
    'rake_in_bb',round(v_bb,2),'bb_per_100',CASE WHEN v_hands>0 THEN round(v_bb*100/v_hands,2) ELSE 0 END,
    'avg_rake_per_raked_hand',CASE WHEN v_raked>0 THEN round(v_rake/v_raked,4) ELSE 0 END,
    'first_hand_at',v_first,'last_hand_at',v_last,'days',
      CASE WHEN p_days IS NULL THEN NULL ELSE least(greatest(p_days,1),3650) END);
END;$function$;

-- 7. Retire the compensating write: job, function, and only its own rows. ----
-- The lag the cron had not yet written, per reader source, from this snapshot.
CREATE TEMP TABLE rake_share_cutover_split ON COMMIT DROP AS
SELECT r.operation_key, r.user_id, r.effective_on, r.amount_cents
  FROM smarter_private.player_fee_redemptions r
 WHERE r.club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
   AND ((r.operation_key = 'woowoo-half-split-' || r.effective_on
         AND r.user_id = '69f2cefa-017d-49f3-ac3e-61505633747c')
     OR (r.operation_key = 'kingfish-from-woowoo-split-' || r.effective_on
         AND r.user_id = '47965354-0e56-43ef-931c-ddaab82af765'));

DO $retire$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    -- Job 505 in production, owned by postgres, the installing role.
    IF EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'woowoo-half-rake-to-kingfish') THEN
      PERFORM cron.unschedule('woowoo-half-rake-to-kingfish');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job j
                WHERE j.command ILIKE '%player_fee_redemptions%'
                   OR j.command ILIKE '%fn_woowoo_half_rake_to_kingfish_sync%'
                   OR j.command ILIKE '%player_rake_share_rules%') THEN
      RAISE EXCEPTION 'a cron job still writes the fee redemptions; nothing changed';
    END IF;
  END IF;
END
$retire$;

DROP FUNCTION smarter_private.fn_woowoo_half_rake_to_kingfish_sync();

DELETE FROM smarter_private.player_fee_redemptions r
 USING rake_share_cutover_split s
 WHERE r.operation_key = s.operation_key;

-- 8. Prove the cutover against the same snapshot, then commit. --------------
UPDATE rake_share_cutover c
   SET after_value = r.value
  FROM (SELECT u.id, x.probe, x.value
          FROM (VALUES ('69f2cefa-017d-49f3-ac3e-61505633747c'::uuid),
                       ('47965354-0e56-43ef-931c-ddaab82af765'::uuid)) u(id),
               LATERAL pg_temp.rake_share_cutover_read(u.id) x) r
 WHERE c.user_id = r.id AND c.probe = r.probe;

DO $prove$
DECLARE
  c_w constant uuid := '69f2cefa-017d-49f3-ac3e-61505633747c';
  c_k constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_club constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  v_split_all numeric; v_split_7 numeric; v_share_all numeric; v_share_7 numeric;
  v_ra_share numeric; v_lag jsonb := '{}'::jsonb; v_expected numeric; r record; d record;
  v_since7 timestamptz := now() - make_interval(days => 7);
BEGIN
  IF (SELECT count(*) FROM rake_share_cutover WHERE after_value IS NOT NULL) <> 10 THEN
    RAISE EXCEPTION 'cutover readback incomplete; nothing changed';
  END IF;

  -- What the cron had written for WooWoo, in each reader's old window.
  SELECT coalesce(sum(amount_cents), 0) / 100.0 INTO v_split_all
    FROM rake_share_cutover_split WHERE user_id = c_w;
  SELECT coalesce(sum(amount_cents), 0) / 100.0 INTO v_split_7
    FROM rake_share_cutover_split WHERE user_id = c_w AND effective_on >= v_since7::date;
  -- What the rule now reports for WooWoo (a give is negative).
  SELECT -coalesce(sum(share_cents), 0) / 100.0 INTO v_share_all
    FROM smarter_private.fn_player_rake_share_hand_cents(c_w, '-infinity', 'chips') WHERE share_club_id = c_club;
  SELECT -coalesce(sum(share_cents), 0) / 100.0 INTO v_share_7
    FROM smarter_private.fn_player_rake_share_hand_cents(c_w, v_since7, 'chips') WHERE share_club_id = c_club;
  SELECT coalesce(sum(round(x.cents)), 0) / 100.0 INTO v_ra_share FROM (
    SELECT round(sum(round(ra.rake_amount * 100)) * 0.5) AS cents
      FROM public.rake_attributions ra
     WHERE ra.club_id = c_club AND ra.player_id = c_w AND ra.rake_amount > 0
       AND ra.created_at >= '2026-10-24 22:21:59.97593+00'
       AND (ra.created_at AT TIME ZONE 'UTC')::date >= public.fn_ca_fee_counting_start()
       AND public.fn_ca_launch_accounting_accepts(ra.club_id,(SELECT rr.created_at FROM public.rake_records rr WHERE rr.id=ra.rake_record_id))
     GROUP BY (ra.created_at AT TIME ZONE 'UTC')::date) x;

  -- A trailing cron never wrote more than the hands held.
  IF v_share_all < v_split_all OR v_share_7 < v_split_7 THEN
    RAISE EXCEPTION 'the rule reports less than the cron wrote (% < %); nothing changed', v_share_all, v_split_all;
  END IF;
  -- A closed day (ten minutes past midnight UTC) was fully written: to the cent.
  FOR d IN SELECT s.effective_on, s.amount_cents FROM rake_share_cutover_split s
            WHERE s.user_id = c_w
              AND ((s.effective_on + 1)::timestamp AT TIME ZONE 'UTC') + interval '10 minutes' <= now() LOOP
    IF (SELECT -coalesce(sum(h.share_cents), 0)
          FROM smarter_private.fn_player_rake_share_hand_cents(c_w, '-infinity', 'chips') h
         WHERE h.share_club_id = c_club AND h.share_day = d.effective_on) <> d.amount_cents THEN
      RAISE EXCEPTION 'closed day % does not match the cron to the cent; nothing changed', d.effective_on;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM rake_share_cutover LOOP
    v_expected := r.before_value + (CASE WHEN r.user_id = c_w THEN 1 ELSE -1 END) *
      CASE r.probe
        WHEN 'fee_totals'     THEN v_split_all - v_ra_share
        WHEN 'rake_stats_all' THEN v_split_all - v_share_all
        WHEN 'by_club_all'    THEN v_split_all - v_share_all
        ELSE                       v_split_7 - v_share_7
      END;
    IF r.after_value IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION '% for % reads % after the cutover, expected % (before %); nothing changed',
        r.probe, r.user_id, r.after_value, v_expected, r.before_value;
    END IF;
  END LOOP;

  RAISE NOTICE 'rake share cutover: cron split %, rule share % (hand facts) / % (attributions); lag % / %',
    v_split_all, v_share_all, v_ra_share, v_share_all - v_split_all, v_ra_share - v_split_all;
END
$prove$;

COMMIT;
