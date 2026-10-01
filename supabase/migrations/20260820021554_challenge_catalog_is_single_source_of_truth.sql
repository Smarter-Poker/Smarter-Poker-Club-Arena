-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260820021554 as "challenge_catalog_is_single_source_of_truth"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- The client kept its OWN copy of every challenge's name, description,
-- requirement and rewards, and rendered from that copy while the server paid
-- from daily_challenge_catalog. The two can drift, and drift here is not
-- cosmetic: it is a card that promises 7 diamonds next to a balance that
-- received 3, or (as already happened once) a challenge id the catalog has
-- never heard of, which the claim RPC rejects and the player can never claim.
--
-- Fix the class, not the instance: the catalog becomes the single source of
-- truth for everything the card displays, and the client renders what the
-- server sends.

ALTER TABLE public.daily_challenge_catalog
  ADD COLUMN IF NOT EXISTS name        text,
  ADD COLUMN IF NOT EXISTS description text;

UPDATE public.daily_challenge_catalog c
   SET name = v.name, description = v.description
  FROM (VALUES
  ('hands_10','Warm Up','Play 10 hands today'),
  ('hands_25','Getting Serious','Play 25 hands today'),
  ('hands_50','Grinder','Play 50 hands today'),
  ('hands_15','Card Shark','Play 15 hands today'),
  ('hands_40','Table Regular','Play 40 hands today'),
  ('hands_75','Session Beast','Play 75 hands today'),
  ('hands_100','Century Club','Play 100 hands today'),
  ('wins_3','Triple Threat','Win 3 hands today'),
  ('wins_5','High Five','Win 5 hands today'),
  ('wins_10','Ten Bagger','Win 10 hands today'),
  ('wins_7','Lucky Seven','Win 7 hands today'),
  ('wins_15','Rush Mode','Win 15 hands today'),
  ('showdown_3','Show Your Cards','Reach 3 showdowns today'),
  ('showdown_5','Showdown King','Reach 5 showdowns today'),
  ('showdown_8','All The Way','Reach 8 showdowns today'),
  ('showdown_10','Fearless','Reach 10 showdowns today'),
  ('tourney_1','Tournament Time','Play 1 tournament today'),
  ('tourney_3','Tournament Regular','Play 3 tournaments today'),
  ('tourney_2','Double Entry','Play 2 tournaments today'),
  ('big_pot_1','Big Score','Win a pot of 500 or more today'),
  ('big_pot_3','Pot Hunter','Win 3 pots of 500 or more today'),
  ('strong_hand_1','Monster Hand','Make a straight or better today'),
  ('strong_hand_3','Hand Collector','Make 3 straights or better today'),
  ('friend_1','Make a Friend','Add 1 friend today'),
  ('weekly_hands_250','Weekly Grinder','Play 250 hands this week'),
  ('weekly_wins_50','Weekly Winner','Win 50 hands this week'),
  ('weekly_tourneys_10','Tournament Specialist','Play 10 tournaments this week'),
  ('weekly_big_pots_10','Weekly Big Game','Win 10 pots of 500 or more this week'),
  ('weekly_strong_hands_8','Weekly Monster Run','Make 8 straights or better this week'),
  ('weekly_showdowns_20','Showdown Machine','Reach 20 showdowns this week'),
  ('monthly_hands_1000','Monthly Marathon','Play 1,000 hands this month'),
  ('monthly_wins_250','Monthly Dominator','Win 250 hands this month'),
  ('monthly_big_pots_50','Monthly Whale','Win 50 pots of 500 or more this month'),
  ('monthly_tourneys_50','Tournament Master','Play 50 tournaments this month')
  ) AS v(id, name, description)
 WHERE c.id = v.id;

DO $$
DECLARE v_missing int; v_total int;
BEGIN
  SELECT count(*) INTO v_total FROM public.daily_challenge_catalog;
  SELECT count(*) INTO v_missing FROM public.daily_challenge_catalog
   WHERE name IS NULL OR btrim(name) = '' OR description IS NULL OR btrim(description) = '';
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'ABORT: % of % catalog rows have no name/description. A card with a blank title is worse than no card.', v_missing, v_total;
  END IF;
  RAISE NOTICE 'catalog metadata populated for all % rows', v_total;
END $$;

ALTER TABLE public.daily_challenge_catalog
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN description SET NOT NULL;

-- One round trip for the whole page.
--
-- The client previously did up to SIX calls to paint /challenges: a SELECT and
-- possibly an assign RPC for each of daily, weekly and monthly. This assigns
-- any missing period and returns all three tiers joined to the catalog, so the
-- displayed requirement and rewards are BY CONSTRUCTION the ones the claim RPC
-- will honour.
CREATE OR REPLACE FUNCTION public.get_or_assign_challenges(
  p_daily_key    text,
  p_daily_ids    text[],
  p_weekly_key   text,
  p_weekly_ids   text[],
  p_monthly_key  text,
  p_monthly_ids  text[]
)
RETURNS TABLE (
  id            uuid,
  challenge_id  text,
  assigned_date text,
  progress      integer,
  completed     boolean,
  claimed       boolean,
  completed_at  timestamptz,
  name          text,
  description   text,
  challenge_type text,
  requirement   integer,
  chip_reward   numeric,
  diamond_reward integer,
  tier          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- assign_user_challenges is already idempotent and already validates every
  -- id against the catalog and the period-key shape. Reuse it rather than
  -- reimplementing those checks here, where they would drift.
  PERFORM public.assign_user_challenges(p_daily_key,   p_daily_ids);
  PERFORM public.assign_user_challenges(p_weekly_key,  p_weekly_ids);
  PERFORM public.assign_user_challenges(p_monthly_key, p_monthly_ids);

  RETURN QUERY
  SELECT u.id, u.challenge_id, u.assigned_date, COALESCE(u.progress, 0),
         COALESCE(u.completed, false), COALESCE(u.claimed, false), u.completed_at,
         c.name, c.description, c.challenge_type, c.requirement,
         COALESCE(c.chip_reward, 0), COALESCE(c.diamond_reward, 0), c.tier
    FROM public.user_daily_challenges u
    JOIN public.daily_challenge_catalog c ON c.id = u.challenge_id
   WHERE u.user_id = v_uid
     AND u.assigned_date IN (p_daily_key, p_weekly_key, p_monthly_key);
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_assign_challenges(text, text[], text, text[], text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_assign_challenges(text, text[], text, text[], text, text[]) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_or_assign_challenges' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'ABORT: get_or_assign_challenges is missing or not SECURITY DEFINER';
  END IF;
  -- An INNER JOIN to the catalog means an id the catalog does not know simply
  -- never reaches the client, instead of rendering as a blank unclaimable card.
  IF EXISTS (
    SELECT 1 FROM public.user_daily_challenges u
     LEFT JOIN public.daily_challenge_catalog c ON c.id = u.challenge_id
     WHERE c.id IS NULL
  ) THEN
    RAISE WARNING 'orphan user_daily_challenges rows exist whose challenge_id is not in the catalog; they will now be hidden rather than shown unclaimable';
  END IF;
END $$;
