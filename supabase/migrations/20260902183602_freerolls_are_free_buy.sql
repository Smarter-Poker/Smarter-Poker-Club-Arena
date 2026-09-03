-- ═══════════════════════════════════════════════════════════════════════════════
--  FREEROLLS ARE FREE BUY (Dan, 2026-09-02, BINDING)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "FREE ROLLS MUST ALWAYS BE SET AS 'FREE BUY'. ITS FREE TO
-- ENTER, $0 BUY IN, BUT REBUYS AND ADD ON'S COST $1. MAKE SURE THAT IS BAKED IN
-- HOW EVER ITS NEEDED."
--
-- WHAT PRODUCTION LOOKED LIKE (18:22 UTC, buy_in_amount = 0, last 14 days):
--   183 freerolls  is_rebuy=false, add_on_available=false, rebuy_cost NULL
--    58 freerolls  is_rebuy=true,  add_on_available=true,  rebuy_cost 1.00
--                  but addon_cost 0.00 (the add-on was given away free)
--    31 older ones with every rebuy/add-on column 0
-- Not one of them followed the rule end to end. The 58 came from
-- tournament_schedules whose config spells the key `addonCost`, while
-- ScheduledTournamentService read `addOnCost`, so the add-on price fell
-- through to `split.total`, which is 0 on a freeroll.
--
-- THE PREDICATE (fn_is_free_buy_event): an event is a freeroll when
--   buy_in_amount = 0 AND buy_in_fee = 0 AND tournament_type = 'MTT'
--   AND variant is not 'spin' / 'sng'.
-- Spins are excluded because a Spin's price IS its multiplier ladder and the
-- tournaments_spin_* constraints own that shape. SNGs are excluded because a
-- two-seat game with no prize side is not a freeroll, it is a misconfigured
-- duel (10 such rows exist, all with a 1.00 fee - the fee test excludes them
-- twice over). Satellites and bounty formats with a 0 buy-in ARE freerolls:
-- entering is free and the $1 rebuys/add-ons feed the same pool.
--
-- WHAT THE TRIGGER DOES: it NORMALISES, it never RAISES. A trigger that refuses
-- the scheduler's insert would stop freerolls being created at all, which is a
-- far worse outcome than a row that needed correcting. On every INSERT of a
-- freeroll, and on every UPDATE of one that has not started (ANNOUNCED or
-- REGISTERING), it forces:
--   is_rebuy = true, add_on_available = true,
--   rebuy_cost = 1.00, addon_cost = 1.00, buy_in_fee = 0,
--   rebuy_chips / addon_chips = starting_chips when 0 or NULL,
--   rebuy_levels = 4 / addon_levels = 1 (the column defaults) when NULL or 0,
--   max_rebuys = NULL when 0.
-- The last two are deliberate: process_tournament_rebuy reads a NOT NULL
-- max_rebuys of 0 as "Rebuy limit reached (0 of 0)" and a 0-level window as
-- "never closes", and both contradict a rule that says rebuys are on. A
-- RUNNING or COMPLETED event is never rewritten: its contract is what its
-- players entered under.
--
-- EVERY NORMALISATION IS LOGGED to ca_freeroll_free_buy_log (tournament, op,
-- and the exact column-by-column before/after) so the rule's activity is
-- visible rather than silent.
--
-- THE ONE-TIME BACKFILL rewrites every NOT-STARTED freeroll to the same
-- settings so today's remaining events comply. Fourteen of them already hold
-- registrations, and fn_guard_managed_game_lifecycle refuses contract edits
-- under registered players unless the caller is the engine. This IS a system
-- revision - the same class as the engine fitting a payout ladder - so the
-- backfill declares itself service_role for the length of this transaction
-- only (set_config(..., true)). fn_capture_managed_game_contract records each
-- rewrite as a 'system_revision' in managed_game_contract_versions, so the
-- change is auditable per event.
--
-- Tier 2. No DROP, no type change, no RPC signature change. One transaction.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The predicate ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_is_free_buy_event(
  p_buy_in_amount numeric,
  p_buy_in_fee numeric,
  p_tournament_type text,
  p_variant text
) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(p_buy_in_amount, 0) = 0
     AND COALESCE(p_buy_in_fee, 0) = 0
     AND upper(COALESCE(p_tournament_type, 'MTT')) = 'MTT'
     AND lower(COALESCE(p_variant, 'freezeout')) NOT IN ('spin', 'sng');
$$;

COMMENT ON FUNCTION public.fn_is_free_buy_event(numeric, numeric, text, text) IS
  'True when a tournaments row is a freeroll under Dan''s 2026-09-02 Free Buy rule: 0 to enter, 0 fee, MTT-family (not a Spin, not an SNG). Such an event must carry 1.00 rebuys and 1.00 add-ons, both switched on.';

