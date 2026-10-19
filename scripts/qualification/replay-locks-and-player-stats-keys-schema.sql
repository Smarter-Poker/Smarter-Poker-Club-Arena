-- Production column shapes (read-only, 2026-10-19) for the rows the measured
-- doors lock, and readers/stubs for what they call that takes no lock the
-- cases measure. The doors themselves are production's own text (replay-locks-and-player-stats-keys-live.sql).
-- Loaded only into the private cluster replay-locks-and-player-stats-keys.py builds; never anywhere else.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;

-- ---------------------------------------------------------------- shared
CREATE TABLE public.clubs (id uuid PRIMARY KEY, union_id uuid, asset text DEFAULT 'chips');
CREATE TABLE public.tables (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, tournament_id uuid,
  name text NOT NULL DEFAULT 'harness');
CREATE TABLE public.profiles (id uuid PRIMARY KEY, is_horse boolean DEFAULT false,
  total_hands_played integer DEFAULT 0);

-- ---------------------------------------------------------------- A: the replay
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, club_id uuid, status text, tournament_type text,
  variant text, ended_at timestamptz, satellite_target_id uuid, satellite_target uuid);
CREATE TABLE public.tournament_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tournament_id uuid NOT NULL,
  user_id uuid NOT NULL, status text DEFAULT 'registered', position integer, chips numeric DEFAULT 0);
CREATE TABLE public.tournament_satellite_settlements (tournament_id uuid PRIMARY KEY, target_id uuid,
  qualifier_ids uuid[], winner_id uuid, receipt_version integer DEFAULT 3);
CREATE TABLE public.financial_alerts (id bigserial PRIMARY KEY, severity text, source text, message text,
  context jsonb, resolved boolean DEFAULT false, resolved_at timestamptz, resolution text,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_mtt_admission_contract (singleton boolean PRIMARY KEY DEFAULT true, abi text);
INSERT INTO public.ca_mtt_admission_contract VALUES (true, 'unlimited-mtt-v2');
-- harness control: a receipt for a tournament named here waits on the runner's gate
-- (so the replay is caught mid-run), or refuses, as a real receipt would.
CREATE TABLE public.harness_pause (id uuid PRIMARY KEY);
CREATE TABLE public.harness_gate (k bigint PRIMARY KEY);
INSERT INTO public.harness_gate VALUES (424243);

-- The runner's gate, waited for outside the caller's lock_timeout (the replay runs
-- with 2 s), so the runner, not the clock, decides when the paused receipt goes on.
CREATE FUNCTION public.harness_wait_at_gate() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_old text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '0', true);
  PERFORM pg_advisory_xact_lock_shared((SELECT k FROM public.harness_gate));
  PERFORM set_config('lock_timeout', v_old, true);
END $f$;

-- The satellite receipts: their live opening, verbatim in what it locks and in
-- what order (fn_ca_satellite_cohort_receipt lines 35-61, 108-148 and
-- fn_ca_satellite_settlement_receipt's same prelude, 2026-10-19). Their ~700
-- further lines read, check and RAISE; they write nothing (read-only check of
-- every callee: no INSERT/UPDATE/DELETE in either body or anything they call).
CREATE FUNCTION public.harness_satellite_receipt(p_tournament_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public' AS $f$
DECLARE v_h public.tournament_satellite_settlements%ROWTYPE;
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_tournament_id);
  SELECT * INTO v_h FROM public.tournament_satellite_settlements s WHERE s.tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  PERFORM 1 FROM public.tournaments t WHERE t.id = v_h.target_id FOR SHARE;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.harness_pause WHERE id = p_tournament_id) THEN
    PERFORM public.harness_wait_at_gate();
  END IF;
  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id);
END $f$;
CREATE FUNCTION public.fn_ca_satellite_cohort_receipt(p_tournament_id uuid, p_observed_qualifier_ids uuid[])
RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.harness_satellite_receipt(p_tournament_id) $f$;
CREATE FUNCTION public.fn_ca_satellite_settlement_receipt(p_tournament_id uuid, p_observed_winner_id uuid)
RETURNS jsonb LANGUAGE sql AS $f$ SELECT public.harness_satellite_receipt(p_tournament_id) $f$;
-- A plain terminal receipt takes no lock (live body: no FOR UPDATE/SHARE, no advisory key).
CREATE FUNCTION public.fn_ca_tournament_terminal_receipt(p_tournament_id uuid, p_observed_winner_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM public.harness_pause WHERE id = p_tournament_id) THEN
    PERFORM public.harness_wait_at_gate();
  END IF;
  RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id);
