-- 20261022165520_mystery_bounty_half_of_the_whole_entry_in_whole_chip_chests.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-22 11:53 CT, verbatim: "YOU ALSO NEED TO ACCOUNT FOR THE RAKE,
-- SO RAKE COMES OUT OF THE TOP 12.5% PAYOUT, 50% GOES INTO THE BOUNTY POOL.
-- MYSTERY BOUNTIES ARE ALWAYS FULL CHIP AMOUNTS, NEVER FRACTIONS."
--
-- 1. HALF OF THE WHOLE ENTRY. 20261022162651 made a new mystery event's bounty
--    half of the entry CONTRIBUTION (buy-in after the fee), so the fee came
--    out of both halves. The bounty is now half of the whole entry (buy-in plus
--    fee) in whole chips (whole Diamonds at the arena); the fee comes out of
--    the prize-pool half alone. A 20 entry with a 2 fee: 10 bounty, 8 prize
--    pool. The description says so, re-derived for the events on the board
--    (whose entry split stays what their entrants paid).
--
-- 2. WHOLE-CHIP CHESTS. A chip event's money unit is a cent, and the chests
--    were cut on it, so a ladder could hold 37.41. fn_mystery_bounty_seed now
--    seals every chest on whole chips (a whole Diamond is already whole): it
--    accepts an inventory the engine built at the cent or at the whole chip,
--    re-cuts it onto whole chips by largest remainder (the order the engine
--    shuffled is kept), and records the sealed total as the mystery pool. The
--    odd cents under one chip stay in the bounty pool, which the champion's
--    residual settlement already pays. Accepting both grids is what lets the
--    serving engine (cents) and the next one (whole chips, mysteryBountyTerms
--    and TournamentManagerBase) both seed. fn_mystery_bounty_reserve splits a
--    shared chest in whole chips too.
--
-- @live-proof: (SELECT position('v_chest_unit' IN pg_get_functiondef('public.fn_mystery_bounty_seed(uuid,integer,jsonb)'::regprocedure)) > 0 AND position('GREATEST(100, public.fn_ca_tournament_unit_cents(p_tournament_id))' IN pg_get_functiondef('public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'::regprocedure)) > 0 AND position('The Prize Pool Is The Rest, After The Fee' IN pg_get_functiondef('public.fn_ca_mystery_mtt_terms()'::regprocedure)) > 0)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ═══ 1. Half of the whole entry, in whole chips ════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_mystery_mtt_terms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_total_cents bigint;
  v_half bigint;
  v_old numeric;
  v_bounty_pct integer;
BEGIN
  IF NOT COALESCE(NEW.is_mystery_bounty, false) OR COALESCE(NEW.is_pko, false) THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.tournament_type, 'MTT')) <> 'MTT'
     OR lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.status, 'REGISTERING')) NOT IN ('REGISTERING', 'ANNOUNCED')
     OR COALESCE(NEW.mystery_bounty_stage, 'pending') <> 'pending' THEN
    RETURN NEW;
  END IF;
  v_total_cents := round((COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0)) * 100);
  IF v_total_cents <= 0 THEN
    RETURN NEW;
  END IF;

  -- Half of the whole entry is the bounty, in whole chips (whole Diamonds at
  -- the arena); the fee comes out of the prize-pool half. Only at creation:
  -- an event that already took entries keeps the split they paid.
  IF TG_OP = 'INSERT' THEN
    v_half := LEAST((v_total_cents / 2 / 100) * 100,
                    round(COALESCE(NEW.buy_in_amount, 0) * 100)::bigint);
    IF v_half > 0 THEN
      v_old := NEW.bounty_amount;
      NEW.bounty_amount := v_half / 100.0;
      IF COALESCE(v_old, 0) > 0 AND v_old <> NEW.bounty_amount THEN
        NEW.mystery_bounty_min := round(COALESCE(NEW.mystery_bounty_min, 0) * NEW.bounty_amount / v_old, 2);
        NEW.mystery_bounty_max := round(COALESCE(NEW.mystery_bounty_max, 0) * NEW.bounty_amount / v_old, 2);
      END IF;
    END IF;
  END IF;

  NEW.mystery_bounty_pool_percent := 100;
  NEW.mystery_bounty_regular_pool_percent := 0;
  NEW.mystery_bounty_activation := 'at_the_money';
  NEW.mystery_bounty_activation_value := NULL;

  IF COALESCE(NEW.bounty_amount, 0) > 0 THEN
    v_bounty_pct := round(NEW.bounty_amount * 10000 / v_total_cents)::integer;
    NEW.short_description := format(
      '%s%% Of Each Entry Funds The Mystery Bounty Pool. The Prize Pool Is The Rest, '
      || 'After The Fee. No Bounties Are Paid Before The Money. Once The Tournament '
      || 'Reaches The Money, Every Knockout Picks 1 Of 3 Mystery Chests.',
      v_bounty_pct);
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_mystery_mtt_terms() IS
  'Dan 2026-10-22: a paid pre-start mystery MTT seals its whole bounty pool into chests opened at the money (no bounty before the money); a new one puts half of the whole entry, in whole chips, into the bounty pool and the fee comes out of the prize-pool half.';

