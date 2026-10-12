-- Stand-ins for scripts/ci/test-tournament-chat-default-db-postgres.py.
--
-- The tables carry every column the governed creator writes and production's
-- ban_chat shape (boolean NOT NULL DEFAULT false). auth.uid() and auth.role()
-- are Supabase's own text. The guards below are the branches of production's
-- triggers that this migration's UPDATE meets, copied from the live
-- definitions read on 2026-10-12: the managed-game lifecycle guard (a
-- registered event's terms, ban_chat among them, are locked for everyone but
-- the service role), the retired-club guard, and the union ownership trigger
-- (verbatim), which rewrites union_id/club_id on any UPDATE.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;

CREATE TABLE public.unions (id uuid PRIMARY KEY);
CREATE TABLE public.clubs (
  id uuid PRIMARY KEY, union_id uuid, lifecycle_status text NOT NULL DEFAULT 'active',
  asset text NOT NULL DEFAULT 'chips');
CREATE TABLE public.union_clubs (union_id uuid NOT NULL, club_id uuid NOT NULL);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, name text, game_type text,
  variant text, tournament_type text, buy_in_amount numeric, buy_in_fee numeric,
  starting_chips integer, max_players integer, min_players integer, current_players integer,
  status text NOT NULL DEFAULT 'ANNOUNCED', blind_structure text, payout_structure text,
  guaranteed_prize numeric, late_reg_levels integer, late_reg_mins integer, rebuy_levels integer,
  start_time timestamptz, is_rebuy boolean, is_reentry boolean, rebuy_cost numeric,
  rebuy_chips integer, add_on_available boolean, addon_cost numeric, addon_chips integer,
  addon_levels integer, is_bounty boolean, bounty_amount numeric, is_pko boolean,
  is_mystery_bounty boolean, spin_type text, satellite_target_id uuid, is_xmtt boolean,
  union_id uuid, is_private boolean, short_description text, is_vip_only boolean,
  ban_chat boolean NOT NULL DEFAULT false, all_in_or_fold boolean, label_as_new boolean,
  hide_club_name boolean, action_time_seconds integer, table_size integer,
  accelerated_mtt boolean, addon_break_minutes integer, big_blind_ante boolean,
  authorized_to_register boolean, early_bird_enabled boolean, early_bird_chips integer,
  bubble_protection boolean, final_table_deal_enabled boolean, restart_every_minutes integer,
  synchronized_breaks boolean, max_rebuys integer, max_reentries integer, is_multi_day boolean,
  total_days integer, mystery_bounty_min numeric, mystery_bounty_max numeric, is_pinned boolean,
  satellite_seats integer, free_buy boolean, addon_from_start boolean, schedule_id uuid,
  restart_source_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.tournament_players (tournament_id uuid NOT NULL, user_id uuid NOT NULL);
CREATE TABLE public.tournament_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), union_id uuid, club_id uuid NOT NULL,
  name text NOT NULL, description text, active boolean NOT NULL DEFAULT true,
  days_of_week integer[] NOT NULL DEFAULT '{1}', start_times_utc text[] NOT NULL DEFAULT '{}',
  interval_minutes integer, config jsonb NOT NULL, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  time_zone text);
CREATE TABLE public.ca_declared_money_triggers (
  table_name text NOT NULL, trigger_name text NOT NULL, note text,
  PRIMARY KEY (table_name, trigger_name));

-- What the governed creator calls.
CREATE FUNCTION public.is_club_admin(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_can_create_games(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE FUNCTION public.fn_ca_new_tournament_is_unlimited(p jsonb) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT upper(COALESCE(p->>'tournament_type','')) = 'MTT' $$;
CREATE FUNCTION public.fn_is_free_buy_event(numeric, numeric, text, text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT false $$;

-- @guards: installed after the seed rows, as production's guards were.
CREATE FUNCTION public.fn_guard_managed_game_lifecycle() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public' AS $function$
DECLARE
  v_is_engine boolean := COALESCE(auth.role(), '') = 'service_role';
  v_protected_tournament_keys text[] := ARRAY['name', 'buy_in_amount', 'tournament_type',
    'is_private', 'is_vip_only', 'ban_chat', 'all_in_or_fold', 'union_id'];
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'tournaments'
     AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id) THEN
    IF NOT v_is_engine THEN
      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (to_jsonb(NEW) -> v_key) IS DISTINCT FROM (to_jsonb(OLD) -> v_key) THEN
          RAISE EXCEPTION 'This tournament cannot be modified after a player has registered'
            USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_tournaments_managed_lifecycle_guard BEFORE UPDATE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_lifecycle();

CREATE FUNCTION public.fn_guard_retired_club_mutation() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id IN (NEW.club_id, OLD.club_id) AND c.lifecycle_status = 'retired') THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR UPDATE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_club_mutation();
CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR UPDATE ON public.tournament_schedules
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_club_mutation();

CREATE FUNCTION public.fn_enforce_tournament_union_ownership_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER trg_tournaments_union_ownership_upd BEFORE UPDATE ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_tournament_union_ownership_update();
