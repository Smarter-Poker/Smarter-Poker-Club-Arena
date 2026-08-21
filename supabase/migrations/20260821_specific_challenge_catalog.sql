-- ═══════════════════════════════════════════════════════════════════════════
--  SPECIFIC CHALLENGES  (Tier 3: drops and recreates an RPC -- rollback below)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan 2026-08-21: "DAILY CHALLENGES ISN'T FUNCTIONAL, IT NEEDS TO PULL THE REAL
-- TIME INFO AND DATA AND UPDATE TO ACTUALLY WORK AND FUNCTION AND PAY OUT" and
-- "COME UP WITH SPECIFIC CHALLENGES, DO NOT USE GENERIC 'BIG POT 4' WIN 4 BIG
-- POTS SMH ITS NOT EVEN SPECIFIED HOW MUCH A BIG POT IS."
--
-- WHAT WAS ACTUALLY WRONG. The tracking pipeline was alive -- a player sitting
-- at a table did move 7/10 on "Grinder 10" today. Three separate things made it
-- read as dead:
--
--  1. NOTHING PAID CHIPS. All 112 catalog rows carried chip_reward = 0, so
--     every claim credited diamonds only and the chip balance never moved.
--  2. NOTHING WAS SPECIFIC. The pot size that counts as "big" was a single
--     hardcoded constant in the challenge TYPE (BIG_POT_MIN = 500), so the
--     catalog could express exactly one size of big pot and its descriptions
--     had to stay vague to remain true. Hence "Big Pot 4 / Win 4 big pots".
--  3. NOTHING HAD EVER BEEN CLAIMED. 0 of 67 rows platform-wide, including a
--     250/250 completion sitting unclaimed since March.
--
-- The threshold moves from the type to the ROW. One type now expresses
-- 500 / 1,000 / 2,500 / 5,000 tiers, each stating its own number on the card,
-- and the same mechanism ranks hands (5 straight, 6 flush, 7 full house,
-- 8 quads) so "Win A Hand With A Flush Or Better" is enforceable.
--
-- Catalog rows are GENERATED from src/services/DailyChallengeService.ts, not
-- retyped, per 20260820c_challenge_catalog_single_source_of_truth.sql.

-- ── Schema ─────────────────────────────────────────────────────────────────
ALTER TABLE public.daily_challenge_catalog
  ADD COLUMN IF NOT EXISTS threshold integer;

COMMENT ON COLUMN public.daily_challenge_catalog.threshold IS
  'Minimum magnitude one event must reach to count: chips for big_pots, a handRankScore floor for strong_hands (5 straight, 6 flush, 7 full house, 8 quads). NULL means every qualifying event counts.';

