-- THE BOMB GUARD WAITS FOR THE ENGINE THAT CAN SATISFY IT.
--
-- 20260906100735 added a DEFERRABLE constraint trigger that refuses to let a
-- bomb-pot hand commit without award units. I applied it to production while
-- the engine still writes the hand and its units as TWO separate transactions,
-- which means I shipped a rule nothing in production could yet obey. That was
-- the wrong order and this migration removes it (already dropped live at
-- 10:12 UTC; this records it so the files and the database agree).
--
-- WHAT ACTUALLY HAPPENED, because the record should be accurate rather than
-- flattering. I watched a 2m41s gap in bomb hands after applying it and
-- concluded I had broken live play. I had not: over the same hour bomb pots
-- averaged 28.7s apart with a maximum gap of 489s, so 161s is ordinary. Worse
-- for my reading, three bomb hands committed at 10:10:40 WITH NO AWARD UNITS
-- while the trigger was live - so it was not blocking anything either. I
-- dropped a guard on evidence I had not finished reading.
--
-- WHAT THE SAME LOOK DID ESTABLISH, and it matters more than the trigger:
-- three of the 125 bomb pots in the last hour have no award units. The
-- detector reports 18 in seven days because it carries a grace period and an
-- epoch floor; the live rate is roughly 3 an hour. The fire-and-forget write
-- is losing far more than the board shows.
--
-- THE FIX IS THE ENGINE, NOT A TRIGGER AND NOT A SWEEP. hand_history and
-- bomb_pot_award_units must be ONE transaction. fn_ca_insert_hand_with_awards
-- from 20260906100735 is kept - it is the single round trip the engine will
-- call - and the constraint trigger goes back in the SAME pull request that
-- ships the engine change, once something can satisfy it. A rule that lands
-- before the code that obeys it is not enforcement, it is an outage waiting
-- for the right hand to be dealt.

BEGIN;

/* Guarded: a bare DROP TRIGGER IF EXISTS still takes AccessExclusiveLock on
   hand_history even when there is nothing to drop, and that deadlocks against
   ~600 inserts a minute. Only reach for the lock if the trigger is really
   there. It was dropped live at 10:12 UTC, so on this database this is a
   no-op; on a replay it is the real drop. */
DO $drop$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.hand_history'::regclass
                AND tgname = 'zz_ca_bomb_hand_keeps_its_award_units') THEN
    SET LOCAL lock_timeout = '10s';
    DROP TRIGGER zz_ca_bomb_hand_keeps_its_award_units ON public.hand_history;
  END IF;
END $drop$;

COMMENT ON FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units() IS
  'NOT ATTACHED. Kept ready for the pull request that makes the engine write '
  'hand_history and bomb_pot_award_units in one transaction through '
  'fn_ca_insert_hand_with_awards. Attaching it before that lands is an outage '
  'waiting for the right hand - see 20260906101230.';

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public.hand_history'::regclass
                AND tgname = 'zz_ca_bomb_hand_keeps_its_award_units') THEN
    RAISE EXCEPTION 'the bomb constraint trigger is still attached';
  END IF;
  RAISE NOTICE 'BOMB_GUARD_DETACHED_PENDING_ENGINE';
END $assert$;

COMMIT;
