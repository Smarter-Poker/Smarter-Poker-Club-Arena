-- AN ACCEPTED HAND IS ONE COMMIT, AND STATS LEAVE THE HOT PATH.
--
-- Production evidence on 2026-09-07 showed that the tournament sweep was not
-- the only source of the table freezes.  In the worst five-minute window 726
-- INSERTs into hand_history were cancelled.  Five synchronous AFTER INSERT
-- triggers were taking club-wide counter locks, player/profile locks and
-- expanding the same JSON several times before the authoritative hand row
-- could commit.  A stats projection was therefore able to cancel the hand it
-- described.
--
-- This migration makes two architectural changes:
--
--   1. table stacks, the hand-history row, tournament_players' chip mirror,
--      bomb award units, the immutable busted-seat generation and a durable
--      projection outbox are committed by ONE RPC/transaction;
--   2. dashboard/stat/mission projections run from that durable outbox after
--      the authoritative commit.  The normal engine path wakes the projector
--      immediately.  The outbox is retained only for a process crash or a lost
--      notification; it is not a reconciliation source and it cannot invent a
--      hand which did not commit.
--
-- The five old trigger functions remain available for historical tooling, but
-- no longer run in the INSERT transaction.  Their exact effects are folded
-- into fn_project_hand_side_effects, which uses the durable outbox row as a
-- transactional claim and serialises each table in hand-number order.

BEGIN;

-- Fail the rollout instead of pausing an active table behind schema work.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '0';

CREATE TABLE IF NOT EXISTS public.hand_projection_outbox (
  hand_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (hand_number)
);

CREATE INDEX IF NOT EXISTS idx_hand_projection_outbox_table_hand
  ON public.hand_projection_outbox(table_id, hand_number);

-- This is the durable proof that a hand went through the *whole* accepted-hand
-- transaction.  hand_history alone is deliberately not used as that proof:
-- during the rolling upgrade an older engine may have written a history row
-- after (or without) the separate stack RPC.  The canonical payload hash also
-- makes a reused global hand number fail closed instead of replaying somebody
-- else's settlement.
CREATE TABLE IF NOT EXISTS public.hand_atomic_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  hand_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  stack_result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number),
  UNIQUE (hand_number),
  UNIQUE (hand_id)
);

ALTER TABLE public.hand_projection_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hand_atomic_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.hand_projection_outbox,
  public.hand_atomic_commits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.hand_projection_outbox,
  public.hand_atomic_commits TO service_role;

-- The physical seat row is reused in place. joined_at is overwritten as soon
-- as another player takes that chair, so it cannot be the audit record of a
-- knockout generation.  Capture it while the accepted hand still owns and
-- locks the seat.
CREATE TABLE IF NOT EXISTS public.tournament_knockout_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  seat_joined_at timestamptz NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL CHECK (hand_number >= 1000000),
  stack_before numeric(20,2) NOT NULL CHECK (stack_before > 0),
  stack_after numeric(20,2) NOT NULL CHECK (stack_after = 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','rebought','eliminated','winner')),
  rebuy_prompt_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (tournament_id, hand_number, eliminated_user_id),
  UNIQUE (tournament_id, eliminated_user_id, seat_joined_at)
);

CREATE INDEX IF NOT EXISTS idx_tournament_knockout_candidates_pending
  ON public.tournament_knockout_candidates(tournament_id, hand_number, eliminated_user_id)
  WHERE state = 'pending';

ALTER TABLE public.tournament_knockout_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_knockout_candidates
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.tournament_knockout_candidates TO service_role;

