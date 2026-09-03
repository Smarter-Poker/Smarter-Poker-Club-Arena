-- ─────────────────────────────────────────────────────────────────────────────
-- ONE ACTIVE QUEUE ROW, AND ONE LIVE HOLD, PER PLAYER (2026-08-31)
--
-- Two gaps left by the 60-second exclusive seat hold, found auditing it.
--
-- 1. THE UNIQUE INDEX ONLY COVERED 'waiting'.
--    table_waitlist_one_active_per_player_uidx was
--    (table_id, user_id) WHERE status = 'waiting'. The moment a row flips to
--    'notified' - i.e. the player is holding an offer - the predicate stops
--    matching it, so the same player could create a SECOND 'waiting' row on
--    the same table while the first was still live.
--
--    WaitlistService already believes this cannot happen: ACTIVE_STATES is
--    ['waiting','notified'], its pre-insert lookup checks both, and its
--    recovery path treats a 23505 as "a concurrent join won the race" and
--    returns the existing active row. So the client was written against the
--    rule; only the index disagreed. Widening it makes the two agree, and the
--    client's existing recovery handles the refusal with no code change.
--
-- 2. NOTHING CAPPED HOW MANY SEATS ONE PLAYER COULD HOLD AT ONCE.
--    A hold is EXCLUSIVE - atomic_table_buyin refuses that seat to everybody
--    else for its full 60 seconds. A player queued on six tables could be
--    offered six seats at once and freeze one seat at each without sitting
--    down at any of them. Nobody is cheated out of money, but six tables are
--    made un-sittable by one idle person.
--
--    The cap is a CONFIG ROW, not a constant, because the right number is
--    Dan's call and not an agent's: waitlist_policy.max_concurrent_holds,
--    defaulting to 1. A larger number restores the old behaviour without a
--    code change; 0 means "no cap".
--
-- Being on many waiting LISTS stays unrestricted - that is how a card room
-- works. Only the number of simultaneously RESERVED seats is capped.
--
-- Checked before applying: 0 duplicate (table_id,user_id) pairs across both
-- active states, and 0 players holding more than one live offer, so neither
-- change could fail on existing data.
--
-- VERIFIED after applying, inside a transaction that was ROLLED BACK
-- (CLAUDE.md 11.5 - never spend real chips to test a rule):
--   TEST 1: a second active row for the same player+table -> refused, 23505.
--   TEST 2: a player holding a live seat on table A, and the ONLY person
--           waiting on table B, was skipped for B's offer.
-- Confirmed afterwards that nothing persisted: active-row count unchanged.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.table_waitlist_one_active_per_player_uidx;
--   CREATE UNIQUE INDEX table_waitlist_one_active_per_player_uidx
--     ON public.table_waitlist (table_id, user_id) WHERE status = 'waiting';
--   DROP TABLE IF EXISTS public.waitlist_policy;
--   (and re-apply the previous fn_offer_open_seat body)
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.table_waitlist_one_active_per_player_uidx;
CREATE UNIQUE INDEX table_waitlist_one_active_per_player_uidx
  ON public.table_waitlist (table_id, user_id)
  WHERE status IN ('waiting', 'notified');

