-- 20260908041432_the_verification_pass_fixes_what_read_as_armed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.86, a signal that answers when it does not know;
-- docs/changelog/2026-09-08-the-verification-pass.md):
--
-- A read-only reviewer went over the five migrations applied earlier tonight against live
-- production and found them fully applied, byte-identical to their files, with the money
-- identity exact. It also found four things that are worth fixing, and three of them are the
-- same shape: a signal that reads as one thing while being another.
--
--   1. DR15:cross_asset_seat READ AS ARMED WHILE NOTHING CONSUMED IT. The rule row carried
--      flip_after 2026-09-22 and clean_days_required 7, but fn_ca_arena_seat_is_same_asset never
--      called fn_ca_diamond_rule_mode, so a flip on the 22nd would have reported mode 'refuse'
--      and changed nothing at all. That is the exact pattern CLAUDE.md 10.86 was written about,
--      and this codebase has been bitten by it before.
--      Two fixes, because either alone leaves the trap for the next rule:
--        a. The seat guard now READS its mode. It still never refuses a seat (a guard that can
--           refuse a seat can strand a player mid-hand) - flipping DR15 escalates the incident
--           from warning to critical, so the flip has a real and honest meaning.
--        b. fn_ca_diamond_rule_flip refuses to flip a rule that no function consults. A rule
--           with no reader cannot become a refusal by accident ever again.
--   2. The trial balance reported the two columns dropped by 20260908033824 as "unreadable",
--      conflating "dropped as planned" with "my query broke" - in the one line whose whole job
--      is to tell those apart. The dead-store loop now checks for the COLUMN, not just the
--      relation, and says "dropped" when it is gone.
--   3. player_diamonds.balance_now included the fixture harness while balance_delta excluded it,
--      so adding the player and fixture rows double-counted the fixtures. balance_now is now
--      the same population the delta is measured on, and the note says so.
--   4. fn_wheel_spin was executable by anon (it calls deduct_diamonds). It refuses a caller with
--      no auth.uid(), so this was never exploitable, but a money path a signed-out visitor can
--      call at all is defence-in-depth we should not be spending. Revoked.
--
-- Nothing here moves a diamond. One transaction.

BEGIN;

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $ca$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_patch: marker in % found % times', p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $ca$;

-- ---------------------------------------------------------------------------
-- 1a. The seat guard reads its own mode. It still never refuses a seat.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('fn_ca_arena_seat_is_same_asset',
$ca_from$      PERFORM public.fn_ca_diamond_incident('DR15:cross_asset_seat', 'warning', NEW.user_id, NEW.stack,$ca_from$,
$ca_to$      -- Flipping DR15 escalates what this files; it never refuses the seat, because a guard
      -- that can refuse a seat can strand a player mid-hand. The mode is READ here so the rule
      -- has a consumer and a flip means something (CLAUDE.md 10.86).
      PERFORM public.fn_ca_diamond_incident('DR15:cross_asset_seat',
        CASE WHEN public.fn_ca_diamond_rule_mode('DR15:cross_asset_seat') = 'refuse'
             THEN 'critical' ELSE 'warning' END, NEW.user_id, NEW.stack,$ca_to$);

COMMENT ON FUNCTION public.fn_ca_arena_seat_is_same_asset() IS
  'Reports a seat whose funding asset disagrees with its club (DR15). It NEVER refuses a seat; flipping DR15 to refuse escalates the incident to critical instead.';

-- ---------------------------------------------------------------------------
-- 1b. A rule that nothing consults cannot be flipped.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('fn_ca_diamond_rule_flip',
$ca_from$  IF now() < v_row.flip_after THEN$ca_from$,
$ca_to$  -- A rule with no reader cannot become a refusal (CLAUDE.md 10.86): the flip would report
  -- mode 'refuse' and change nothing, which is worse than never having flipped it. Found by the
  -- verification pass on 2026-09-08, when DR15 was exactly that.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc LIKE '%fn_ca_diamond_rule_mode%'
       AND p.prosrc LIKE '%' || p_rule || '%'
  ) THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip: no function consults %; flipping it would change nothing', p_rule;
  END IF;
  IF now() < v_row.flip_after THEN$ca_to$);

-- ---------------------------------------------------------------------------
-- 2 and 3. The trial balance says what it means.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('fn_ca_diamond_trial_balance',
$ca_from$      IF to_regclass('public.' || r.rel) IS NULL THEN v_note := v_note || r.rel || ': absent. ';$ca_from$,
$ca_to$      IF to_regclass('public.' || r.rel) IS NULL THEN v_note := v_note || r.rel || ': absent. ';
      ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = r.rel AND c.column_name = r.col) THEN
        -- Dropped on purpose (20260908033824), which is not the same thing as a query that
        -- broke. This line exists to tell those two apart, so it has to say which one it is.
        v_note := v_note || format('%s.%s: dropped. ', r.rel, r.col);$ca_to$);