-- The optimized three-argument position projector was applied live on
-- 2026-08-24 but its migration file contained only a history comment.  Pin the
-- exact live definition here before the trigger is detached so a clean schema
-- rebuild has the same callable implementation as production.
CREATE OR REPLACE FUNCTION public.fn_process_hand_position_stats(
  p_players jsonb,
  p_actions jsonb,
  p_winners jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_order uuid[] := '{}';
  v_pre jsonb[] := '{}';
  v_uid uuid;
  v_n int;
  v_i int;
  v_pos text;
  v_raises int;
  v_player_raised boolean;
  v_vpip int; v_pfr int; v_3bet int; v_fold3 int;
  v_won int; v_profit numeric;
  a jsonb;
  v_raise_count_before int;
BEGIN
  IF p_players IS NULL OR jsonb_typeof(p_players) <> 'array' THEN
    RETURN;
  END IF;

  IF p_actions IS NOT NULL AND jsonb_typeof(p_actions) = 'array' THEN
    v_pre := ARRAY(
      SELECT e
        FROM jsonb_array_elements(p_actions) e
       WHERE e->>'stage' = 'preflop'
         AND (e->>'userId') IS NOT NULL
    );
  END IF;

  FOREACH a IN ARRAY v_pre LOOP
    v_uid := (a->>'userId')::uuid;
    IF NOT v_uid = ANY(v_order) THEN
      v_order := v_order || v_uid;
    END IF;
  END LOOP;

  v_n := array_length(v_order, 1);
  IF v_n IS NULL OR v_n < 2 THEN RETURN; END IF;

  FOR v_i IN 1..v_n LOOP
    v_uid := v_order[v_i];
    v_pos := CASE v_n - v_i
      WHEN 0 THEN 'BB'
      WHEN 1 THEN 'SB'
      WHEN 2 THEN 'BTN'
      WHEN 3 THEN 'CO'
      WHEN 4 THEN 'MP'
      ELSE 'UTG' END;

    v_vpip := 0; v_pfr := 0; v_3bet := 0; v_fold3 := 0;
    v_raises := 0; v_player_raised := false;

    FOREACH a IN ARRAY v_pre LOOP
      v_raise_count_before := v_raises;
      IF a->>'action' IN ('raise','bet') THEN v_raises := v_raises + 1; END IF;

      IF (a->>'userId')::uuid = v_uid THEN
        IF a->>'action' IN ('call','raise','bet')
           AND COALESCE((a->>'amount')::numeric, 0) > 0 THEN
          v_vpip := 1;
        END IF;
        IF a->>'action' IN ('raise','bet') THEN
          v_pfr := 1;
          IF v_raise_count_before >= 1 THEN v_3bet := 1; END IF;
          v_player_raised := true;
        END IF;
        IF a->>'action' = 'fold' AND v_player_raised
           AND v_raise_count_before >= 2 THEN
          v_fold3 := 1;
        END IF;
      END IF;
    END LOOP;

    SELECT COALESCE(sum((w->>'amount')::numeric), 0) INTO v_profit
      FROM jsonb_array_elements(COALESCE(p_winners, '[]'::jsonb)) w
     WHERE (w->>'userId')::uuid = v_uid;
    v_won := CASE WHEN v_profit > 0 THEN 1 ELSE 0 END;

    v_profit := v_profit - COALESCE((
      SELECT sum(mx) FROM (
        SELECT max(COALESCE((a2->>'amount')::numeric, 0)) AS mx
          FROM jsonb_array_elements(p_actions) a2
         WHERE (a2->>'userId')::uuid = v_uid
           AND a2->>'action' IN ('call','raise','bet')
         GROUP BY a2->>'stage'
      ) s), 0);

    INSERT INTO public.player_position_stats AS pps
      (user_id, position, hands_played, vpip_count, pfr_count, three_bet_count,
       fold_to_three_bet_count, hands_won, total_profit, updated_at)
    VALUES (v_uid, v_pos, 1, v_vpip, v_pfr, v_3bet, v_fold3, v_won,
            round(v_profit, 2), now())
    ON CONFLICT (user_id, position) DO UPDATE SET
      hands_played = pps.hands_played + 1,
      vpip_count = pps.vpip_count + EXCLUDED.vpip_count,
      pfr_count = pps.pfr_count + EXCLUDED.pfr_count,
      three_bet_count = pps.three_bet_count + EXCLUDED.three_bet_count,
      fold_to_three_bet_count = pps.fold_to_three_bet_count + EXCLUDED.fold_to_three_bet_count,
      hands_won = pps.hands_won + EXCLUDED.hands_won,
      total_profit = pps.total_profit + EXCLUDED.total_profit,
      updated_at = now();
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_process_hand_position_stats(p_hand_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_h record;
BEGIN
  SELECT players, actions, winners INTO v_h
    FROM public.hand_history WHERE id=p_hand_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM public.fn_process_hand_position_stats(v_h.players,v_h.actions,v_h.winners);
END;
$function$;

-- Retention is the only application-owned hand delete path.  Keep its bounded
-- SKIP LOCKED algorithm, but make a pending projection or knockout generation
-- ineligible at selection time and remove the compact receipt in the same
-- transaction as an otherwise-prunable hand.  Replacing the function avoids
-- ACCESS EXCLUSIVE DDL on the continuously written hand_history table.
CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,7),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 7; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players
        FROM public.hand_history hh
       WHERE hh.has_human IS DISTINCT FROM true
         AND hh.reported IS NOT true
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
       ORDER BY hh.created_at
       LIMIT p_batch
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$;

-- Rolling-safe cutover without ACCESS EXCLUSIVE DDL on the hot hand table.
-- Old pods do not set the transaction-local marker and retain the existing
-- stats projections; the Daily Missions trigger is already outbox-only and is
-- safe for both generations. New atomic commits set the marker and every
-- synchronous stats trigger exits before taking projection locks. The trigger
-- catalog is untouched until every old pod has drained.
CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_event jsonb;
  v_uid uuid;
BEGIN
  IF jsonb_typeof(NEW.daily_mission_events)<>'array' THEN RETURN NEW; END IF;
  FOR v_event IN
    SELECT value FROM jsonb_array_elements(NEW.daily_mission_events)
     ORDER BY value->>'user_id',value::text
  LOOP
    BEGIN
      v_uid := (v_event->>'user_id')::uuid;
      IF v_uid IS NULL THEN CONTINUE; END IF;
      INSERT INTO public.daily_challenge_event_outbox
        (user_id,event_key,amounts,magnitudes,threshold_values,occurred_at)
      VALUES (
        v_uid,
        'hand:'||NEW.id::text,
        v_event->'amounts',
        coalesce(v_event->'magnitudes','{}'::jsonb),
        coalesce(v_event->'values','{}'::jsonb),
        coalesce(NEW.ended_at,NEW.created_at,now())
      )
      ON CONFLICT (user_id,event_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions hand event % could not be queued: %',NEW.id,SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_fold_hand_winnings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_bb numeric;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  IF NEW.tournament_id IS NOT NULL OR NEW.players IS NULL
     OR jsonb_typeof(NEW.players)<>'array' OR jsonb_array_length(NEW.players)=0 THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id=NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  v_bb := greatest(coalesce(NEW.big_blind,0),0);
  WITH seated AS (
    SELECT DISTINCT (pl->>'userId') AS uid
      FROM jsonb_array_elements(NEW.players) pl
     WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), won AS (
    SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.winners)='array'
        THEN NEW.winners ELSE '[]'::jsonb END) w
     WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce((w->>'amount')::numeric,0)>0
     GROUP BY 1
  )
  INSERT INTO public.player_stats
    (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
  SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
    FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
   WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
  ON CONFLICT (user_id,club_id) DO UPDATE SET
    hands_dealt=player_stats.hands_dealt+EXCLUDED.hands_dealt,
    sum_big_blind=player_stats.sum_big_blind+EXCLUDED.sum_big_blind,
    total_winnings=player_stats.total_winnings+EXCLUDED.total_winnings,
    updated_at=now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_hand_history_position_stats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  BEGIN
    PERFORM public.fn_process_hand_position_stats(NEW.players,NEW.actions,NEW.winners);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'position stats failed for hand %: %',NEW.id,SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_ca_stats_live_from_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid,NEW.created_at,NEW.id
    FROM jsonb_array_elements(coalesce(NEW.players,'[]'::jsonb)) pl
   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.ca_hand_player_stat(
    user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
    big_blind,small_blind,n_players,seat_position,my_blind,won_amt,is_winner,
    invested_actions,aggro_cnt,call_cnt,vpip,pfr,folded,three_bet,
    three_bet_opp,faced_three_bet,folded_to_three_bet,cbet_opp,cbet_made,
    showdown,hand_secs,profit)
  SELECT f.user_id,f.hand_id,f.created_at,f.is_cash,f.tournament_id,f.game_variant,
    f.big_blind,f.small_blind,f.n_players,f.seat_position,f.my_blind,f.won_amt,f.is_winner,
    f.invested_actions,f.aggro_cnt,f.call_cnt,f.vpip,f.pfr,f.folded,f.three_bet,
    f.three_bet_opp,f.faced_three_bet,f.folded_to_three_bet,f.cbet_opp,f.cbet_made,
    f.showdown,f.hand_secs,f.profit
    FROM public.ca_hand_player_facts_one(NEW.id,NULL) f
  ON CONFLICT (user_id,hand_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_ca_stats_live_from_hand: % (hand %)',SQLERRM,NEW.id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_hand_history_club_member_stats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_date date; v_tourney boolean;
BEGIN
  IF coalesce(current_setting('app.atomic_hand_commit',true),'')='on' THEN RETURN NEW; END IF;
  SELECT t.club_id,(t.tournament_id IS NOT NULL)
    INTO v_club,v_tourney FROM public.tables t WHERE t.id=NEW.table_id;
  IF v_club IS NULL THEN RETURN NEW; END IF;
  v_tourney := coalesce(v_tourney,false) OR (NEW.tournament_id IS NOT NULL);
  v_date := (NEW.created_at AT TIME ZONE 'UTC')::date;
  WITH pl AS (
    SELECT DISTINCT ON (p->>'userId') (p->>'userId')::uuid AS uid,
           (p->>'stack')::numeric AS stack
      FROM jsonb_array_elements(coalesce(NEW.players,'[]'::jsonb)) p
     WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (p->>'stack') IS NOT NULL
  ), wn AS (
    SELECT (w->>'userId')::uuid AS uid,sum((w->>'amount')::numeric) AS won
      FROM jsonb_array_elements(coalesce(NEW.winners,'[]'::jsonb)) w
     WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     GROUP BY 1
  ), base AS (
    SELECT pl.uid,pl.stack,coalesce(wn.won,0) AS won,st.last_stack,
      (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL
       AND NEW.hand_number IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.hand_history h2 WHERE h2.table_id=NEW.table_id
          AND h2.hand_number>st.last_hand_number AND h2.hand_number<NEW.hand_number)) AS adjacent
      FROM pl LEFT JOIN wn ON wn.uid=pl.uid
      LEFT JOIN public.club_member_table_state st
        ON st.table_id=NEW.table_id AND st.user_id=pl.uid
  ), agg AS (
    SELECT count(*) AS seated,count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
           coalesce(sum(stack-last_stack) FILTER (WHERE last_stack IS NOT NULL),0) AS dsum
      FROM base
  ), calc AS (
    SELECT b.uid,b.won,
      CASE WHEN b.last_stack IS NOT NULL THEN b.stack-b.last_stack ELSE 0 END AS delta,
      CASE WHEN a.seated=a.with_prior
        THEN abs(a.dsum+coalesce(NEW.rake_amount,0)+coalesce(NEW.bbj_amount,0))<0.005
        ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable
      FROM base b CROSS JOIN agg a
  )
  INSERT INTO public.club_member_daily_stats AS s(
    club_id,table_id,user_id,stat_date,hands_played,hands_attributed,hands_won,
    total_won,profit,biggest_pot_won,biggest_pot,topup_total)
  SELECT v_club,NEW.table_id,calc.uid,v_date,1,
    CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN 1 ELSE 0 END,
    CASE WHEN calc.won>0 THEN 1 ELSE 0 END,
    CASE WHEN v_tourney THEN 0 ELSE calc.won END,
    CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN calc.delta ELSE 0 END,
    CASE WHEN v_tourney THEN 0 ELSE calc.won END,
    CASE WHEN v_tourney THEN 0 ELSE coalesce(NEW.pot_size,0) END,
    CASE WHEN v_tourney THEN 0 WHEN NOT calc.attributable AND calc.delta>calc.won
      THEN calc.delta-calc.won ELSE 0 END
    FROM calc
  ON CONFLICT (club_id,table_id,user_id,stat_date) DO UPDATE SET
    hands_played=s.hands_played+1,
    hands_attributed=s.hands_attributed+EXCLUDED.hands_attributed,
    hands_won=s.hands_won+EXCLUDED.hands_won,
    total_won=s.total_won+EXCLUDED.total_won,
    profit=s.profit+EXCLUDED.profit,
    biggest_pot_won=greatest(s.biggest_pot_won,EXCLUDED.biggest_pot_won),
    biggest_pot=greatest(s.biggest_pot,EXCLUDED.biggest_pot),
    topup_total=s.topup_total+EXCLUDED.topup_total,
    updated_at=now();
  INSERT INTO public.club_member_table_state AS st(
    table_id,user_id,last_stack,last_hand_number)
  SELECT DISTINCT ON (p->>'userId') NEW.table_id,(p->>'userId')::uuid,
         (p->>'stack')::numeric,NEW.hand_number
    FROM jsonb_array_elements(coalesce(NEW.players,'[]'::jsonb)) p
   WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND (p->>'stack') IS NOT NULL
  ON CONFLICT (table_id,user_id) DO UPDATE SET
    last_stack=EXCLUDED.last_stack,last_hand_number=EXCLUDED.last_hand_number,
    updated_at=now();
  INSERT INTO public.club_hand_daily_shard AS d(
    club_id,stat_date,shard,hands,rake,bbj,pot_total)
  VALUES (v_club,v_date,(pg_backend_pid()%16)::smallint,1,
    coalesce(NEW.rake_amount,0),coalesce(NEW.bbj_amount,0),coalesce(NEW.pot_size,0))
  ON CONFLICT (club_id,stat_date,shard) DO UPDATE SET
    hands=d.hands+1,rake=d.rake+EXCLUDED.rake,bbj=d.bbj+EXCLUDED.bbj,
    pot_total=d.pot_total+EXCLUDED.pot_total,updated_at=now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_hand_history_club_member_stats failed: %',SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_h public.hand_history%ROWTYPE;
  v_club uuid;
  v_date date;
  v_tourney boolean;
  v_bb numeric;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'fn_project_hand_side_effects is engine/service only';
  END IF;

  -- The durable outbox row is also the claim.  Locking it keeps the additive
  -- projections and its DELETE in one transaction: a crash rolls both back;
  -- a concurrent worker waits, then finds no row and cannot run them twice.
  SELECT h.* INTO v_h
    FROM public.hand_projection_outbox o
    JOIN public.hand_history h ON h.id=o.hand_id
   WHERE o.hand_id=p_hand_id
   FOR UPDATE OF o;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_pending','hand_id',p_hand_id);
  END IF;

  -- One table's club-member projection carries prior-stack state.  Serialise
  -- it and refuse to leapfrog an earlier durable hand from that table.
  PERFORM pg_advisory_xact_lock(hashtextextended('hand-projection:'||v_h.table_id::text,0));
  IF EXISTS (
    SELECT 1 FROM public.hand_projection_outbox earlier
     WHERE earlier.table_id=v_h.table_id
       AND earlier.hand_number<v_h.hand_number
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','predecessor_pending');
  END IF;

  SELECT t.club_id, (t.tournament_id IS NOT NULL)
    INTO v_club, v_tourney
    FROM public.tables t WHERE t.id=v_h.table_id;
  v_tourney := COALESCE(v_tourney,false) OR (v_h.tournament_id IS NOT NULL);
  v_date := (v_h.created_at AT TIME ZONE 'UTC')::date;

  -- Projection 1: club member/table/day state.  This is the current live
  -- trigger body, with NEW replaced by the immutable hand row selected above.
  IF v_club IS NOT NULL THEN
    WITH pl AS (
      SELECT DISTINCT ON (p->>'userId')
             (p->>'userId')::uuid AS uid, (p->>'stack')::numeric AS stack
        FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
       WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND (p->>'stack') IS NOT NULL
    ), wn AS (
      SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
        FROM jsonb_array_elements(coalesce(v_h.winners,'[]'::jsonb)) w
       WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ), base AS (
      SELECT pl.uid, pl.stack, coalesce(wn.won,0) AS won, st.last_stack,
             (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL
              AND v_h.hand_number IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.hand_history h2
                 WHERE h2.table_id=v_h.table_id
                   AND h2.hand_number>st.last_hand_number
                   AND h2.hand_number<v_h.hand_number)) AS adjacent
        FROM pl
        LEFT JOIN wn ON wn.uid=pl.uid
        LEFT JOIN public.club_member_table_state st
          ON st.table_id=v_h.table_id AND st.user_id=pl.uid
    ), agg AS (
      SELECT count(*) AS seated,
             count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
             coalesce(sum(stack-last_stack) FILTER (WHERE last_stack IS NOT NULL),0) AS dsum
        FROM base
    ), calc AS (
      SELECT b.uid,b.won,
             CASE WHEN b.last_stack IS NOT NULL THEN b.stack-b.last_stack ELSE 0 END AS delta,
             CASE WHEN a.seated=a.with_prior
                  THEN abs(a.dsum+coalesce(v_h.rake_amount,0)+coalesce(v_h.bbj_amount,0))<0.005
                  ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable
        FROM base b CROSS JOIN agg a
    )
    INSERT INTO public.club_member_daily_stats AS s
      (club_id,table_id,user_id,stat_date,hands_played,hands_attributed,hands_won,
       total_won,profit,biggest_pot_won,biggest_pot,topup_total)
    SELECT v_club,v_h.table_id,calc.uid,v_date,1,
           CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN 1 ELSE 0 END,
           CASE WHEN calc.won>0 THEN 1 ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 WHEN calc.attributable THEN calc.delta ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 ELSE coalesce(v_h.pot_size,0) END,
           CASE WHEN v_tourney THEN 0
                WHEN NOT calc.attributable AND calc.delta>calc.won THEN calc.delta-calc.won
                ELSE 0 END
      FROM calc
    ON CONFLICT (club_id,table_id,user_id,stat_date) DO UPDATE SET
      hands_played=s.hands_played+1,
      hands_attributed=s.hands_attributed+EXCLUDED.hands_attributed,
      hands_won=s.hands_won+EXCLUDED.hands_won,
      total_won=s.total_won+EXCLUDED.total_won,
      profit=s.profit+EXCLUDED.profit,
      biggest_pot_won=greatest(s.biggest_pot_won,EXCLUDED.biggest_pot_won),
      biggest_pot=greatest(s.biggest_pot,EXCLUDED.biggest_pot),
      topup_total=s.topup_total+EXCLUDED.topup_total,
      updated_at=now();

    INSERT INTO public.club_member_table_state AS st
      (table_id,user_id,last_stack,last_hand_number)
    SELECT DISTINCT ON (p->>'userId')
           v_h.table_id,(p->>'userId')::uuid,(p->>'stack')::numeric,v_h.hand_number
      FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
     WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (p->>'stack') IS NOT NULL
    ON CONFLICT (table_id,user_id) DO UPDATE SET
      last_stack=EXCLUDED.last_stack,
      last_hand_number=EXCLUDED.last_hand_number,
      updated_at=now();

    INSERT INTO public.club_hand_daily_shard AS d
      (club_id,stat_date,shard,hands,rake,bbj,pot_total)
    VALUES (
      v_club,v_date,(pg_backend_pid()%16)::smallint,1,
      coalesce(v_h.rake_amount,0),coalesce(v_h.bbj_amount,0),coalesce(v_h.pot_size,0))
    ON CONFLICT (club_id,stat_date,shard) DO UPDATE SET
      hands=d.hands+1,
      rake=d.rake+EXCLUDED.rake,
      bbj=d.bbj+EXCLUDED.bbj,
      pot_total=d.pot_total+EXCLUDED.pot_total,
      updated_at=now();
  END IF;

  -- Projection 2: legacy player_stats fold/winnings totals (cash only).
  IF v_h.tournament_id IS NULL
     AND v_club IS NOT NULL
     AND jsonb_typeof(v_h.players)='array'
     AND jsonb_array_length(v_h.players)>0 THEN
    v_bb := greatest(coalesce(v_h.big_blind,0),0);
    WITH seated AS (
      SELECT DISTINCT (pl->>'userId') AS uid
        FROM jsonb_array_elements(v_h.players) pl
       WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ), won AS (
      SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_h.winners)='array' THEN v_h.winners ELSE '[]'::jsonb END) w
       WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND coalesce((w->>'amount')::numeric,0)>0
       GROUP BY 1
    )
    INSERT INTO public.player_stats AS ps
      (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
    SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
      FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
     WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
    ON CONFLICT (user_id,club_id) DO UPDATE SET
      hands_dealt=ps.hands_dealt+EXCLUDED.hands_dealt,
      sum_big_blind=ps.sum_big_blind+EXCLUDED.sum_big_blind,
      total_winnings=ps.total_winnings+EXCLUDED.total_winnings,
      updated_at=now();
  END IF;

  -- Projection 3: positional aggregates.
  PERFORM public.fn_process_hand_position_stats(v_h.players,v_h.actions,v_h.winners);

  -- Projection 4: exact per-hand stats materialisation and player index.
  INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid,v_h.created_at,v_h.id
    FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) pl
   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ca_hand_player_stat AS hs (
    user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
    big_blind,small_blind,n_players,seat_position,my_blind,won_amt,is_winner,
    invested_actions,aggro_cnt,call_cnt,vpip,pfr,folded,three_bet,
    three_bet_opp,faced_three_bet,folded_to_three_bet,cbet_opp,cbet_made,
    showdown,hand_secs,profit)
  SELECT
    f.user_id,f.hand_id,f.created_at,f.is_cash,f.tournament_id,f.game_variant,
    f.big_blind,f.small_blind,f.n_players,f.seat_position,f.my_blind,f.won_amt,f.is_winner,
    f.invested_actions,f.aggro_cnt,f.call_cnt,f.vpip,f.pfr,f.folded,f.three_bet,
    f.three_bet_opp,f.faced_three_bet,f.folded_to_three_bet,f.cbet_opp,f.cbet_made,
    f.showdown,f.hand_secs,f.profit
    FROM public.ca_hand_player_facts_one(v_h.id,NULL) f
  ON CONFLICT (user_id,hand_id) DO NOTHING;

  -- Daily Mission booking has its own durable outbox. The hand-history
  -- trigger above only inserts those rows; it never takes a player/profile
  -- lock, and this stats projector must not become a second synchronous
  -- consumer. fn_drain_daily_challenge_event_outbox owns booking exactly once.

  DELETE FROM public.hand_projection_outbox o WHERE o.hand_id=v_h.id;

  RETURN jsonb_build_object('ok',true,'hand_id',v_h.id,'hand_number',v_h.hand_number);
