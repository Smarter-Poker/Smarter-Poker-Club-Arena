-- ═══════════════════════════════════════════════════════════════════════════
-- DAN, 2026-10-21: "STARTING TOMORROW ALL MTT TOURNAMENTS MUST PAY OUT THE TOP
-- 12.5% OF THE FIELD. ANYTHING LESS IS WRONG. CORRECT THIS AND MAKE SURE ALL
-- FUTURE TOURNAMENTS HAVE THIS IMPLEMENTED. (STAND ALONE CLUBS CAN SET IT TO
-- WHAT EVER THEY WANT, BUT THE DEFAULT SHOULD BE 12.5%)"
--
-- Before this migration every MTT paid ceil(field * payout_percent / 100) with
-- payout_percent a smallint restricted to 10/15/20, and every live event held
-- 10. 12.5 cannot be stored in that column, and changing its type rewrites a
-- 1.25 GB hot table under ACCESS EXCLUSIVE. So the paid depth gets its own
-- column, added as metadata only:
--
--   payout_depth_percent numeric(5,2)   the share of the field paid, (0,100]
--
-- One trigger is the single authority for every write path (creation RPC,
-- scheduled spawner, recurring templates, Diamond creator, restarts):
--   * MTTs in the Midway Union, any union, or the Diamond Arena: 12.5, always.
--   * Standalone club MTTs: whatever the club set; 12.5 when it set nothing.
--     A legacy explicit 15/20 in payout_percent is honoured; legacy 10 was the
--     old default and becomes 12.5.
--   * Satellites, Spins and Sit & Gos: untouched (NULL; they keep their terms).
--   * Once an event's prize pool is finalized its depth is frozen.
--
-- The two ladder builders (entry close and start lock) now read
-- COALESCE(payout_depth_percent, payout_percent). Completed and committed
-- events are never rewritten. Live MTTs whose payout terms are not yet
-- committed are moved to 12.5 by the DML-only companion migration
-- 20261022014651 (row locks only, kept out of this ACCESS EXCLUSIVE window).
-- ═══════════════════════════════════════════════════════════════════════════
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)'::regprocedure)) = 'b753df26912528d468e2dd71c7eb03ad' AND md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure)) = 'e979db46832dfeec050164ab02eeb5d2' AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.tournaments'::regclass AND tgname = 'ca_mtt_payout_depth_guard'))
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- Short, backing-off lock on the hot table (pattern from 20261021174448): never
-- queue live writers behind this transaction for more than 200 ms per try.
DO $locks$
DECLARE i int;
BEGIN
 FOR i IN 1..100 LOOP
  BEGIN
   PERFORM set_config('lock_timeout','200ms',true);
   LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE;
   PERFORM set_config('lock_timeout','3s',true);
   RETURN;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
   PERFORM pg_sleep(0.1 + random()*0.15);
  END;
 END LOOP;
 RAISE EXCEPTION 'tournaments lock not obtained in 100 short tries';
END $locks$;

-- None of the functions changed here may be a watched guard.
DO $watchlist$
BEGIN
 IF public.fn_ca_guard_watchlist() && ARRAY[
   'fn_finalize_tournament_entry_pool_locked','fn_ca_fund_overlay_on_lock',
   'fn_create_tournament','fn_poker_diamond_create_tournament_core',
   'fn_club_welcome_package_config','fn_ca_payout_structure'
 ]::text[] THEN
   RAISE EXCEPTION 'payout depth target became watched; requalify guard declarations';
 END IF;
END $watchlist$;

-- ── 1. The column (metadata-only: nullable, no default) ────────────────────
ALTER TABLE public.tournaments ADD COLUMN payout_depth_percent numeric(5,2);
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_payout_depth_percent_range
  CHECK (payout_depth_percent IS NULL
         OR (payout_depth_percent > 0 AND payout_depth_percent <= 100)) NOT VALID;
COMMENT ON COLUMN public.tournaments.payout_depth_percent IS
  'Share of the field an MTT pays, in percent (Dan 2026-10-21). 12.5 for every Midway, union and Diamond Arena MTT; standalone clubs choose, default 12.5. NULL for Spins, Sit & Gos and satellites, which keep payout_percent. Paid places = ceil(entrants * depth / 100), minimum 1. Set by trg ca_mtt_payout_depth_guard; frozen once the prize pool is finalized.';

