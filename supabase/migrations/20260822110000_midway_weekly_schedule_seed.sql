-- ═══════════════════════════════════════════════════════════════════════════════
-- MIDWAY UNION WEEKLY TOURNAMENT SCHEDULE SEED (2026-08-22)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- A PokerStars-style repeating schedule for the Midway Union
-- (fade0000-0000-0000-0000-000000000001), consumed by
-- server/src/services/ScheduledTournamentService.ts.
--
-- Modeled on how PokerStars runs its lobby:
--   * A fixed set of DAILY events that repeat every day at the same UTC time
--     (Kickoff, Daily Big + Mini, Hot Turbos, Bounty Builders, freerolls).
--   * Day-of-week specials that change the lineup each day
--     (Monday Marathon, Super Tuesday, Mystery Wednesday, Thursday Thrill,
--      Friday Night Fight, Saturday Knockout).
--   * SUNDAY as the flagship day: Kickoff, Warm-Up, Storm, the Midway Major,
--     Mystery Million, PLO High Roller, Second Chance, Supersonic.
--   * Interval repeaters (a la hourly Bounty Builders / Hot $X) that keep one
--     instance live around the clock.
--   * Daily satellites feeding the Sunday Midway Major by name prefix.
--
-- config uses fn_create_tournament p_config key shapes plus blindPreset /
-- payoutPreset (resolved by ScheduledTournamentService). buyIn is the TOTAL
-- the player pays; 0 = freeroll. Times are UTC; days_of_week 0=Sunday.
--
-- Idempotent: rows are keyed by (club_id, name) via WHERE NOT EXISTS.

INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc, interval_minutes, config)
SELECT
  k.mid, k.mid, v.name, v.descr, true, v.dow, v.times, v.intv, v.cfg::jsonb