CREATE TABLE IF NOT EXISTS public.waitlist_policy (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  max_concurrent_holds  int     NOT NULL DEFAULT 1 CHECK (max_concurrent_holds >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.waitlist_policy (id, max_concurrent_holds)
VALUES (true, 1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.waitlist_policy IS
  'Single-row waitlist policy. max_concurrent_holds = how many EXCLUSIVE seat holds one player may have across all tables at once (1 = a player can only reserve one seat at a time; 0 = no cap). Dan owns this number - change the row, not the code.';

ALTER TABLE public.waitlist_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.waitlist_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.waitlist_policy TO service_role;

CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(
  p_table_id  uuid,
  p_offer_ttl interval DEFAULT interval '60 seconds',
  p_entry_ttl interval DEFAULT interval '24 hours'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
  v_holds    int := 0;
  v_cap      int := 1;
BEGIN
  SELECT COALESCE(max_concurrent_holds, 1) INTO v_cap FROM public.waitlist_policy WHERE id;
  IF v_cap IS NULL THEN v_cap := 1; END IF;

  SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players
    INTO v_tbl
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_tbl.tournament_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table');
  END IF;

  IF COALESCE(v_tbl.current_players, 0) >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  WITH dead AS (
    UPDATE public.table_waitlist
       SET status = 'expired'
     WHERE table_id = p_table_id
       AND status = 'notified'
       AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) < now()
    RETURNING user_id
  )
  INSERT INTO public.notifications (user_id, type, title, message, data)
  SELECT d.user_id,
         'waitlist_offer_expired',
         'Seat Offer Expired',
         'Your Seat At ' || COALESCE(v_tbl.name, 'The Table') ||
           ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
         jsonb_build_object('table_id', p_table_id, '_push', 'skip')
    FROM dead d;
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE table_id = p_table_id
     AND status = 'waiting'
     AND created_at < now() - p_entry_ttl;

  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = p_table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );

  SELECT COUNT(*) INTO v_holds
    FROM public.table_waitlist
   WHERE table_id = p_table_id
     AND status = 'notified'
     AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) > now();

  IF COALESCE(v_tbl.current_players, 0) + v_holds >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'open_seats_already_held', 'offers_expired', v_expired
    );
  END IF;

  -- THE HEAD OF THE QUEUE, LOCKED, AND NOT ALREADY HOLDING A SEAT ELSEWHERE.
  -- A hold is exclusive, so handing one player several at once takes seats
  -- away from everybody behind them. Skipping a capped player leaves their
  -- place in line untouched: they are passed over for THIS seat only, and the
  -- next caller reconsiders them the moment their other hold resolves.
  SELECT w.id, w.user_id
    INTO v_next
    FROM public.table_waitlist w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND NOT COALESCE(p.is_horse, false)
     AND (
       v_cap = 0
       OR (
         SELECT count(*) FROM public.table_waitlist h
          WHERE h.user_id = w.user_id
            AND h.status = 'notified'
            AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
       ) < v_cap
     )
   ORDER BY w.created_at
     FOR UPDATE OF w SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'nobody_waiting', 'offers_expired', v_expired
    );
  END IF;

  UPDATE public.table_waitlist
     SET status = 'notified',
         notified_at = now(),
         hold_expires_at = now() + p_offer_ttl
   WHERE id = v_next.id;

  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (
    v_next.user_id,
    'waitlist_seat_open',
    'Seat Open',
    'A Seat Just Opened At ' || COALESCE(v_tbl.name, 'Your Waitlisted Table') ||
      '. It Is Held For You For 60 Seconds. Sit Down Now To Claim It.',
    jsonb_build_object('table_id', p_table_id)
  )
  RETURNING id INTO v_notif_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_next.user_id,
    'table_name', v_tbl.name,
    'notification_id', v_notif_id,
    'hold_expires_in_seconds', EXTRACT(epoch FROM p_offer_ttl)::int,
    'offers_expired', v_expired
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid, interval, interval) TO service_role;

DO $$
DECLARE v_pred text; v_cap int; v_probe jsonb;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'table_waitlist_one_active_per_player_uidx';
  IF v_pred IS NULL OR v_pred NOT LIKE '%notified%' THEN
    RAISE EXCEPTION 'post-apply failed: unique index does not cover notified (predicate: %)', v_pred;
  END IF;

  SELECT max_concurrent_holds INTO v_cap FROM public.waitlist_policy WHERE id;
  IF v_cap IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'post-apply failed: waitlist_policy row missing or wrong (got %)', v_cap;
  END IF;

  SELECT public.fn_offer_open_seat('00000000-0000-0000-0000-000000000000'::uuid) INTO v_probe;
  IF COALESCE(v_probe ->> 'reason', '') <> 'table_not_found' THEN
    RAISE EXCEPTION 'post-apply failed: offer probe answered %', v_probe;
  END IF;
END $$;
