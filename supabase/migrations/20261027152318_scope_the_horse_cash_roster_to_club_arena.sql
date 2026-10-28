-- Owner October 27: only the selected half plays CLUB ARENA cash. All 1000
-- registered, nonretired horses remain eligible for Diamond cash/tournaments.
-- This narrows the cash-roster trigger only; normal Diamond custody, wallet,
-- entry, schedule, game-load and profile guards remain authoritative. No seats,
-- wallets, roster rows, tags, retirement state or arena switches are mutated.
-- Version reserved by scripts/new-migration.mjs.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure))
     <> 'd29f6bc4ae830d56bee7130076e95d9e' THEN
    RAISE EXCEPTION 'horse roster seat guard changed; review current source before installing';
  END IF;
END
$preimage$;
CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_seat_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.left_at IS NULL
     AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id THEN RETURN NEW; END IF;
  -- Existing seats and settlement updates remain legal. Tournaments are unchanged.
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=NEW.user_id AND p.is_horse)
     OR EXISTS (SELECT 1 FROM public.tables t WHERE t.id=NEW.table_id AND t.tournament_id IS NOT NULL)
  THEN RETURN NEW; END IF;
  -- Diamond cash is a distinct asset, never inferred from a caller's club id.
  -- A malformed platform/union identity cannot widen the Club Arena roster.
  IF EXISTS (
    SELECT 1 FROM public.tables t
    JOIN public.clubs c ON c.id=t.club_id
    JOIN public.profiles p ON p.id=NEW.user_id
    JOIN public.ca_horse_fleet_register r ON r.horse_id=p.id AND r.retired_at IS NULL
    WHERE t.id=NEW.table_id AND t.tournament_id IS NULL AND t.union_id IS NULL
      AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
      AND p.is_horse AND coalesce(p.status,'active')='active'
      AND coalesce(p.horse_status,'available') <> 'disabled'
  ) THEN RETURN NEW; END IF;
  -- A game's already-owned seat move must complete before the normal safe exit.
  IF NEW.active_game_scope IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.table_seats s WHERE s.user_id=NEW.user_id AND s.left_at IS NULL
      AND s.active_game_scope=NEW.active_game_scope AND s.table_id IS DISTINCT FROM NEW.table_id)
  THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_horse_active_roster r WHERE r.horse_id=NEW.user_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='horse_not_on_cash_roster: only the selected cash performance roster plays Club Arena cash games';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_seat_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_seat_guard() TO service_role;
COMMIT;
