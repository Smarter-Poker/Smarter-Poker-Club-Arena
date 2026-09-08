-- 20260908051448_player_spend_is_decided_by_the_registers_own_origin_rule.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.86; docs/changelog/2026-09-08-the-economy-has-a-report.md):
--
-- THE SECOND CORRECTION TO THE SAME NUMBER, AND THE REASON IS WORTH KEEPING.
--
-- 20260908051206 defined "what players spent playing" as every debit whose issuance_class is not
-- 'admin' or 'refund'. Applied, it returned 16,993 - identical to the raw sink, so the fix fixed
-- nothing. The cause: the five admin adjustments that make up 83 percent of that figure are
-- HISTORICAL rows written before the journal classifier existed, and their issuance_class is
-- NULL. `COALESCE(class,'') NOT IN ('admin','refund')` is true of NULL, so they were all counted
-- as player spending, exactly as before.
--
-- Classifying by a column that is empty on the rows in question is a guess dressed as a rule.
-- The database already has an authority for what a movement IS, and it reads the kind rather
-- than the class: fn_ca_diamond_journal_origin, the same function the register uses to decide
-- whether a journal row mints, burns or does neither. Against the same window it separates them
-- cleanly - adjustment 14,120, spend 2,670, bridge 203 - so player spend is 2,873 and the health
-- number is 6.9, not 1.17 and not 1.15.
--
-- The lesson, and it is the third time tonight: a definition is only true of the rows it was
-- tested on. This one is now tested against the live window before it ships, and the migration
-- asserts the separation rather than trusting it.
--
-- Nothing here moves a diamond.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_player_spend(p_from timestamptz)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- What players spent PLAYING, decided by the register's own authority on what a movement is:
  --   'spend'  - a debit for something in the game (entries, stakes, features, time banks)
  --   'bridge' - diamonds converted into chips, which is a player spending them
  -- and NOT 'adjustment' (the house correcting its books), NOT 'refund' (money going back to a
  -- card), NOT NULL (transfers, the Mint's own doors, seeds and test rows, which move no value
  -- out of the player economy). Fixtures are not players.
  SELECT COALESCE(sum(-dt.amount), 0)::numeric
    FROM public.diamond_transactions dt
   WHERE dt.amount < 0
     AND dt.created_at >= p_from
     AND public.fn_ca_diamond_journal_origin(dt.type, dt.transaction_type, dt.source,
                                             dt.issuance_class, dt.amount) IN ('spend', 'bridge')
     AND NOT public.fn_ca_is_fixture_account(dt.user_id);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_player_spend(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_player_spend(timestamptz) TO service_role;
COMMENT ON FUNCTION public.fn_ca_diamond_player_spend(timestamptz) IS
  'What players spent playing since p_from, by the register''s own origin rule: spend and bridge only, fixtures excluded. The denominator of the health number. Classifying by issuance_class instead returned the raw sink, because historical rows carry NULL there.';

DO $$
DECLARE v_player numeric; v_raw numeric; v_adjust numeric; v_ratio numeric; v jsonb;
BEGIN
  -- the separation must be real on live data, not assumed
  SELECT public.fn_ca_diamond_player_spend(now() - interval '30 days') INTO v_player;
  SELECT COALESCE(sum(-dt.amount), 0) INTO v_raw
    FROM public.diamond_transactions dt
   WHERE dt.amount < 0 AND dt.created_at >= now() - interval '30 days'
     AND NOT public.fn_ca_is_fixture_account(dt.user_id);
  SELECT COALESCE(sum(-dt.amount), 0) INTO v_adjust
    FROM public.diamond_transactions dt
   WHERE dt.amount < 0 AND dt.created_at >= now() - interval '30 days'
     AND public.fn_ca_diamond_journal_origin(dt.type, dt.transaction_type, dt.source,
                                             dt.issuance_class, dt.amount) = 'adjustment';
  IF v_adjust > 0 AND v_player >= v_raw THEN
    RAISE EXCEPTION 'player spend % still equals every debit % while % of adjustments exist; the separation did not take',
      v_player, v_raw, v_adjust;
  END IF;

  SELECT value INTO v_ratio FROM public.fn_ca_diamond_economy(30)
   WHERE section = 'flow' AND metric = 'faucet_over_sink';
  v := public.fn_ca_diamond_economy_watch();
  IF (v ->> 'faucet_over_sink')::numeric IS DISTINCT FROM v_ratio THEN
    RAISE EXCEPTION 'the alarm says % and the report says %', v ->> 'faucet_over_sink', v_ratio;
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
