-- the_freeroll_listing_says_what_it_pays
--
-- THE FREEROLL LISTING SAYS WHAT IT PAYS (2026-10-09). Dan, 2026-10-09:
-- "FINISH ALL OF THESE UP NOW" on the open list, item 4. Every "$100 Freeroll"
-- schedule (Midway and the Diamond Arena) pays its guarantee as a floor: the
-- pool is the greater of $100 and what the $1 rebuys and add-ons bring in
-- (fn_ca_return_excess_start_overlay_locked, and its Diamond branch
-- fn_poker_diamond_tournament_settle_overlay). The listing read "$100 Base
-- Prize Pool ... 100% Of $1 Rebuys And $1 Add-Ons Are Added To The Prize Pool",
-- which reads as $100 plus every rebuy. The schedules now say what the pool
-- does. Occurrences already open for registration keep the text they were
-- registered under (fn_guard_managed_game_lifecycle locks a registered event);
-- every occurrence created from now on carries the new text. Data only.
BEGIN;
UPDATE public.tournament_schedules
   SET config = jsonb_set(config, '{shortDescription}',
         to_jsonb('$100 Guaranteed Prize Pool. Entry Is Free. Every $1 Rebuy And $1 Add-On Goes Into The Prize Pool, Which Never Pays Less Than $100.'::text))
 WHERE config->>'shortDescription' = '$100 Base Prize Pool. Entry Is Free. 100% Of $1 Rebuys And $1 Add-Ons Are Added To The Prize Pool.';
COMMIT;