-- ── 2. The activity log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_freeroll_free_buy_log (
  id              bigserial PRIMARY KEY,
  tournament_id   uuid NOT NULL,
  tournament_name text,
  op              text NOT NULL,
  status          text,
  changed         jsonb NOT NULL,
  db_role         text NOT NULL DEFAULT current_user,
  app_name        text NOT NULL DEFAULT COALESCE(current_setting('application_name', true), ''),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ca_freeroll_free_buy_log IS
  'One row per tournaments INSERT/UPDATE/BACKFILL that fn_freerolls_are_free_buy had to correct. `changed` is {column: {from, to}}. Added 2026-09-02 so the Free Buy rule''s activity is visible: a creator that keeps landing here is a creator that still passes the wrong settings.';

ALTER TABLE public.ca_freeroll_free_buy_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_freeroll_free_buy_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ca_freeroll_free_buy_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_freeroll_free_buy_log_id_seq TO service_role;

CREATE INDEX IF NOT EXISTS idx_ca_freeroll_free_buy_log_tournament
  ON public.ca_freeroll_free_buy_log (tournament_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_freeroll_free_buy_log_recent
  ON public.ca_freeroll_free_buy_log (created_at DESC);

-- ── 3. The normaliser ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_freerolls_are_free_buy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_stack   integer;
  v_op      text;
BEGIN
  IF NOT public.fn_is_free_buy_event(
       NEW.buy_in_amount, NEW.buy_in_fee, NEW.tournament_type, NEW.variant
     ) THEN
    RETURN NEW;
  END IF;

  -- A live or finished event keeps the contract its players entered under.
  -- Inserts are always pre-start.
  IF TG_OP = 'UPDATE'
     AND upper(COALESCE(NEW.status, '')) NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN NEW;
  END IF;

  v_stack := COALESCE(NULLIF(NEW.starting_chips, 0), 10000);

  IF NEW.buy_in_fee IS DISTINCT FROM 0 THEN
    v_changed := v_changed || jsonb_build_object('buy_in_fee',
      jsonb_build_object('from', NEW.buy_in_fee, 'to', 0));
    NEW.buy_in_fee := 0;
  END IF;

  IF NOT COALESCE(NEW.is_rebuy, false) THEN
    v_changed := v_changed || jsonb_build_object('is_rebuy',
      jsonb_build_object('from', NEW.is_rebuy, 'to', true));
    NEW.is_rebuy := true;
  END IF;

  IF NOT COALESCE(NEW.add_on_available, false) THEN
    v_changed := v_changed || jsonb_build_object('add_on_available',
      jsonb_build_object('from', NEW.add_on_available, 'to', true));
    NEW.add_on_available := true;
  END IF;

  IF NEW.rebuy_cost IS DISTINCT FROM 1.00 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_cost',
      jsonb_build_object('from', NEW.rebuy_cost, 'to', 1.00));
    NEW.rebuy_cost := 1.00;
  END IF;

  IF NEW.addon_cost IS DISTINCT FROM 1.00 THEN
    v_changed := v_changed || jsonb_build_object('addon_cost',
      jsonb_build_object('from', NEW.addon_cost, 'to', 1.00));
    NEW.addon_cost := 1.00;
  END IF;

  IF COALESCE(NEW.rebuy_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_chips',
      jsonb_build_object('from', NEW.rebuy_chips, 'to', v_stack));
    NEW.rebuy_chips := v_stack;
  END IF;

  IF COALESCE(NEW.addon_chips, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_chips',
      jsonb_build_object('from', NEW.addon_chips, 'to', v_stack));
    NEW.addon_chips := v_stack;
  END IF;

  IF COALESCE(NEW.rebuy_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('rebuy_levels',
      jsonb_build_object('from', NEW.rebuy_levels, 'to', 4));
    NEW.rebuy_levels := 4;
  END IF;

  IF COALESCE(NEW.addon_levels, 0) <= 0 THEN
    v_changed := v_changed || jsonb_build_object('addon_levels',
      jsonb_build_object('from', NEW.addon_levels, 'to', 1));
    NEW.addon_levels := 1;
  END IF;

  IF NEW.max_rebuys IS NOT NULL AND NEW.max_rebuys <= 0 THEN
    v_changed := v_changed || jsonb_build_object('max_rebuys',
      jsonb_build_object('from', NEW.max_rebuys, 'to', NULL));
    NEW.max_rebuys := NULL;
  END IF;

  IF v_changed <> '{}'::jsonb THEN
    v_op := CASE
      WHEN COALESCE(current_setting('app.freeroll_free_buy_backfill', true), '') = 'on'
        THEN 'BACKFILL'
      ELSE TG_OP
    END;
    BEGIN
      INSERT INTO public.ca_freeroll_free_buy_log
        (tournament_id, tournament_name, op, status, changed)
      VALUES
        (NEW.id, NEW.name, v_op, NEW.status, v_changed);
    EXCEPTION WHEN OTHERS THEN
      -- The log is evidence, not a gate. Never let it block the row.
      RAISE WARNING 'fn_freerolls_are_free_buy: could not log % for %: %',
        v_op, NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_freerolls_are_free_buy() IS
  'BEFORE INSERT OR UPDATE on tournaments. When fn_is_free_buy_event says the row is a freeroll and it has not started, forces is_rebuy/add_on_available on at 1.00 each, fee 0, chips from starting_chips, windows 4/1, max_rebuys NULL when 0, and logs the diff to ca_freeroll_free_buy_log. It normalises; it never raises (Dan 2026-09-02: a refused scheduler insert would stop freerolls being created).';

DROP TRIGGER IF EXISTS zz_freerolls_are_free_buy ON public.tournaments;
CREATE TRIGGER zz_freerolls_are_free_buy
  BEFORE INSERT OR UPDATE OF
    buy_in_amount, buy_in_fee, tournament_type, variant,
    is_rebuy, add_on_available, rebuy_cost, addon_cost,
    rebuy_chips, addon_chips, rebuy_levels, addon_levels, max_rebuys
  ON public.tournaments
  FOR EACH ROW
  WHEN (COALESCE(NEW.buy_in_amount, 0) = 0)
  EXECUTE FUNCTION public.fn_freerolls_are_free_buy();

-- ── 4. One-time backfill of every NOT-STARTED freeroll ───────────────────────
-- The lifecycle guard admits contract edits under registered players only from
-- the engine. This normalisation is a system revision of exactly that kind;
-- the role claim is transaction-local and dies with the COMMIT below.
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('app.freeroll_free_buy_backfill', 'on', true);

UPDATE public.tournaments t
   SET is_rebuy = true,
       add_on_available = true,
       rebuy_cost = 1.00,
       addon_cost = 1.00
 WHERE public.fn_is_free_buy_event(t.buy_in_amount, t.buy_in_fee, t.tournament_type, t.variant)
   AND upper(COALESCE(t.status, '')) IN ('ANNOUNCED', 'REGISTERING')
   AND (
        NOT COALESCE(t.is_rebuy, false)
     OR NOT COALESCE(t.add_on_available, false)
     OR t.rebuy_cost IS DISTINCT FROM 1.00
     OR t.addon_cost IS DISTINCT FROM 1.00
     OR COALESCE(t.rebuy_chips, 0) <= 0
     OR COALESCE(t.addon_chips, 0) <= 0
     OR COALESCE(t.rebuy_levels, 0) <= 0
     OR COALESCE(t.addon_levels, 0) <= 0
     OR (t.max_rebuys IS NOT NULL AND t.max_rebuys <= 0)
   );

SELECT set_config('app.freeroll_free_buy_backfill', '', true);
SELECT set_config('request.jwt.claim.role', '', true);

-- ── 5. Post-apply assertions (abort the whole transaction if any fail) ───────
DO $$
DECLARE
  v_violators integer;
  v_src text;
BEGIN
  SELECT count(*) INTO v_violators
    FROM public.tournaments t
   WHERE public.fn_is_free_buy_event(t.buy_in_amount, t.buy_in_fee, t.tournament_type, t.variant)
     AND upper(COALESCE(t.status, '')) IN ('ANNOUNCED', 'REGISTERING')
     AND (
          NOT COALESCE(t.is_rebuy, false)
       OR NOT COALESCE(t.add_on_available, false)
       OR t.rebuy_cost IS DISTINCT FROM 1.00
       OR t.addon_cost IS DISTINCT FROM 1.00
       OR COALESCE(t.rebuy_chips, 0) <= 0
       OR COALESCE(t.addon_chips, 0) <= 0
       OR COALESCE(t.rebuy_levels, 0) <= 0
       OR COALESCE(t.addon_levels, 0) <= 0
       OR (t.max_rebuys IS NOT NULL AND t.max_rebuys <= 0)
     );
  IF v_violators <> 0 THEN
    RAISE EXCEPTION 'freerolls_are_free_buy: % not-started freeroll(s) still violate the Free Buy rule after backfill', v_violators;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournaments'::regclass
       AND tgname = 'zz_freerolls_are_free_buy'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'freerolls_are_free_buy: trigger zz_freerolls_are_free_buy is missing';
  END IF;

  -- The normaliser must never refuse a row. RAISE WARNING (the log fallback)
  -- is allowed; RAISE EXCEPTION is not.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_freerolls_are_free_buy';
  IF v_src ~* 'RAISE\s+EXCEPTION' THEN
    RAISE EXCEPTION 'freerolls_are_free_buy: the normaliser contains RAISE EXCEPTION - it must normalise, never refuse';
  END IF;

  -- No running or finished event was touched by the backfill.
  IF EXISTS (
    SELECT 1 FROM public.ca_freeroll_free_buy_log
     WHERE op = 'BACKFILL'
       AND upper(COALESCE(status, '')) NOT IN ('ANNOUNCED', 'REGISTERING')
  ) THEN
    RAISE EXCEPTION 'freerolls_are_free_buy: backfill touched an event that had already started';
  END IF;
END $$;

COMMIT;
