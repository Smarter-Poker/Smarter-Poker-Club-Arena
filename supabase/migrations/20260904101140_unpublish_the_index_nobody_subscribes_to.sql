-- ═══════════════════════════════════════════════════════════════════════════
--  ca_hand_player_idx IS BROADCAST TO NOBODY, 4.5 MILLION TIMES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (measured 2026-09-04)
--
-- The realtime replication slot is 136 MB behind and falling further behind,
-- which is a spiral rather than a cliff: a slot that lags must read WAL from
-- disk instead of memory, which is slower, so being behind makes it fall
-- further behind.
--
-- `ca_hand_player_idx` is a member of the `supabase_realtime` publication:
--
--     3,872 MB      4,488,677 inserts      1,108,454 deletes
--
-- Every one of those inserts is decoded out of WAL, reassembled into a change
-- record, RLS-evaluated and prepared for delivery. It is then delivered to
-- nobody, because nobody has ever subscribed to it:
--
--   * `realtime.subscription` has never held a single row for this entity
--     (`select count(*) ... where entity = 'public.ca_hand_player_idx'` = 0);
--   * no `postgres_changes` subscription in Club Arena, the World Hub or
--     Club Commander names it - the string does not appear in `src/`,
--     `server/src/` or `scripts/` in any of the three repos;
--   * it is an internal hand index, written by `trg_ca_capture_hand_facts`
--     on the prune path, and read only by server-side analysis.
--
-- This is the cheapest available reduction in decoding work: it removes the
-- single largest publisher of change records that no client has ever asked
-- for. It changes nothing a player sees and nothing a player is owed.
--
-- WHAT THIS IS NOT
--
-- This is NOT the `has_human` trigger gate proposed in the 2026-09-04 handoff.
-- That was written, shipped, rejected by Dan and reverted the same day as
-- PR #2913, because gating derived work on `has_human` denies a horse
-- something a human gets and CLAUDE.md 10.5 forbids it without exception.
-- Nothing here is conditional on who sat in the seat: the table keeps every
-- row it has ever kept, for horses and humans alike, written by the same
-- trigger at the same moment. The only change is that Postgres stops
-- preparing a realtime broadcast of those rows for an audience of zero.
--
-- REVERSIBLE
--
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.ca_hand_player_idx;
--
-- ROLLBACK IS THAT ONE LINE. Nothing is dropped, nothing is deleted, no row
-- changes, and the table itself is untouched.
--
-- ASSERTIONS
--
-- The migration aborts rather than proceeding if the board moved underneath
-- it: if a subscriber has appeared since this was measured, or if the table
-- is no longer published (in which case there is nothing to do and a silent
-- success would be a lie).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_published  boolean;
  v_subs       bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_publication p
    JOIN pg_publication_rel pr ON pr.prpubid = p.oid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = 'public.ca_hand_player_idx'::regclass
  ) INTO v_published;

  IF NOT v_published THEN
    RAISE EXCEPTION
      'ca_hand_player_idx is not in supabase_realtime - somebody already removed it, or the table is gone. Re-measure before re-running.';
  END IF;

  SELECT count(*) INTO v_subs
  FROM realtime.subscription
  WHERE entity = 'public.ca_hand_player_idx'::regclass;

  IF v_subs > 0 THEN
    RAISE EXCEPTION
      'ABORT: % live realtime subscription(s) now exist for ca_hand_player_idx. It had zero when this was written. Something began subscribing - find out what before unpublishing (never unpublish a table a client still subscribes to; dropping table_hole_cards cost every player their hole cards for four hours).',
      v_subs;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime DROP TABLE public.ca_hand_player_idx;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication p
    JOIN pg_publication_rel pr ON pr.prpubid = p.oid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = 'public.ca_hand_player_idx'::regclass
  ) THEN
    RAISE EXCEPTION 'post-condition failed: ca_hand_player_idx is still published';
  END IF;

  RAISE NOTICE 'ca_hand_player_idx unpublished. supabase_realtime now has % tables.',
    (SELECT count(*) FROM pg_publication p
       JOIN pg_publication_rel pr ON pr.prpubid = p.oid
      WHERE p.pubname = 'supabase_realtime');
END $$;
