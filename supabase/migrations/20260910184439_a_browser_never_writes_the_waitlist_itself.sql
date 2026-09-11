-- 20260910184439_a_browser_never_writes_the_waitlist_itself
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
-- Lane B follow-up of the 2026-09-09 must-move audit, finding F11
-- (docs/audits/2026-09-09-must-move-audit/lane-B.md, section 8). NOT applied
-- by the lane; probed ROLLED BACK with psql and handed over.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A BROWSER NEVER WRITES THE WAITLIST ITSELF
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG. `table_waitlist` carried the RLS policy `waitlist_user_own`
-- FOR ALL (`user_id = auth.uid()`, role authenticated) with INSERT, UPDATE and
-- DELETE granted to `authenticated` and `anon`. So any signed-in browser could
-- INSERT a row `status = 'notified'` for itself at ANY table with ANY
-- `hold_expires_at`, and every reader on the platform would honour it as a
-- seat hold: the buy-in gate (`SEAT_RESERVED` for everyone else), the
-- open-seat count, the cluster census, the horse fleet's humans-waiting read.
-- A chair blocked for as long as they liked, at no cost, from the browser
-- console. Pre-existing; found while wiring the join door's hold
-- (20260910183043) to the same row.
--
-- WHAT THIS DOES, at the root:
--
--   1. The policy becomes SELECT-only (`waitlist_user_own_read`): a player still
--      reads their own rows. `waitlist_public_queue_read` and
--      `waitlist_admin_read` are untouched.
--   2. INSERT / UPDATE / DELETE (and TRUNCATE, REFERENCES, TRIGGER) are revoked
--      from `authenticated` and `anon`. The grant now says what the policy
--      enforces (the same shape as 20260909181259 part 4). `service_role`
--      keeps everything: the engine and the World Hub API routes write this
--      table as the service and bypass RLS.
--   3. The two browser writes that were legitimate get their own SECURITY
--      DEFINER doors, keyed on auth.uid() and nothing else:
--        fn_table_waitlist_join(p_table_id)  - join a table's line
--        fn_table_waitlist_leave(p_table_id) - leave it
--      (`join_waitlist(p_table_id, p_user_id)` already exists but is invoker-
--      rights, service_role-only and takes a user id; it is left as it is.)
--
-- EVERY CLIENT CALLER OF A DIRECT WRITE, read before restricting anything
-- (grep of src/ and of the World Hub's pages/ and src/):
--
--   LIVE, browser, must move to the new doors (lane G's files, NOT edited here):
--     src/services/WaitlistService.ts:208   .insert({ table_id, user_id, status: 'waiting' })   in joinWaitlist()
--         -> supabase.rpc('fn_table_waitlist_join', { p_table_id: tableId })
--            (returns { ok, already_on_waitlist, entry: { id, table_id, user_id, status, position, created_at, notified_at, hold_expires_at } }
--             or { ok: false, reason: 'already_seated' }; mapRow(entry) keeps the WaitlistEntry shape)
--     src/services/WaitlistService.ts:267   .update({ status: 'left' })   in leaveWaitlist()
--         -> supabase.rpc('fn_table_waitlist_leave', { p_table_id: tableId })   ({ ok, cancelled })
--     src/services/WaitlistService.ts:522   .update({ status: 'left' })   in leave()
--         -> the same fn_table_waitlist_leave call
--     Callers of those three: src/pages/ClubHomePage.tsx:3335 (joinWaitlist),
--     src/pages/ClubHomePage.tsx:3344 (leave), src/pages/WaitlistPage.tsx:156 (leave),
--     src/components/table/TableModalsLayer.tsx:874 (leaveWaitlist) - unchanged,
--     they go through the service.
--   DEAD, browser (component mounted nowhere in src/; would fail if it were):
--     src/components/waitlist/WaitlistManager.tsx:155 insert, :189 delete, :206 delete, :214 delete
--     (:206 and :214 delete OTHER players' rows and were ALREADY refused by the
--      old policy - a host "seating" or "removing" a waitlisted player through
--      that component has silently done nothing; RLS DELETE matches 0 rows.)
--   READ-ONLY, unaffected (SELECT stays):
--     src/components/waitlist/WaitlistManager.tsx:96, src/components/common/GlobalWaitlistListener.tsx:192,
--     src/services/TableService.ts:706, src/services/WaitlistService.ts:177/229/290/311/332/364/402/454/470
--   SERVICE, unaffected (service role key, bypasses RLS):
--     Smarter-Poker-World-Hub/pages/api/club-arena/waitlist.js:60-187 (all eight)
--     Smarter-Poker-World-Hub/pages/api/poker/engine/seat.js (join/leave through the engine controller;
--       its `SUPABASE_SERVICE_ROLE_KEY || NEXT_PUBLIC_SUPABASE_ANON_KEY` fallback would be refused
--       if the service key were ever missing, which is the correct failure)
--     server/src/services/HorseFleetManager.ts, HorseSessionRotator.ts (service_role)
--
-- WHAT THE JOIN DOOR REFUSES, so a queue is never a back door onto a table
-- the offer path would refuse anyway: a tournament table (fn_offer_open_seat
-- refuses those), a closed or deleted table, and a player already seated at
-- that table (the seat trigger would immediately mark the row 'seated').
-- Idempotent: an active row of theirs at that table is returned, not doubled
-- (`table_waitlist_one_active_per_player_uidx` would refuse the double).
--
-- HORSES ARE PLAYERS. Neither door reads `is_horse`; the fleet's own queue
-- handling is unchanged (it writes as service_role and prunes its own
-- 'waiting' rows by design, Dan 2026-09-02). The post-apply assertion refuses
-- either body if it reads the flag.
--
-- ROLLBACK:
--   DROP POLICY waitlist_user_own_read ON public.table_waitlist;
--   CREATE POLICY waitlist_user_own ON public.table_waitlist FOR ALL TO authenticated
--     USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
--   GRANT INSERT, UPDATE, DELETE ON public.table_waitlist TO authenticated, anon;
--   DROP FUNCTION public.fn_table_waitlist_join(uuid), public.fn_table_waitlist_leave(uuid);
--
-- ONE transaction (production DDL policy, CLAUDE.md section 2).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. THE POLICY: read your own rows, write nothing ────────────────────────
DROP POLICY IF EXISTS waitlist_user_own ON public.table_waitlist;
DROP POLICY IF EXISTS waitlist_user_own_read ON public.table_waitlist;
CREATE POLICY waitlist_user_own_read ON public.table_waitlist
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ── 2. THE GRANTS SAY WHAT THE POLICY ENFORCES ──────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.table_waitlist FROM authenticated, anon;
GRANT SELECT ON public.table_waitlist TO authenticated;

-- ── 3. THE TWO DOORS ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_table_waitlist_join(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  t record; w record;
  v_pos integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  SELECT id, tournament_id, status, lifecycle, coalesce(is_deleted, false) AS is_deleted
    INTO t FROM public.tables WHERE id = p_table_id;
  IF NOT FOUND OR t.is_deleted OR t.status IN ('closed', 'deleted') OR t.lifecycle = 'closed' THEN
    RAISE EXCEPTION 'WAITLIST_TABLE_CLOSED: that table is not open' USING ERRCODE = 'check_violation';
  END IF;
  IF t.tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'WAITLIST_TOURNAMENT_TABLE: a tournament table has no waiting list' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = p_table_id AND s.user_id = v_uid AND s.left_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_seated');
  END IF;

  -- Idempotent: a live row of theirs at this table is the answer.
  SELECT * INTO w FROM public.table_waitlist
   WHERE table_id = p_table_id AND user_id = v_uid AND status IN ('waiting', 'notified')
   ORDER BY created_at LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_on_waitlist', true, 'entry', to_jsonb(w));
  END IF;

  -- position is vestigial (order is created_at everywhere that reads this
  -- table) but NOT NULL; the next number in the line, as join_waitlist does.
  SELECT coalesce(max(position), 0) + 1 INTO v_pos FROM public.table_waitlist
   WHERE table_id = p_table_id AND status IN ('waiting', 'notified');
  INSERT INTO public.table_waitlist (table_id, user_id, position, status, created_at)
  VALUES (p_table_id, v_uid, v_pos, 'waiting', now())
  RETURNING * INTO w;
  RETURN jsonb_build_object('ok', true, 'already_on_waitlist', false, 'entry', to_jsonb(w));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_table_waitlist_leave(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_n integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  UPDATE public.table_waitlist SET status = 'left'
   WHERE table_id = p_table_id AND user_id = v_uid AND status IN ('waiting', 'notified');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n);
END;
$function$;

-- A definer states who may call it (2026-09-05).
REVOKE ALL ON FUNCTION public.fn_table_waitlist_join(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_table_waitlist_leave(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_table_waitlist_join(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_table_waitlist_leave(uuid) TO authenticated, service_role;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────
DO $assert$
DECLARE v_join text; v_leave text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.table_waitlist'::regclass AND polname = 'waitlist_user_own') THEN
    RAISE EXCEPTION 'the FOR ALL policy survives';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.table_waitlist'::regclass AND polname = 'waitlist_user_own_read' AND polcmd = 'r') THEN
    RAISE EXCEPTION 'the read-own policy is missing or is not SELECT-only';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.table_waitlist'::regclass AND polcmd <> 'r') > 0 THEN
    RAISE EXCEPTION 'a write policy exists on table_waitlist for a browser role';
  END IF;
  IF has_table_privilege('authenticated', 'public.table_waitlist', 'INSERT')
     OR has_table_privilege('authenticated', 'public.table_waitlist', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.table_waitlist', 'DELETE')
     OR has_table_privilege('anon', 'public.table_waitlist', 'INSERT') THEN
    RAISE EXCEPTION 'a browser role can still write table_waitlist';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.table_waitlist', 'SELECT') THEN
    RAISE EXCEPTION 'the read grant was revoked with the writes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.table_waitlist', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.table_waitlist', 'UPDATE') THEN
    RAISE EXCEPTION 'the service lost its writes';
  END IF;
  v_join := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_table_waitlist_join(uuid)'::regprocedure);
  v_leave := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_table_waitlist_leave(uuid)'::regprocedure);
  IF position('is_horse' in v_join) > 0 OR position('is_horse' in v_leave) > 0 THEN
    RAISE EXCEPTION 'a waitlist door reads is_horse (CLAUDE.md 10.5)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fn_table_waitlist_join(uuid)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.fn_table_waitlist_leave(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'a waitlist door is not SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_table_waitlist_join(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_table_waitlist_leave(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_table_waitlist_join(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the waitlist doors do not state who may call them';
  END IF;
END;
$assert$;

COMMIT;