-- ── The catalog ────────────────────────────────────────────────────────────
-- GENERATED from CHALLENGE_POOL / WEEKLY_CHALLENGE_POOL / MONTHLY_CHALLENGE_POOL
-- in src/services/DailyChallengeService.ts. Do not hand-edit either copy.
-- [id, tier, challenge_type, requirement, threshold, chip_reward,
--  diamond_reward, name, description]
-- A REAL staging table, not pg_temp: a temp object only survives if every
-- statement below runs on the same connection, and nothing here guarantees
-- that. It is dropped at the end of the migration.
DROP TABLE IF EXISTS public._challenge_seed;
CREATE TABLE public._challenge_seed AS
SELECT r FROM jsonb_array_elements($j$[
  ["hp_10","daily","hands_played",10,null,500,8,"First Ten","Play 10 Hands Today"],
  ["hp_25","daily","hands_played",25,null,1200,12,"Warmed Up","Play 25 Hands Today"],
  ["hp_50","daily","hands_played",50,null,2500,18,"Half Century","Play 50 Hands Today"],
  ["hp_100","daily","hands_played",100,null,5000,30,"Century Grind","Play 100 Hands Today"],
  ["hp_200","daily","hands_played",200,null,10000,50,"Iron Seat","Play 200 Hands Today"],
  ["hw_3","daily","hands_won",3,null,750,10,"Three Up","Win 3 Hands Today"],
  ["hw_8","daily","hands_won",8,null,1800,16,"Eight And Out","Win 8 Hands Today"],
  ["hw_15","daily","hands_won",15,null,3500,26,"Fifteen Pots","Win 15 Hands Today"],
  ["hw_30","daily","hands_won",30,null,7000,42,"Thirty Strong","Win 30 Hands Today"],
  ["sd_3","daily","showdowns",3,null,600,9,"Cards Up","Reach Showdown 3 Times Today"],
  ["sd_10","daily","showdowns",10,null,2000,20,"Showdown Regular","Reach Showdown 10 Times Today"],
  ["sd_20","daily","showdowns",20,null,4200,34,"Showdown Fixture","Reach Showdown 20 Times Today"],
  ["sdw_2","daily","showdowns_won",2,null,900,12,"Called And Correct","Win 2 Hands At Showdown Today"],
  ["sdw_5","daily","showdowns_won",5,null,2200,22,"Showdown Sheriff","Win 5 Hands At Showdown Today"],
  ["sdw_10","daily","showdowns_won",10,null,4800,38,"Proof Merchant","Win 10 Hands At Showdown Today"],
  ["nsw_3","daily","hands_won_no_showdown",3,null,900,12,"No Cards Needed","Win 3 Hands Without Reaching Showdown Today"],
  ["nsw_7","daily","hands_won_no_showdown",7,null,2400,24,"Quiet Thief","Win 7 Hands Without Reaching Showdown Today"],
  ["nsw_12","daily","hands_won_no_showdown",12,null,4500,36,"Ghost Stacker","Win 12 Hands Without Reaching Showdown Today"],
  ["bp_500_1","daily","big_pots",1,500,1000,14,"Five Hundred Club","Win A Pot Worth 500 Chips Or More Today"],
  ["bp_500_3","daily","big_pots",3,500,2600,26,"Pot Collector","Win 3 Pots Worth 500 Chips Or More Today"],
  ["bp_1000_1","daily","big_pots",1,1000,1600,20,"Four Figures","Win A Pot Worth 1,000 Chips Or More Today"],
  ["bp_1000_3","daily","big_pots",3,1000,4200,34,"Thousand Club","Win 3 Pots Worth 1,000 Chips Or More Today"],
  ["bp_2500_1","daily","big_pots",1,2500,3000,30,"Monster Pot","Win A Pot Worth 2,500 Chips Or More Today"],
  ["bp_5000_1","daily","big_pots",1,5000,6000,48,"Table Breaker","Win A Pot Worth 5,000 Chips Or More Today"],
  ["sh_str_1","daily","strong_hands",1,5,1200,15,"Straight Away","Win A Hand With A Straight Or Better Today"],
  ["sh_str_3","daily","strong_hands",3,5,3200,30,"Rank And File","Win 3 Hands With A Straight Or Better Today"],
  ["sh_fl_1","daily","strong_hands",1,6,1800,20,"Flush Money","Win A Hand With A Flush Or Better Today"],
  ["sh_fl_2","daily","strong_hands",2,6,3600,34,"Double Flush","Win 2 Hands With A Flush Or Better Today"],
  ["sh_fh_1","daily","strong_hands",1,7,2800,28,"Full Sail","Win A Hand With A Full House Or Better Today"],
  ["sh_quad_1","daily","strong_hands",1,8,7500,60,"Four Of A Kind","Win A Hand With Four Of A Kind Or Better Today"],
  ["cw_2500","daily","chips_won",2500,null,800,11,"Pocket Change","Win 2,500 Chips In Pots Today"],
  ["cw_10000","daily","chips_won",10000,null,2400,24,"Stack Builder","Win 10,000 Chips In Pots Today"],
  ["cw_25000","daily","chips_won",25000,null,5200,40,"Chip Magnet","Win 25,000 Chips In Pots Today"],
  ["cw_100000","daily","chips_won",100000,null,12000,70,"Bankroll Day","Win 100,000 Chips In Pots Today"],
  ["tp_1","daily","tournaments_played",1,null,1000,14,"Sign Me Up","Play 1 Tournament Today"],
  ["tp_3","daily","tournaments_played",3,null,3000,30,"Triple Entry","Play 3 Tournaments Today"],
  ["tp_5","daily","tournaments_played",5,null,5500,45,"Tournament Tour","Play 5 Tournaments Today"],
  ["fa_1","daily","friends_added",1,null,600,10,"New Face","Add 1 Friend Today"],
  ["fa_3","daily","friends_added",3,null,2000,25,"Social Circle","Add 3 Friends Today"],
  ["wk_hands_500","weekly","hands_played",500,null,30000,120,"Weekly Marathon","Play 500 Hands This Week"],
  ["wk_wins_100","weekly","hands_won",100,null,32000,130,"Weekly Winner","Win 100 Hands This Week"],
  ["wk_sdw_40","weekly","showdowns_won",40,null,28000,115,"Weekly Showdown King","Win 40 Hands At Showdown This Week"],
  ["wk_nsw_50","weekly","hands_won_no_showdown",50,null,28000,115,"Weekly Ghost","Win 50 Hands Without Reaching Showdown This Week"],
  ["wk_bp_1000_15","weekly","big_pots",15,1000,36000,145,"Weekly Pot Hunter","Win 15 Pots Worth 1,000 Chips Or More This Week"],
  ["wk_sh_fl_10","weekly","strong_hands",10,6,38000,150,"Weekly Flush Hunter","Win 10 Hands With A Flush Or Better This Week"],
  ["wk_chips_250k","weekly","chips_won",250000,null,40000,160,"Weekly Bankroll","Win 250,000 Chips In Pots This Week"],
  ["wk_tourneys_10","weekly","tournaments_played",10,null,34000,140,"Weekly Circuit","Play 10 Tournaments This Week"],
  ["mo_hands_2500","monthly","hands_played",2500,null,150000,500,"Monthly Marathon","Play 2,500 Hands This Month"],
  ["mo_wins_500","monthly","hands_won",500,null,165000,550,"Monthly Champion","Win 500 Hands This Month"],
  ["mo_bp_2500_25","monthly","big_pots",25,2500,200000,650,"Monthly Monster Hunt","Win 25 Pots Worth 2,500 Chips Or More This Month"],
  ["mo_sh_fh_25","monthly","strong_hands",25,7,210000,680,"Monthly Full House","Win 25 Hands With A Full House Or Better This Month"],
  ["mo_chips_1m","monthly","chips_won",1000000,null,250000,800,"Monthly Millionaire","Win 1,000,000 Chips In Pots This Month"],
  ["mo_tourneys_40","monthly","tournaments_played",40,null,180000,600,"Monthly Grinder","Play 40 Tournaments This Month"]
]$j$::jsonb) AS r;