END $f$;

-- ---------------------------------------------------------------- B: player_stats writers
CREATE TABLE public.player_stats (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "club_id" uuid,
  "hands_played" integer DEFAULT 0,
  "total_winnings" numeric(15,2) DEFAULT 0 NOT NULL,
  "total_losses" numeric(15,2) DEFAULT 0,
  "total_rake" numeric(15,2) DEFAULT 0 NOT NULL,
  "vpip" numeric(5,2) DEFAULT 0,
  "pfr" numeric(5,2) DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now(),
  "tournaments_played" integer DEFAULT 0,
  "tournaments_won" integer DEFAULT 0,
  "hands_dealt" bigint DEFAULT 0 NOT NULL,
  "sum_big_blind" numeric DEFAULT 0 NOT NULL,
  UNIQUE (user_id, club_id)
);
CREATE TABLE public.rake_records (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "hand_id" uuid, "table_id" uuid, "club_id" uuid,
  "rake_amount" numeric(18,4) DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "is_tournament" boolean DEFAULT false NOT NULL,
  "tournament_id" uuid, "metadata" jsonb
);
CREATE TABLE public.rake_attributions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  "hand_id" uuid NOT NULL, "player_id" uuid NOT NULL, "rake_amount" numeric NOT NULL,
  "rake_record_id" uuid, "club_id" uuid, "weighted_rake_credit" numeric
);
CREATE TABLE public.rakeback_stats_applied (
  "rake_record_id" uuid NOT NULL, "user_id" uuid NOT NULL, "hands" integer, "rake" numeric,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (rake_record_id, user_id)
);
CREATE TABLE public.accounting_cash_source_work (rake_record_id uuid PRIMARY KEY, receipt_id uuid,
  source_fingerprint text, status text, attempts integer, next_attempt_at timestamptz);
CREATE TABLE public.accounting_cash_source_receipts (id uuid PRIMARY KEY, rake_record_id uuid, attempt integer,
  earned_at timestamptz, source_fingerprint text, status text, reason text, sqlstate text, error_detail text,
  scope jsonb, result jsonb);
CREATE TABLE public.accounting_cash_accrual_batches (rake_record_id uuid, hand_id uuid, status text);
CREATE TABLE public.accounting_cash_rake_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rake_record_id uuid, player_id uuid, club_id uuid, rake_credit numeric);
CREATE TABLE public.accounting_period_recompute_requests (club_id uuid, period_start date, period_end date,
  last_requested_at timestamptz DEFAULT clock_timestamp(), status text DEFAULT 'pending', reason text,
  UNIQUE (club_id, period_start, period_end));
CREATE TABLE public.accounting_tournament_fee_sources (rake_record_id uuid, player_id uuid, club_id uuid,
  charged_at timestamptz);
CREATE TABLE public.ca_launch_reset_operations (operation_id uuid PRIMARY KEY, state text);
CREATE TABLE public.ca_launch_profile_hand_baselines (user_id uuid, operation_id uuid, hand_offset integer,
  restored_scope_hands integer, captured_at timestamptz);

CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.fn_ca_launch_accounting_accepts(uuid, timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.fn_ca_launch_accounting_cutoff(text, uuid) RETURNS timestamptz LANGUAGE sql AS 'SELECT NULL::timestamptz';
CREATE FUNCTION public.fn_ca_launch_accounting_actor(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION public.fn_union_week_start(timestamptz) RETURNS timestamptz LANGUAGE sql
  AS $f$ SELECT date_trunc('week', $1) $f$;
CREATE FUNCTION public.fn_cash_source_refusal_scope(uuid) RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;
CREATE FUNCTION public.credit_agent_commission_from_rake(uuid, uuid, numeric, text, uuid, text) RETURNS void
  LANGUAGE sql AS 'SELECT';
-- The accrual: its live lock opening (the hand key, the record FOR SHARE), then
-- the contributor rows fn_process_cash_accounting_source folds into player_stats,
-- in plan order (rake_attributions by club_id, player_id). Commission rows and
-- their club keys are the commission-key cases of chip-deadlocks.py, not these.
CREATE FUNCTION public.fn_accrue_cash_hand_commissions(p_hand_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public' AS $f$
DECLARE source public.rake_records%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
  SELECT * INTO source FROM public.rake_records WHERE hand_id=p_hand_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.harness_pause WHERE id = p_hand_id) THEN
    PERFORM pg_advisory_xact_lock_shared((SELECT k FROM public.harness_gate));
  END IF;
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,status) VALUES (source.id,p_hand_id,'accrued');
  INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,rake_credit)
  SELECT source.id,a.player_id,a.club_id,a.weighted_rake_credit FROM public.rake_attributions a
   WHERE a.rake_record_id=source.id ORDER BY a.club_id,a.player_id;
  RETURN jsonb_build_object('recorded',true,'status','accrued','source_version',2);
