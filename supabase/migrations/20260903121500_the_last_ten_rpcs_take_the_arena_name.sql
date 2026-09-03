-- ============================================================================
-- THE LAST TEN RPCs TAKE THE ARENA NAME
--
-- Dan, 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE
-- POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB."
--
-- Completes the sweep started in 20260903120000 (one resolver) and
-- 20260903121000 (the first ten RPCs). These are the remaining ten public
-- functions that this repo calls and that select a person's name straight out
-- of `profiles`.
--
-- WHY THIS ONE IS GENERATED RATHER THAN RETYPED
--
-- The first ten were retyped in full, which is the readable way to do it. Three
-- of these ten are money functions - fn_club_bank_ledger, fn_agent_downline_rake
-- and fn_union_settlement_preview - and retyping 45KB of settlement arithmetic
-- to change a name expression is how a rounding rule quietly changes. So this
-- migration reads each definition from the catalog, substitutes ONLY
-- `<alias>.display_name` for the named profiles aliases, and then PROVES the
-- substitution was the only edit: it collapses the new definition back and
-- refuses to proceed unless the result is byte-identical to what it started
-- with. A transcription error cannot survive that check; a retype has no
-- equivalent guarantee.
--
-- THE ALIAS MAP, verified against the catalog rather than assumed
--
-- Blind substitution would have been wrong. ca_club_member_detail and
-- ca_club_members also reference `cm.display_name`, `m.display_name` and
-- `r.display_name`, which are club_members and CTE columns, not profiles; and
-- the three player-page functions carry a `u` alias that is
-- union_rake_paid_daily_user. Only these aliases are profiles, confirmed by
-- reading the FROM/JOIN clauses:
--
--   ca_club_member_detail        pr, u
--   ca_club_members              pr
--   ca_club_player_breakdown     pr
--   ca_club_player_export_start  pr
--   ca_club_player_page          pr
--   fn_agent_downline_rake       pr, up
--   fn_bbj_hand_detail           pr
--   fn_bbj_recent_hits           pr
--   fn_club_bank_ledger          pf, pt
--   fn_union_settlement_preview  pr
--
-- fn_club_bank_ledger additionally read pf.full_name / pt.full_name as the last
-- step of a coalesce. Those become unreachable rather than removed:
-- fn_arena_name never returns NULL (it bottoms out at 'Player'), so the
-- coalesce short-circuits before it. Left in place so the diff stays minimal.
--
-- DDL POLICY (CLAUDE.md, 2026-08-31): one transaction, one schema-cache
-- rebuild.
--
-- ROLLBACK: run the same loop with the replacement reversed - the assertion
-- below is exactly that transformation, so it is known to restore the
-- originals.
-- ============================================================================

BEGIN;

DO $mig$
DECLARE
  r        record;
  v_alias  text;
  v_old    text;
  v_new    text;
  v_back   text;
  v_expr   text;
  v_count  integer := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('ca_club_member_detail',       ARRAY['pr','u']),
      ('ca_club_members',             ARRAY['pr']),
      ('ca_club_player_breakdown',    ARRAY['pr']),
      ('ca_club_player_export_start', ARRAY['pr']),
      ('ca_club_player_page',         ARRAY['pr']),
      ('fn_agent_downline_rake',      ARRAY['pr','up']),
      ('fn_bbj_hand_detail',          ARRAY['pr']),
      ('fn_bbj_recent_hits',          ARRAY['pr']),
      ('fn_club_bank_ledger',         ARRAY['pf','pt']),
      ('fn_union_settlement_preview', ARRAY['pr'])
    ) AS t(fname, aliases)
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_old
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname = r.fname;

    IF v_old IS NULL THEN
      RAISE EXCEPTION 'function % not found', r.fname;
    END IF;

    -- Forward: <alias>.display_name -> the resolver over that alias's columns.
    v_new := v_old;
    FOREACH v_alias IN ARRAY r.aliases LOOP
      v_expr := 'public.fn_arena_name(' || v_alias || '.alias, ' || v_alias
             || '.username, ' || v_alias || '.display_name, ' || v_alias
             || '.first_name, ' || v_alias || '.last_name, ' || v_alias
             || '.full_name)';
      v_new := regexp_replace(v_new, '\m' || v_alias || '\.display_name\M', v_expr, 'g');
    END LOOP;

    IF v_new = v_old THEN
      RAISE EXCEPTION 'no name reference was rewritten in % - the alias map is stale', r.fname;
    END IF;

    -- Backward: collapse the resolver back and demand the original, byte for
    -- byte. This is the whole safety argument for generating instead of
    -- retyping.
    v_back := v_new;
    FOREACH v_alias IN ARRAY r.aliases LOOP
      v_expr := 'public.fn_arena_name(' || v_alias || '.alias, ' || v_alias
             || '.username, ' || v_alias || '.display_name, ' || v_alias
             || '.first_name, ' || v_alias || '.last_name, ' || v_alias
             || '.full_name)';
      v_back := replace(v_back, v_expr, v_alias || '.display_name');
    END LOOP;

    IF v_back IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'rewrite of % changed something other than the name expression', r.fname;
    END IF;

    EXECUTE v_new;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 10 THEN
    RAISE EXCEPTION 'expected to rewrite 10 functions, rewrote %', v_count;
  END IF;
END
$mig$;

-- Every one of the twenty now goes through the resolver.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('ca_club_member_detail','ca_club_members','ca_club_player_breakdown',
                       'ca_club_player_export_start','ca_club_player_page','fn_agent_downline_rake',
                       'fn_bbj_hand_detail','fn_bbj_recent_hits','fn_club_bank_ledger',
                       'fn_union_settlement_preview')
     AND pg_get_functiondef(p.oid) NOT ILIKE '%fn_arena_name%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these functions did not pick up the arena resolver: %', v_bad;
  END IF;
END $$;

COMMIT;
