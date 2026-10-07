-- 20261007014946_five_launch_owner_decisions.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THREE OF THE FIVE LAUNCH-CHECKLIST OWNER DECISIONS, decided by Claude under
-- CLAUDE.md 10.9 on Dan's delegation ("THESE ARE ALL YOURS TO FINISH UP AND
-- DECIDE", 2026-10-07). The other two are the engine's hi-lo insurance gate
-- (ServerTableEngineRunout.ts) and the Diamond jackpot ladder's leftovers
-- (20261007015026). Every number below was read from production on
-- 2026-10-07 before this file was written.
-- docs/changelog/2026-10-07-five-launch-owner-decisions.md.
--
-- 1. UNPAID ADVERTISED REWARDS: A PROMOTION CARRIES NO PRIZE MONEY.
--    `promotions.prize_pool` is rendered to players ("Prize 5K") and nothing
--    pays it: there is no high-hand scorer, no rake-race settler and no
--    leaderboard payer, and a promotion claim credits no wallet
--    (20260829221751, 20260905084034). Four promotions, all on Club JAQK,
--    advertised 9,500 between them; promotion_leaderboards held 0 rows and
--    promotion_claims 0, so nobody entered and nobody is owed. 10.9's clear
--    path to PAY does not exist (no rule says who would be owed what), so the
--    platform STOPS ADVERTISING: every row's prize_pool becomes 0, the two
--    still marked active or scheduled (both long past their end dates) are
--    cancelled, and a CHECK refuses a prize pool from now on. The warning
--    trigger that only reported the gap is dropped with it, as its own header
--    asked ("delete this trigger in the same commit"): the gap cannot recur.
--    Paid leaderboard prizes remain the club leaderboard programme
--    (leaderboard_reward_program_versions), which has a settler.
--
-- 2. TOURNAMENT RESULT NOTICES: EVERY PAID FINISH OF A SCHEDULED EVENT IS TOLD.
--    No tournament result notice was ever sent (14 days of notifications:
--    zero of any tournament-result type; PushNotificationService's
--    notifyTournamentResult has no caller). A Spin or Sit and Go ends with its
--    players at the table, where the result card shows; a scheduled
--    multi-table event or satellite pays at its end, hours after most of the
--    money finishers busted and left. So every tournament_payouts row of an
--    MTT or SATELLITE event writes one in-app notice to its player in the same
--    transaction as the payment: no job, no sweep. Horses receive it on
--    exactly the same terms (CLAUDE.md 10.5). One notice per player per event
--    (a unique index), and a notice that cannot be written never blocks a
--    payment. Measured volume: about 1,440 a day.
--
-- 3. CLUB-CARD UPLOAD POLICY: ONLY A CLUB'S OWNER WRITES ITS CARD IMAGE.
--    storage.objects let ANY signed-in account insert and overwrite any object
--    under club-assets/club-cards/ ("club cards owner update" had no owner
--    test), so anyone could replace any club's lobby card with any image. The
--    card URL lives on clubs.card_image_url, which only the owner may update
--    ("Owners can update clubs"). The storage rule now says the same: a
--    club-cards object may be written only by the owner of the club whose
--    number names the file. The bucket's own limits stay: PNG, JPEG, WebP or
--    GIF, 2 MB.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. promotions carry no unpaid prize ───────────────────────────────────
DROP TRIGGER IF EXISTS trg_promotion_prize_has_no_payout_path ON public.promotions;
DROP FUNCTION IF EXISTS public.fn_warn_promotion_has_no_payout_path();

DO $pre1$
DECLARE v_rows integer; v_pool numeric; v_entries integer; v_claims integer;
BEGIN
  SELECT count(*), COALESCE(sum(prize_pool), 0) INTO v_rows, v_pool
    FROM public.promotions WHERE COALESCE(prize_pool, 0) <> 0;
  SELECT count(*) INTO v_entries FROM public.promotion_leaderboards;
  SELECT count(*) INTO v_claims FROM public.promotion_claims;
  -- The board read on 2026-10-07: four rows, 9,500 advertised, no entry and
  -- no claim. If anyone has entered or claimed since, stop: that is a
  -- different decision.
  IF v_rows <> 4 OR v_pool <> 9500 OR v_entries <> 0 OR v_claims <> 0 THEN
    RAISE EXCEPTION 'promotions moved since they were read: % rows, % advertised, % entries, % claims',
      v_rows, v_pool, v_entries, v_claims;
  END IF;
END $pre1$;

UPDATE public.promotions
   SET status = CASE WHEN status IN ('active', 'scheduled') THEN 'cancelled' ELSE status END,
       prize_pool = 0,
       updated_at = now()
 WHERE COALESCE(prize_pool, 0) <> 0;

ALTER TABLE public.promotions
  ADD CONSTRAINT promotions_advertise_no_unpaid_prize
  CHECK (COALESCE(prize_pool, 0) = 0);

COMMENT ON CONSTRAINT promotions_advertise_no_unpaid_prize ON public.promotions IS
  'Owner decision 2026-10-07: no promotion type has a payer, so none may advertise prize money. Lift this only in the change that builds the payer. docs/changelog/2026-10-07-five-launch-owner-decisions.md';

-- ── 2. a paid finish of a scheduled event is told ─────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedup_tournament_result
  ON public.notifications (user_id, ((data ->> 'tournament_id')))
  WHERE type = 'tournament_result';

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_tells_the_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_target text;
  v_diamonds boolean;
  v_unit text;
  v_amount text;
  v_place text;
  v_message text;
