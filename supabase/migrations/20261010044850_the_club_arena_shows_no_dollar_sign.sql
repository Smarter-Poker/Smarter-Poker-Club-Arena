-- the_club_arena_shows_no_dollar_sign
--
-- THE CLUB ARENA SHOWS NO DOLLAR SIGN (2026-10-09). Dan, 2026-10-09 23:44 CT:
-- "you are forbidden from using $ the dollar sign anywhere in the club arena.
-- it just needs to say 100 Chip Guarantee". Full account:
-- docs/changelog/2026-10-09-the-club-arena-shows-no-dollar-sign.md.
--
-- 1. public.fn_ca_text_without_dollar(text) is the one rewrite: a freeroll
--    description becomes "100 Chip Guarantee", "$100 Freeroll" becomes
--    "100 Chip Guarantee Freeroll", "Cost $8.00 And" becomes "Cost 8 Chips And",
--    "One $8.00 Add-On" becomes "One 8 Chip Add-On", any other "$N" becomes
--    "N", and no "$" survives. It is pure and deterministic.
-- 2. fn_guard_managed_game_lifecycle keeps every registered event's terms
--    frozen, and now admits exactly one change to its name, short description
--    or description: that rewrite of the text it already had. No other edit to
--    those three, and no edit to any other protected key, passes.
-- 3. Every schedule's name, shortDescription and satelliteTargetName are
--    rewritten, so every future occurrence is born without a "$" and every
--    satellite still finds its target by the same rewritten name.
-- 4. Every event not yet finished (ANNOUNCED, REGISTERING, RUNNING and the
--    live states) is rewritten the same way, targets and satellites together.
--    Finished events keep the names they were played under. No money moves.
--
-- @live-proof: (SELECT to_regprocedure('public.fn_ca_text_without_dollar(text)') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tournament_schedules s WHERE s.name LIKE '%$%' OR s.config::text LIKE '%$%'))

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_text_without_dollar(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE WHEN p_text IS NULL OR position('$' IN p_text) = 0 THEN p_text ELSE
    replace(
     regexp_replace(
      regexp_replace(
       regexp_replace(
        regexp_replace(
         regexp_replace(
          regexp_replace(p_text,
            '^\$([0-9]+) (Base|Guaranteed) Prize Pool\. Entry Is Free\..*$', '\1 Chip Guarantee'),
          'Free Entry\. \$([0-9]+) Base Prize Pool\.', 'Free Entry. \1 Chip Guarantee.', 'g'),
         '\$([0-9]+)((?: [A-Za-z0-9]+)*?) Freeroll', '\1 Chip Guarantee\2 Freeroll', 'g'),
        'Cost \$([0-9]+)(?:\.00)? And', 'Cost \1 Chips And', 'g'),
       'One \$([0-9]+)(?:\.00)? Add-On', 'One \1 Chip Add-On', 'g'),
      '\$([0-9]+(?:\.[0-9]+)?)', '\1', 'g'),
    '$', '') END
$fn$;

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'NO_DOLLAR_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure);
BEGIN
  IF position('fn_ca_text_without_dollar' IN v_src) > 0 THEN
    RAISE NOTICE 'NO_DOLLAR already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM 'b90cc1cb27839211a82715c4741410c1' THEN
    RAISE EXCEPTION 'NO_DOLLAR_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
$a$,
$a$      FOREACH v_key IN ARRAY v_protected_tournament_keys LOOP
        -- THE CLUB ARENA SHOWS NO DOLLAR SIGN (2026-10-09): the one change a
        -- registered event's display text may take is the dollar-free rewrite
        -- of the text it already had (public.fn_ca_text_without_dollar).
        CONTINUE WHEN v_key IN ('name', 'short_description', 'description')
          AND jsonb_typeof(v_old_document -> v_key) = 'string'
          AND (v_new_document ->> v_key) IS NOT DISTINCT FROM
              public.fn_ca_text_without_dollar(v_old_document ->> v_key);
        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN
$a$, 'guard loop');
  EXECUTE v_src;
END
$patch$;

-- 3. The schedules: every future occurrence is born without a dollar sign.
UPDATE public.tournament_schedules s
   SET name = public.fn_ca_text_without_dollar(s.name),
       config = s.config
         || CASE WHEN jsonb_typeof(s.config -> 'name') = 'string'
                 THEN jsonb_build_object('name', public.fn_ca_text_without_dollar(s.config ->> 'name')) ELSE '{}'::jsonb END
         || CASE WHEN jsonb_typeof(s.config -> 'shortDescription') = 'string'
                 THEN jsonb_build_object('shortDescription', public.fn_ca_text_without_dollar(s.config ->> 'shortDescription')) ELSE '{}'::jsonb END
         || CASE WHEN jsonb_typeof(s.config -> 'satelliteTargetName') = 'string'
                 THEN jsonb_build_object('satelliteTargetName', public.fn_ca_text_without_dollar(s.config ->> 'satelliteTargetName')) ELSE '{}'::jsonb END
 WHERE s.name LIKE '%$%' OR s.config::text LIKE '%$%';

-- 4. Every event not yet finished.
UPDATE public.tournaments t
   SET name = public.fn_ca_text_without_dollar(t.name),
       short_description = public.fn_ca_text_without_dollar(t.short_description),
       description = public.fn_ca_text_without_dollar(t.description)
 WHERE t.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
   AND (t.name LIKE '%$%' OR t.short_description LIKE '%$%' OR t.description LIKE '%$%');

DO $prove$
BEGIN
  IF public.fn_ca_text_without_dollar('$100 Freeroll • 6:00 AM') IS DISTINCT FROM '100 Chip Guarantee Freeroll • 6:00 AM'
     OR public.fn_ca_text_without_dollar('$100 Guaranteed Prize Pool. Entry Is Free. Every $1 Rebuy And $1 Add-On Goes Into The Prize Pool, Which Never Pays Less Than $100.') IS DISTINCT FROM '100 Chip Guarantee'
     OR public.fn_ca_text_without_dollar('Rebuys Cost $8.00 And Receive The Starting Stack. One $8.00 Add-On At Late-Reg Close Receives 2x Starting Stack.')
          IS DISTINCT FROM 'Rebuys Cost 8 Chips And Receive The Starting Stack. One 8 Chip Add-On At Late-Reg Close Receives 2x Starting Stack.'
     OR public.fn_ca_text_without_dollar('Sunday $200 Deep Stack') IS DISTINCT FROM 'Sunday 200 Deep Stack'
     OR public.fn_ca_text_without_dollar('No sign here') IS DISTINCT FROM 'No sign here' THEN
    RAISE EXCEPTION 'NO_DOLLAR_RESULT_CHANGED: the rewrite';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_schedules s WHERE s.name LIKE '%$%' OR s.config::text LIKE '%$%') THEN
    RAISE EXCEPTION 'NO_DOLLAR_RESULT_CHANGED: a schedule still shows a dollar sign';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournaments t
              WHERE t.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
                AND (t.name LIKE '%$%' OR t.short_description LIKE '%$%' OR t.description LIKE '%$%')) THEN
    RAISE EXCEPTION 'NO_DOLLAR_RESULT_CHANGED: a live event still shows a dollar sign';
  END IF;
  IF position('fn_ca_text_without_dollar' IN pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'NO_DOLLAR_RESULT_CHANGED: the guard';
  END IF;
END
$prove$;

COMMIT;
