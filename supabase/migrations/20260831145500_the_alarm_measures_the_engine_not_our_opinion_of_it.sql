-- ═══════════════════════════════════════════════════════════════════════════
-- THE ALARM MEASURES THE ENGINE, NOT OUR OPINION OF IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_rake_law_violations` reports `over_cap` when a hand was raked above the
-- cap its stake resolves to. That accusation is only worth anything if the cap
-- it compares against is the cap the ENGINE actually applies. Two migrations
-- applied on top of the alarm an hour after it shipped -- 20260831141737 and
-- 20260831142001, both applied to production and neither committed until now
-- -- moved that number away from the engine in two ways:
--
--   1. SIX SCHEDULE ROWS THE ENGINE DOES NOT HAVE. 0.01/0.02, 0.02/0.05,
--      0.05/0.10, 0.10/0.25, 25/50 and 50/100 were inserted into
--      ca_rake_schedule. src/config/RakeConfig.ts RAKE_SCHEDULE still carries
--      fourteen rows and none of those six.
--   2. A PROPORTIONAL BOUND THE ENGINE DOES NOT APPLY. The tier fallback
--      became LEAST(tier.rake_cap, bb * fn_unscheduled_cap_bb()), where that
--      helper derives 15 BB from the schedule's own worst ratio.
--      `getRakeConfig` has no such rule: exact schedule row, else the tier cap,
--      and stop.
--
-- MEASURED CONSEQUENCE, not a theoretical one. 0.05/0.10 is a live stake:
-- 1,206 raked hands in the last 48 hours, top rake 3.00, which is exactly the
-- `nano` tier cap the engine applies and is correct behaviour. After those two
-- migrations the database answered 1.50 for that stake, so 63 of those 1,206
-- hands would have been filed as `over_cap` criticals against an engine that
-- was obeying its own schedule to the cent. An alarm that cries wolf on
-- correct behaviour is worse than no alarm: it teaches whoever is on shift to
-- scroll past `rake_law`.
--
-- WHAT WAS RIGHT AND IS KEPT. The second migration replaced the tier lookup's
-- `p_bb >= t.min_bb AND p_bb <= t.max_bb` with a cascade on max_bb alone. That
-- was a genuine bug fix and it is preserved, because `getTierForBB` IS a
-- cascade -- bb <= 0.2 nano, <= 0.8 micro, <= 3 small, <= 8 mid, <= 40 high,
-- else nosebleeds -- with no gaps, while the min/max form left 0.2-0.3,
-- 0.8-1.0, 3.0-3.5, 8.0-9.0 and 40-41 resolving to NULL, which silently
-- disabled the cap check for any table in those bands. ca_rake_tier.min_bb is
-- now decorative; max_bb is the cascade boundary.
--
-- WHAT WAS ALSO RIGHT AND IS NOT THROWN AWAY. The engine's nano cap is 3.00 on
-- a 0.10 big blind -- THIRTY big blinds of rake, against a schedule whose own
-- worst ratio is fifteen. That is a real observation about the published
-- schedule and it deserves a decision, not a deletion. So the six rows STAY,
-- flagged `source = 'proposed'`, excluded from cap resolution, and surfaced by
-- fn_rake_schedule_drift() as a question for Dan. What the platform charges
-- players is his call, not an agent's.

BEGIN;

SET LOCAL lock_timeout = '4s';

ALTER TABLE public.ca_rake_schedule
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'engine_mirror';

ALTER TABLE public.ca_rake_schedule
  DROP CONSTRAINT IF EXISTS ca_rake_schedule_source_check;
ALTER TABLE public.ca_rake_schedule
  ADD CONSTRAINT ca_rake_schedule_source_check
  CHECK (source IN ('engine_mirror', 'proposed'));

UPDATE public.ca_rake_schedule
   SET source = 'proposed'
 WHERE (sb, bb) IN ((0.01,0.02), (0.02,0.05), (0.05,0.10), (0.10,0.25), (25,50), (50,100));

COMMENT ON COLUMN public.ca_rake_schedule.source IS
  'engine_mirror: this row exists in RAKE_SCHEDULE in src/config/RakeConfig.ts and is what the engine charges. proposed: a stake somebody thinks SHOULD be scheduled; never used to resolve a cap, only reported by fn_rake_schedule_drift().';

-- ── The cap the ENGINE resolves. getRakeConfig, mirrored ──
CREATE OR REPLACE FUNCTION public.fn_effective_rake_cap(p_sb numeric, p_bb numeric)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (SELECT s.rake_cap FROM public.ca_rake_schedule s
      WHERE s.sb = p_sb AND s.bb = p_bb AND s.source = 'engine_mirror'),
    (SELECT t.rake_cap FROM public.ca_rake_tier t
      WHERE t.max_bb IS NULL OR p_bb <= t.max_bb
      ORDER BY t.max_bb ASC NULLS LAST
      LIMIT 1)
  );
$$;

-- ── Where the proposal and the engine disagree, on a stake that is live ──
CREATE OR REPLACE FUNCTION public.fn_rake_schedule_drift()
RETURNS TABLE (
  small_blind    numeric,
  big_blind      numeric,
  charged_cap    numeric,
  proposed_cap   numeric,
  charged_cap_bb numeric,
  hands_48h      bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT p.sb, p.bb,
         public.fn_effective_rake_cap(p.sb, p.bb),
         p.rake_cap,
         round(public.fn_effective_rake_cap(p.sb, p.bb) / NULLIF(p.bb, 0), 2),
         (SELECT count(*) FROM public.hand_history h
            JOIN public.tables t ON t.id = h.table_id
           WHERE t.tournament_id IS NULL
             AND t.small_blind = p.sb AND t.big_blind = p.bb
             AND h.created_at > now() - interval '48 hours'
             AND COALESCE(h.rake_amount, 0) > 0)
    FROM public.ca_rake_schedule p
   WHERE p.source = 'proposed'
     AND public.fn_effective_rake_cap(p.sb, p.bb) IS DISTINCT FROM p.rake_cap
   ORDER BY p.bb;
$$;

REVOKE ALL ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_rake_schedule_drift()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_unscheduled_cap_bb()                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_effective_rake_cap(numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rake_schedule_drift()                TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_unscheduled_cap_bb()                 TO service_role;

-- ── The cap this function returns must equal what the engine charges ──
-- The expectations below are RAKE_SCHEDULE and STAKES_TIERS transcribed from
-- src/config/RakeConfig.ts, not read back from the tables this migration just
-- wrote. A test that reads its own output proves nothing.
DO $$
DECLARE
  r        record;
  v_actual numeric;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (0.1::numeric, 0.2::numeric,  3.0::numeric),
      (0.2,  0.4,  3.0),  (0.25, 0.5,  3.0),  (0.3,  0.6,  5.0),
      (0.5,  1.0,  5.0),  (1,    2,    5.0),  (2,    4,    7.5),
      (2,    5,    7.5),  (5,    5,    7.5),  (3,    6,    8.0),
      (4,    8,   10.0),  (5,   10,   12.5),  (10,  20,   15.0),
      (10,  25,   15.0),
      (0.05, 0.10, 3.0),   -- nano       bb <= 0.2   <- the 63 false criticals
      (0.10, 0.25, 3.0),   -- micro      bb <= 0.8
      (0.45, 0.9,  5.0),   -- small      bb <= 3
      (1.6,  3.2,  8.0),   -- mid        bb <= 8
      (4.25, 8.5, 15.0),   -- high       bb <= 40
      (25,  50,   20.0),   -- nosebleeds
      (50, 100,   20.0)    -- nosebleeds
    ) AS t(sb, bb, engine_cap)
  LOOP
    v_actual := public.fn_effective_rake_cap(r.sb, r.bb);
    IF v_actual IS DISTINCT FROM r.engine_cap THEN
      RAISE EXCEPTION 'stake %/%: the engine charges % but this function says %',
        r.sb, r.bb, r.engine_cap, v_actual;
    END IF;
  END LOOP;

  -- The cascade must leave no big blind without a cap. A NULL cap does not
  -- fail loudly, it silently switches the over_cap check off for that table.
  FOR r IN SELECT unnest(ARRAY[0.011, 0.07, 0.25, 0.9, 3.2, 8.5, 40.5, 1000]::numeric[]) AS bb
  LOOP
    IF public.fn_effective_rake_cap(r.bb / 2, r.bb) IS NULL THEN
      RAISE EXCEPTION 'big blind % resolves to no cap at all', r.bb;
    END IF;
  END LOOP;

  -- The live check, over the same window pg_cron uses, must report no over-cap
  -- hand: the audit established by hand that every stake obeyed its cap to the
  -- cent. A 48-hour sweep would also cover the 0.05/0.10 hands that produced
  -- the 63 false criticals, but it exceeds the statement timeout; those were
  -- measured out of band and that stake's cap is pinned to 3.00 above, which
  -- is the same guarantee.
  IF EXISTS (SELECT 1 FROM public.fn_rake_law_violations('2 hours'::interval)
              WHERE kind IN ('over_cap', 'over_percent')) THEN
    RAISE EXCEPTION 'the corrected cap still reports an over-cap hand in the cron window';
  END IF;
END $$;

COMMIT;