BEGIN
  IF NEW.user_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT t.name, t.tournament_type, t.club_id, t.satellite_target_id
    INTO v_t FROM public.tournaments t WHERE t.id = NEW.tournament_id;
  -- Spins and Sit and Gos end with their players seated, where the result
  -- card already shows. A scheduled event pays at its end, after most of its
  -- money finishers have left: those are the players who must be told.
  IF NOT FOUND OR upper(COALESCE(v_t.tournament_type, '')) NOT IN ('MTT', 'SATELLITE') THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_diamonds := v_t.club_id IS NOT NULL AND v_t.club_id = public.fn_diamond_arena_club();
    v_unit := CASE WHEN v_diamonds THEN 'Diamonds' ELSE 'Chips' END;
    v_amount := CASE
      WHEN v_diamonds OR NEW.amount = trunc(NEW.amount)
        THEN to_char(trunc(NEW.amount), 'FM999,999,999,990')
      ELSE to_char(NEW.amount, 'FM999,999,999,990.00')
    END;
    v_place := CASE
      WHEN NEW.position IS NULL OR NEW.position < 1 THEN NULL
      WHEN NEW.position % 100 IN (11, 12, 13) THEN NEW.position || 'th'
      WHEN NEW.position % 10 = 1 THEN NEW.position || 'st'
      WHEN NEW.position % 10 = 2 THEN NEW.position || 'nd'
      WHEN NEW.position % 10 = 3 THEN NEW.position || 'rd'
      ELSE NEW.position || 'th'
    END;

    IF NEW.source = 'satellite_seat' THEN
      SELECT t2.name INTO v_target FROM public.tournaments t2 WHERE t2.id = v_t.satellite_target_id;
      v_message := 'You Won A Seat' || COALESCE(' In ' || v_target, '') || '.';
    ELSIF NEW.source = 'satellite_ticket' THEN
      v_message := 'You Won A Tournament Ticket Worth ' || v_amount || ' ' || v_unit || '.';
    ELSIF NEW.source = 'bubble_protection' THEN
      v_message := 'Bubble Protection Paid You ' || v_amount || ' ' || v_unit || '.';
    ELSIF v_place IS NOT NULL THEN
      v_message := 'You Finished ' || v_place || ' And Won ' || v_amount || ' ' || v_unit || '.';
    ELSE
      v_message := 'You Won ' || v_amount || ' ' || v_unit || '.';
    END IF;

    INSERT INTO public.notifications (user_id, type, title, message, data, action_url)
    VALUES (
      NEW.user_id,
      'tournament_result',
      left('Tournament Result: ' || COALESCE(NULLIF(btrim(v_t.name), ''), 'Tournament'), 120),
      v_message,
      jsonb_build_object(
        'tournament_id', NEW.tournament_id,
        'payout_id', NEW.id,
        'position', NEW.position,
        'amount', NEW.amount,
        'unit', lower(v_unit),
        'source', NEW.source),
      '/hub/club-arena/tournaments/' || NEW.tournament_id::text)
    ON CONFLICT (user_id, ((data ->> 'tournament_id'))) WHERE type = 'tournament_result'
    DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- A notice is never the reason a payment fails.
    RAISE WARNING 'tournament result notice not written for payout %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_payout_tells_the_player()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_tournament_payout_tells_the_player ON public.tournament_payouts;
CREATE TRIGGER trg_tournament_payout_tells_the_player
  AFTER INSERT ON public.tournament_payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_tournament_payout_tells_the_player();

-- ── 3. only a club's owner writes its card image ──────────────────────────
CREATE OR REPLACE FUNCTION public.fn_club_card_object_is_callers(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND p_name IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.clubs c
        WHERE c.owner_id = auth.uid()
          AND c.club_id IS NOT NULL
          AND p_name ~ ('^club-cards/' || c.club_id::text || '-card-[A-Za-z0-9._-]+$'));
$function$;

REVOKE ALL ON FUNCTION public.fn_club_card_object_is_callers(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_card_object_is_callers(text) TO authenticated;

DROP POLICY IF EXISTS "club cards authenticated insert" ON storage.objects;
DROP POLICY IF EXISTS "club cards owner update" ON storage.objects;

CREATE POLICY "club cards club owner insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'club-assets'
              AND name LIKE 'club-cards/%'
              AND public.fn_club_card_object_is_callers(name));

CREATE POLICY "club cards club owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'club-assets'
         AND name LIKE 'club-cards/%'
         AND public.fn_club_card_object_is_callers(name))
  WITH CHECK (bucket_id = 'club-assets'
              AND name LIKE 'club-cards/%'
              AND public.fn_club_card_object_is_callers(name));

-- ── every edit landed ─────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.promotions WHERE COALESCE(prize_pool, 0) <> 0)
     OR EXISTS (SELECT 1 FROM public.promotions WHERE status IN ('active', 'scheduled') AND end_date < now()) THEN
    RAISE EXCEPTION 'a promotion still advertises a prize or still reads running after its end';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_promotion_prize_has_no_payout_path') THEN
    RAISE EXCEPTION 'the reporting trigger was not removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.tournament_payouts'::regclass
                    AND tgname = 'trg_tournament_payout_tells_the_player' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'the result notice trigger is not installed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname IN ('club cards authenticated insert', 'club cards owner update')) THEN
    RAISE EXCEPTION 'an open club-card write policy survived';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname IN ('club cards club owner insert', 'club cards club owner update')) <> 2 THEN
    RAISE EXCEPTION 'the owner-only club-card policies are not both installed';
  END IF;
  IF has_function_privilege('anon', 'public.fn_club_card_object_is_callers(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_tournament_payout_tells_the_player()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_payout_tells_the_player()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a definer this file created is reachable by a role that must not reach it';
  END IF;
END $post$;

COMMIT;