-- ═══ 2. Whole-chip chests ══════════════════════════════════════════════════

DO $seed$
DECLARE
  sig constant regprocedure := 'public.fn_mystery_bounty_seed(uuid,integer,jsonb)'::regprocedure;
  d text;
  a0 constant text := E'  v_unrecorded_cents bigint := 0;\n';
  a1 constant text := E'  IF v_sum <> v_pool_cents THEN';
  a2 constant text := E'  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)';
  a3 constant text := E'    FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(c, ord)';
  a4 constant text := E'         mystery_bounty_pool_cents = v_pool_cents\n';
  n integer;
BEGIN
  d := pg_get_functiondef(sig);
  IF position('v_chest_unit' IN d) > 0 THEN RETURN; END IF;
  FOREACH n IN ARRAY ARRAY[
    (length(d) - length(replace(d, a0, ''))) / length(a0),
    (length(d) - length(replace(d, a1, ''))) / length(a1),
    (length(d) - length(replace(d, a2, ''))) / length(a2),
    (length(d) - length(replace(d, a3, ''))) / length(a3),
    (length(d) - length(replace(d, a4, ''))) / length(a4)] LOOP
    IF n <> 1 THEN
      RAISE EXCEPTION 'fn_mystery_bounty_seed changed shape; whole-chip chests not installed';
    END IF;
  END LOOP;

  d := replace(d, a0, a0
    || E'  -- WHOLE CHIPS (Dan 2026-10-22): every chest is a whole chip, or a whole\n'
    || E'  -- Diamond, whichever is larger than the event''s money unit.\n'
    || E'  v_chest_unit bigint;\n'
    || E'  v_whole bigint;\n'
    || E'  v_norm jsonb;\n');

  d := replace(d, a1,
       E'  v_chest_unit := GREATEST(100, public.fn_ca_tournament_unit_cents(p_tournament_id));\n'
    || E'  v_whole := (v_pool_cents / v_chest_unit) * v_chest_unit;\n'
    || E'  -- The serving engine cuts at the money unit, the next one at the whole\n'
    || E'  -- chip: either total is this pool.\n'
    || E'  IF v_sum <> v_pool_cents AND v_sum <> v_whole THEN');

  d := replace(d, a2,
       E'  -- Re-cut onto whole chips by largest remainder, keeping the engine''s\n'
    || E'  -- shuffled order (seq). A pool too small to give every chest a chip\n'
    || E'  -- keeps the cut it was given rather than strand the knockouts.\n'
    || E'  v_norm := p_chests;\n'
    || E'  IF v_whole >= v_chest_unit * jsonb_array_length(p_chests) THEN\n'
    || E'    WITH c AS (\n'
    || E'      SELECT e, ord, (e->>''amount_cents'')::bigint AS amt\n'
    || E'        FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(e, ord)\n'
    || E'    ), s AS (SELECT sum(amt) AS total FROM c),\n'
    || E'    f AS (\n'
    || E'      SELECT c.e, c.ord,\n'
    || E'             (c.amt::numeric * v_whole / NULLIF(s.total, 0)) / v_chest_unit AS exact\n'
    || E'        FROM c, s\n'
    || E'    ), g AS (\n'
    || E'      SELECT e, ord, floor(exact)::bigint AS base, exact - floor(exact) AS frac FROM f\n'
    || E'    ), r AS (\n'
    || E'      SELECT e, ord, base,\n'
    || E'             row_number() OVER (ORDER BY frac DESC, ord) AS rk,\n'
    || E'             (v_whole / v_chest_unit) - sum(base) OVER () AS spare\n'
    || E'        FROM g\n'
    || E'    )\n'
    || E'    SELECT jsonb_agg(e || jsonb_build_object(''amount_cents'',\n'
    || E'             (base + CASE WHEN rk <= spare THEN 1 ELSE 0 END) * v_chest_unit) ORDER BY ord)\n'
    || E'      INTO v_norm FROM r;\n'
    || E'    IF v_norm IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_norm) x\n'
    || E'                WHERE (x->>''amount_cents'')::bigint < v_chest_unit) THEN\n'
    || E'      v_norm := p_chests;\n'
    || E'    END IF;\n'
    || E'  END IF;\n\n'
    || a2);

  d := replace(d, a3, E'    FROM jsonb_array_elements(v_norm) WITH ORDINALITY AS t(c, ord)');
  d := replace(d, a4,
    E'         mystery_bounty_pool_cents = (SELECT sum((x->>''amount_cents'')::bigint)\n'
    || E'                                        FROM jsonb_array_elements(v_norm) x)\n');
  EXECUTE d;