END;
$function$;

-- Stack settlement retains its existing conservation/idempotency function,
-- but it is now called *inside* this larger transaction.  The outer function
-- locks tournament -> roster rows -> seats in a stable order before invoking
-- it, matching the payout/manager lock order and keeping its writes, the hand,
-- the chip mirror and knockout generation indivisible.
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_stack_result jsonb;
  v_hand_id uuid;
  v_existing public.hand_history%ROWTYPE;
  v_prior public.hand_atomic_commits%ROWTYPE;
  v_commit_hash text;
  v_normalized_stacks jsonb;
  v_normalized_units jsonb;
  v_stack jsonb;
  v_uid uuid;
  v_written numeric;
  v_before numeric;
  v_seat record;
  v_prompt_until timestamptz;
  v_rebuy_cap integer;
  v_rebuy_offer_available boolean;
  v_n integer;
  v_distinct integer;
  v_changed integer;
  v_candidate_id uuid;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'fn_ca_commit_hand_settlement is engine/service only';
  END IF;
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
     OR jsonb_typeof(p_stacks)<>'array' OR jsonb_array_length(p_stacks)=0
     OR jsonb_typeof(p_hand_row)<>'object'
     OR jsonb_typeof(coalesce(p_units,'[]'::jsonb))<>'array'
     OR coalesce(p_hand_row->>'table_id','')<>p_table_id::text
     OR coalesce(p_hand_row->>'hand_number','')<>p_hand_number::text THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_atomic_hand_payload');
  END IF;

  -- Validate before any cast or lock.  A malformed service payload is a
  -- semantic refusal, not a partially executed settlement.
  SELECT count(*), count(DISTINCT x->>'user_id')
    INTO v_n, v_distinct
    FROM jsonb_array_elements(p_stacks) x
   WHERE jsonb_typeof(x)='object'
     AND coalesce(x->>'user_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND jsonb_typeof(x->'stack')='number'
     AND jsonb_typeof(x->'stack_before')='number'
     AND (x->>'stack')::numeric>=0
     AND (x->>'stack_before')::numeric>=0;
  IF v_n<>jsonb_array_length(p_stacks) OR v_distinct<>v_n THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_or_duplicate_stack_rows');
  END IF;

  SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO v_normalized_stacks
    FROM jsonb_array_elements(p_stacks) x;
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO v_normalized_units
    FROM jsonb_array_elements(coalesce(p_units,'[]'::jsonb)) x;
  v_commit_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'table_id',p_table_id,'hand_number',p_hand_number,
    'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
    'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
    'units',v_normalized_units)::text,'UTF8'),'sha256'),'hex');

  -- A lifecycle bug must not let two engines settle different hand numbers
  -- for the same table concurrently.  The table lock closes that split-brain
  -- boundary; the global hand-number lock then protects the platform-wide
  -- receipt identity.  Every caller takes them in this order.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-table:'||p_table_id::text,0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-hand:'||p_hand_number::text,0));

  -- This receipt, not hand_history, is the proof that every authoritative leg
  -- committed.  A replay with one changed cent/seat/row is rejected.
  SELECT * INTO v_prior
    FROM public.hand_atomic_commits c
   WHERE c.hand_number=p_hand_number
   FOR UPDATE;
  IF FOUND THEN
    IF v_prior.table_id IS DISTINCT FROM p_table_id
       OR v_prior.payload_hash IS DISTINCT FROM v_commit_hash THEN
      RETURN jsonb_build_object(
        'success',false,'reason','atomic_hand_payload_conflict',
        'hand_number',p_hand_number,'existing_table_id',v_prior.table_id);
    END IF;
    RETURN v_prior.stack_result || jsonb_build_object(
      'success',true,'atomic_hand_commit',true,'replay',true,
      'history_id',v_prior.hand_id,'commit_hash',v_prior.payload_hash);
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t WHERE t.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'reason','table_not_found');
  END IF;

  IF (p_hand_row->>'tournament_id') IS DISTINCT FROM v_tournament_id::text THEN
    RETURN jsonb_build_object(
      'success',false,'reason','hand_tournament_mismatch',
      'table_tournament_id',v_tournament_id,
      'row_tournament_id',p_hand_row->>'tournament_id');
  END IF;

  -- Everything below is one PL/pgSQL subtransaction.  A history/candidate/
  -- mirror invariant failure raises and rolls the nested stack settler back as
  -- well; only the structured refusal returned by this exception handler can
  -- escape.
  BEGIN

    IF v_tournament_id IS NOT NULL THEN
      /* Every table in one tournament may settle a hand at the same time.
         The parent row is a lifecycle boundary, not a per-hand mutex: SHARE
         excludes manager UPDATE/DELETE writers while allowing independent
         table settlements to overlap.  An UPDATE lock here serialized the
         whole field behind the slowest table and surfaced to players as a
         pause between streets/hands. */
      PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR SHARE;
      -- Manager money paths use tournament -> player -> seat.  Pre-lock both
      -- player/seat sets in UUID order so the nested legacy settler cannot
      -- invert them.  Different tables own disjoint active player rows.
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id=v_tournament_id
         AND tp.user_id IN (
           SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
       ORDER BY tp.user_id
       FOR UPDATE;
    END IF;
    v_stack_result := public.fn_ca_settle_hand_stacks_absolute(
      p_table_id,p_hand_number,v_normalized_stacks,p_rake,p_bbj,p_ref,p_inflow);
    IF coalesce((v_stack_result->>'success')::boolean,false) IS NOT TRUE THEN
      RETURN v_stack_result || jsonb_build_object('atomic_hand_commit',false);
    END IF;
    IF coalesce((v_stack_result->>'replay')::boolean,false) IS TRUE THEN
      RAISE EXCEPTION 'legacy stack settlement exists for hand % without an atomic receipt',
        p_hand_number USING ERRCODE='integrity_constraint_violation';
    END IF;

    SELECT * INTO v_existing
      FROM public.hand_history h WHERE h.hand_number=p_hand_number;
    IF FOUND THEN
      -- A legacy history-only row is not evidence of an atomic commit.  Never
      -- bless it retroactively: doing so could pair this hand with a different
      -- already-committed stack payload during a rolling deployment.
      RAISE EXCEPTION 'hand % already exists without an atomic commit receipt',p_hand_number
        USING ERRCODE='integrity_constraint_violation';
    ELSE
      -- The conditional compatibility triggers see this transaction-local
      -- marker and leave projection to the outbox.  Old engines do not set it
      -- and continue to project inline until the rolling fleet is drained.
      PERFORM set_config('app.atomic_hand_commit','on',true);
      v_hand_id := public.fn_ca_insert_hand_with_awards(p_hand_row,p_units);
    END IF;

    IF v_tournament_id IS NOT NULL THEN
    -- Mirror precisely what the conservation function actually wrote, not
    -- the engine proposal (a concurrent between-hand credit may have rebased
    -- one seat).  A successful hand can therefore never be visible with a
    -- stale positive tournament_players count.
      FOR v_stack IN SELECT value FROM jsonb_array_elements(p_stacks)
      LOOP
      v_uid := (v_stack->>'user_id')::uuid;
      v_before := round((v_stack->>'stack_before')::numeric,2);
      v_written := round((v_stack_result->'written'->>v_uid::text)::numeric,2);
      IF v_written IS NULL THEN
        RAISE EXCEPTION 'accepted tournament hand omitted written stack for %',v_uid;
      END IF;
      IF v_written<>trunc(v_written) THEN
        RAISE EXCEPTION 'accepted tournament hand produced fractional stack % for %',v_written,v_uid;
      END IF;

      SELECT s.id,s.joined_at,s.seat_number
        INTO v_seat
        FROM public.table_seats s
       WHERE s.table_id=p_table_id AND s.user_id=v_uid AND s.left_at IS NULL
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'accepted tournament hand lost active seat for % before generation capture',v_uid;
      END IF;

      UPDATE public.tournament_players tp
         SET chips=greatest(v_written,0)::integer,
             table_id=p_table_id,
             seat_number=v_seat.seat_number
       WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
         AND tp.status='playing';
      GET DIAGNOSTICS v_changed=ROW_COUNT;
      IF v_changed<>1 AND NOT EXISTS (
        SELECT 1 FROM public.tournament_players tp
         WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
           AND tp.status='playing'
           AND tp.chips=greatest(v_written,0)::integer
           AND tp.table_id=p_table_id
           AND tp.seat_number=v_seat.seat_number) THEN
        RAISE EXCEPTION 'accepted tournament hand could not mirror playing roster row for %',v_uid;
      END IF;

        IF v_before>0 AND v_written=0 THEN
        SELECT
          (coalesce(t.is_rebuy,false)
             AND (t.max_rebuys IS NULL OR coalesce(tp.rebuys,0)<t.max_rebuys))
          OR
          (coalesce(t.is_reentry,false)
             AND (t.max_reentries IS NULL OR coalesce(tp.rebuys,0)<t.max_reentries)),
          coalesce(nullif(t.rebuy_levels,0),nullif(t.late_reg_levels,0),0)
            + CASE WHEN coalesce(t.add_on_available,false)
                   THEN coalesce(nullif(t.addon_levels,0),1) ELSE 0 END
          INTO v_rebuy_offer_available,v_rebuy_cap
          FROM public.tournaments t
          JOIN public.tournament_players tp
            ON tp.tournament_id=t.id AND tp.user_id=v_uid
         WHERE t.id=v_tournament_id;
        SELECT CASE
          WHEN v_rebuy_offer_available
           AND v_rebuy_cap>0
           AND (SELECT coalesce(current_level,0) FROM public.tournaments WHERE id=v_tournament_id)<v_rebuy_cap
           AND NOT (SELECT coalesce(prize_pool_finalized,false) FROM public.tournaments WHERE id=v_tournament_id)
          THEN clock_timestamp()+interval '30 seconds'
          ELSE NULL END
          INTO v_prompt_until;

        v_candidate_id := NULL;
        INSERT INTO public.tournament_knockout_candidates(
          tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
          hand_id,hand_number,stack_before,stack_after,rebuy_prompt_until)
        VALUES (
          v_tournament_id,v_uid,p_table_id,v_seat.id,v_seat.joined_at,
          v_hand_id,p_hand_number,v_before,0,v_prompt_until)
        ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING
        RETURNING id INTO v_candidate_id;
        IF v_candidate_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM public.tournament_knockout_candidates c
           WHERE c.tournament_id=v_tournament_id
             AND c.hand_number=p_hand_number
             AND c.eliminated_user_id=v_uid
             AND c.table_id=p_table_id
             AND c.seat_id=v_seat.id
             AND c.seat_joined_at=v_seat.joined_at
             AND c.hand_id=v_hand_id
             AND c.stack_before=v_before
             AND c.stack_after=0) THEN
          RAISE EXCEPTION 'knockout candidate identity conflict for tournament %, hand %, user %',
            v_tournament_id,p_hand_number,v_uid;
        END IF;

        UPDATE public.tournament_players tp
           SET rebuy_prompt_until=v_prompt_until
         WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
           AND tp.status='playing';
        END IF;
      END LOOP;
    END IF;

    INSERT INTO public.hand_projection_outbox(hand_id,table_id,hand_number)
    VALUES (v_hand_id,p_table_id,p_hand_number);

    INSERT INTO public.hand_atomic_commits(
      table_id,hand_number,hand_id,payload_hash,stack_result)
    VALUES (p_table_id,p_hand_number,v_hand_id,v_commit_hash,v_stack_result);

    RETURN v_stack_result || jsonb_build_object(
      'success',true,
      'atomic_hand_commit',true,
      'history_id',v_hand_id,
      'tournament_id',v_tournament_id,
      'commit_hash',v_commit_hash);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',false,'atomic_hand_commit',false,'reason','atomic_hand_rolled_back',
      'error',SQLERRM,'sqlstate',SQLSTATE,'table_id',p_table_id,
      'hand_number',p_hand_number,'commit_hash',v_commit_hash);
  END;