SELECT pg_temp.ca_patch('fn_ca_diamond_trial_balance',
$ca_from$  v_tot_now := v_tot_now + v_players; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'player_diamonds'::text, v_players, v_delta, v_jrn, v_mint, v_diff, v_note;$ca_from$,
$ca_to$  -- balance_now must be the SAME population balance_delta is measured on, or adding this row
  -- to fixture_accounts double counts the harness (found by the verification pass, 2026-09-08).
  DECLARE v_players_shown numeric := CASE
    WHEN s0.id IS NOT NULL AND s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL
    THEN v_players - v_fix ELSE v_players END;
  BEGIN
    v_tot_now := v_tot_now + v_players_shown; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
    v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
    RETURN QUERY SELECT 'player_diamonds'::text, v_players_shown, v_delta, v_jrn, v_mint, v_diff,
      (v_note || CASE WHEN v_players_shown <> v_players
                      THEN ' balance_now is players WITHOUT the harness (' || v_fix || ' shown on the fixture_accounts row), so the two rows add up.'
                      ELSE '' END)::text;
  END;$ca_to$);

-- ---------------------------------------------------------------------------
-- 4. A money path a signed-out visitor can call at all.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) FROM anon;

-- ---------------------------------------------------------------------------
-- 5. Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_body text; v_orphans text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_arena_seat_is_same_asset';
  IF v_body NOT LIKE '%fn_ca_diamond_rule_mode(''DR15:cross_asset_seat'')%' THEN
    RAISE EXCEPTION 'the seat guard still does not consult its rule';
  END IF;
  IF v_body LIKE '%RAISE EXCEPTION%' THEN
    RAISE EXCEPTION 'the seat guard can now refuse a seat, which it must never do';
  END IF;

  -- every rule has a consumer
  SELECT string_agg(r.rule, ', ') INTO v_orphans
    FROM public.ca_diamond_rule_modes r
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosrc LIKE '%fn_ca_diamond_rule_mode%' AND p.prosrc LIKE '%' || r.rule || '%');
  IF v_orphans IS NOT NULL THEN
    RAISE EXCEPTION 'these rules read as armed but nothing consults them: %', v_orphans;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_rule_flip';
  IF v_body NOT LIKE '%flipping it would change nothing%' THEN
    RAISE EXCEPTION 'the flip can still arm a rule with no reader';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_trial_balance';
  IF v_body NOT LIKE '%: dropped. %' OR v_body NOT LIKE '%v_players_shown%' THEN
    RAISE EXCEPTION 'the trial balance was not corrected';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL aclexplode(p.proacl) a
              WHERE n.nspname = 'public' AND p.proname = 'fn_wheel_spin' AND a.grantee = 'anon'::regrole) THEN
    RAISE EXCEPTION 'fn_wheel_spin is still executable by anon';
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
