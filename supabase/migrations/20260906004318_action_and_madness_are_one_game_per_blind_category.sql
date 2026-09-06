-- 20260906004318_action_and_madness_are_one_game_per_blind_category.sql
--
-- ACTION AND MADNESS ARE ONE GAME PER BLIND CATEGORY (Dan, 2026-09-05)
--
-- Dan, verbatim: "WE NEED TO CONSOLIDATE 'ACTION' AND 'MADNESS' TO ONE GAME
-- PER BLIND CATEGORY. ONE MICRO, ONE SMALL, ONE MID, AND ONE HIGH PER GAME
-- TYPE. 'CLASSIC' SHOULD HAVE ALL THE GAME SAME STAKES IT HAS."
--
-- READ, NOT ASSUMED (2026-09-05 17:40 CDT). Action and Madness carry 31 games
-- each, created through the New Cash Game flow on 2026-09-04 between 16:14 and
-- 16:51. Per (style, variant) the micro band holds two or three games at once
-- (0.10/0.25 AND 0.25/0.50 are both micro) while every other band holds one.
-- Twelve (style, variant, micro) groups are duplicated, fourteen games in all.
-- Not one of them has a human seated; every occupant is a horse.
--
-- THE FOUR BANDS ARE THE ONES THE ENGINE ALREADY USES.
-- `stakeBandForBigBlind` (server/src/services/HorseBehavior.ts) has always
-- read micro <= 0.5, low <= 2, mid <= 6, high > 6, which is exactly Dan's
-- micro, small, mid, high. This migration gives that rule an IMMUTABLE SQL
-- twin, `fn_cash_stake_band`, so the database can index on it and the shape
-- becomes something the schema enforces rather than something an operator
-- remembers.
--
-- WHICH GAME SURVIVES. In order of preference: the band's canonical rung
-- (micro 0.25/0.50, low 1.00/2.00, mid 2.00/5.00, high 5.00/10.00), then the
-- one with the most players seated right now, then the most live tables, then
-- the oldest. So a player already sitting is never the reason a game is
-- retired, and the surviving ladder reads the same in every variant.
--
-- WHAT RETIRING MEANS. `enabled = false` and `closed_at = now()`, nothing
-- else. No table is closed here and no chip is moved: OPORD 1.4 section 18.4
-- and `fn_cash_cluster_tick` already close an empty table of a disabled game
-- (`table_closed_disabled`), the fleet does not seat one (2026-09-05,
-- HorseDisabledGames), and anybody seated finishes, stands up through the
-- ordinary door and takes their stack with them. A retired game keeps its
-- history and its id.
--
-- GAPS ARE NOT FILLED, and that is Dan's call, made 2026-09-05 with the
-- numbers in front of him: most variants have no mid or high rung. The shape
-- is law from here, so a rung added later cannot be added twice.
--
-- CLASSIC IS NOT TOUCHED. Its 87 games across 55 keys and 13 stake levels
-- stay exactly as they are; the index below is partial and names only
-- 'action' and 'madness'.
--
-- ROLLBACK:
--   DROP INDEX public.cash_games_one_per_band_action_madness;
--   DROP TRIGGER zz_one_game_per_blind_category ON public.cash_games;
--   DROP FUNCTION public.fn_guard_one_game_per_blind_category();
--   DROP FUNCTION public.fn_cash_stake_band(numeric);
--   UPDATE public.cash_games SET enabled = true, closed_at = NULL
--    WHERE template_name IN ('action','madness') AND closed_at = <this run's timestamp>;
--
-- TWO STEPS, AND THE INDEX IS BUILT CONCURRENTLY. The first apply of this
-- file put everything in one transaction (production DDL policy, CLAUDE.md
-- section 2) and DEADLOCKED against the cluster controller: the tick writes
-- `cash_games.last_tick_at` on ~120 rows every five seconds, and a plain
-- CREATE UNIQUE INDEX wants a lock those writes will not give up. Nothing
-- applied; the transaction rolled back whole. So the function, the data and
-- the trigger stay in ONE transaction (they are what the schema-cache reload
-- rule is about) and the index is built CONCURRENTLY afterwards, outside any
-- transaction, which takes no blocking lock. The trigger below enforces the
-- rule on its own for every write path; the index is the guarantee underneath
-- it, and it is created second on purpose - by the time it builds, the data
-- it must not reject is already consolidated.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The band, as the database's own function. IMMUTABLE so a unique index may
-- be built on it. It is the twin of stakeBandForBigBlind, and
-- tests/actionAndMadnessAreOnePerBand.law.test.ts pins the two together so
-- they cannot drift.
CREATE OR REPLACE FUNCTION public.fn_cash_stake_band(p_bb numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
           WHEN p_bb IS NULL THEN NULL
           WHEN p_bb <= 0.5 THEN 'micro'
           WHEN p_bb <= 2   THEN 'low'
           WHEN p_bb <= 6   THEN 'mid'
           ELSE                  'high'
         END;
$$;

COMMENT ON FUNCTION public.fn_cash_stake_band(numeric) IS
  'The blind category of a big blind: micro <= 0.5, low <= 2, mid <= 6, high above. The SQL twin of stakeBandForBigBlind in server/src/services/HorseBehavior.ts. Dan calls low "small".';

REVOKE ALL ON FUNCTION public.fn_cash_stake_band(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_stake_band(numeric) TO authenticated, service_role;

-- Retire the duplicates.
CREATE TEMP TABLE zz_retire ON COMMIT DROP AS
WITH ranked AS (
  SELECT g.id, g.club_id, g.template_name, g.variant, g.sb, g.bb,
         public.fn_cash_stake_band(g.bb) AS band,
         row_number() OVER (
           PARTITION BY g.club_id, g.template_name, g.variant, public.fn_cash_stake_band(g.bb)
           ORDER BY
             CASE WHEN (public.fn_cash_stake_band(g.bb) = 'micro' AND g.bb = 0.50)
                    OR (public.fn_cash_stake_band(g.bb) = 'low'   AND g.bb = 2.00)
                    OR (public.fn_cash_stake_band(g.bb) = 'mid'   AND g.bb = 5.00)
                    OR (public.fn_cash_stake_band(g.bb) = 'high'  AND g.bb = 10.00)
                  THEN 0 ELSE 1 END,
             (SELECT count(*) FROM public.table_seats ts
                JOIN public.tables tb ON tb.id = ts.table_id
               WHERE tb.cluster_id = g.id AND ts.left_at IS NULL AND tb.lifecycle <> 'closed') DESC,
             (SELECT count(*) FROM public.tables tb
               WHERE tb.cluster_id = g.id AND tb.lifecycle <> 'closed' AND tb.status <> 'closed') DESC,
             g.created_at
         ) AS rn
    FROM public.cash_games g
   WHERE g.template_name IN ('action', 'madness')
     AND g.enabled
)
SELECT id, club_id, template_name, variant, sb, bb, band FROM ranked WHERE rn > 1;

DO $retire$
DECLARE
  v_n integer;
  v_humans integer;
BEGIN
  SELECT count(*) INTO v_n FROM zz_retire;

  -- A human seated on a game this would retire is a reason to stop and look,
  -- not to carry on: nothing here would take their chips, but the board would
  -- change under them without anybody deciding that it should.
  SELECT count(*) INTO v_humans
    FROM zz_retire r
    JOIN public.tables tb ON tb.cluster_id = r.id AND tb.lifecycle <> 'closed'
    JOIN public.table_seats ts ON ts.table_id = tb.id AND ts.left_at IS NULL
    JOIN public.profiles p ON p.id = ts.user_id
   WHERE NOT coalesce(p.is_horse, false);
  IF v_humans > 0 THEN
    RAISE EXCEPTION 'refusing to retire: % human player(s) are seated on a game this would disable; re-run when they have finished', v_humans;
  END IF;

  IF v_n = 0 THEN
    RAISE NOTICE 'no duplicate action/madness games; the ladder is already one per band';
  ELSE
    RAISE NOTICE 'retiring % duplicate action/madness game(s)', v_n;
  END IF;
END
$retire$;

UPDATE public.cash_games g
   SET enabled = false,
       closed_at = now(),
       updated_at = now()
  FROM zz_retire r
 WHERE g.id = r.id;

-- The index is the guarantee; this trigger is the sentence a human reads
-- instead of a unique-violation, and it names the game already holding the
-- rung so the operator knows what to close first.
CREATE OR REPLACE FUNCTION public.fn_guard_one_game_per_blind_category()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_existing text;
BEGIN
  IF NOT NEW.enabled OR NEW.template_name NOT IN ('action', 'madness') THEN
    RETURN NEW;
  END IF;
  SELECT g.name || ' (' || g.sb || '/' || g.bb || ')'
    INTO v_existing
    FROM public.cash_games g
   WHERE g.enabled
     AND g.id <> NEW.id
     AND g.club_id = NEW.club_id
     AND g.template_name = NEW.template_name
     AND g.variant = NEW.variant
     AND public.fn_cash_stake_band(g.bb) = public.fn_cash_stake_band(NEW.bb)
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION
      'ONE_GAME_PER_BLIND_CATEGORY: this club already runs % as its % % game. Close it before opening another.',
      v_existing, initcap(NEW.template_name), public.fn_cash_stake_band(NEW.bb)
      USING ERRCODE = 'unique_violation',
            HINT = 'Dan 2026-09-05: Action and Madness run one game per blind category per game type. Classic is unrestricted.';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.fn_guard_one_game_per_blind_category() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_one_game_per_blind_category() TO service_role;

DROP TRIGGER IF EXISTS zz_one_game_per_blind_category ON public.cash_games;
CREATE TRIGGER zz_one_game_per_blind_category
  BEFORE INSERT OR UPDATE OF enabled, template_name, variant, bb, club_id
  ON public.cash_games
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_one_game_per_blind_category();

-- Assert the shape before committing.
DO $post$
DECLARE
  v_dupes integer;
  v_classic integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.cash_games
     WHERE enabled AND template_name IN ('action', 'madness')
     GROUP BY club_id, template_name, variant, public.fn_cash_stake_band(bb)
    HAVING count(*) > 1) s;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'still % duplicated (club, style, variant, band) group(s) after the retire', v_dupes;
  END IF;

  SELECT count(*) INTO v_classic FROM public.cash_games WHERE template_name = 'classic';
  IF v_classic < 80 THEN
    RAISE EXCEPTION 'classic went from 87 games to % - this migration must not touch classic', v_classic;
  END IF;

  IF public.fn_cash_stake_band(0.50) <> 'micro' OR public.fn_cash_stake_band(2) <> 'low'
     OR public.fn_cash_stake_band(5) <> 'mid' OR public.fn_cash_stake_band(10) <> 'high'
     OR public.fn_cash_stake_band(0.02) <> 'micro' OR public.fn_cash_stake_band(50) <> 'high' THEN
    RAISE EXCEPTION 'fn_cash_stake_band does not agree with stakeBandForBigBlind';
  END IF;
END
$post$;

COMMIT;

-- ── Step 2, outside the transaction: the index ──────────────────────────────
-- CONCURRENTLY cannot run inside a transaction block and needs no blocking
-- lock, so it cannot deadlock with the controller's five-second tick. If it
-- ever fails it leaves an INVALID index behind: drop it and re-run this one
-- statement, nothing else in this file needs repeating.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS cash_games_one_per_band_action_madness
  ON public.cash_games (club_id, template_name, variant, public.fn_cash_stake_band(bb))
  WHERE enabled AND template_name IN ('action', 'madness');

COMMENT ON INDEX public.cash_games_one_per_band_action_madness IS
  'Dan 2026-09-05: one Action game and one Madness game per blind category per game type. Classic is deliberately not covered.';

DO $idx$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'cash_games_one_per_band_action_madness' AND i.indisvalid) THEN
    RAISE EXCEPTION 'cash_games_one_per_band_action_madness is missing or INVALID; drop it and re-run the CREATE INDEX CONCURRENTLY above';
  END IF;
END
$idx$;