-- ── 2. The ladder generator at any depth ───────────────────────────────────
CREATE FUNCTION public.fn_ca_payout_structure(p_entrants integer, p_percent numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_places int;
  v_pct    numeric;
  v_out    jsonb;
BEGIN
  v_pct := CASE WHEN p_percent > 0 AND p_percent <= 100 THEN p_percent ELSE 12.5 END;
  IF COALESCE(p_entrants,0) <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  -- at least one place, never more places than players, rounded up
  v_places := GREATEST(1, LEAST(p_entrants, ceil(p_entrants * v_pct / 100.0)::int));

  WITH w AS (
    SELECT i AS place, 1.0 / power(i, 0.8) AS weight
      FROM generate_series(1, v_places) i
  ), n AS (
    SELECT place, 100.0 * weight / SUM(weight) OVER () AS exact FROM w
  ), f AS (
    SELECT place, floor(exact * 100) / 100 AS floored,
           (exact * 100) - floor(exact * 100) AS frac
      FROM n
  ), r AS (
    SELECT place, floored,
           row_number() OVER (ORDER BY frac DESC, place ASC) AS rk,
           round((100.0 - SUM(floored) OVER ()) * 100)::int AS cents_left
      FROM f
  )
  SELECT jsonb_agg(jsonb_build_object('place', place,
           'percentage', floored + CASE WHEN rk <= cents_left THEN 0.01 ELSE 0 END)
           ORDER BY place)
    INTO v_out FROM r;
  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$fn$;
COMMENT ON FUNCTION public.fn_ca_payout_structure(integer, numeric) IS
  'Payout table for p_entrants paying the top p_percent of the field (any value in (0,100], default 12.5). Places = ceil(entrants * percent / 100), min 1, never more than the field. Weight 1/place^0.8, largest-remainder rounding to exactly 100.00.';
REVOKE ALL ON FUNCTION public.fn_ca_payout_structure(integer, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_payout_structure(integer, numeric) TO service_role;

-- The one place the depth an event pays is read.
CREATE FUNCTION public.fn_ca_effective_payout_depth(p_depth numeric, p_legacy_percent smallint)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $fn$
  SELECT COALESCE(p_depth, p_legacy_percent::numeric, 12.5);
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_effective_payout_depth(numeric, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_effective_payout_depth(numeric, smallint) TO service_role;

-- A creator's requested depth: any number in (0,100], otherwise none.
CREATE FUNCTION public.fn_ca_requested_payout_depth(p_value text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $fn$
DECLARE v numeric;
BEGIN
  IF p_value IS NULL OR btrim(p_value) !~ '^[0-9]+(\.[0-9]+)?$' THEN RETURN NULL; END IF;
  v := round(btrim(p_value)::numeric, 2);
  RETURN CASE WHEN v > 0 AND v <= 100 THEN v END;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_requested_payout_depth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_requested_payout_depth(text) TO service_role;

-- ── 3. The write boundary ──────────────────────────────────────────────────
CREATE FUNCTION public.fn_ca_mtt_payout_depth_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp AS $fn$
DECLARE
  v_club_union uuid;
  v_asset text;
  v_is_mtt boolean;
  v_enforced boolean;
  v_depth numeric;
BEGIN
  -- Payout terms that are already committed never move.
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.prize_pool_finalized, false) THEN
    NEW.payout_depth_percent := OLD.payout_depth_percent;
    RETURN NEW;
  END IF;

  v_is_mtt := upper(COALESCE(NEW.tournament_type,'')) = 'MTT'
          AND lower(COALESCE(NEW.variant,'')) NOT IN ('spin','sng','satellite')
          AND NEW.satellite_target_id IS NULL
          AND NOT COALESCE(NEW.is_premium_spin, false);
  IF NOT v_is_mtt THEN
    NEW.payout_depth_percent := NULL;
    RETURN NEW;
  END IF;

  SELECT c.union_id, c.asset INTO v_club_union, v_asset
    FROM public.clubs c WHERE c.id = NEW.club_id;
  v_enforced := NEW.union_id IS NOT NULL
             OR v_club_union IS NOT NULL
             OR v_asset = 'diamonds'
             OR NEW.club_id IS NULL
             OR COALESCE(NEW.is_xmtt, false)
             OR NEW.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid;

  IF v_enforced THEN
    v_depth := 12.5;
  ELSE
    v_depth := COALESCE(
      CASE WHEN NEW.payout_depth_percent > 0 AND NEW.payout_depth_percent <= 100
           THEN NEW.payout_depth_percent END,
      CASE WHEN NEW.payout_percent IN (15, 20) THEN NEW.payout_percent::numeric END,
      12.5);
  END IF;

  -- Never produce a diff an UPDATE did not need (Diamond and lifecycle guards
  -- compare whole rows).
  IF TG_OP = 'UPDATE' AND OLD.payout_depth_percent IS NOT DISTINCT FROM v_depth THEN
    NEW.payout_depth_percent := OLD.payout_depth_percent;
  ELSE
    NEW.payout_depth_percent := v_depth;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_mtt_payout_depth_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ca_mtt_payout_depth_guard
  BEFORE INSERT OR UPDATE OF payout_depth_percent, payout_percent
  ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_ca_mtt_payout_depth_guard();

-- ── 4. The ladder builders read the depth ──────────────────────────────────
-- Exact, asserted text substitutions on the live definitions, so nothing else
-- in these long functions can drift.
DO $patch$
DECLARE
  r record;
  d text;
  n text;
  c int;
  v_meta_before text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_finalize_tournament_entry_pool_locked(uuid,text,text)',
     '4b536704f1210d9a94efb1a8c7be4467', 'b753df26912528d468e2dd71c7eb03ad',
     'COALESCE(v_t.payout_percent,10)',
     'public.fn_ca_effective_payout_depth(v_t.payout_depth_percent,v_t.payout_percent)', 1),
    ('public.fn_ca_fund_overlay_on_lock()',
     '01088024234d3c4ed7a2dc23178d1f50', 'e979db46832dfeec050164ab02eeb5d2',
     'COALESCE(NEW.payout_percent,10)',
     'public.fn_ca_effective_payout_depth(NEW.payout_depth_percent,NEW.payout_percent)', 2),
    ('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)',
     'df0299322b55f04207f82f396af73cb3', 'd739dd286672b1b0be01b447ff31aa68',
     'CASE WHEN (v_cfg->>''payoutPercent'')::int IN (10,15,20) THEN (v_cfg->>''payoutPercent'')::smallint ELSE 10 END',
     'CASE WHEN v_cfg->>''payoutPercent'' IN (''10'',''15'',''20'') THEN (v_cfg->>''payoutPercent'')::smallint ELSE 10 END', 1),
    ('public.fn_club_welcome_package_config(text)',
     '10f88c605edba2da4e0efabe7c07ba22', '815c4459bf3493912bcb7ad7f00dd3bb',
     '''payoutPercent'',10,',
     '''payoutPercent'',12.5,', 1),
    ('public.fn_create_tournament(uuid,jsonb)',
     '547056ed6d7d7b1595a78c7a71bbf780', 'd3585069bf906c99bdb3ae795ac4304d',
     E'UPDATE public.tournaments SET payout_percent = v_pct\n',
     E'UPDATE public.tournaments SET payout_percent = v_pct,\n         payout_depth_percent = public.fn_ca_requested_payout_depth(p_config->>''payoutPercent'')\n', 1)
  ) AS v(sig, md5_before, md5_after, old_text, new_text, expected)
  LOOP
    d := pg_get_functiondef(r.sig::regprocedure);
    IF md5(d) <> r.md5_before THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', r.sig, md5(d);
    END IF;
    c := (length(d) - length(replace(d, r.old_text, ''))) / length(r.old_text);
    IF c <> r.expected THEN
      RAISE EXCEPTION '%: anchor found % times, expected %', r.sig, c, r.expected;
    END IF;
    n := replace(d, r.old_text, r.new_text);
    IF md5(n) <> r.md5_after THEN
      RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', r.sig, md5(n);
    END IF;
    SELECT p.proowner::regrole::text || '|' || p.prosecdef || '|' || COALESCE(p.proconfig::text,'') || '|' || COALESCE(p.proacl::text,'')
      INTO v_meta_before FROM pg_proc p WHERE p.oid = r.sig::regprocedure;
    EXECUTE n;
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.md5_after
       OR (SELECT p.proowner::regrole::text || '|' || p.prosecdef || '|' || COALESCE(p.proconfig::text,'') || '|' || COALESCE(p.proacl::text,'')
             FROM pg_proc p WHERE p.oid = r.sig::regprocedure) IS DISTINCT FROM v_meta_before THEN
      RAISE EXCEPTION '%: owner, security, settings or grants moved', r.sig;
    END IF;
  END LOOP;
END $patch$;

COMMIT;