FROM (
  VALUES

  -- ═════════════════════════════ DAILY CORE ═════════════════════════════

  ('Midway Kickoff',
   'Daily opener. Early bird chips for registering before start.',
   '{0,1,2,3,4,5,6}'::int[], '{12:00}'::text[], NULL::int,
   '{"name":"Midway Kickoff","type":"mtt","gameVariant":"nlh","buyIn":5,"guaranteedPrize":500,"startingStack":10000,"maxPlayers":300,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":6,"tableSize":9,"earlyBirdEnabled":true,"earlyBirdChips":1000,"labelAsNew":true,"shortDescription":"The daily opener. Register early for 1,000 bonus chips.","horsesToRegister":6}'),

  ('The Daily Big',
   'The flagship daily deep stack. Big blind ante, final table deal enabled.',
   '{0,1,2,3,4,5,6}', '{18:00}', NULL,
   '{"name":"The Daily Big","type":"mtt","gameVariant":"nlh","buyIn":20,"guaranteedPrize":2500,"startingStack":20000,"maxPlayers":500,"minPlayers":4,"blindPreset":"SLOW","payoutPreset":"NINE","lateRegistrationLevels":8,"tableSize":9,"actionTimeSeconds":20,"bigBlindAnte":true,"finalTableDealEnabled":true,"isFeatured":true,"shortDescription":"The flagship daily deep stack with a 2,500 guarantee.","horsesToRegister":8}'),

  ('The Daily Big Mini',
   'One tenth the price of The Daily Big, same structure.',
   '{0,1,2,3,4,5,6}', '{18:30}', NULL,
   '{"name":"The Daily Big Mini","type":"mtt","gameVariant":"nlh","buyIn":2,"guaranteedPrize":250,"startingStack":15000,"maxPlayers":500,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":8,"tableSize":9,"shortDescription":"The Daily Big at a tenth of the price.","horsesToRegister":6}'),

  ('Hot Turbo',
   'Fast structure, twice a day. Accelerated after late registration.',
   '{0,1,2,3,4,5,6}', '{15:00,21:00}', NULL,
   '{"name":"Hot Turbo","type":"mtt","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1000,"startingStack":10000,"maxPlayers":300,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":4,"tableSize":9,"actionTimeSeconds":12,"acceleratedMtt":true,"shortDescription":"Twice daily turbo. Levels speed up once late reg closes.","horsesToRegister":6}'),

  ('Bounty Builder',
   'Daily fixed knockout. Half the buy-in on every head.',
   '{0,1,2,3,4,5,6}', '{17:00}', NULL,
   '{"name":"Bounty Builder","type":"bounty","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1000,"startingStack":12000,"maxPlayers":300,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"tableSize":9,"bountyAmount":5,"shortDescription":"Daily knockout. Every elimination pays a bounty.","horsesToRegister":6}'),

  ('Bounty Builder Turbo',
   'Late night knockout at turbo speed.',
   '{0,1,2,3,4,5,6}', '{23:00}', NULL,
   '{"name":"Bounty Builder Turbo","type":"progressive_bounty","gameVariant":"nlh","buyIn":5,"guaranteedPrize":500,"startingStack":10000,"maxPlayers":200,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":4,"tableSize":9,"bountyAmount":2,"shortDescription":"Progressive knockout at turbo speed.","horsesToRegister":5}'),

  ('Night Owl Hyper',
   'Hyper turbo for the late crowd. Plays through global breaks.',
   '{0,1,2,3,4,5,6}', '{01:00}', NULL,
   '{"name":"Night Owl Hyper","type":"mtt","gameVariant":"nlh","buyIn":5,"guaranteedPrize":400,"startingStack":5000,"maxPlayers":200,"minPlayers":4,"blindPreset":"HYPER_TURBO","payoutPreset":"THREE","lateRegistrationLevels":2,"tableSize":6,"actionTimeSeconds":10,"synchronizedBreaks":false,"shortDescription":"Hyper turbo. No breaks, straight through.","horsesToRegister":5}'),

  ('Deep Stack Daily',
   'Slow structure re-entry with add-on break and bubble protection.',
   '{0,1,2,3,4,5,6}', '{16:00}', NULL,
   '{"name":"Deep Stack Daily","type":"mtt","gameVariant":"nlh","buyIn":15,"guaranteedPrize":1500,"startingStack":30000,"maxPlayers":300,"minPlayers":4,"blindPreset":"SLOW","payoutPreset":"NINE","lateRegistrationLevels":8,"tableSize":9,"actionTimeSeconds":20,"isReentry":true,"maxReentries":2,"addOnAvailable":true,"addOnLevels":1,"addonBreakMinutes":3,"bubbleProtection":true,"shortDescription":"30,000 chips, slow levels, two re-entries, add-on break, bubble protection.","horsesToRegister":6}'),

  ('Daily Freeroll',
   'Free entry, real prize pool, every day.',
   '{0,1,2,3,4,5,6}', '{14:00}', NULL,
   '{"name":"Daily Freeroll","type":"mtt","gameVariant":"nlh","buyIn":0,"guaranteedPrize":100,"startingStack":5000,"maxPlayers":500,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":4,"tableSize":9,"shortDescription":"Free entry. 100 guaranteed every day.","horsesToRegister":6}'),

  ('Midnight Freeroll',
   'Late night free entry turbo.',
   '{0,1,2,3,4,5,6}', '{02:00}', NULL,
   '{"name":"Midnight Freeroll","type":"mtt","gameVariant":"nlh","buyIn":0,"guaranteedPrize":50,"startingStack":5000,"maxPlayers":300,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":3,"tableSize":9,"shortDescription":"Free entry turbo after midnight.","horsesToRegister":5}'),

  ('PLO Daily',
   'Pot Limit Omaha, six handed, every day.',
   '{0,1,2,3,4,5,6}', '{20:00}', NULL,
   '{"name":"PLO Daily","type":"mtt","gameVariant":"plo4","buyIn":10,"guaranteedPrize":750,"startingStack":12000,"maxPlayers":200,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"tableSize":6,"shortDescription":"Daily four card PLO, six handed.","horsesToRegister":5}'),

  ('Short Deck Shootout',
   'Six plus holdem, six handed, daily.',
   '{0,1,2,3,4,5,6}', '{13:00}', NULL,
   '{"name":"Short Deck Shootout","type":"mtt","gameVariant":"shortdeck","buyIn":10,"guaranteedPrize":500,"startingStack":10000,"maxPlayers":120,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"THREE","lateRegistrationLevels":4,"tableSize":6,"shortDescription":"Short deck action, six handed.","horsesToRegister":5}'),

  ('All-In or Fold Frenzy',
   'Two buttons only. Ten second decisions.',
   '{0,1,2,3,4,5,6}', '{22:00}', NULL,
   '{"name":"All-In or Fold Frenzy","type":"mtt","gameVariant":"nlh","buyIn":2,"guaranteedPrize":200,"startingStack":3000,"maxPlayers":200,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":3,"tableSize":6,"actionTimeSeconds":10,"allInOrFold":true,"labelAsNew":true,"shortDescription":"All in or fold. Nothing in between.","horsesToRegister":5}'),

  ('Mystery Bounty Nightly',
   'Every knockout draws a mystery prize.',
   '{0,1,2,3,4,5,6}', '{19:30}', NULL,
   '{"name":"Mystery Bounty Nightly","type":"mystery_bounty","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1000,"startingStack":12000,"maxPlayers":300,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"tableSize":9,"bountyAmount":5,"mysteryBountyMin":0.5,"mysteryBountyMax":10,"shortDescription":"Knockouts draw a mystery bounty up to ten times the head price.","horsesToRegister":6}'),

  ('The Silent Assassin',
   'Turbo with chat disabled. Cards speak.',
   '{0,1,2,3,4,5,6}', '{03:00}', NULL,
   '{"name":"The Silent Assassin","type":"mtt","gameVariant":"nlh","buyIn":5,"guaranteedPrize":300,"startingStack":8000,"maxPlayers":150,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"THREE","lateRegistrationLevels":3,"tableSize":6,"banChat":true,"synchronizedBreaks":false,"shortDescription":"No chat. Cards speak.","horsesToRegister":5}'),

  ('Sunday Major Satellite',
   'Daily satellite awarding seats to the Sunday Midway Major.',
   '{0,1,2,3,4,5,6}', '{19:00}', NULL,
   '{"name":"Sunday Major Satellite","type":"satellite","gameVariant":"nlh","buyIn":5,"startingStack":8000,"maxPlayers":100,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":4,"tableSize":9,"satelliteTargetName":"Sunday Midway Major","satelliteSeats":5,"shortDescription":"Win a seat in the Sunday Midway Major.","horsesToRegister":5}'),

  -- ═════════════════════════ INTERVAL REPEATERS ═════════════════════════

  ('Blitz Bounty',
   'Always one live. Respawns an hour after the last one finishes.',
   '{0,1,2,3,4,5,6}', '{}', 60,
   '{"name":"Blitz Bounty","type":"progressive_bounty","gameVariant":"nlh","buyIn":3,"startingStack":6000,"maxPlayers":60,"minPlayers":3,"blindPreset":"TURBO","payoutPreset":"THREE","lateRegistrationLevels":3,"tableSize":6,"bountyAmount":1,"shortDescription":"Around the clock progressive knockout.","horsesToRegister":4}'),

  ('Heads-Up Hyper Duel',
   'One on one hyper turbo, always available.',
   '{0,1,2,3,4,5,6}', '{}', 30,
   '{"name":"Heads-Up Hyper Duel","type":"sng","gameVariant":"nlh","buyIn":15,"startingStack":5000,"maxPlayers":2,"minPlayers":2,"blindPreset":"HYPER_TURBO","payoutPreset":"HEADS_UP","tableSize":2,"actionTimeSeconds":12,"shortDescription":"Winner takes all, one on one.","horsesToRegister":0}'),

  ('Spin Royale',
   'Premium three handed spin, always available.',
   '{0,1,2,3,4,5,6}', '{}', 30,
   '{"name":"Spin Royale","type":"spin","gameVariant":"nlh","buyIn":25,"startingStack":1000,"maxPlayers":3,"minPlayers":3,"blindPreset":"HYPER_TURBO","payoutPreset":"WINNER_TAKE_ALL","tableSize":3,"shortDescription":"Premium spin with a multiplied prize pool.","horsesToRegister":0}'),

  -- ═══════════════════════ WEEKDAY SPECIALS ═══════════════════════

  ('Monday Marathon',
   'Monday. The slowest, deepest structure of the week.',
   '{1}', '{19:00}', NULL,
   '{"name":"Monday Marathon","type":"mtt","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1500,"startingStack":25000,"maxPlayers":300,"minPlayers":4,"blindPreset":"SLOW","payoutPreset":"NINE","lateRegistrationLevels":10,"tableSize":9,"actionTimeSeconds":20,"bubbleProtection":true,"shortDescription":"The deepest structure of the week.","horsesToRegister":6}'),

  ('Super Tuesday',
   'Tuesday high buy-in major.',
   '{2}', '{19:00}', NULL,
   '{"name":"Super Tuesday","type":"mtt","gameVariant":"nlh","buyIn":50,"guaranteedPrize":5000,"startingStack":25000,"maxPlayers":300,"minPlayers":4,"blindPreset":"SLOW","payoutPreset":"NINE","lateRegistrationLevels":8,"tableSize":9,"actionTimeSeconds":20,"bigBlindAnte":true,"finalTableDealEnabled":true,"isFeatured":true,"shortDescription":"The midweek major. 5,000 guaranteed.","horsesToRegister":8}'),

  ('Mystery Wednesday',
   'Wednesday mystery bounty special.',
   '{3}', '{19:00}', NULL,
   '{"name":"Mystery Wednesday","type":"mystery_bounty","gameVariant":"nlh","buyIn":20,"guaranteedPrize":2000,"startingStack":15000,"maxPlayers":300,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":6,"tableSize":9,"bountyAmount":9,"mysteryBountyMin":0.5,"mysteryBountyMax":13,"isFeatured":true,"shortDescription":"Midweek mystery bounty. Top prize thirteen times the head.","horsesToRegister":6}'),

  ('Thursday Thrill',
   'Thursday PLO progressive knockout.',
   '{4}', '{19:00}', NULL,
   '{"name":"Thursday Thrill","type":"progressive_bounty","gameVariant":"plo4","buyIn":25,"guaranteedPrize":2000,"startingStack":15000,"maxPlayers":200,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"tableSize":6,"bountyAmount":11,"shortDescription":"Four card PLO knockout night.","horsesToRegister":5}'),

  ('Friday Night Fight',
   'Friday short deck turbo.',
   '{5}', '{19:00}', NULL,
   '{"name":"Friday Night Fight","type":"mtt","gameVariant":"shortdeck","buyIn":10,"guaranteedPrize":1000,"startingStack":10000,"maxPlayers":150,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"FIVE","lateRegistrationLevels":4,"tableSize":6,"shortDescription":"Short deck brawl to start the weekend.","horsesToRegister":5}'),

  ('TGIF Freeroll',
   'Friday free entry special.',
   '{5}', '{20:30}', NULL,
   '{"name":"TGIF Freeroll","type":"mtt","gameVariant":"nlh","buyIn":0,"guaranteedPrize":200,"startingStack":8000,"maxPlayers":500,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":4,"tableSize":9,"shortDescription":"Free entry Friday special. 200 guaranteed.","horsesToRegister":6}'),

  ('Saturday Knockout',
   'Saturday progressive bounty main.',
   '{6}', '{18:00}', NULL,
   '{"name":"Saturday Knockout","type":"progressive_bounty","gameVariant":"nlh","buyIn":20,"guaranteedPrize":2000,"startingStack":15000,"maxPlayers":300,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":6,"tableSize":9,"bountyAmount":9,"shortDescription":"Saturday knockout with growing bounties.","horsesToRegister":6}'),

  ('Super Saturday Satellite',
   'Ten seats to the Sunday Midway Major.',
   '{6}', '{20:00}', NULL,
   '{"name":"Super Saturday Satellite","type":"satellite","gameVariant":"nlh","buyIn":10,"startingStack":10000,"maxPlayers":200,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":5,"tableSize":9,"satelliteTargetName":"Sunday Midway Major","satelliteSeats":10,"shortDescription":"Ten Sunday Midway Major seats guaranteed.","horsesToRegister":5}'),

  ('Saturday Speedway',
   'Saturday night hyper turbo.',
   '{6}', '{21:30}', NULL,
   '{"name":"Saturday Speedway","type":"mtt","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1000,"startingStack":5000,"maxPlayers":200,"minPlayers":4,"blindPreset":"HYPER_TURBO","payoutPreset":"FIVE","lateRegistrationLevels":2,"tableSize":6,"actionTimeSeconds":10,"shortDescription":"Flat out hyper turbo racing.","horsesToRegister":5}'),

  -- ═══════════════════════ SUNDAY: THE BIG DAY ═══════════════════════

  ('Sunday Kickoff',
   'Sunday opener.',
   '{0}', '{13:00}', NULL,
   '{"name":"Sunday Kickoff","type":"mtt","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1000,"startingStack":12000,"maxPlayers":300,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":6,"tableSize":9,"earlyBirdEnabled":true,"earlyBirdChips":1000,"shortDescription":"The Sunday grind starts here.","horsesToRegister":6}'),

  ('Sunday Freeroll Special',
   'The biggest freeroll of the week.',
   '{0}', '{14:00}', NULL,
   '{"name":"Sunday Freeroll Special","type":"mtt","gameVariant":"nlh","buyIn":0,"guaranteedPrize":300,"startingStack":8000,"maxPlayers":1000,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":4,"tableSize":9,"shortDescription":"Free entry. The biggest guarantee of any freeroll this week.","horsesToRegister":8}'),

  ('Sunday Warm-Up',
   'Deep stack tune-up before the Major.',
   '{0}', '{15:00}', NULL,
   '{"name":"Sunday Warm-Up","type":"mtt","gameVariant":"nlh","buyIn":20,"guaranteedPrize":2000,"startingStack":20000,"maxPlayers":300,"minPlayers":4,"blindPreset":"SLOW","payoutPreset":"NINE","lateRegistrationLevels":8,"tableSize":9,"actionTimeSeconds":20,"shortDescription":"Deep stack warm up before the Major.","horsesToRegister":6}'),

  ('Sunday Storm',
   'Tiny buy-in, huge field, three rebuys.',
   '{0}', '{16:00}', NULL,
   '{"name":"Sunday Storm","type":"mtt","gameVariant":"nlh","buyIn":2,"guaranteedPrize":1500,"startingStack":10000,"maxPlayers":1000,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":6,"tableSize":9,"isRebuy":true,"maxRebuys":3,"rebuyLevels":6,"shortDescription":"The people''s major. Tiny buy in, huge field.","horsesToRegister":8}'),

  ('Sunday Midway Major',
   'The flagship event of the week. Satellites run all week.',
   '{0}', '{17:00}', NULL,
   '{"name":"Sunday Midway Major","type":"mtt","gameVariant":"nlh","buyIn":100,"guaranteedPrize":10000,"startingStack":30000,"maxPlayers":1000,"minPlayers":4,"blindPreset":"SLOW","payoutPreset":"NINE","lateRegistrationLevels":10,"tableSize":9,"actionTimeSeconds":20,"bigBlindAnte":true,"finalTableDealEnabled":true,"bubbleProtection":true,"earlyBirdEnabled":true,"earlyBirdChips":2000,"isFeatured":true,"spawnAheadMinutes":10080,"shortDescription":"The flagship. 10,000 guaranteed, satellites all week.","horsesToRegister":10}'),

  ('Sunday Mystery Million',
   'Sunday mystery bounty headliner.',
   '{0}', '{18:30}', NULL,
   '{"name":"Sunday Mystery Million","type":"mystery_bounty","gameVariant":"nlh","buyIn":50,"guaranteedPrize":5000,"startingStack":20000,"maxPlayers":500,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"NINE","lateRegistrationLevels":6,"tableSize":9,"bountyAmount":20,"mysteryBountyMin":0.5,"mysteryBountyMax":13,"isFeatured":true,"shortDescription":"Sunday mystery bounty. Envelopes up to thirteen times the head.","horsesToRegister":8}'),

  ('Sunday PLO High Roller',
   'Four card PLO for the big Sunday finish.',
   '{0}', '{19:30}', NULL,
   '{"name":"Sunday PLO High Roller","type":"mtt","gameVariant":"plo4","buyIn":100,"guaranteedPrize":3000,"startingStack":25000,"maxPlayers":200,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"tableSize":6,"actionTimeSeconds":20,"bigBlindAnte":true,"finalTableDealEnabled":true,"shortDescription":"Sunday PLO for the high rollers.","horsesToRegister":5}'),

  ('VIP Sunday Sanctuary',
   'VIP members only.',
   '{0}', '{20:30}', NULL,
   '{"name":"VIP Sunday Sanctuary","type":"mtt","gameVariant":"nlh","buyIn":25,"guaranteedPrize":1500,"startingStack":15000,"maxPlayers":200,"minPlayers":4,"blindPreset":"STANDARD","payoutPreset":"FIVE","lateRegistrationLevels":6,"tableSize":9,"isVipOnly":true,"shortDescription":"VIP members only. Bring your badge.","horsesToRegister":5}'),

  ('Sunday Second Chance',
   'Busted the Major? Run it back.',
   '{0}', '{21:00}', NULL,
   '{"name":"Sunday Second Chance","type":"mtt","gameVariant":"nlh","buyIn":20,"guaranteedPrize":1500,"startingStack":12000,"maxPlayers":300,"minPlayers":4,"blindPreset":"TURBO","payoutPreset":"NINE","lateRegistrationLevels":5,"tableSize":9,"shortDescription":"The comeback event for Major casualties.","horsesToRegister":6}'),

  ('Sunday Supersonic',
   'The last flight out. Hyper turbo nightcap.',
   '{0}', '{22:30}', NULL,
   '{"name":"Sunday Supersonic","type":"mtt","gameVariant":"nlh","buyIn":10,"guaranteedPrize":1000,"startingStack":5000,"maxPlayers":300,"minPlayers":4,"blindPreset":"HYPER_TURBO","payoutPreset":"FIVE","lateRegistrationLevels":2,"tableSize":6,"actionTimeSeconds":10,"synchronizedBreaks":false,"shortDescription":"The Sunday nightcap at hyper speed.","horsesToRegister":6}')

) AS v(name, descr, dow, times, intv, cfg)
CROSS JOIN (SELECT 'fade0000-0000-0000-0000-000000000001'::uuid AS mid) k
WHERE NOT EXISTS (
  SELECT 1 FROM public.tournament_schedules t
  WHERE t.club_id = k.mid AND t.name = v.name
);

-- Post-apply assertion: the full weekly grid is present.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.tournament_schedules
  WHERE club_id = 'fade0000-0000-0000-0000-000000000001' AND active;
  IF n < 35 THEN
    RAISE EXCEPTION 'midway weekly schedule seed incomplete: only % active rows', n;
  END IF;
END $$;
