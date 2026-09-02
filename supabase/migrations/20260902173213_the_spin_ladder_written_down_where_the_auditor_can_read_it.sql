-- Applied to production 2026-09-02 17:32 UTC. Part 1 of 2.
--
-- THE SPIN LADDER, WRITTEN DOWN WHERE THE AUDITOR CAN READ IT
--
-- On 2026-09-02 a trigger rewrote tournaments.payout_structure for Spins from
-- the size of the field, replacing every high multiplier with winner-take-all.
-- 95 games underpaid 1,878.00 chips to second and third place.
--
-- The reason it ran unnoticed is the part worth fixing:
-- fn_tournament_payout_reconcile reads payout_structure as its SOURCE OF
-- TRUTH. With the column corrupted it computed "expected = 100% to place 1",
-- saw place 1 paid in full, and returned clean:true on a game that had
-- short-changed two players. The corruption made itself invisible to the one
-- check built to catch it. So the ladder needs a source of truth of its own.
--
-- The trigger that attaches the guard is a separate migration because it needs
-- an AccessExclusiveLock on `tournaments`, one of the hottest tables here -
-- taking it in the same statement as everything else deadlocked against live
-- play on the first attempt.

CREATE TABLE IF NOT EXISTS public.spin_payout_ladder (
  multiplier  numeric PRIMARY KEY,
  structure   jsonb   NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.spin_payout_ladder IS
  'The payout ladder each Spin multiplier owes, mirroring SPIN_TIERS in '
  'server/src/config/spinSpec.ts. Sub-10x is winner-take-all; 10x is 80/20; '
  '25x/50x/100x are 80/12/8. Kept in the database because the payout auditor '
  'runs here and had no way to tell a drawn ladder from an overwritten one.';

INSERT INTO public.spin_payout_ladder (multiplier, structure) VALUES
  (2,   '[{"place":1,"percentage":100}]'::jsonb),
  (3,   '[{"place":1,"percentage":100}]'::jsonb),
  (4,   '[{"place":1,"percentage":100}]'::jsonb),
  (5,   '[{"place":1,"percentage":100}]'::jsonb),
  (10,  '[{"place":1,"percentage":80},{"place":2,"percentage":20}]'::jsonb),
  (25,  '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb),
  (50,  '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb),
  (100, '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb)
ON CONFLICT (multiplier) DO UPDATE
  SET structure = EXCLUDED.structure, updated_at = now();

-- NORMALISES, NEVER REFUSES. The same reasoning the seat-exit trigger records:
-- a guard that can refuse is a guard that can strand a game. Raising here would
-- stop a Spin starting, which is a worse outage than the one being prevented.
-- It writes the drawn ladder and files a critical alert instead: the money
-- comes out right either way, and the defect is loud.
CREATE OR REPLACE FUNCTION public.fn_spin_ladder_is_the_drawn_one()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_expected jsonb;
  v_actual   jsonb;
BEGIN
  IF COALESCE(NEW.variant,'') <> 'spin'
     AND upper(COALESCE(NEW.tournament_type,'')) <> 'SPIN' THEN
    RETURN NEW;
  END IF;

  -- Before the wheel is drawn there is no ladder to enforce.
  IF NEW.spin_multiplier IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT structure INTO v_expected
    FROM public.spin_payout_ladder WHERE multiplier = NEW.spin_multiplier;

  -- An unknown multiplier is a real question, not something to guess at.
  IF v_expected IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_actual := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_actual := NULL;
  END;

  IF v_actual IS NOT DISTINCT FROM v_expected THEN
    RETURN NEW;
  END IF;

  NEW.payout_structure := v_expected::text;

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      'critical',
      'fn_spin_ladder_is_the_drawn_one',
      format('Spin %s (%sx) had its payout ladder overwritten with %s; the drawn ladder %s was restored before it could underpay anyone.',
             COALESCE(NEW.name, NEW.id::text), NEW.spin_multiplier,
             COALESCE(v_actual::text,'(unreadable)'), v_expected::text),
      jsonb_build_object('kind','spin_ladder_overwritten',
                         'tournament_id', NEW.id,
                         'multiplier', NEW.spin_multiplier,
                         'was', v_actual,
                         'restored_to', v_expected),
      NEW.id::text);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the correction matters more than the alarm
  END;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.fn_spin_ladder_drift_check(p_since_days integer DEFAULT 7)
RETURNS TABLE (
  tournament_id uuid, multiplier numeric, expected jsonb, actual jsonb, ended_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT t.id, t.spin_multiplier, l.structure,
         NULLIF(btrim(COALESCE(t.payout_structure,'')),'')::jsonb, t.ended_at
    FROM public.tournaments t
    JOIN public.spin_payout_ladder l ON l.multiplier = t.spin_multiplier
   WHERE upper(COALESCE(t.tournament_type,'')) = 'SPIN'
     AND t.created_at > now() - make_interval(days => p_since_days)
     AND NULLIF(btrim(COALESCE(t.payout_structure,'')),'')::jsonb IS DISTINCT FROM l.structure
   ORDER BY t.ended_at DESC NULLS LAST;
$fn$;

COMMENT ON FUNCTION public.fn_spin_ladder_drift_check(integer) IS
  'Spins whose payout ladder does not match the one their multiplier owes. '
  'Should be empty; a non-empty result means something writes the column by a '
  'path that bypasses the trigger.';

-- OPERATOR TELEMETRY, NOT PUBLIC SURFACE.
-- This shipped with the default grant, which is PUBLIC, so an unauthenticated
-- caller could run a SECURITY DEFINER function past RLS and be told every Spin
-- whose ladder disagrees with its multiplier. The pre-push
-- definer-authorization check caught it before the branch landed.
-- Read-only is not the same as harmless. PUBLIC is named as well as the roles
-- because anon inherits whatever PUBLIC holds, so revoking anon alone reads as
-- a fix and does nothing. Confirmed it is not an RLS policy helper, so this
-- cannot deny a SELECT anywhere.
REVOKE ALL ON FUNCTION public.fn_spin_ladder_drift_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_ladder_drift_check(integer)
  TO service_role;