END;
$function$;

-- Open and read rebuy decisions under the same tournament -> player lock
-- order used by the purchase transaction.  This is also the rolling-upgrade
-- bridge for a zero stack written by an old engine: a manager restart reads
-- the persisted deadline instead of inventing another thirty seconds in RAM.
CREATE OR REPLACE FUNCTION public.fn_open_tournament_rebuy_decisions(
  p_tournament_id uuid,
  p_user_ids uuid[]
) RETURNS TABLE(
  user_id uuid,
  rebuy_prompt_until timestamptz,
  decision_open boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_rebuy_cap integer;
BEGIN
  IF p_tournament_id IS NULL OR p_user_ids IS NULL
     OR cardinality(p_user_ids)=0 OR cardinality(p_user_ids)>50
     OR EXISTS (SELECT 1 FROM unnest(p_user_ids) u WHERE u IS NULL) THEN
    RAISE EXCEPTION 'invalid rebuy-decision candidate set'
      USING ERRCODE='invalid_parameter_value';
  END IF;

  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament not found' USING ERRCODE='no_data_found';
  END IF;

  v_rebuy_cap := coalesce(nullif(v_t.rebuy_levels,0),nullif(v_t.late_reg_levels,0),0)
    + CASE WHEN coalesce(v_t.add_on_available,false)
           THEN coalesce(nullif(v_t.addon_levels,0),1) ELSE 0 END;

  RETURN QUERY
  WITH locked AS MATERIALIZED (
    SELECT tp.tournament_id,tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND tp.user_id=ANY(p_user_ids)
       AND tp.status='playing'
       AND coalesce(tp.chips,0)<=0
     ORDER BY tp.user_id
     FOR UPDATE
  ), opened AS (
    UPDATE public.tournament_players tp
       SET rebuy_prompt_until = CASE
         WHEN tp.rebuy_prompt_until IS NULL
          AND v_rebuy_cap>0
          AND coalesce(v_t.current_level,0)<v_rebuy_cap
          AND NOT coalesce(v_t.prize_pool_finalized,false)
          AND (
            (coalesce(v_t.is_rebuy,false)
              AND (v_t.max_rebuys IS NULL OR coalesce(tp.rebuys,0)<v_t.max_rebuys))
            OR
            (coalesce(v_t.is_reentry,false)
              AND (v_t.max_reentries IS NULL OR coalesce(tp.rebuys,0)<v_t.max_reentries))
          )
         THEN v_now+interval '30 seconds'
         ELSE tp.rebuy_prompt_until
       END
      FROM locked l
     WHERE tp.tournament_id=l.tournament_id AND tp.user_id=l.user_id
    RETURNING tp.user_id,tp.rebuy_prompt_until
  )
  SELECT o.user_id,o.rebuy_prompt_until,
         o.rebuy_prompt_until IS NOT NULL AND o.rebuy_prompt_until>v_now
    FROM opened o
   ORDER BY o.user_id;
END;
$function$;

-- The preceding bounty migration wires this hook into the authoritative
-- process_tournament_rebuy transaction.  Replacing the hook here closes the
-- exact durable zero-stack generation without adding a trigger (or taking an
-- ACCESS EXCLUSIVE lock) on the hot tournament_players table.
CREATE OR REPLACE FUNCTION public.fn_after_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid,
  p_rebuy_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_candidate uuid;
  v_candidates uuid[];
  v_count integer;
BEGIN
  IF p_rebuy_type NOT IN ('rebuy','reentry') THEN RETURN; END IF;
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  SELECT array_agg(locked.id ORDER BY locked.hand_number)
    INTO v_candidates
    FROM (
      SELECT c.id,c.hand_number
        FROM public.tournament_knockout_candidates c
       WHERE c.tournament_id=p_tournament_id
         AND c.eliminated_user_id=p_user_id
         AND c.state='pending'
       ORDER BY c.hand_number
       FOR UPDATE
    ) locked;
  v_count := coalesce(cardinality(v_candidates),0);
  v_candidate := v_candidates[1];
  IF v_count>1 THEN
    RAISE EXCEPTION 'rebuy has % unresolved knockout generations for tournament %, user %',
      v_count,p_tournament_id,p_user_id USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF v_count=1 THEN
    UPDATE public.tournament_knockout_candidates
       SET state='rebought',resolved_at=clock_timestamp()
     WHERE id=v_candidate;
  END IF;
  UPDATE public.tournament_players
     SET rebuy_prompt_until=NULL
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_decline_tournament_rebuy(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_auth uuid := auth.uid();
  -- SECURITY DEFINER changes current_user to the function owner, so it can
  -- never identify the invoker.  The JWT role is the PostgREST caller and
  -- session_user remains the direct database principal for operator calls.
  v_jwt_role text := auth.role();
  v_changed integer;
  v_candidates uuid[];
BEGIN
  IF session_user NOT IN ('postgres','service_role','supabase_admin')
     AND v_jwt_role IS DISTINCT FROM 'service_role'
     AND (v_auth IS NULL OR v_auth<>p_user_id) THEN
    RAISE EXCEPTION 'caller may only decline their own rebuy' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  UPDATE public.tournament_players tp
     SET rebuy_prompt_until=clock_timestamp()
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status='playing' AND coalesce(tp.chips,0)<=0
     AND tp.rebuy_prompt_until IS NOT NULL
     AND tp.rebuy_prompt_until>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed=1 THEN
    SELECT array_agg(locked.id)
      INTO v_candidates
      FROM (
        SELECT c.id
          FROM public.tournament_knockout_candidates c
         WHERE c.tournament_id=p_tournament_id
           AND c.eliminated_user_id=p_user_id
           AND c.state='pending'
         ORDER BY c.hand_number
         FOR UPDATE
      ) locked;
    IF coalesce(cardinality(v_candidates),0)>1 THEN
      RAISE EXCEPTION 'decline has multiple unresolved knockout generations'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
    UPDATE public.tournament_knockout_candidates c
       SET rebuy_prompt_until=clock_timestamp()
     WHERE c.id=v_candidates[1];
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id,'rebuy');
  END IF;
  RETURN jsonb_build_object('ok',true,'declined',v_changed=1);
END;
$function$;

-- The accepted-hand transaction above creates one immutable knockout
-- generation. Consume that exact generation in the same transaction as the
-- status/payment RPC. Without this bridge, a delayed sweep can reuse an old
-- zero-stack observation after a rebuy and eliminate the new entry.
--
-- The predecessor names are intentionally retained for the DB-first rolling
-- window. A hand settled by an old pod has no hand_atomic_commits receipt and
-- may use the predecessor's exact legacy settlement evidence. If an atomic
-- receipt exists, however, a missing candidate is corruption and fails closed.
DO $rename$
BEGIN
  IF to_regprocedure(
       'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'
     ) IS NULL THEN
    ALTER FUNCTION public.fn_eliminate_tournament_player_atomic(
      uuid,uuid,integer,numeric,numeric)
      RENAME TO fn_eliminate_player_legacy_candidate_20260907;
  END IF;
  IF to_regprocedure(
       'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'
     ) IS NULL THEN
    ALTER FUNCTION public.fn_claim_tournament_bounty_elimination(
      uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
      RENAME TO fn_claim_bounty_legacy_candidate_20260907;
  END IF;
END;
$rename$;

CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_bubble_refund numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_pending_count integer;
  v_latest_joined_at timestamptz;
  v_legacy_hand_number bigint;
  v_result jsonb;
BEGIN
  -- Match the canonical tournament -> player -> candidate/seat lock order.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_player
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending'
   ORDER BY c.hand_number
   FOR UPDATE;
  SELECT count(*) INTO v_pending_count
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending';
  IF v_pending_count>1 THEN
    RETURN jsonb_build_object('ok',false,'reason','multiple_pending_knockout_generations');
  END IF;

  SELECT * INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state IN ('pending','eliminated')
   ORDER BY (c.state='pending') DESC,c.hand_number DESC
   LIMIT 1
   FOR UPDATE;

  SELECT max(s.joined_at) INTO v_latest_joined_at
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id;

  IF v_candidate.id IS NOT NULL THEN
    IF v_candidate.seat_joined_at IS DISTINCT FROM v_latest_joined_at THEN
      RETURN jsonb_build_object('ok',false,'reason','knockout_generation_is_not_current');
    END IF;
    IF v_candidate.state='pending'
       AND v_candidate.rebuy_prompt_until IS NOT NULL
       AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','rebuy_decision_open',
        'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
    END IF;
  ELSIF v_player.status='playing' THEN
    -- Old pods wrote a successful stack receipt but no atomic receipt. Permit
    -- only that precisely identifiable rolling-upgrade case. A new atomic hand
    -- with no candidate is never silently downgraded to legacy authority.
    SELECT (k.result->>'hand_number')::bigint
      INTO v_legacy_hand_number
      FROM public.settlement_idempotency_keys k
     WHERE k.table_id=v_player.table_id
       AND k.status='succeeded'
       AND k.completed_at>=v_latest_joined_at
       AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
       AND k.result->>'table_id'=v_player.table_id::text
       AND k.result->'written' ? p_user_id::text
       AND coalesce(k.result->'written'->>p_user_id::text,'') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (k.result->'written'->>p_user_id::text)::numeric<=0
     ORDER BY k.completed_at DESC
     LIMIT 1;
    IF v_legacy_hand_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','knockout_evidence_not_found');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits c
       WHERE c.table_id=v_player.table_id AND c.hand_number=v_legacy_hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','atomic_knockout_candidate_missing');
    END IF;
  END IF;

  v_result := public.fn_eliminate_player_legacy_candidate_20260907(
    p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  IF coalesce((v_result->>'ok')::boolean,false) AND v_candidate.id IS NOT NULL THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state IN ('pending','eliminated');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_claim_tournament_bounty_elimination(
  p_tournament_id uuid,
  p_eliminated_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_table_id uuid,
  p_hand_id uuid,
  p_hand_number bigint,
  p_seat_joined_at timestamptz,
  p_knocker_user_id uuid,
  p_claimants jsonb,
  p_bubble_refund numeric DEFAULT 0,
  p_allow_existing_eliminated boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_result jsonb;
BEGIN
  -- The predecessor takes the same tournament/player locks. Taking them first
  -- here makes the candidate check and the eventual payout/status mutation one
  -- serial transaction, including exact replays after a lost HTTP response.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;

  SELECT * INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
     AND c.table_id=p_table_id
     AND c.hand_id=p_hand_id
     AND c.hand_number=p_hand_number
     AND c.seat_joined_at=p_seat_joined_at
   FOR UPDATE;

  IF v_candidate.id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits c
       WHERE c.table_id=p_table_id
         AND c.hand_id=p_hand_id
         AND c.hand_number=p_hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','atomic_knockout_candidate_missing');
    END IF;
    -- No atomic receipt means this can only be an old-pod hand. The predecessor
    -- still requires its exact settlement, history, seat and canonical-pot
    -- proof; no timestamp or caller attribution is accepted as authority.
  ELSIF v_candidate.state NOT IN ('pending','eliminated') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','knockout_generation_already_closed','state',v_candidate.state);
  ELSIF v_candidate.state='pending'
        AND v_candidate.rebuy_prompt_until IS NOT NULL
        AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','rebuy_decision_open',
      'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
  END IF;

  v_result := public.fn_claim_bounty_legacy_candidate_20260907(
    p_tournament_id,p_eliminated_user_id,p_position,p_prize,p_table_id,p_hand_id,
    p_hand_number,p_seat_joined_at,p_knocker_user_id,p_claimants,
    p_bubble_refund,p_allow_existing_eliminated);
  IF coalesce((v_result->>'ok')::boolean,false) AND v_candidate.id IS NOT NULL THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state IN ('pending','eliminated');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bounty knockout generation changed while claim committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_project_hand_side_effects(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_project_hand_side_effects(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(
  uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_after_tournament_rebuy(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_open_tournament_rebuy_decisions(uuid,uuid[])
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_open_tournament_rebuy_decisions(uuid,uuid[])
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_decline_tournament_rebuy(uuid,uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_decline_tournament_rebuy(uuid,uuid)
  TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid,uuid,integer,numeric,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_tournament_bounty_elimination(
  uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)
  TO service_role;

-- These routines are implementation details of the accepted-hand boundary,
-- not browser RPCs. CREATE OR REPLACE preserves whatever ACL happened to be
-- live, while a clean schema creates every function executable by PUBLIC. Pin
-- the intended posture explicitly so neither history can expose a stats writer,
-- the retention deleter, or a trigger body through PostgREST.
--
-- Both position projectors and the pruner are owner-run implementation
-- details. Old engine pods insert hand_history; PostgreSQL invokes the
-- installed SECURITY DEFINER trigger without checking the DML role's EXECUTE
-- privilege on either the trigger body or a nested helper. No engine process
-- calls any of these eight routines directly, so every API role is denied.
REVOKE ALL ON FUNCTION public.fn_process_hand_position_stats(jsonb,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_process_hand_position_stats(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_enqueue_hand_daily_missions()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_fold_hand_winnings()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_hand_history_position_stats()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_ca_stats_live_from_hand()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.trg_hand_history_club_member_stats()
  FROM PUBLIC,anon,authenticated,service_role;

DO $publication$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hand_projection_outbox;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$publication$;

DO $assert$
DECLARE
  v_names text[];
  v_role text;
  v_signature text;
BEGIN
  SELECT coalesce(array_agg(t.tgname ORDER BY t.tgname),'{}'::text[])
    INTO v_names
    FROM pg_trigger t
   WHERE t.tgrelid='public.hand_history'::regclass
     AND NOT t.tgisinternal
     AND t.tgname=ANY(ARRAY[
       'hand_history_club_member_stats','hand_history_fold_stats',
       'hand_history_position_stats','trg_ca_stats_live_from_hand',
       'trg_enqueue_hand_daily_missions']);
  IF cardinality(v_names)<>5 OR EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid='public.hand_history'::regclass
       AND NOT t.tgisinternal
       AND t.tgname=ANY(v_names)
       AND t.tgname<>'trg_enqueue_hand_daily_missions'
       AND position('app.atomic_hand_commit' IN pg_get_functiondef(t.tgfoid))=0
  ) THEN
    RAISE EXCEPTION 'rolling-safe hand projection trigger gate is incomplete: %',v_names;
  END IF;
  IF position('daily_challenge_event_outbox' IN pg_get_functiondef(
       'public.fn_enqueue_hand_daily_missions()'::regprocedure))=0
     OR position('ON CONFLICT' IN pg_get_functiondef(
       'public.fn_enqueue_hand_daily_missions()'::regprocedure))=0
     OR position('enqueue_daily_challenge_event' IN pg_get_functiondef(
       'public.fn_enqueue_hand_daily_missions()'::regprocedure))>0
     OR position('fn_lock_daily_mission_user' IN pg_get_functiondef(
       'public.fn_enqueue_hand_daily_missions()'::regprocedure))>0
     OR position('enqueue_daily_challenge_event' IN pg_get_functiondef(
       'public.fn_project_hand_side_effects(uuid)'::regprocedure))>0 THEN
    RAISE EXCEPTION 'accepted-hand Daily Missions work is not outbox-only';
  END IF;
  IF to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.fn_project_hand_side_effects(uuid)') IS NULL
     OR to_regprocedure('public.fn_open_tournament_rebuy_decisions(uuid,uuid[])') IS NULL
     OR to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)') IS NULL
     OR to_regprocedure('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)') IS NULL THEN
    RAISE EXCEPTION 'atomic hand, projector, decision or candidate bridge is missing';
  END IF;
  IF has_table_privilege('service_role','public.hand_projection_outbox','INSERT')
     OR has_table_privilege('service_role','public.hand_atomic_commits','INSERT')
     OR has_table_privilege('service_role','public.tournament_knockout_candidates','UPDATE') THEN
    RAISE EXCEPTION 'service role can forge an authoritative hand receipt/candidate';
  END IF;
  IF has_function_privilege('anon','public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.fn_project_hand_side_effects(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_project_hand_side_effects(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.fn_open_tournament_rebuy_decisions(uuid,uuid[])','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_open_tournament_rebuy_decisions(uuid,uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute the accepted-hand or projection authority';
  END IF;
  IF has_function_privilege(
       'service_role',
       'public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)',
       'EXECUTE')
     OR has_function_privilege(
       'service_role',
       'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)',
       'EXECUTE')
     OR position('tournament_knockout_candidates' IN pg_get_functiondef(
       'public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure))=0
     OR position('tournament_knockout_candidates' IN pg_get_functiondef(
       'public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'candidate consumption can be bypassed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid='public.hand_history'::regclass
       AND t.tgname='zz_ca_bomb_hand_keeps_its_award_units'
       AND t.tgenabled<>'D') THEN
    RAISE EXCEPTION 'bomb award-unit commit guard was detached';
  END IF;
  IF position('hand_projection_outbox' IN
       pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0
     OR position('tournament_knockout_candidates' IN
       pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0
     OR position('hand_atomic_commits' IN
       pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'hand retention can erase pending projection/candidate evidence';
  END IF;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.fn_process_hand_position_stats(jsonb,jsonb,jsonb)',
    'public.fn_process_hand_position_stats(uuid)',
    'public.sp_prune_hand_history(integer)',
    'public.fn_enqueue_hand_daily_missions()',
    'public.fn_fold_hand_winnings()',
    'public.trg_hand_history_position_stats()',
    'public.trg_ca_stats_live_from_hand()',
    'public.trg_hand_history_club_member_stats()'
  ] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_function_privilege(v_role,v_signature,'EXECUTE') THEN
        RAISE EXCEPTION '% can execute internal hand routine %',v_role,v_signature;
      END IF;
    END LOOP;
  END LOOP;
END;
$assert$;

COMMIT;