END $f$;

-- the hand projection's tables and the callees that write none of the measured rows
CREATE TABLE public.hand_history (id uuid PRIMARY KEY, table_id uuid, hand_number integer, created_at timestamptz DEFAULT now(),
  players jsonb, winners jsonb, actions jsonb, tournament_id uuid, big_blind numeric, rake_amount numeric,
  bbj_amount numeric, pot_size numeric);
CREATE TABLE public.hand_projection_outbox (hand_id uuid PRIMARY KEY, table_id uuid, hand_number integer);
CREATE TABLE public.hand_atomic_commits (hand_id uuid PRIMARY KEY, post_commit_payload jsonb);
CREATE TABLE public.club_member_daily_stats (club_id uuid, table_id uuid, user_id uuid, stat_date date,
  hands_played integer DEFAULT 0, hands_attributed integer DEFAULT 0, hands_won integer DEFAULT 0,
  total_won numeric DEFAULT 0, profit numeric DEFAULT 0, biggest_pot_won numeric DEFAULT 0,
  biggest_pot numeric DEFAULT 0, topup_total numeric DEFAULT 0, updated_at timestamptz DEFAULT now(),
  UNIQUE (club_id, table_id, user_id, stat_date));
CREATE TABLE public.club_member_table_state (table_id uuid, user_id uuid, last_stack numeric, last_hand_number integer,
  updated_at timestamptz DEFAULT now(), PRIMARY KEY (table_id, user_id));
CREATE TABLE public.club_hand_daily_shard (club_id uuid, stat_date date, shard smallint, hands integer DEFAULT 0,
  rake numeric DEFAULT 0, bbj numeric DEFAULT 0, pot_total numeric DEFAULT 0, updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (club_id, stat_date, shard));
CREATE TABLE public.ca_hand_player_idx (user_id uuid, created_at timestamptz, hand_id uuid,
  PRIMARY KEY (user_id, created_at, hand_id));
CREATE TABLE public.ca_hand_player_stat (user_id uuid, hand_id uuid, created_at timestamptz, is_cash boolean,
  tournament_id uuid, game_variant text, big_blind numeric, small_blind numeric, n_players integer,
  seat_position integer, my_blind numeric, won_amt numeric, is_winner boolean, invested_actions numeric,
  aggro_cnt integer, call_cnt integer, vpip boolean, pfr boolean, folded boolean, three_bet boolean,
  three_bet_opp boolean, faced_three_bet boolean, folded_to_three_bet boolean, cbet_opp boolean,
  cbet_made boolean, showdown boolean, hand_secs numeric, profit numeric, asset text DEFAULT 'chips',
  PRIMARY KEY (user_id, hand_id));
CREATE TABLE public.ca_diamond_player_day (user_id uuid, stat_date date, hands_dealt integer, total_winnings numeric,
  total_losses numeric, sum_big_blind numeric, updated_at timestamptz, PRIMARY KEY (user_id, stat_date));
CREATE FUNCTION public.ca_hand_player_facts_one(uuid, uuid) RETURNS SETOF public.ca_hand_player_stat
  LANGUAGE sql AS 'SELECT * FROM public.ca_hand_player_stat WHERE false';
CREATE FUNCTION public.fn_process_hand_position_stats(jsonb, jsonb, jsonb) RETURNS void LANGUAGE sql AS 'SELECT';
CREATE FUNCTION public.ca_project_hand_stats_facts(uuid) RETURNS void LANGUAGE sql AS 'SELECT';
