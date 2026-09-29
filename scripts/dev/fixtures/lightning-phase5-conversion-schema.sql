-- Isolated PostgreSQL contract fixture, never a production migration.
--
-- THE PRE-MIGRATION SHAPE FOR LIGHTNING PHASE 5, THE CONVERSION
-- (20260921151618). It is a DELTA, laid on top of the two fixtures the Phase 4
-- harnesses already use, and it exists for one reason: Phase 5 does not
-- retype fn_cash_cluster_tick or fn_cash_cluster_balance, it SUBSTITUTES into
-- whatever the catalogue holds. A stub body that happened to contain the
-- anchor would let the substitution succeed against a fake and prove nothing
-- at all, so this file carries the REAL bodies, taken verbatim out of the
-- migrations that produced them.
--
-- WHY THE PHASE 4 CHAIN IS NOT ENOUGH, MEASURED RATHER THAN ASSUMED. The tick
-- that scripts/dev/fixtures/lightning-phase3-remediation-schema.sql installs is
-- a deliberately reduced one - it names the eight steps it does not implement
-- in a comment so that 25523's and 44045's survival checks can see them - and
-- it does not mention fn_platform_frozen anywhere. Phase 5's own read-back
-- asserts `v_live !~ 'fn_platform_frozen'` is FALSE after its substitution, so
-- against the Phase 4 chain alone the migration under test refuses to apply
-- with "the substitution into fn_cash_cluster_tick lost a guard that was there
-- before it". fn_cash_cluster_balance does not exist in that chain at all, and
-- neither does hand_history, which is the whole of Phase 5's step 9.
--
-- EVERY BYTE BELOW IS EXTRACTED FROM A REAL MIGRATION BY LINE RANGE, not
-- transcribed. The extraction is reproducible; scripts/dev/fixtures/
-- lightning-phase5-conversion-schema.sql.build documents it line by line and
-- regenerates this file.
--
-- WHAT IS IN HERE, AND WHERE EACH PIECE CAME FROM:
--
--   public.engine_maintenance_break  20260902080000 lines 41-70, plus
--                                    20260902090000 line 91-92 (enforce_freeze)
--   public.fn_platform_frozen()      20260902090000 lines 103-129, verbatim,
--                                    including its COMMENT and its GRANT. The
--                                    real tick calls it, Phase 5's begin and
--                                    commit gate on it, and Phase 5 asserts
--                                    the abort does NOT.
--   public.fn_entry_purchases_frozen 20260908042800 lines 41-75, verbatim. The
--                                    real tick's top guard is
--                                    `IF fn_platform_frozen() OR
--                                    fn_entry_purchases_frozen()`, put there by
--                                    20260909181632, so without it the tick
--                                    raises on its own first IF and section G
--                                    could not prove a must_move tick works.
--   public.hand_history              20260307 lines 7-26 and 20260419 lines
--                                    25-30, which is where started_at and
--                                    ended_at were added. Phase 5's
--                                    conversion-safe hand boundary is defined
--                                    entirely in terms of those two columns.
--   cash_seat_moves.resolved_at      20260910181447 lines 88-90. Phase 5's
--                                    begin_pending_on writes it on every move
--                                    it cancels, and the Phase 4 fixture chain
--                                    predates the column.
--   public.fn_cash_cluster_tick      20260906015029 lines 61-645 - the LAST
--                                    migration to define the whole body - then
--                                    the tick DO blocks of 20260907171507,
--                                    20260907173251, 20260909035726,
--                                    20260909181632 and 20260909181704, each
--                                    lifted whole out of its own file and
--                                    applied in version order. 38,705 bytes of
--                                    20260906015029 become 43,538 in the
--                                    catalogue after those five, and 44,355
--                                    once the harness applies 20260921025523
--                                    and 20260921044045 on top of this file -
--                                    which is the body Phase 5 substitutes
--                                    into, next to the 40,443 its own header
--                                    measures on production.
--   public.fn_cash_cluster_balance   20260910181433 lines 123-219 plus its two
--                                    grant lines. THE anchor Phase 5 asserts
--                                    occurs exactly once - BEGIN followed by
--                                    `v_census := public.fn_cash_cluster_census
--                                    (p_game_id, p_now);` - is at byte 364 of
--                                    this body and is not put there by this
--                                    file.
--   public.fn_cash_clusters_tick_all 20260906150956 lines 61-226 plus grants.
--                                    Phase 5's section 7 exists BECAUSE this
--                                    function calls the balancer after every
--                                    tick whatever the tick returned, so the
--                                    harness has to be able to run the real
--                                    pass and watch both stand down together.
--
-- THREE TICK SUBSTITUTIONS ARE DELIBERATELY NOT REPLAYED, AND SAYING SO IS THE
-- POINT OF THIS PARAGRAPH RATHER THAN A FOOTNOTE:
--
--   20260909054702 and 20260909062236 both refuse to run until "native
--   committed seat ownership" / "native game ownership" is installed, which is
--   a different subsystem entirely and is not in any Lightning fixture.
--   20260909181259 reads public.fn_cash_game_roster_track(), which no Lightning
--   fixture creates.
--
--   None of the three touches any string Phase 5 reads, asserts or substitutes:
--   the anchor, `IF NOT g.must_move THEN RETURN`, manual_game,
--   fn_platform_frozen, FOR UPDATE and the absence of is_horse are all present
--   and correct without them, and the harness asserts each one of those on the
--   body this file actually produces before the migration under test is
--   applied, so the substitution is biting a real 43KB body and the assertions
--   about it are about that body. What is missing from the fixture tick
--   relative to production is the expiry-reason wording of 181259 and two
--   ownership retirements - none of which is reachable from any Phase 5 code
--   path. It is named here rather than faked.
--
-- 20260910181447 is likewise not replayed: its balancer edit is guarded on a
-- back-off predicate inside fn_cash_seat_change_plan that the Phase 3 fixture's
-- reduced planner does not carry. It changes the MINUTE a refusal is stamped
-- with. Phase 5 reads nothing it writes.

CREATE TABLE IF NOT EXISTS public.engine_maintenance_break (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  -- 'last_hand'     : announced, tables are finishing the hand in front of them,
  --                   no new hand starts. break_ends_at is NULL because the
  --                   countdown has not started yet and we refuse to show
  --                   players a number we would have to take back.
  -- 'counting_down' : every table parked, the 5:00 countdown is running,
  --                   break_ends_at is authoritative.
  phase             TEXT NOT NULL CHECK (phase IN ('last_hand', 'counting_down')),

  announced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  break_started_at  TIMESTAMPTZ,
  break_ends_at     TIMESTAMPTZ,

  -- Shown to players verbatim. Title Case with no em dashes, per CLAUDE.md
  -- sections 5.7 and 10.7 - this string reaches a popup and an overlay.
  reason            TEXT NOT NULL DEFAULT 'Scheduled Engine Maintenance',

  -- Which engine build declared it, for post-mortems that ask "who paused the
  -- platform at 04:53 and did the restart that followed actually land".
  declared_by       TEXT,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A counting_down break without an end time is a break nothing can ever end.
  CONSTRAINT counting_down_has_an_end
    CHECK (phase <> 'counting_down' OR break_ends_at IS NOT NULL)
);


ALTER TABLE public.engine_maintenance_break
  ADD COLUMN IF NOT EXISTS enforce_freeze BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
-- SECURITY INVOKER (the default), DELIBERATELY. The pre-push
-- definer-authorization guard refused the DEFINER version, and rightly: the
-- break row already carries a public SELECT policy, so INVOKER reads exactly
-- what any caller could read for themselves and lends nobody any rights.
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.engine_maintenance_break b
    WHERE b.phase = 'counting_down'
      AND b.enforce_freeze
      AND b.break_ends_at > NOW()
      -- Belt and braces against a clock skew or a bad write: the longest
      -- legitimate freeze is five minutes, so refuse to honour one that
      -- claims to run for more than fifteen.
      AND b.break_ends_at < NOW() + INTERVAL '15 minutes'
  );
$$;

COMMENT ON FUNCTION public.fn_platform_frozen() IS
  'True while the scheduled maintenance freeze is running (counting_down phase only - the last_hand phase still has pots to settle). Self-expiring: a stale row cannot freeze the platform permanently.';

GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.engine_maintenance_break b
     WHERE b.enforce_freeze
       AND (
         (
           b.phase = 'last_hand'
           /* The engine can legitimately adopt this row until its own
              announcement-anchored :53 -> :00 window ends. Four minutes
              reopened admissions at :57 while a restarted engine still had
              every table parked through :00. */
           AND b.announced_at + INTERVAL '7 minutes' > clock_timestamp()
           AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
         )
         OR
         (
           b.phase = 'counting_down'
           AND b.break_ends_at > clock_timestamp()
           AND b.break_ends_at < clock_timestamp() + INTERVAL '15 minutes'
         )
       )
  );
$function$;

COMMENT ON FUNCTION public.fn_entry_purchases_frozen() IS
  'True while a bounded last-hand announcement or countdown forbids new seats, registrations, launches, rebuys and add-ons. Unlike fn_platform_frozen, this entry-only predicate includes last_hand while allowing the hand already in flight to settle.';

GRANT EXECUTE ON FUNCTION public.fn_entry_purchases_frozen()
  TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS hand_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id UUID,
  tournament_id UUID,
  hand_number INTEGER NOT NULL,
  game_variant TEXT NOT NULL DEFAULT 'nlh',
  small_blind DECIMAL(12,2) NOT NULL DEFAULT 0,
  big_blind DECIMAL(12,2) NOT NULL DEFAULT 0,
  pot_size DECIMAL(12,2) NOT NULL DEFAULT 0,
  rake_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  community_cards TEXT[],
  winners JSONB,
  players JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hand_history_table ON hand_history(table_id);