INSERT INTO public.daily_challenge_catalog
  (id, tier, challenge_type, requirement, threshold, chip_reward, diamond_reward, name, description)
SELECT r->>0, r->>1, r->>2, (r->>3)::int, (r->>4)::int, (r->>5)::numeric,
       (r->>6)::int, r->>7, r->>8
  FROM public._challenge_seed r
ON CONFLICT (id) DO UPDATE SET
  tier           = EXCLUDED.tier,
  challenge_type = EXCLUDED.challenge_type,
  requirement    = EXCLUDED.requirement,
  threshold      = EXCLUDED.threshold,
  chip_reward    = EXCLUDED.chip_reward,
  diamond_reward = EXCLUDED.diamond_reward,
  name           = EXCLUDED.name,
  description    = EXCLUDED.description;

-- Re-deal every player from the new pool. A row that is unclaimed AND
-- incomplete represents no earned value, so dropping it costs the player
-- nothing and spares them a generic set until the period rolls over.
-- Claimed rows (paid) and completed-but-unclaimed rows (owed) are never
-- touched: the 250/250 sitting unclaimed since March is still claimable after
-- this runs, and it now pays chips as well as diamonds.
DELETE FROM public.user_daily_challenges u
 WHERE u.claimed = false
   AND u.completed = false
   AND u.challenge_id NOT IN (
     SELECT r->>0 FROM public._challenge_seed r);

-- Retire generic catalog entries, but ONLY those no player row still points
-- at. A claimed "Grinder 5" from March is settled history and its catalog row
-- is the only thing that can still name it; get_or_assign_challenges INNER
-- JOINs the catalog, so deleting it would blank a card already earned.
DELETE FROM public.daily_challenge_catalog c
 WHERE c.id NOT IN (
     SELECT r->>0 FROM public._challenge_seed r)
   AND NOT EXISTS (SELECT 1 FROM public.user_daily_challenges u WHERE u.challenge_id = c.id);