END
$seed$;

DO $reserve$
DECLARE
  sig constant regprocedure :=
    'public.fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer)'::regprocedure;
  d text;
  a constant text := 'v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);';
BEGIN
  d := pg_get_functiondef(sig);
  IF position('GREATEST(100, public.fn_ca_tournament_unit_cents(p_tournament_id))' IN d) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'fn_mystery_bounty_reserve changed shape; whole-chip splits not installed';
  END IF;
  -- A shared chest divides in whole chips (Dan 2026-10-22).
  EXECUTE replace(d, a,
    'v_unit integer := GREATEST(100, public.fn_ca_tournament_unit_cents(p_tournament_id));');
END
$reserve$;

-- The offer table is reached only through its SECURITY DEFINER doors; no role
-- holds it directly (20261022162651 revoked anon and authenticated only).
REVOKE ALL ON public.tournament_bounty_award_offers FROM PUBLIC, anon, authenticated, service_role;

-- ═══ 3. The events on the board describe their real split ══════════════════

SELECT set_config('app.mystery_terms_rule', 'on', true);

UPDATE public.tournaments t
   SET mystery_bounty_pool_percent = 100
 WHERE COALESCE(t.is_mystery_bounty, false)
   AND NOT COALESCE(t.is_pko, false)
   AND upper(COALESCE(t.tournament_type, 'MTT')) = 'MTT'
   AND lower(COALESCE(t.variant, '')) <> 'satellite'
   AND t.satellite_target_id IS NULL
   AND upper(COALESCE(t.status, '')) IN ('REGISTERING', 'ANNOUNCED')
   AND COALESCE(t.mystery_bounty_stage, 'pending') = 'pending'
   AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0;

UPDATE public.tournament_schedules s
   SET config = s.config || jsonb_build_object('shortDescription',
         '50% Of Each Entry Funds The Mystery Bounty Pool. The Prize Pool Is The Rest, '
         || 'After The Fee. No Bounties Are Paid Before The Money. Once The Tournament '
         || 'Reaches The Money, Every Knockout Picks 1 Of 3 Mystery Chests.'),
       updated_at = now()
 WHERE s.config->>'type' = 'mystery_bounty'
   AND s.config ? 'shortDescription';

DO $assert$
DECLARE
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
   WHERE COALESCE(t.is_mystery_bounty, false)
     AND NOT COALESCE(t.is_pko, false)
     AND upper(COALESCE(t.tournament_type, 'MTT')) = 'MTT'
     AND lower(COALESCE(t.variant, '')) <> 'satellite'
     AND t.satellite_target_id IS NULL
     AND upper(COALESCE(t.status, '')) IN ('REGISTERING', 'ANNOUNCED')
     AND COALESCE(t.mystery_bounty_stage, 'pending') = 'pending'
     AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
     AND t.short_description NOT LIKE '%The Prize Pool Is The Rest, After The Fee%';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'mystery events not re-described after the rule: %', v_left;
  END IF;
END
$assert$;

COMMIT;
