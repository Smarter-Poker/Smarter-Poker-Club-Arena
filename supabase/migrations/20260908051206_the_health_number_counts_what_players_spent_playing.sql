-- 20260908051206_the_health_number_counts_what_players_spent_playing.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.86; docs/changelog/2026-09-08-the-economy-has-a-report.md):
--
-- THE HEALTH NUMBER WAS MEASURING THE WRONG SINK, AND I FOUND IT BY READING MY OWN REPORT.
--
-- fn_ca_diamond_economy shipped an hour ago with faucet_over_sink as "everything issued divided
-- by everything spent". Its first live read returned 1.15, which says the currency is close to
-- balanced. It is not. Of the 16,993 counted as spending in that window, 14,120 were five ADMIN
-- ADJUSTMENTS - the house correcting its own books - and one 2,500 feature purchase. What
-- players actually spent on playing was 370: chip buy-ins 200, PvP stakes 120, game costs 40 and
-- one 10-diamond reroll. The true ratio is about 53, not 1.15.
--
-- A number that answers 1.15 when the answer is 53 is worse than no number, and the velocity
-- alarm built beside it read the same figure, so it would have sat quiet through exactly the
-- condition it exists to catch. Both are corrected here:
--
--   * the raw lines stay (faucet_total, sink_total) because an admin adjustment IS a diamond
--     leaving a wallet and the trial balance must still see it;
--   * a new line, sink_player_total, counts only what players spent playing - everything except
--     issuance_class 'admin' and 'refund';
--   * faucet_over_sink is now computed on THAT, and says so in its note;
--   * fn_ca_diamond_economy_watch reads the same definition, so the alarm and the report can
--     never disagree about what the health number means.
--
-- Nothing here moves a diamond.

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

-- One definition of "what players spent", used by the report and the alarm alike.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_player_spend(p_from timestamptz)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Everything a player spent PLAYING. Excludes 'admin' (the house correcting its own books)
  -- and 'refund' (money going back to a card, not into the game). Fixtures are not players.
  SELECT COALESCE(sum(-dt.amount), 0)::numeric
    FROM public.diamond_transactions dt
   WHERE dt.amount < 0
     AND dt.created_at >= p_from
     AND COALESCE(dt.issuance_class, '') NOT IN ('admin', 'refund')
     AND NOT public.fn_ca_is_fixture_account(dt.user_id);
$$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_player_spend(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_player_spend(timestamptz) TO service_role;
COMMENT ON FUNCTION public.fn_ca_diamond_player_spend(timestamptz) IS
  'What players spent playing, since p_from: every debit except admin adjustments and refunds, fixtures excluded. The denominator of the health number.';

SELECT pg_temp.ca_patch('fn_ca_diamond_economy',
$ca_from$  RETURN QUERY SELECT 'flow'::text, 'faucet_over_sink'::text,
    CASE WHEN v_sink > 0 THEN round(v_faucet / v_sink, 2) ELSE NULL END, v_faucet - v_sink,
    'THE HEALTH NUMBER. Above 1 the currency inflates; comparison is the net added to supply over the window. A ratio in the hundreds means the faucet is priced above the store.'::text;$ca_from$,
$ca_to$  RETURN QUERY SELECT 'flow'::text, 'sink_player_total'::text,
    public.fn_ca_diamond_player_spend(v_from), v_sink - public.fn_ca_diamond_player_spend(v_from),
    'what players spent PLAYING; comparison is what the raw sink counted that this does not - admin adjustments and refunds, which are the house moving its own money.'::text;
  RETURN QUERY SELECT 'flow'::text, 'faucet_over_sink'::text,
    CASE WHEN public.fn_ca_diamond_player_spend(v_from) > 0
         THEN round(v_faucet / public.fn_ca_diamond_player_spend(v_from), 2) ELSE NULL END,
    v_faucet - public.fn_ca_diamond_player_spend(v_from),
    'THE HEALTH NUMBER: issuance divided by what players spent PLAYING, not by every debit. Measured against the raw sink it read 1.15 on 2026-09-08 while the true ratio was about 53, because five admin adjustments were 83 percent of the raw figure. Above 1 the currency inflates; comparison is the net added to supply.'::text;$ca_to$);

SELECT pg_temp.ca_patch('fn_ca_diamond_economy_watch',
$ca_from$  v_ratio := CASE WHEN v_sink > 0 THEN round(v_faucet / v_sink, 2) ELSE NULL END;$ca_from$,
$ca_to$  -- The SAME definition the report uses, so the alarm and the report can never disagree about
  -- what the health number means. Measured against every debit it read 1.15 while the true
  -- ratio was about 53: this alarm would have sat quiet through the condition it exists for.
  v_sink := public.fn_ca_diamond_player_spend(now() - interval '30 days');
  v_ratio := CASE WHEN v_sink > 0 THEN round(v_faucet / v_sink, 2) ELSE NULL END;$ca_to$);

DO $$
DECLARE v_ratio numeric; v_player numeric; v_raw numeric; v jsonb;
BEGIN
  SELECT value INTO v_player FROM public.fn_ca_diamond_economy(30)
   WHERE section = 'flow' AND metric = 'sink_player_total';
  SELECT value INTO v_raw FROM public.fn_ca_diamond_economy(30)
   WHERE section = 'flow' AND metric = 'sink_total';
  SELECT value INTO v_ratio FROM public.fn_ca_diamond_economy(30)
   WHERE section = 'flow' AND metric = 'faucet_over_sink';
  IF v_player IS NULL OR v_raw IS NULL OR v_ratio IS NULL THEN
    RAISE EXCEPTION 'the flow section is incomplete: player %, raw %, ratio %', v_player, v_raw, v_ratio;
  END IF;
  IF v_player > v_raw THEN
    RAISE EXCEPTION 'player spend % exceeds every debit %', v_player, v_raw;
  END IF;

  v := public.fn_ca_diamond_economy_watch();
  IF (v ->> 'faucet_over_sink')::numeric IS DISTINCT FROM v_ratio THEN
    RAISE EXCEPTION 'the alarm says % and the report says %', v ->> 'faucet_over_sink', v_ratio;
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