CREATE INDEX IF NOT EXISTS idx_hand_history_tournament ON hand_history(tournament_id);
CREATE INDEX IF NOT EXISTS idx_hand_history_created ON hand_history(created_at DESC);

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS seed        TEXT,                                    -- hex PRNG seed (6.1.4)
  ADD COLUMN IF NOT EXISTS version     TEXT NOT NULL DEFAULT 'v1',              -- replay format version
  ADD COLUMN IF NOT EXISTS started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),      -- deal time
  ADD COLUMN IF NOT EXISTS ended_at    TIMESTAMPTZ,                             -- settled time
  ADD COLUMN IF NOT EXISTS hole_cards  JSONB,                                   -- {seat: [card,card]} — written on settle
  ADD COLUMN IF NOT EXISTS board       JSONB;                                   -- {flop, turn, river}

ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
COMMENT ON COLUMN public.cash_seat_moves.resolved_at IS
  'When the move left pending (done, cancelled or expired), stamped by zz_cash_seat_move_resolved. NULL while pending. The planners back off a refused player for 60 s from THIS moment, not from created_at (20260910181447).';

-- THE PRODUCTION COLUMNS THE REAL TICK NEEDS AND THE LIGHTNING FIXTURES LACK.
--
-- Derived mechanically from the real public.tables and public.table_seats DDL
-- in the production schema dump at tests/fixtures/full-weekly-accounting/
-- schema.sql, for exactly the columns the Phase 3 and Phase 4 fixtures do not
-- already carry. NOT NULL, DEFAULT, CHECK and GENERATED are dropped
-- deliberately: this fixture seats its rows through its own writers, and a
-- production NOT NULL with no default would refuse them.
--
-- Nothing in Phase 5 reads one of these. They exist so that the REAL tick
-- RUNS - fn_cash_apply_ruleset, which is its very first action, projects a
-- ruleset onto thirty of them, and the duplicate-chair reconciliation reads
-- table_seats.club_id - instead of raising on its own first statement. A tick
-- that raised would make "the stood-down tick moved nothing" vacuously true,
-- which is the one thing section 08 must not be.
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS id uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS club_id uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS game_type text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS stakes text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS small_blind numeric(15,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS big_blind numeric(15,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS min_buy_in numeric(15,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS max_buy_in numeric(15,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS max_players integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS current_players integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_private boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS settings jsonb;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS game_variant text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS enable_straddle boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS run_it_twice boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_muck boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS ante numeric(15,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS allow_rabbit_hunt boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS allow_run_it_twice boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS allow_straddle boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS game_mode character varying(10);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_vip_only boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_anonymous boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS ban_chat boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS label_as_new boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_featured boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS hide_club_name boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_template boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS double_board boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS triple_board boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS pineapple_holdem boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS seven_deuce_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS nit_game boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS cap_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS no_rathole boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS action_time_seconds integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS ante_bb numeric(10,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS career_percent_min integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS maintain_percent_min integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS maintain_hands integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_start_players integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS game_length_hours integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS calltime_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_extension boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_restart boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_create_table boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_utg_straddle boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS voluntary_straddle boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS insurance_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS run_it_mode character varying(20);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS rake_percent numeric(5,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS rake_cap_bb numeric(5,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS agent_downline_limit integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS buy_in_authorization boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS restrict_device boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS restrict_observers boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS gps_restriction boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS ip_restriction boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS pc_emulator_restriction boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS photo_rotation_verification boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS short_description text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS accelerated_mtt boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS all_in_or_fold boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS custom_rebuy_reentry_cost boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS number_of_rebuys_reentries integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS add_on_multiplier numeric(3,1);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS custom_add_on boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS add_on_break_length_minutes integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS ko_bounty boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS gtd_prize_pool boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS final_table_deal boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS big_blind_ante boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS authorized_to_register boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS late_registration_level integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS early_bird_registration boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bubble_protection boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS featured_tournament boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS min_players_mtt integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS max_players_mtt integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS multi_day_mtt boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS save_start_time boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS start_time timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS restart_tournament_every boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS tournament_schedule boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS synchronized_breaks boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS sng_buy_in numeric(10,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS blind_structure character varying(20);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS payout_structure character varying(50);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS starting_chips integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS blinds_up_minutes integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS next_step_satellite boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS sng_custom_buy_in boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS sng_player_count integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_spins boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS spins_multiplier integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_deleted boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bbj_percent numeric(5,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS tournament_id uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS live_state jsonb;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS union_id uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS big_blind_ante_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS straddle_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS straddle_type text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS max_straddles integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS run_it_twice_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_muck_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS show_hand_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS disconnect_timeout_seconds integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS max_consecutive_timeouts integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS prefer_check_over_fold boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS time_bank_max_uses integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS time_bank_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS ante_enabled boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_frequency integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_ante_multiplier integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS wait_for_big_blind boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS seven_deuce_amount numeric;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS hands_dealt bigint;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS avg_pot numeric(14,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_double_board boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS cap_bb numeric(10,2);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_board_count smallint;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_trigger_mode text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_interval_seconds integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_min_players smallint;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_ante_fixed numeric;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS first_button_seat integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_variant text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_next_due_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_sched_state jsonb;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_manual_pending boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_button_policy text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_announce_seconds integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS cluster_id uuid;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS main_index integer;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS lifecycle text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS opened_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS live_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS break_started_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS break_eligible_since timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS promote_pending boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS observer_show_cards boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS terminal_closed_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS seat_game_scope text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS seat_admission_key text;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS f06_lifecycle bigint;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS table_id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS seat_number integer;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS player_id integer;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS member_id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS stack numeric(15,2);
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS is_sitting_out boolean;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS is_away boolean;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS joined_at timestamp with time zone;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS horse_id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS scheduled_leave_hands integer;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS left_at timestamp with time zone;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS leave_pending boolean;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS auto_rebuy boolean;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS time_bank_remaining integer;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS time_bank_uses_remaining integer;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS club_id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS sit_out_at timestamp with time zone;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS entry_hold text;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS entry_post_agreed boolean;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS occupancy_id uuid;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS active_game_scope text;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS active_parent_key text;
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS terminal_closed_at timestamp with time zone;

-- public.club_members, from the production dump at
-- tests/fixtures/full-weekly-accounting/schema.sql, NOT NULL stripped. It is
-- read by fn_player_home_club, which the tick names in the duplicate-chair
-- reconciliation SELECT. PL/pgSQL plans that SELECT the first time the loop
-- is reached even when it returns no rows, so the function and its table have
-- to exist for the tick to run at all.
CREATE TABLE IF NOT EXISTS public.club_members(club_id uuid ,
user_id uuid ,
role text,
agent_id uuid,
joined_at timestamp with time zone,
parent_agent_id uuid,
invited_by uuid,
notes text,
last_active_at timestamp with time zone,
created_at timestamp with time zone,
updated_at timestamp with time zone,
is_bot boolean,
status text,
chip_balance numeric(20,2) ,
diamonds integer ,
is_active boolean,
orange_ball_status text,
rank_level integer,
credit_limit numeric(15,2),
credit_used numeric(15,2),
nickname text,
last_active timestamp with time zone,
tier text,
trust_score integer,
sessions_played integer,
promo_balance numeric(14,2),
chips_won bigint,
chips_lost bigint,
commission_rate numeric(5,2),
rakeback_rate numeric(5,2),
hands_played integer,
total_rake_paid bigint,
biggest_pot bigint,
locked_chips integer,
player_rakeback_pct numeric(5,4),
held_chips numeric,
display_name text,
is_prepaid boolean,
promo_received_total numeric(14,2),
promo_wagered numeric(14,2),
promo_playthrough_required numeric(14,2),
missions_completed integer,
membership_lifecycle_status text ,
departed_at timestamp with time zone,
departed_by uuid,
departure_reason text);

CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_club_hint IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_hint
       AND cm.status IN ('active','approved')
  ) THEN RETURN p_club_hint; END IF;
  SELECT cm.club_id INTO v_club
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id AND cm.status IN ('active','approved')
   ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
   LIMIT 1;
  RETURN v_club;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_player_home_club(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_player_home_club(uuid,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cash_apply_ruleset(p_game_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; s jsonb; v_opts jsonb;
  v_ante text; v_ante_chips numeric; v_vpip integer; v_vpip_window integer;
  v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_min_bb integer; v_max_bb integer;
  v_trigger_mode text; v_interval integer; v_action_secs integer;
  v_rit text; v_rit_mode text; v_rit_on boolean; v_sd boolean;
  v_n integer := 0;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  s := g.ruleset_snapshot;
  IF s IS NULL THEN RETURN 0; END IF;

  -- The same mapping fn_cash_cluster_open_table applies at open. Kept in
  -- one place by construction: the opener's INSERT and this UPDATE must read
  -- the snapshot identically or a fresh table and a reconciled one disagree.
  v_opts := coalesce(s->'options', '{}'::jsonb);
  v_ante := coalesce(s->>'regular_ante', 'none');
  v_ante_chips := CASE v_ante WHEN 'sb' THEN g.sb WHEN 'bb' THEN g.bb ELSE 0 END;
  v_vpip := coalesce((s->>'vpip_floor')::integer, 0);
  v_vpip_window := coalesce((s->>'vpip_window')::integer, 40);
  v_bomb_on := coalesce((s->'bombs'->>'enabled')::boolean, false);
  v_bomb_trigger := s->'bombs'->>'trigger';
  v_bomb_ante := (s->'bombs'->>'ante_bb')::integer;
  v_bomb_boards := (s->'bombs'->>'boards')::integer;
  v_min_bb := coalesce((s->>'min_buyin_bb')::integer, 40);
  v_max_bb := coalesce((s->>'max_buyin_bb')::integer, 200);
  v_trigger_mode := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'
                         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
                         ELSE 'every_n_hands' END;
  v_interval := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END;
  v_action_secs := LEAST(120, GREATEST(10, coalesce((v_opts->>'action_time_seconds')::integer, 15)));
  -- RUN IT N TIMES (2026-09-09, lane E audit): the opener projects the
  -- snapshot's run_it_n_times as run_it_mode + the three RIT booleans and
  -- this function never did, so the 42 tables adopted at the Gate 7 cutover
  -- kept the old form's answer - four tables of one game offering
  -- run-it-twice and the fifth not. The snapshot only ever says 'opt_in'
  -- today; the other spellings are mapped rather than defaulted so a future
  -- writer cannot land 'none' by accident.
  v_rit := lower(coalesce(s->>'run_it_n_times', 'opt_in'));
  v_rit_mode := CASE v_rit
                  WHEN 'opt_in' THEN 'player_choice'
                  WHEN 'player_choice' THEN 'player_choice'
                  WHEN 'mandatory_twice' THEN 'mandatory_twice'
                  WHEN 'mandatory_three' THEN 'mandatory_three'
                  ELSE 'none' END;
  v_rit_on := v_rit_mode <> 'none';
  -- 7-2 IS A HOLD'EM BOUNTY. The create path guards it ("AND v_v = 'nlh'");
  -- the projection guards it too so no other snapshot writer can put a
  -- seven-deuce bounty on an Omaha table.
  v_sd := coalesce((v_opts->>'seven_deuce_enabled')::boolean, false) AND g.variant = 'nlh';

  UPDATE public.tables t
     SET ante_enabled = v_ante_chips > 0,
         ante = v_ante_chips,
         ante_bb = CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END,
         big_blind_ante_enabled = (v_ante = 'bb'),
         nit_game = v_vpip > 0,
         career_percent_min = 0,
         maintain_percent_min = v_vpip,
         maintain_hands = v_vpip_window,
         bomb_pot_enabled = v_bomb_on,
         bomb_pot_trigger_mode = v_trigger_mode,
         bomb_pot_interval_seconds = v_interval,
         bomb_pot_frequency = 0,
         bomb_pot_ante_multiplier = coalesce(v_bomb_ante, 2),
         bomb_pot_board_count = coalesce(v_bomb_boards, 1),
         bomb_pot_double_board = coalesce(v_bomb_boards, 1) >= 2,
         bomb_pot_min_players = 2,
         min_buy_in = round(g.bb * v_min_bb, 2),
         max_buy_in = round(g.bb * v_max_bb, 2),
         straddle_enabled = false, auto_utg_straddle = false, voluntary_straddle = false,
         run_it_mode = v_rit_mode,
         run_it_twice = v_rit_on,
         allow_run_it_twice = v_rit_on,
         run_it_twice_enabled = v_rit_on,
         is_private = coalesce((v_opts->>'is_private')::boolean, false),
         is_vip_only = coalesce((v_opts->>'is_vip_only')::boolean, false),
         is_anonymous = coalesce((v_opts->>'is_anonymous')::boolean, false),
         ban_chat = coalesce((v_opts->>'ban_chat')::boolean, false),
         insurance_enabled = coalesce((v_opts->>'insurance_enabled')::boolean, false),
         seven_deuce_enabled = v_sd,
         seven_deuce_amount = CASE WHEN v_sd THEN 2 ELSE 0 END,
         action_time_seconds = v_action_secs,
         updated_at = now()
   WHERE t.cluster_id = g.id
     AND t.lifecycle <> 'closed'
     AND coalesce(t.is_deleted, false) = false
     AND (
          t.ante_enabled IS DISTINCT FROM (v_ante_chips > 0)
       OR t.ante IS DISTINCT FROM v_ante_chips
       OR t.ante_bb IS DISTINCT FROM (CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END)
       OR t.big_blind_ante_enabled IS DISTINCT FROM (v_ante = 'bb')
       OR t.nit_game IS DISTINCT FROM (v_vpip > 0)
       OR t.maintain_percent_min IS DISTINCT FROM v_vpip
       OR t.maintain_hands IS DISTINCT FROM v_vpip_window
       OR t.bomb_pot_enabled IS DISTINCT FROM v_bomb_on
       OR t.bomb_pot_trigger_mode IS DISTINCT FROM v_trigger_mode
       OR t.bomb_pot_interval_seconds IS DISTINCT FROM v_interval
       OR t.bomb_pot_ante_multiplier IS DISTINCT FROM coalesce(v_bomb_ante, 2)
       OR t.bomb_pot_board_count IS DISTINCT FROM coalesce(v_bomb_boards, 1)
       OR t.bomb_pot_double_board IS DISTINCT FROM (coalesce(v_bomb_boards, 1) >= 2)
       OR t.bomb_pot_min_players IS DISTINCT FROM 2
       OR t.min_buy_in IS DISTINCT FROM round(g.bb * v_min_bb, 2)
       OR t.max_buy_in IS DISTINCT FROM round(g.bb * v_max_bb, 2)
       OR coalesce(t.straddle_enabled, false) OR coalesce(t.auto_utg_straddle, false) OR coalesce(t.voluntary_straddle, false)
       OR t.run_it_mode IS DISTINCT FROM v_rit_mode
       OR t.run_it_twice IS DISTINCT FROM v_rit_on
       OR t.allow_run_it_twice IS DISTINCT FROM v_rit_on
       OR t.run_it_twice_enabled IS DISTINCT FROM v_rit_on
       OR t.is_private IS DISTINCT FROM coalesce((v_opts->>'is_private')::boolean, false)
       OR t.is_vip_only IS DISTINCT FROM coalesce((v_opts->>'is_vip_only')::boolean, false)
       OR t.is_anonymous IS DISTINCT FROM coalesce((v_opts->>'is_anonymous')::boolean, false)
       OR t.ban_chat IS DISTINCT FROM coalesce((v_opts->>'ban_chat')::boolean, false)
       OR t.insurance_enabled IS DISTINCT FROM coalesce((v_opts->>'insurance_enabled')::boolean, false)
       OR t.seven_deuce_enabled IS DISTINCT FROM v_sd
       OR t.seven_deuce_amount IS DISTINCT FROM (CASE WHEN v_sd THEN 2 ELSE 0 END)
       OR t.action_time_seconds IS DISTINCT FROM v_action_secs
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'ruleset_applied',
            jsonb_build_object('tables', v_n, 'vpip_floor', v_vpip, 'vpip_window', v_vpip_window,
                               'ante', v_ante, 'bombs', v_bomb_on, 'bomb_trigger', v_trigger_mode,
                               'rit', v_rit_mode));
  END IF;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_apply_ruleset(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_apply_ruleset(uuid) TO service_role;


-- ===========================================================================
-- THE REAL fn_cash_cluster_tick, 43,538 CHARACTERS OF IT
-- ===========================================================================
-- 20260906015029 lines 61-645 verbatim, then five real substitution blocks in
-- version order. This is the body Phase 5 section 6 reads out of the catalogue,
-- asserts the anchor in exactly once, replaces once and reads back. Nothing
-- here is written for the harness: if a byte of it drifts, the migration under
-- test refuses to apply, which is the migration working.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  g record; t record; r record;
  v_census public.cash_cluster_census_row[];
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_open_unreserved integer := 0;
  v_buyers integer;
  v_waiting integer;
  v_prev_feeder record;
  v_candidate record;
  v_floor integer;
  v_remaining_capacity integer;
  v_remaining_tables integer;
  v_main1 record;
  v_new_state text;
  v_moves integer := 0;
  v_n integer;
  v_idx integer;
  v_shortest uuid;
  v_table_cap integer;
  v_res jsonb;
  v_hands integer;
  v_orbit integer;
  v_window interval;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT g.must_move THEN RETURN jsonb_build_object('ok', false, 'reason', 'manual_game'); END IF;

  -- ── 1. RECONCILE ─────────────────────────────────────────────────────────
  UPDATE public.cash_seat_moves SET state = 'expired'
   WHERE game_id = g.id AND state = 'pending' AND expires_at <= v_now;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;

  -- THE SNAPSHOT IS THE RULE (Gate 5, 2026-09-05). Every open table of the
  -- game carries exactly the rules its snapshot says; a table that drifted
  -- (54 did, on the VPIP floor alone) is corrected here, every tick.
  v_n := public.fn_cash_apply_ruleset(g.id);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('ruleset_applied', v_n); END IF;

  -- THE ROSTER AND THE SEAT-CHANGE LIST (Dan 2026-09-05). A roster row whose
  -- player holds no chair in the game and has no move planned is closed (the
  -- seat trigger closes most of them; this catches a chair that emptied
  -- while a move was pending and the move then died). A seat change whose
  -- move was cancelled or expired goes back on the list, at its old place;
  -- the back-off in the planner gives the refusal its minute.
  UPDATE public.cash_game_roster ro SET left_at = v_now
   WHERE ro.game_id = g.id AND ro.left_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                      WHERE ts.user_id = ro.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed')
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id = ro.user_id AND mv.game_id = g.id AND mv.state = 'pending');
  UPDATE public.cash_seat_change_requests rq SET status = 'cancelled', resolved_at = v_now, note = 'left_game'
   WHERE rq.game_id = g.id AND rq.status = 'requested'
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_roster ro WHERE ro.game_id = g.id AND ro.user_id = rq.user_id AND ro.left_at IS NULL);
  UPDATE public.cash_seat_change_requests rq SET status = 'requested', resolved_at = NULL, move_id = NULL, note = 'move_' || mv.state
    FROM public.cash_seat_moves mv
   WHERE rq.game_id = g.id AND rq.status = 'moved' AND rq.move_id = mv.id AND mv.state IN ('cancelled', 'expired')
     AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = rq.from_table_id AND ts.user_id = rq.user_id AND ts.left_at IS NULL);

  -- THE GAME WAITLIST (Gate 4, 2026-09-05). A row whose player now holds a
  -- seat in the game is `seated`; a `notified` row (the join door told them
  -- a seat was open) that has not turned into a seat in three minutes is
  -- `expired` - their browser asks again if they are still there, and the
  -- OPEN rule stops counting a buyer who left.
  UPDATE public.cash_game_waitlist w SET status = 'seated', updated_at = v_now
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                  WHERE ts.user_id = w.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed');
  UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = v_now
   WHERE w.game_id = g.id AND w.status = 'notified' AND w.updated_at < v_now - interval '3 minutes';

  -- A CLOSED TABLE WITH SOMEONE ON IT (2026-09-05). The census excludes
  -- closed tables, so a player who reached one (the seat guard below now
  -- refuses; this covers what got through before it, and any future hole)
  -- would never be planned out. It goes back to `breaking`, which the
  -- census sees and step 5 walks empty, then closes again.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'closed'
              AND coalesce(tb.is_deleted, false) = false
              AND EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET lifecycle = 'breaking', status = 'running', break_started_at = v_now, updated_at = now()
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'closed_table_reopened_to_break');
    v_actions := v_actions || jsonb_build_object('reopened_to_break', t.id);
  END LOOP;

  -- ONE CHAIR PER PLAYER PER GAME, EVERY TICK (2026-09-05). The door
  -- refuses a second chair now; before it did, the fleet seated the same
  -- horse at two tables of one game, and the tick only settled that on a
  -- BREAKING table (below). Found live: one horse on Main 1 since 17:01 and
  -- on the feeder since 19:17 the day before, both chairs idle. The roster
  -- is per player, so every such pair also read as one row of drift. The
  -- oldest chair is the player's; each newer one goes home through the
  -- same door as a Leave: between hands (table waiting) it is cashed out
  -- now, exactly as the breaking branch does; mid-game it is flagged
  -- leave_pending and the engine cashes it out at the hand boundary.
  FOR r IN
    SELECT ts.user_id, ts.table_id, ts.seat_number, ts.stack, tb.status,
           coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = g.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND tb.lifecycle <> 'closed' AND coalesce(tb.is_deleted, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                    WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> ts.table_id
                      AND ot.cluster_id = g.id AND ot.lifecycle <> 'closed'
                      AND (o.joined_at < ts.joined_at OR (o.joined_at = ts.joined_at AND o.id < ts.id)))
  LOOP
    IF r.status = 'waiting' AND coalesce(r.stack, 0) > 0 AND r.club_id IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', r.table_id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, r.table_id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, r.table_id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack, 'club_id', r.club_id,
                                 'credited', v_res->'credited', 'key', v_res->'idempotency_key', 'where', 'reconcile'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    ELSE
      UPDATE public.table_seats SET leave_pending = true
       WHERE table_id = r.table_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, r.table_id, 'second_chair_leave_pending',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack, 'table_status', r.status));
      v_actions := v_actions || jsonb_build_object('second_chair_leave_pending', r.user_id);
    END IF;
  END LOOP;

  -- AN OPENING FEEDER NOBODY CAME TO (2026-09-05, window raised the same
  -- night). It was opened for two buyers; SIX minutes with nobody on it
  -- means they went elsewhere. It closes, the live feeder it was going to
  -- promote stays the feeder, and OPEN below waits two minutes before
  -- trying again.
  --
  -- WHY SIX AND NOT THREE. The buyers are horses, and the fleet that seats
  -- them reads the open-table list ONCE at the top of a cycle that takes 57
  -- to 118 seconds (HorseFleetManager: "Seeding cycle took 118s and 3 30s
  -- tick(s) were dropped while it ran"), on a 30-second tick. Three minutes
  -- is shorter than one worst-case cycle plus a full tick interval, so a
  -- feeder could be closed before the fleet's next cycle ever reached it -
  -- and the fleet then bought into the closed row and was refused
  -- TABLE_CLOSING. Measured 2026-09-05 20:45 CDT: 22 feeder_opened, 4
  -- feeder_live, 20 feeder_abandoned in one hour; NLH 0.05/0.10 Classic
  -- abandoned 11 in 90 minutes. 118s + 30s is 148s, so six minutes is that
  -- with a full cycle of margin on top. The two-minute rest after an abandon
  -- and the 60-second opening hold are unchanged.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'opening'
              AND coalesce(tb.is_deleted, false) = false
              AND coalesce(tb.opened_at, tb.created_at) < v_now - interval '6 minutes'
              AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
     WHERE id = t.id;
    UPDATE public.tables SET promote_pending = false
     WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_abandoned');
    v_actions := v_actions || jsonb_build_object('feeder_abandoned', t.id);
  END LOOP;

  -- A TABLE CLOSED BY STATUS BUT NOT BY LIFECYCLE (2026-09-05). Fifteen
  -- cluster tables carried status = 'closed' with lifecycle still 'live'
  -- (an operator's close-game action and the pre-controller close path
  -- write status only). The census reads status and drops them, the roles
  -- step reads lifecycle and still counts them, so a game could hold a
  -- Main 1 nobody could see and a feeder with nobody to feed. With no seat
  -- on it, the lifecycle follows the status; with a seat on it, the closed
  -- table sweep above has already put it back to breaking.
  UPDATE public.tables SET lifecycle = 'closed', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND status = 'closed' AND lifecycle <> 'closed'
     AND coalesce(is_deleted, false) = false
     -- An enabled game's Main 1 is not followed down: R3 below repairs it in
     -- place (same id, same lobby links) instead of opening a replacement.
     AND NOT (g.enabled AND role = 'main' AND main_index = 1)
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, 'lifecycle_followed_status', jsonb_build_object('tables', v_n));
    v_actions := v_actions || jsonb_build_object('lifecycle_followed_status', v_n);
  END IF;

  -- THE HEADCOUNT COLUMN IS THE SEATS (2026-09-05, 15:05). tables.current_players
  -- is what every per-table surface paints and the engine writes it only
  -- when it loads seats to deal; a table with one seated player and no
  -- engine said 0 (22 of them live). The seats are the truth; the column
  -- follows them here, every tick, for this game's open tables.
  UPDATE public.tables tb SET current_players = s.n
    FROM (SELECT tx.id, (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tx.id AND ts.left_at IS NULL)::integer AS n
            FROM public.tables tx WHERE tx.cluster_id = g.id AND tx.lifecycle <> 'closed' AND coalesce(tx.is_deleted, false) = false) s
   WHERE tb.id = s.id AND tb.current_players IS DISTINCT FROM s.n;

  v_census := public.fn_cash_cluster_census(g.id, v_now);
  SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;

  -- R3: an enabled game always has Main 1 open. Anything that closed it
  -- (a stray close, the pre-controller lifecycle pass, a restart) is undone
  -- here rather than by a row flag.
  --
  -- THE LOOKUP READS THE LIVE BOARD, NOT THE OLDEST ROW (2026-09-05, 14:45).
  -- This used to select the oldest table ever numbered Main 1, closed or not.
  -- On NLH 0.05/0.10 Classic the original Main 1 was closed for good, so
  -- every tick found a closed row, took the "open a new one" branch, and
  -- opened a fresh Main 1: 3,000 tables in 148 minutes (08:01 to 10:29),
  -- every one of them then broken and renumbered by the steps below, 10,989
  -- moves planned to shuffle 43 players through them. Now: a Main 1 that is
  -- live or opening on a waiting/running table is the game's; a game with
  -- ANY live table but no such Main 1 leaves it to the ROLES step, which
  -- promotes the oldest live table (that is what Main 1 means, 1.3 s9.2);
  -- only a game with no live table at all opens one. The status-only repair
  -- (a live-lifecycle Main 1 whose status got set to closed) stays.
  SELECT * INTO v_main1 FROM public.tables
   WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND coalesce(is_deleted, false) = false
     AND lifecycle IN ('live', 'opening')
   ORDER BY created_at LIMIT 1;
  IF g.enabled AND v_main1.id IS NOT NULL AND v_main1.status NOT IN ('waiting', 'running', 'active') THEN
    UPDATE public.tables SET status = 'waiting', lifecycle = 'live', current_players = 0, updated_at = now()
     WHERE id = v_main1.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, v_main1.id, 'main1_reopened');
    v_actions := v_actions || jsonb_build_object('main1', 'reopened');
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  ELSIF g.enabled AND v_main1.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.tables
                         WHERE cluster_id = g.id AND coalesce(is_deleted, false) = false
                           AND lifecycle IN ('live', 'opening', 'breaking') AND status IN ('waiting', 'running', 'active')) THEN
    PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
    v_actions := v_actions || jsonb_build_object('main1', 'opened');
    -- Recount after the repair; the rest of the tick sees the real board.
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  END IF;

  -- ── 2. MUST-MOVE (1.3 s9.5) ──────────────────────────────────────────────
  -- For every Main with an unreserved open seat, the longest-seated player on
  -- the feeder (or on a breaking table) is planned onto it, one per seat,
  -- one per player. The engine executes at the player's next hand boundary.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE c.role = 'main' AND c.lifecycle = 'live' AND c.open_unreserved > 0
            ORDER BY c.main_index
  LOOP
    v_n := t.open_unreserved
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL);
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN unnest(v_census) c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         -- A Main 1 seat draws from the WHOLE list (every table but Main 1);
         -- a Main N seat draws from the feeder and any breaking table.
         AND (c.role = 'feeder' OR c.breaking OR (t.main_index = 1 AND c.id <> t.id))
         AND c.id <> t.id
         -- NOT WITH NOTHING, NOT WHILE LEAVING (2026-09-05): a busted seat is
         -- in its rebuy window, a leave_pending seat is on its way out.
         AND coalesce(ts.stack, 0) > 0
         AND coalesce(ts.leave_pending, false) = false
         -- Never onto a table they are already sitting at.
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = t.id AND d.user_id = ts.user_id AND d.left_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
         -- BACK-OFF (2026-09-05): a move the engine just refused (cancelled
         -- with a note) is not re-planned every 5 s; the refusal gets a minute.
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
       -- THE ORDER YOU JOINED THE GAME (Dan 2026-09-05): the roster's
       -- joined_at, which survives every move; the chair's own joined_at
       -- only for a chair that predates the roster.
       ORDER BY c.breaking DESC,
                coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                           WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at) ASC,
                ts.joined_at ASC
       LIMIT GREATEST(v_n, 0)
    LOOP
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, r.table_id, t.id, 'must_move');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', r.table_id, 'reason', 'must_move'));
    END LOOP;
  END LOOP;
  IF v_moves > 0 THEN v_actions := v_actions || jsonb_build_object('moves_planned', v_moves); END IF;

  -- ── 2b. SEAT CHANGES (Dan 2026-09-05) ────────────────────────────────────
  -- After Main seats are filled in must-move order and before a feeder is
  -- opened: a requested table change takes the next unreserved chair on a
  -- table that is not Main 1, oldest request first; two requests that would
  -- take each other's table are swapped.
  v_n := public.fn_cash_seat_change_plan(g.id, v_now);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('seat_changes_planned', v_n); END IF;

  -- ── 3. OPEN (18.3) ───────────────────────────────────────────────────────
  SELECT coalesce(sum(c.open_unreserved), 0) INTO v_open_unreserved
    FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND NOT c.breaking;
  SELECT count(*) INTO v_waiting FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  v_buyers := v_waiting + GREATEST(coalesce(p_eligible_horses, 0), 0);
  -- (a CASE ... THEN inside an IF condition ends the condition early in
  --  PL/pgSQL, so the cap is computed first)
  v_table_cap := g.cap_mains + 1;
  IF g.allow_second_feeder THEN v_table_cap := v_table_cap + 1; END IF;

  IF g.enabled AND v_open_unreserved = 0 AND v_live_tables > 0
     AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'opening')
     AND v_live_tables < v_table_cap
     -- Two minutes after a feeder was abandoned, not before.
     AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                      WHERE e.game_id = g.id AND e.kind = 'feeder_abandoned' AND e.at > v_now - interval '2 minutes') THEN
    IF v_buyers >= 2 THEN
      UPDATE public.tables SET promote_pending = true
       WHERE cluster_id = g.id AND role = 'feeder' AND lifecycle = 'live';
      PERFORM public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'opening', NULL);
      UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
      v_actions := v_actions || jsonb_build_object('feeder', 'opened', 'buyers', v_buyers);
    ELSIF v_buyers = 1 THEN
      -- One buyer holds for 60 s; the fleet's next cycle usually brings a
      -- partner. No ghost table.
      -- AN EXPIRED HOLD RESTS (2026-09-05): five minutes before the next.
      IF g.opening_hold_since IS NULL
         AND (g.opening_hold_rested_until IS NULL OR g.opening_hold_rested_until <= v_now) THEN
        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'started');
      ELSIF g.opening_hold_since IS NOT NULL AND g.opening_hold_since < v_now - interval '60 seconds' THEN
        UPDATE public.cash_games SET opening_hold_since = NULL, opening_hold_rested_until = v_now + interval '5 minutes' WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold_expired');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'expired');
      END IF;
    END IF;
  ELSIF g.opening_hold_since IS NOT NULL THEN
    UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
  END IF;

  -- ── 4. PROMOTE (18.3) ────────────────────────────────────────────────────
  -- An opening feeder with two seated is live. The feeder before it, marked
  -- promote_pending, becomes Main N+1.
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle = 'opening' AND c.seated >= 2 LOOP
    UPDATE public.tables SET lifecycle = 'live', live_at = v_now WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_live');
    SELECT coalesce(max(main_index), 0) + 1 INTO v_idx FROM public.tables
     WHERE cluster_id = g.id AND role = 'main' AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
    FOR v_prev_feeder IN SELECT id, name FROM public.tables
                          WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending AND id <> t.id
                            AND lifecycle = 'live' ORDER BY created_at
    LOOP
      UPDATE public.tables SET role = 'main', main_index = v_idx, promote_pending = false,
             name = left(g.name, 50) || ' Main ' || v_idx
       WHERE id = v_prev_feeder.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_prev_feeder.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', v_idx));
      v_idx := v_idx + 1;
    END LOOP;
    v_actions := v_actions || jsonb_build_object('feeder_live', t.id);
  END LOOP;

  -- Refresh the census for the steps that read roles (the counts are the
  -- tick's own snapshot and stay).
  SELECT coalesce(array_agg(
           (tb.id, tb.role, tb.main_index, tb.lifecycle, c.status, c.created_at, c.max_players,
            c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
           ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
    INTO v_census
    FROM unnest(v_census) c JOIN public.tables tb ON tb.id = c.id;

  -- ── 5. BREAK (18.3) ──────────────────────────────────────────────────────
  -- Candidate: newest table first (feeder, then the highest main), never
  -- Main 1, never a table still opening. Condition: everyone fits in the
  -- rest at or above the floor. It breaks when that has held for the
  -- SHORTER of two completed orbits on the candidate or five minutes
  -- (OPORD 1.4 18.3). An orbit is one hand per seated player; a table
  -- with fewer than two seated deals no hands, so only the clock runs
  -- for it. Until 2026-09-05 only the clock ran for everyone, and a
  -- six-handed feeder that dealt twenty hands in four minutes with the
  -- whole game fitting elsewhere still sat there for the fifth.
  v_floor := CASE WHEN g.handedness <= 6 THEN 3 ELSE 4 END;
  -- EMPTY FIRST (2026-09-05, 14:50). An empty table has nobody to move and
  -- nothing to interrupt; it is the cheapest table to close and the one the
  -- lobby least wants to see. Then the newest.
  SELECT * INTO v_candidate FROM unnest(v_census) c
   WHERE NOT (c.role = 'main' AND c.main_index = 1) AND c.lifecycle = 'live'
   ORDER BY (c.seated = 0) DESC, (c.role = 'feeder') DESC, c.main_index DESC NULLS FIRST, c.created_at DESC LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.breaking) AND v_candidate.id IS NOT NULL THEN
    SELECT coalesce(sum(c.max_players - c.reserved), 0), count(*) INTO v_remaining_capacity, v_remaining_tables
      FROM unnest(v_census) c WHERE c.id <> v_candidate.id AND c.lifecycle = 'live';
    -- THE FLOOR CLAUSE IS GONE (2026-09-05, 14:50). It read
    -- `seated_total >= floor x remaining_tables`: break only if the
    -- rest would average at or above the maintain floor afterwards. Breaking
    -- a table never makes the rest SHORTER, so the clause could only ever
    -- refuse the breaks that matter most: a game of 1 player on 4 tables
    -- (1 >= 3 x 3, never) kept all four for ever, and a game of 42 on 16
    -- (42 >= 4 x 15, never) never armed. Read live at 14:45: eligible_since
    -- NULL on every table of both. Dan's rule is "fewer tables, more players
    -- at each"; the floor is a target for the fleet to fill to, not a bar
    -- to consolidation. The STRICT fit stays (everyone fits AND the rest
    -- keeps a seat open, so the OPEN rule does not fire on the same board).
    IF v_remaining_tables >= 1
       AND v_seated_total < v_remaining_capacity THEN
      SELECT break_eligible_since INTO r FROM public.tables WHERE id = v_candidate.id;
      IF r.break_eligible_since IS NULL THEN
        UPDATE public.tables SET break_eligible_since = v_now WHERE id = v_candidate.id;
        v_actions := v_actions || jsonb_build_object('break_eligible', v_candidate.id);
      ELSE
        v_orbit := v_candidate.seated;
        v_hands := 0;
        IF v_orbit >= 2 THEN
          SELECT count(*) INTO v_hands FROM public.hand_history h
           WHERE h.table_id = v_candidate.id AND h.created_at >= r.break_eligible_since;
        END IF;
        -- A TABLE WITH NOBODY, OR ONE PLAYER, HAS NOTHING TO INTERRUPT
        -- (2026-09-05): no hand can be dealt there, so the five-minute
        -- window protects nobody. Sixty seconds is enough to let someone who
        -- is sitting down finish sitting down.
        -- (computed first: a CASE ... THEN inside an IF condition ends the
        --  condition early in PL/pgSQL, see the OPEN rule's cap above)
        v_window := CASE WHEN v_orbit <= 1 THEN interval '60 seconds' ELSE interval '5 minutes' END;
        IF r.break_eligible_since <= v_now - v_window
           OR (v_orbit >= 2 AND v_hands >= 2 * v_orbit) THEN
          UPDATE public.tables SET lifecycle = 'breaking', break_started_at = v_now, break_eligible_since = NULL
           WHERE id = v_candidate.id;
          SELECT coalesce(array_agg(
                   (c.id, c.role, c.main_index,
                    CASE WHEN c.id = v_candidate.id THEN 'breaking' ELSE c.lifecycle END,
                    c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved,
                    c.breaking OR c.id = v_candidate.id)::public.cash_cluster_census_row
                   ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
            INTO v_census FROM unnest(v_census) c;
          INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
          VALUES (g.id, v_candidate.id, 'table_break_started',
                  jsonb_build_object('seated_total', v_seated_total, 'remaining_capacity', v_remaining_capacity,
                                     'eligible_since', r.break_eligible_since, 'hands_since_eligible', v_hands, 'orbit', v_orbit));
          v_actions := v_actions || jsonb_build_object('break_started', v_candidate.id,
                                                       'hands_since_eligible', v_hands, 'orbit', v_orbit);
        END IF;
      END IF;
    ELSE
      UPDATE public.tables SET break_eligible_since = NULL
       WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
    END IF;
  ELSE
    UPDATE public.tables SET break_eligible_since = NULL
     WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
  END IF;

  -- A breaking table: every seated player is planned onto the shortest live
  -- table with room (must-move already took the mains' open seats above;
  -- this covers what is left, feeder included). When the last chair is
  -- empty it closes.
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.breaking LOOP
    IF t.seated = 0 THEN
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_break_completed');
      SELECT coalesce(array_agg(c ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
        INTO v_census FROM unnest(v_census) c WHERE c.id <> t.id;
      v_actions := v_actions || jsonb_build_object('closed', t.id);
      CONTINUE;
    END IF;
    -- A SECOND CHAIR IN ONE GAME (2026-09-05). Before the door refused it, the
    -- fleet could seat the same horse at two tables of one game; found live
    -- with one of the two chairs on this breaking table. There is nowhere to
    -- move that chair to (they are already at the other table), so it goes
    -- home: the stack returns to the wallet through the forced cash-out the
    -- table-close path uses. Nothing is lost; the other chair is untouched.
    FOR r IN SELECT ts.user_id, ts.seat_number, ts.stack,
                    coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
               FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                             WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> t.id
                               AND ot.cluster_id = g.id AND ot.lifecycle IN ('live', 'opening'))
    LOOP
      CONTINUE WHEN r.club_id IS NULL;
      -- The same three calls fn_cashout_seats_for_closing_table makes, per seat.
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', t.id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, t.id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack,
                                 'club_id', r.club_id, 'credited', v_res->'credited', 'key', v_res->'idempotency_key'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    END LOOP;
    FOR r IN SELECT ts.user_id FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND coalesce(ts.leave_pending, false) = false
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND m.created_at > v_now - interval '60 seconds')
              ORDER BY coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                                  WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at),
                       ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM unnest(v_census) c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = c.id AND d.user_id = r.user_id AND d.left_at IS NULL)
       ORDER BY c.seated ASC, c.main_index ASC NULLS LAST LIMIT 1;
      EXIT WHEN v_shortest IS NULL;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, t.id, v_shortest, 'break');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_shortest, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', t.id, 'reason', 'break'));
    END LOOP;
  END LOOP;

  -- ── 6. ROLES (1.3 s9.2) ──────────────────────────────────────────────────
  -- Oldest live table is Main 1; mains renumber by age; with no feeder left
  -- and two or more tables, the newest becomes the feeder.
  -- A GAME WITH A FEEDER AND NO MAIN (2026-09-05). Found live: Main 1 closed
  -- by status under a disabled game, five players still on its feeder, and
  -- nothing below promoted the feeder because this step only renumbers
  -- mains. Oldest live table is Main 1 (1.3 s9.2); if no main is live, the
  -- oldest live feeder becomes it, so the players on it have a Main to be
  -- on and the R3 repair does not open a second table beside them.
  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main')
     AND EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder') THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder' ORDER BY c.created_at LIMIT 1;
    UPDATE public.tables SET role = 'main', main_index = 1, promote_pending = false, name = g.name WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', 1, 'reason', 'no_live_main'));
    SELECT coalesce(array_agg(
             (c.id, CASE WHEN c.id = t.id THEN 'main' ELSE c.role END, CASE WHEN c.id = t.id THEN 1 ELSE c.main_index END,
              c.lifecycle, c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
             ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
      INTO v_census FROM unnest(v_census) c;
    v_actions := v_actions || jsonb_build_object('feeder_became_main1', t.id);
  END IF;
  v_idx := 0;
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main' ORDER BY c.created_at LOOP
    v_idx := v_idx + 1;
    IF t.main_index IS DISTINCT FROM v_idx THEN
      UPDATE public.tables SET main_index = v_idx,
             name = CASE WHEN v_idx = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_idx END
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'main_renumbered', jsonb_build_object('from', t.main_index, 'to', v_idx));
    END IF;
  END LOOP;
  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- ── enabled = false (18.4): no seeding, no opening; empties close ─────────
  IF NOT g.enabled THEN
    FOR t IN SELECT * FROM unnest(v_census) c WHERE c.seated = 0 LOOP
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now() WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_closed_disabled');
      v_actions := v_actions || jsonb_build_object('closed_disabled', t.id);
    END LOOP;
  END IF;

  -- ── 7. WAKE / SLEEP (18.4) ───────────────────────────────────────────────
  v_new_state := CASE WHEN v_seated_total = 0 AND coalesce(p_eligible_horses, 0) = 0 THEN 'dormant' ELSE 'live' END;
  IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN
    UPDATE public.cash_games SET state = v_new_state, updated_at = now() WHERE id = g.id;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, CASE WHEN v_new_state = 'live' THEN 'game_woken' ELSE 'game_dormant' END,
            jsonb_build_object('seated_total', v_seated_total, 'eligible_horses', p_eligible_horses));
    v_actions := v_actions || jsonb_build_object('state', v_new_state);
  END IF;

  UPDATE public.cash_games SET last_tick_at = v_now, last_tick_actions = v_actions WHERE id = g.id;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'seated_total', v_seated_total,
                            'tables', v_live_tables, 'buyers', v_buyers, 'actions', v_actions);
END;
$fn$;


-- 20260907171507 (an expired move says what it was waiting for), verbatim.
DO $patch$
DECLARE
  v_old text;
  v_new text;
  v_find text;
  v_repl text;
  v_hits integer;
BEGIN
  v_old := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  v_find := '  UPDATE public.cash_seat_moves SET state = ''expired''
   WHERE game_id = g.id AND state = ''pending'' AND expires_at <= v_now;';

  v_repl := '  -- AN EXPIRED MOVE SAYS WHAT IT WAS WAITING FOR (2026-09-07). Three
  -- different failures land here and the row could not tell them apart.
  UPDATE public.cash_seat_moves m SET state = ''expired'',
         note = CASE
                  WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                    WHERE ts.table_id = m.from_table_id
                                      AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                    THEN ''player_left_before_boundary''
                  WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                WHERE ts.table_id = m.from_table_id
                                  AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                  AND coalesce(ts.stack, 0) = 0)
                    THEN ''player_busted_before_boundary''
                  ELSE ''engine_did_not_execute_before_expiry''
                END
   WHERE m.game_id = g.id AND m.state = ''pending'' AND m.expires_at <= v_now;';

  SELECT count(*) INTO v_hits FROM regexp_matches(v_old, regexp_replace(v_find, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one expiry site in fn_cash_cluster_tick, found %', v_hits;
  END IF;

  v_new := replace(v_old, v_find, v_repl);
  IF v_new = v_old THEN
    RAISE EXCEPTION 'the substitution changed nothing';
  END IF;
  IF position('engine_did_not_execute_before_expiry' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement text is not in the new definition';
  END IF;

  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('engine_did_not_execute_before_expiry' in v_def) = 0 THEN
    RAISE EXCEPTION 'the live function does not carry the expiry note';
  END IF;
  IF position('UPDATE public.cash_seat_moves SET state = ''expired''' in v_def) <> 0 THEN
    RAISE EXCEPTION 'the old noteless expiry is still in the live function';
  END IF;
END $assert$;

-- 20260907173251 (a disabled game still tells the truth about itself), verbatim.
DO $patch$
DECLARE v_old text; v_new text; v_find text; v_repl text; v_hits integer;
BEGIN
  v_old := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  v_find := '  IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN';

  v_repl := '  -- NOT gated on g.enabled (2026-09-07). `enabled` says whether this game
  -- may OPEN tables; it has nothing to do with whether `state` is true. Three
  -- games sat at ''live'' with no tables and nobody in them for 38 hours
  -- because a disabled game could never be corrected, and once its last table
  -- closed fn_cash_clusters_to_tick stopped admitting it at all.
  IF g.state IS DISTINCT FROM v_new_state THEN';

  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_old, regexp_replace(v_find, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one enabled-gated state write, found %', v_hits;
  END IF;

  v_new := replace(v_old, v_find, v_repl);
  IF v_new = v_old THEN RAISE EXCEPTION 'the substitution changed nothing'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text; v_left integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN' in v_def) <> 0 THEN
    RAISE EXCEPTION 'the state write is still gated on enabled';
  END IF;
  IF position('IF g.state IS DISTINCT FROM v_new_state THEN' in v_def) = 0 THEN
    RAISE EXCEPTION 'the ungated state write is not there';
  END IF;

  SELECT count(*) INTO v_left FROM public.cash_games g
   WHERE g.state = 'live' AND NOT g.enabled
     AND NOT EXISTS (SELECT 1 FROM public.tables t
                      WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                        AND coalesce(t.is_deleted, false) = false);
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% game(s) still stranded at live with no tables', v_left;
  END IF;
END $assert$;

-- 20260909035726 (status follows lifecycle down as well as up), verbatim.
DO $migration$
DECLARE
  v_src text;
  v_new text;
  -- Anchor on the COMPLETE lifecycle-follows-status pair, so the new block can
  -- only ever land after it and can never split an UPDATE from its diagnostics.
  v_anchor CONSTANT text :=
'  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, ''lifecycle_followed_status'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''lifecycle_followed_status'', v_n);
  END IF;';
  v_repl CONSTANT text :=
'  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, ''lifecycle_followed_status'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''lifecycle_followed_status'', v_n);
  END IF;

  -- AND THE SAME SPLIT IN THE OTHER DIRECTION (2026-09-09).
  -- `lifecycle closed / status waiting` had no repair, and it is the one that
  -- reaches a player: the lobby treats the table as joinable while
  -- fn_cash_apply_ruleset skips it as closed, so it can be sat at carrying a
  -- ruleset nothing is reconciling. 32 fleet tables were in that state.
  -- Only EMPTY ones follow down; one with a seat is already sent back to
  -- `breaking` by the sweep above, which walks it empty first.
  UPDATE public.tables SET status = ''closed'', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND lifecycle = ''closed'' AND status <> ''closed''
     AND coalesce(is_deleted, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, ''status_followed_lifecycle'', jsonb_build_object(''tables'', v_n));
    v_actions := v_actions || jsonb_build_object(''status_followed_lifecycle'', v_n);
  END IF;';
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('status_followed_lifecycle' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION
      'the lifecycle_followed_status pair is not in the live definition in the shape this migration expects';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF position('status_followed_lifecycle' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  IF position('lifecycle_followed_status' in v_new) = 0
     OR position('fn_platform_frozen' in v_new) = 0
     OR position('AND NOT (g.enabled AND role = ''main'' AND main_index = 1)' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- 20260909181632 (a move cannot be late while the platform is parking), verbatim.
DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$  UPDATE public.cash_seat_moves m SET state = 'expired',
         note = CASE
                  WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                    WHERE ts.table_id = m.from_table_id
                                      AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                    THEN 'player_left_before_boundary'
                  WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                WHERE ts.table_id = m.from_table_id
                                  AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                  AND coalesce(ts.stack, 0) = 0)
                    THEN 'player_busted_before_boundary'
                  ELSE 'engine_did_not_execute_before_expiry'
                END
   WHERE m.game_id = g.id AND m.state = 'pending' AND m.expires_at <= v_now;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;$old$;
  v_repl CONSTANT text := $new$  -- A DEADLINE DOES NOT RUN WHILE THE PLATFORM IS PARKING (2026-09-09).
  -- fn_platform_frozen() (checked at the top of this function) is the :55-:00
  -- freeze. fn_entry_purchases_frozen() is WIDER: it is also true from :53,
  -- when the break is announced and the last hand is called, and through the
  -- post-thaw release boundary. fn_cash_seat_move_execute refuses on the wider
  -- one. So in that window the tick is awake and the executor cannot act, and
  -- expiring a move there blames the engine for a refusal the platform made
  -- (CLAUDE.md 10.86 rule 1). Measured: 38% of all expiries fell in the two
  -- five-minute buckets either side of :55.
  --
  -- So the deadline is held instead, forward to the three minutes
  -- fn_cash_seat_move_window guarantees as its floor. GREATEST never shortens
  -- a longer window. fn_thaw_platform then shifts what is still pending at
  -- :00, exactly as CLAUDE.md 13 rule 4 requires.
  IF public.fn_entry_purchases_frozen() THEN
    UPDATE public.cash_seat_moves m
       SET expires_at = GREATEST(m.expires_at, v_now + interval '3 minutes')
     WHERE m.game_id = g.id AND m.state = 'pending'
       AND m.expires_at <= v_now + interval '3 minutes';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_held_for_maintenance', v_n); END IF;
  ELSE
    UPDATE public.cash_seat_moves m SET state = 'expired',
           note = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                      WHERE ts.table_id = m.from_table_id
                                        AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                      THEN 'player_left_before_boundary'
                    WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                  WHERE ts.table_id = m.from_table_id
                                    AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                    AND coalesce(ts.stack, 0) = 0)
                      THEN 'player_busted_before_boundary'
                    ELSE 'engine_did_not_execute_before_expiry'
                  END
     WHERE m.game_id = g.id AND m.state = 'pending' AND m.expires_at <= v_now;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;
  END IF;$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('moves_held_for_maintenance' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION
      'the expiry statement and its diagnostics are not in the live definition in the shape this migration expects';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF position('moves_held_for_maintenance' in v_new) = 0
     OR position('engine_did_not_execute_before_expiry' in v_new) = 0
     OR position('moves_expired' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  -- Landmarks: every other mechanism of the tick must survive the edit.
  IF position('fn_platform_frozen' in v_new) = 0
     OR position('lifecycle_followed_status' in v_new) = 0
     OR position('status_followed_lifecycle' in v_new) = 0
     OR position('feeder_abandoned' in v_new) = 0
     OR position('main1_reopened' in v_new) = 0
     OR position('table_break_started' in v_new) = 0
     OR position('main_demoted_to_feeder' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('IF public.fn_entry_purchases_frozen() THEN' in v_def) = 0 THEN
    RAISE EXCEPTION 'the maintenance hold is not in the live definition after apply';
  END IF;
  IF position('moves_held_for_maintenance' in v_def) = 0
     OR position('engine_did_not_execute_before_expiry' in v_def) = 0 THEN
    RAISE EXCEPTION 'the live definition lost a branch of the expiry taxonomy';
  END IF;
END;
$assert$;

-- 20260909181704 (a main keeps its number while it breaks), verbatim.
DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;$old$;
  v_repl CONSTANT text := $new$  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- A BREAKING MAIN KEEPS A NUMBER A SURVIVOR IS RENUMBERED INTO (2026-09-09).
  -- The loop above walks live|opening mains only, so a BREAKING main holds its
  -- old index while the survivors renumber past it. The break candidate is
  -- chosen empty-first, so an empty Main 2 is taken ahead of a populated
  -- feeder and Main 3 is renumbered to 2 in the same pass: two tables carrying
  -- main_index 2, both named "... Main 2", until the break completes and
  -- fn_closed_cluster_main_releases_index nulls the closed one. Nothing
  -- refuses the duplicate - there is no unique index on
  -- (cluster_id, main_index) - and fn_cash_clusters_to_tick reads
  -- `main_index = 1 AND lifecycle <> 'closed'`, which a breaking table
  -- satisfies, so the controller's eligible-horse map can be keyed on a table
  -- that refuses every player it is sent.
  --
  -- So the breaking one moves above the live range, here, in the transaction
  -- that created the collision. After the demote block on purpose: v_idx is
  -- the live main count and a demoted table's main_index is NULL, so these
  -- numbers can collide with nothing. Seats, lifecycle and planned moves are
  -- untouched.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE c.breaking AND c.role = 'main'
              AND c.main_index IS NOT NULL AND c.main_index <= v_idx
            ORDER BY c.main_index
  LOOP
    v_idx := v_idx + 1;
    UPDATE public.tables SET main_index = v_idx, name = left(g.name, 50) || ' Main ' || v_idx
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'main_renumbered',
            jsonb_build_object('from', t.main_index, 'to', v_idx,
                               'reason', 'breaking_main_released_a_live_index'));
    v_actions := v_actions || jsonb_build_object('breaking_main_renumbered', t.id);
  END LOOP;$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('breaking_main_released_a_live_index' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION
      'the demote-to-feeder block is not in the live definition in the shape this migration expects';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF position('breaking_main_released_a_live_index' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  IF position('main_demoted_to_feeder' in v_new) = 0
     OR position('fn_platform_frozen' in v_new) = 0
     OR position('feeder_promoted_to_main' in v_new) = 0
     OR position('main1_reopened' in v_new) = 0
     OR position('table_break_started' in v_new) = 0
     OR position('status_followed_lifecycle' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

DO $assert$
DECLARE v_def text; v_dupes integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('breaking_main_released_a_live_index' in v_def) = 0 THEN
    RAISE EXCEPTION 'the breaking-main release is not in the live definition after apply';
  END IF;

  -- Nothing on the board may already be carrying a duplicate index; if one is,
  -- say so rather than leaving it for the next tick to trip over.
  SELECT count(*) INTO v_dupes FROM (
    SELECT cluster_id, main_index FROM public.tables
     WHERE cluster_id IS NOT NULL AND role = 'main' AND main_index IS NOT NULL
       AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false
     GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE WARNING 'ATTENTION: % (cluster, main_index) pairs are duplicated right now; the next tick of each game clears them', v_dupes;
  END IF;
END;
$assert$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

-- ===========================================================================
-- THE REAL fn_cash_cluster_balance
-- ===========================================================================
-- 20260910181433 lines 123-219 verbatim plus its grants. Phase 5 section 7
-- substitutes a cluster_mode stand-down in front of its census call; the anchor
-- is this body's own first two lines of executable text.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_balance(p_game_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_census public.cash_cluster_census_row[];
  v_planned integer := 0;
  v_from uuid;
  v_to uuid;
  v_player uuid;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  -- THE POOL IS THE FEEDERS (2026-09-10). It used to be every live table
  -- except Main 1, so Main 2..N were in it - and step 2 of the tick holds
  -- every main FULL from the feeder. The balancer moved the newest arrival
  -- off a full main onto the feeder, step 2 moved the longest-seated feeder
  -- player straight back, and the same players went round every hand: 355
  -- exact round trips in one hour, two players moved 55 times each. Mains are
  -- step 2's, as source and as destination; this balances feeders among
  -- themselves and, with one feeder, does nothing.
  WITH pool AS (
    SELECT c.id,
           c.main_index,
           c.created_at,
           c.seated
             - (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.from_table_id = c.id AND m.state = 'pending')
             + (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.to_table_id = c.id AND m.state = 'pending') AS n,
           c.open_unreserved
             - (SELECT count(*) FROM public.cash_seat_moves m
                 WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) AS room
      FROM unnest(v_census) c
     WHERE c.role = 'feeder'
       AND c.lifecycle = 'live'
       AND NOT c.breaking
  ),
  hi AS (
    SELECT * FROM pool ORDER BY n DESC, main_index DESC NULLS FIRST, created_at DESC LIMIT 1
  ),
  lo AS (
    SELECT * FROM pool WHERE room > 0
     ORDER BY n ASC, main_index ASC NULLS LAST, created_at ASC LIMIT 1
  ),
  pair AS (
    SELECT hi.id AS from_id, lo.id AS to_id
      FROM hi, lo
     WHERE hi.id <> lo.id
       AND hi.n - lo.n >= 2
       AND hi.n >= 3
       AND lo.n >= 1
  ),
  mover AS (
    SELECT p.from_id, p.to_id, ts.user_id
      FROM pair p
      JOIN public.table_seats ts ON ts.table_id = p.from_id AND ts.left_at IS NULL
     WHERE ts.user_id IS NOT NULL
       AND coalesce(ts.stack, 0) > 0
       AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.table_seats d
                        WHERE d.table_id = p.to_id AND d.user_id = ts.user_id AND d.left_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = ts.user_id AND m.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = ts.user_id AND m.state = 'cancelled'
                          AND m.created_at > p_now - interval '60 seconds')
     ORDER BY coalesce((SELECT r.joined_at FROM public.cash_game_roster r
                         WHERE r.game_id = p_game_id AND r.user_id = ts.user_id AND r.left_at IS NULL),
                       ts.joined_at) DESC,
              ts.joined_at DESC
     LIMIT 1
  ),
  ins AS (
    INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
    SELECT p_game_id, m.user_id, m.from_id, m.to_id, 'balance' FROM mover m
    RETURNING player_id, from_table_id, to_table_id
  )
  SELECT count(*)::integer,
         (array_agg(i.from_table_id))[1],
         (array_agg(i.to_table_id))[1],
         (array_agg(i.player_id))[1]
    INTO v_planned, v_from, v_to, v_player
    FROM ins i;

  IF coalesce(v_planned, 0) > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (p_game_id, v_to, 'move_planned',
            jsonb_build_object('player_id', v_player, 'from_table_id', v_from, 'reason', 'balance'));
  END IF;

  RETURN coalesce(v_planned, 0);
END;
$function$;


REVOKE ALL ON FUNCTION public.fn_cash_cluster_balance(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_balance(uuid, timestamp with time zone) TO service_role;

-- ===========================================================================
-- THE REAL fn_cash_clusters_tick_all
-- ===========================================================================
-- 20260906150956 lines 61-226 plus grants. It calls fn_cash_cluster_balance
-- after every tick, in the same transaction, INDEPENDENTLY of what the tick
-- returned - which is the entire argument for Phase 5 section 7 existing, and
-- is a claim the harness runs rather than reads.

CREATE OR REPLACE FUNCTION public.fn_cash_clusters_tick_all(p_eligible jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  w record;
  v_now timestamptz := clock_timestamp();
  v_games integer := 0;
  v_ticked integer := 0;
  v_errors integer := 0;
  v_rested integer := 0;
  v_balanced integer := 0;
  v_bal integer;
  v_eligible integer;
  v_res jsonb;
  v_results jsonb := '[]'::jsonb;
  v_rested_games jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_message text;
  -- A PASS COMMITS WHAT IT DID (2026-09-06). See the header of migration
  -- 20260906150956. The engine's role has an 8-second statement_timeout, and
  -- a pass that crosses it is rolled back WHOLE: every game it ticked is
  -- un-ticked and the 8 seconds are gone. Measured 2026-09-06: mean 1,187 ms,
  -- max 7,993 ms, 9 whole-pass timeouts in three hours, while a pass over all
  -- 108 games in isolation is ~3.3 s (avg 25 ms a game, worst 675 ms) - the
  -- overrun is waiting, not work. So: the pass stops STARTING games at
  -- v_budget and hands the rest to the next pass (they are ordered oldest-
  -- ticked first, so nothing starves), and a single lock wait is bounded by
  -- v_lock_wait so one held row costs one game its tick, not the pass.
  v_budget interval := interval '5500 milliseconds';
  v_lock_wait text := '2000ms';
  v_deferred integer := 0;
  v_deferred_games jsonb := '[]'::jsonb;
BEGIN
  -- Transaction-local, so it dies with the RPC. lock_timeout is checked at
  -- every lock acquisition, so unlike statement_timeout it can be set from
  -- inside the statement it governs. A game whose tick waits longer than this
  -- raises 55P03 inside its own sub-block below and becomes an error row.
  PERFORM set_config('lock_timeout', v_lock_wait, true);

  -- THE FREEZE (CLAUDE.md 13): the same short-circuit the per-game tick has,
  -- taken once for the pass so a frozen platform costs one row read.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen',
                              'games', 0, 'ticked', 0, 'errors', 0, 'rested', 0,
                              'balanced', 0,
                              'results', '[]'::jsonb, 'rested_games', '[]'::jsonb);
  END IF;

  FOR w IN
    SELECT l.game_id, l.club_id, l.main1_table_id, l.state, l.enabled,
           g.last_tick_at,
           coalesce((p_eligible ->> (l.main1_table_id::text))::integer, 0) AS eligible,
           EXISTS (
             SELECT 1
               FROM public.tables t
               JOIN public.table_seats ts ON ts.table_id = t.id AND ts.left_at IS NULL
              WHERE t.cluster_id = l.game_id
                AND t.lifecycle <> 'closed'
           ) AS anyone_seated
      FROM public.fn_cash_clusters_to_tick() l
      JOIN public.cash_games g ON g.id = l.game_id
     -- Oldest-ticked first (2026-09-06; it was created_at). With a budget
     -- that can defer the tail of the list, creation order would defer the
     -- SAME games every pass. A game deferred now is the oldest next pass.
     ORDER BY g.last_tick_at NULLS FIRST, g.created_at
  LOOP
    v_games := v_games + 1;


    -- DUE? Live, disabled, occupied or wanted: every pass. Otherwise every 30 s.
    IF NOT (
         w.state = 'live'
      OR NOT w.enabled
      OR w.anyone_seated
      OR w.eligible > 0
      OR w.last_tick_at IS NULL
      OR w.last_tick_at < v_now - interval '30 seconds'
    ) THEN
      v_rested := v_rested + 1;
      -- A RESTED GAME STILL ANSWERS "WHO ARE YOU" (2026-09-05). The controller
      -- builds its per-game row map from what this pass returns, and a wake on
      -- a game absent from that map cannot read `enabled` or find Main 1 - so
      -- the 18.4 dealer wake was skipped for precisely the dormant game a wake
      -- is for. Identity only; no result, because it was not ticked.
      v_rested_games := v_rested_games || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state
      );
      CONTINUE;
    END IF;

    -- THE BUDGET. Checked after the rest test and before a game STARTS, so
    -- a resting game is still counted as rested and `deferred` means DUE but
    -- not started; a game already ticking finishes. Deferred games answer
    -- "who are you" exactly as rested games do, so the controller's row map
    -- still knows them and a wake finds Main 1. Their last_tick_at is
    -- untouched, which is what puts them first next pass.
    IF clock_timestamp() - v_now > v_budget THEN
      v_deferred := v_deferred + 1;
      v_deferred_games := v_deferred_games || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state
      );
      CONTINUE;
    END IF;

    v_eligible := w.eligible;
    BEGIN
      v_res := public.fn_cash_cluster_tick(w.game_id, v_eligible);
      v_ticked := v_ticked + 1;
      -- THE TABLES STAY WITHIN ONE PLAYER (Dan 2026-09-05). After the tick,
      -- never before it: the must-move step has just filled the main game's
      -- open seats from the list, and balancing against the board as it was
      -- BEFORE that would move players the tick was about to move anyway.
      v_bal := public.fn_cash_cluster_balance(w.game_id, v_now);
      v_balanced := v_balanced + coalesce(v_bal, 0);
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state,
        'balanced', coalesce(v_bal, 0),
        'result', coalesce(v_res, '{}'::jsonb)
      );
    EXCEPTION WHEN OTHERS THEN
      -- The sub-block rolled this game's tick back; the pass goes on. The
      -- error is a row, not a log line, so the next agent can find it.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_errors := v_errors + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (w.game_id, w.main1_table_id, 'controller_tick_error',
              jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message,
                                 'eligible_horses', v_eligible));
      v_results := v_results || jsonb_build_object(
        'game_id', w.game_id,
        'main1_table_id', w.main1_table_id,
        'enabled', w.enabled,
        'state', w.state,
        'error', jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message)
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'games', v_games,
    'ticked', v_ticked,
    'errors', v_errors,
    'rested', v_rested,
    'deferred', v_deferred,
    'balanced', v_balanced,
    'elapsed_ms', round(extract(epoch from (clock_timestamp() - v_now)) * 1000),
    'results', v_results,
    -- Deferred games ride with the rested ones: identity rows, so the
    -- controller's map is complete without a new shape to parse.
    'rested_games', v_rested_games || v_deferred_games
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_clusters_tick_all(jsonb) TO service_role;
