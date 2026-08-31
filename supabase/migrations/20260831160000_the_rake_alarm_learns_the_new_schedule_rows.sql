-- ═══════════════════════════════════════════════════════════════════════════
-- THE RAKE ALARM LEARNS THE NEW SCHEDULE ROWS (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
-- Companion to the same-day code change "every stake the form offers is a
-- stake the schedule prices". Dan's ruling, verbatim:
--
--   "WE HAVE A SCALE THAT WE USE FOR THE CASH GAME FOR RAKE AND BBJ, USE THE
--    SAME PERCENTAGES WE USE FOR THE OTHER GAMES, IF YOU DON'T HAVE A RAKE OR
--    BBJ SCHEDULE FOR A SPECIFIC GAME."
--
-- `ca_rake_schedule` was created hours earlier by the rake-law alarm and its
-- own comment names its job: "Mirror of RAKE_SCHEDULE in
-- src/config/RakeConfig.ts". There are now THREE copies of the ladder — the
-- client, the engine, and this one — and a mirror that does not move when the
-- thing it mirrors moves is worse than no mirror: fn_rake_law_violations
-- would judge live rake against a stale ladder and quietly stop seeing the
-- stakes it was added to watch.
--
-- Two changes, both mechanical mirrors of the TypeScript:
--
--   1. The six schedule rows added today, so no stake the create-table form
--      offers resolves through a tier any more.
--
--   2. fn_effective_rake_cap's FALLBACK. A stake with no row resolved to the
--      tier's flat dollar cap, which is a sane number at the stake its tier
--      was written for and an absurd one two rungs below it: $3 on a $0.02
--      big blind is 150 BB, against a published ladder whose most generous
--      row is 15 BB. The fallback is now held to that same proportion, which
--      is the second half of Dan's ruling. The bound is DERIVED from
--      ca_rake_schedule rather than written down, exactly as UNSCHEDULED_CAP_BB
--      is derived from RAKE_SCHEDULE in the TypeScript, so the three copies
--      cannot drift apart on this number even if they drift on a row.
--
-- The earlier migration noted "(25/50 has no schedule row and resolves through
-- the nosebleeds tier. That is the design ...)". Dan's ruling supersedes that,
-- and the cap does not move: 25/50 was charged $20 by the tier and is charged
-- $20 by its new row. Its 139 hands over the audited 24 hours are unaffected.
--
-- LIVE EFFECT: none on any stake with hands. The nine stakes in the alarm's
-- own 24-hour census (0.1/0.2, 0.25/0.5, 0.5/1, 1/2, 2/4, 2/5, 5/10, 10/25,
-- 25/50) all resolve to exactly the cap they resolved to before. The only
-- schedule cap that MOVES is 0.05/0.10, $3 -> $1.50, and that stake has no
-- hands and two closed tables. Nothing is raked more than before.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (migration name: the_rake_alarm_learns_the_new_schedule_rows), then verified
-- by re-reading the rows and pg_get_functiondef.
--
-- ROLLBACK:
--   DELETE FROM public.ca_rake_schedule
--    WHERE (sb, bb) IN ((0.01,0.02),(0.02,0.05),(0.05,0.1),(0.1,0.25),
--                       (25,50),(50,100));
--   -- and restore fn_effective_rake_cap to the COALESCE(schedule, tier) body
--   -- in 20260831140000_the_rake_law_gets_an_alarm.sql.

INSERT INTO public.ca_rake_schedule (sb, bb, rake_percent, rake_cap, bbj_fee_bb) VALUES
  (0.01, 0.02, 10,  0.30, 0.6),
  (0.02, 0.05, 10,  0.75, 0.6),
  (0.05, 0.10, 10,  1.50, 0.6),
  (0.10, 0.25, 10,  3.00, 0.6),
  (25,   50,   10, 20.00, 0.03),
  (50,  100,   10, 20.00, 0.03)
ON CONFLICT (sb, bb) DO UPDATE
  SET rake_percent = EXCLUDED.rake_percent,
      rake_cap     = EXCLUDED.rake_cap,
      bbj_fee_bb   = EXCLUDED.bbj_fee_bb;

-- The most generous share of a big blind any published row takes. Derived,
-- never written down. Mirrors UNSCHEDULED_CAP_BB in src/config/RakeConfig.ts.
CREATE OR REPLACE FUNCTION public.fn_unscheduled_cap_bb()
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(max(s.rake_cap / s.bb), 0)
    FROM public.ca_rake_schedule s
   WHERE s.bb > 0;
$$;

-- Exactly the precedence getRakeConfig applies: the exact schedule row first,
-- otherwise the tier HELD TO THE LADDER'S OWN PROPORTION.
CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb),
    (SELECT LEAST(t.rake_cap, round(p_bb * public.fn_unscheduled_cap_bb(), 2))
       FROM public.ca_rake_tier t
      WHERE p_bb >= t.min_bb AND (t.max_bb IS NULL OR p_bb <= t.max_bb)
      ORDER BY t.min_bb DESC LIMIT 1)
  );
$$;

-- Post-apply assertions.
DO $$
DECLARE
  v_rows integer;
  v_bound numeric;
  v_default numeric;
  v_2550 numeric;
  v_odd numeric;
BEGIN
  SELECT count(*) INTO v_rows FROM public.ca_rake_schedule;
  IF v_rows <> 20 THEN
    RAISE EXCEPTION 'expected 20 schedule rows after the insert, found %', v_rows;
  END IF;

  v_bound := public.fn_unscheduled_cap_bb();
  IF v_bound <> 15 THEN
    RAISE EXCEPTION 'the derived proportion should be 15 BB, got %', v_bound;
  END IF;

  -- The default preset now resolves to its own row, not to the Nano tier.
  v_default := public.fn_effective_rake_cap(0.05, 0.10);
  IF v_default <> 1.50 THEN
    RAISE EXCEPTION '0.05/0.10 should cap at 1.50, got %', v_default;
  END IF;

  -- 25/50 keeps the exact cap it was already charged.
  v_2550 := public.fn_effective_rake_cap(25, 50);
  IF v_2550 <> 20 THEN
    RAISE EXCEPTION '25/50 should still cap at 20, got %', v_2550;
  END IF;

  -- An unscheduled stake is priced in proportion, not by the flat tier cap.
  v_odd := public.fn_effective_rake_cap(0.03, 0.07);
  IF v_odd <> 1.05 THEN
    RAISE EXCEPTION 'unscheduled 0.03/0.07 should cap at 1.05, got %', v_odd;
  END IF;
END $$;