-- Assumption checks. A silent partial apply means cards that promise a reward
-- the claim path will not pay, so fail loudly instead.
DO $do$
DECLARE v_n int; v_bad int;
BEGIN
  SELECT count(*) INTO v_n FROM public.daily_challenge_catalog c
   WHERE EXISTS (SELECT 1 FROM public._challenge_seed r WHERE r->>0 = c.id);
  IF v_n <> 53 THEN
    RAISE EXCEPTION 'ABORT: expected 53 catalog rows from this migration, found %', v_n;
  END IF;

  SELECT count(*) INTO v_bad FROM public.daily_challenge_catalog c
   WHERE COALESCE(c.chip_reward, 0) <= 0
     AND EXISTS (SELECT 1 FROM public._challenge_seed r WHERE r->>0 = c.id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % new challenges still pay zero chips, the exact bug this migration exists to fix', v_bad;
  END IF;

  -- Every big_pots / strong_hands row must carry its own threshold, or its
  -- description promises something the server cannot enforce.
  SELECT count(*) INTO v_bad FROM public.daily_challenge_catalog
   WHERE challenge_type IN ('big_pots','strong_hands') AND threshold IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ABORT: % magnitude challenges have no threshold', v_bad;
  END IF;
END $do$;

DROP TABLE public._challenge_seed;


-- ═══════════════════════════════════════════════════════════════════════════
--  bump_challenge_progress: threshold-aware
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DROP then CREATE, not CREATE OR REPLACE: replace cannot change an argument
-- list, so it would leave a SECOND overload behind and PostgREST would resolve
-- the call by named-argument match. Two live definitions of the function that
-- pays players is exactly the ambiguity the migration-safety rules call out.
DROP FUNCTION IF EXISTS public.bump_challenge_progress(uuid, jsonb, text, text, text);
DROP FUNCTION IF EXISTS public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text);

CREATE FUNCTION public.bump_challenge_progress(
  p_user_id uuid,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_daily_key text,
  p_weekly_key text,
  p_monthly_key text
)
RETURNS TABLE(id uuid, challenge_id text, progress integer, requirement integer,
              chip_reward numeric, newly_completed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid;
BEGIN
  -- Same trust rule as the rest of the challenge RPCs: an end-user JWT wins and
  -- p_user_id is ignored; only a server context (auth.uid() IS NULL) may name
  -- another user. `anon` holds no EXECUTE grant.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN v_uid := p_user_id; END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_amounts IS NULL OR jsonb_typeof(p_amounts) <> 'object' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH bumps AS (
    SELECT key AS ctype, GREATEST(COALESCE((value #>> '{}')::int, 0), 0) AS amount
      FROM jsonb_each(p_amounts)
  ),
  updated AS (
    UPDATE public.user_daily_challenges u
       SET progress = LEAST(u.progress + b.amount, c.requirement),
           completed = (u.progress + b.amount) >= c.requirement,
           completed_at = CASE
             WHEN (u.progress + b.amount) >= c.requirement AND u.completed_at IS NULL
             THEN now() ELSE u.completed_at END
      FROM public.daily_challenge_catalog c, bumps b
     WHERE u.user_id = v_uid
       AND u.challenge_id = c.id
       AND c.challenge_type = b.ctype
       AND b.amount > 0
       AND u.completed = false
       AND u.assigned_date IN (p_daily_key, p_weekly_key, p_monthly_key)
       -- THE THRESHOLD GATE. A row with no threshold counts every event, which
       -- is the right reading for a pure counter like hands_played. A row that
       -- HAS one only advances when this event measured up, so a 600-chip pot
       -- moves "500 Or More" and leaves "5,000 Or More" alone. A missing
       -- magnitude reads as 0 and clears nothing: an unmeasured event cannot be
       -- shown to have passed any bar, and crediting it would let a folded hand
       -- complete "Win A Pot Worth 5,000 Chips Or More".
       AND (
         c.threshold IS NULL
         OR COALESCE((p_magnitudes -> b.ctype) #>> '{}', '0')::numeric >= c.threshold
       )
    RETURNING u.id, u.challenge_id, u.progress, u.completed, c.requirement, c.chip_reward
  )
  SELECT up.id, up.challenge_id, up.progress, up.requirement, up.chip_reward, up.completed
    FROM updated up;   -- every row it moved, completed or not
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
--  ROLLBACK  (Tier 3 requirement -- paste and run to undo)
-- ═══════════════════════════════════════════════════════════════════════════
-- The catalog rewrite is data and is reverted by re-running the previous
-- catalog population. The function change reverts to the 5-argument form:
--
--   DROP FUNCTION IF EXISTS public.bump_challenge_progress(uuid, jsonb, jsonb, text, text, text);
--   CREATE FUNCTION public.bump_challenge_progress(
--     p_user_id uuid, p_amounts jsonb, p_daily_key text, p_weekly_key text, p_monthly_key text)
--   RETURNS TABLE(id uuid, challenge_id text, progress integer, requirement integer,
--                 chip_reward numeric, newly_completed boolean)
--   LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ ... $$;
--   -- body: identical to the above minus the threshold gate in the WHERE clause.
--   -- Full prior text: supabase/migrations/20260820d_bump_challenge_progress.sql
--
-- ALTER TABLE public.daily_challenge_catalog DROP COLUMN threshold;  -- optional
