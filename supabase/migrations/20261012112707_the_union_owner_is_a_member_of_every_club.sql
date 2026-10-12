-- 20261012112707_the_union_owner_is_a_member_of_every_club.sql
--
-- THE UNION OWNER IS A MEMBER OF EVERY CLUB THAT JOINS (Dan, 2026-10-12).
-- Full account: docs/changelog/2026-10-12-the-union-owner-is-a-member-of-every-club.md.
--
-- Dan, verbatim: "union owner MUST BE A MEMBER OF EVERY CLUB THAT JOINS."
--
-- Measured on production (kuklfnapbkmacvwxktbh), read-only, 2026-10-12
-- 11:10-11:30 UTC:
--   * 1 union (Midway Union), 2 union_clubs rows (Club JAQK, SHARK CLUB). The
--     union owner already holds an active 'owner' membership in both, so the
--     backfill below is expected to create 0 rows and change 0 rows.
--   * Union owners banned or suspended in any club: 0. Union owners banned in
--     a club of their own union: 0.
--   * No database function inserts or updates union_clubs or unions.owner_id
--     (union_applications and union_leave_requests are read by no function):
--     a club reaches a union only by a union_clubs INSERT (application
--     approval, invitation, direct add, a founding club, a re-join) or a
--     union_clubs UPDATE that reassigns it, all made by the server or staff
--     tools. So the rule lives on union_clubs itself, where every one of those
--     paths has to pass, and on unions.owner_id for a change of owner.
--
-- WHAT THIS DOES, in one transaction, without an engine release:
--   1. public.fn_union_owner_holds_membership(union, club) makes the union's
--      owner an ACTIVE member of the club: nothing if an active membership is
--      already there (an owner, admin or player row is left exactly as it is),
--      a pending, inactive or departed row is activated (role kept, as the
--      ordinary Join A Club rejoin keeps it), and otherwise a new 'player'
--      row with zero chips is inserted - the role every ordinary join gets.
--      An owner who is BANNED in the club refuses the join with
--      UNION_OWNER_BANNED_IN_CLUB, and SUSPENDED with
--      UNION_OWNER_SUSPENDED_IN_CLUB: club discipline is never lifted
--      silently. The union's own club row and a Diamond club are skipped.
--   2. trg_union_owner_joins_every_club (AFTER INSERT OR UPDATE OF union_id,
--      club_id ON union_clubs) calls it for the club that joined, in the same
--      transaction as the join.
--   3. trg_union_new_owner_joins_every_club (AFTER UPDATE OF owner_id ON
--      unions) calls it for every club in the union when the union changes
--      hands. The previous owner's memberships stay as ordinary memberships.
--   4. trg_union_owner_membership_is_kept (BEFORE UPDATE OR DELETE ON
--      club_members) refuses, with UNION_OWNER_MEMBERSHIP_REQUIRED, any
--      change that ends the union owner's active membership in a club that is
--      in the owner's union: removal (departure), ban, suspension, leave,
--      deactivation, delete, or moving the row. Every removal door ends in
--      one of those row changes, so one trigger covers them all
--      (fn_remove_settled_club_member, fn_club_set_member_status,
--      fn_member_leave_to_treasury, a staff tool, a direct write). Once the
--      club leaves the union the membership is ordinary again and nothing is
--      removed automatically. A club or person being deleted (ON DELETE
--      CASCADE) is not refused.
--   5. fn_require_explicit_club_membership_source admits the new source
--      'union_owner_membership' (one counted substitution), and
--      fn_enforce_four_club_limit lets that one source past the personal
--      10-club cap (one counted insertion above the horse exemption): the
--      union rule must not refuse a club's join because its owner already
--      belongs to ten clubs. Both md5-pinned before and after; owner,
--      SECURITY DEFINER, search_path and grants kept.
--   6. Backfill: every club now in a union is given its union owner's active
--      membership (measured 0 missing).
--
-- No money moves. The new row carries zero chips (fn_membership_starts_with_
-- zero_chips also forces that), so no wallet leg, autoledger or tally fires;
-- there is no welcome grant on club_members. The row passes the same audit,
-- member-count, level, management-access and agreement-history triggers an
-- ordinary join passes, once each. A 'player' membership gives no bank,
-- cashier-staff or finance access: ca_can_view_club_finances and
-- is_club_admin require owner/co_owner/admin(/super_agent) roles,
-- fn_club_bank_role answers 'player', and fn_can_create_games already admits
-- the union owner for a union club through the union.
--
-- Hourly break: inserting a zero-chip membership and changing a status are
-- never refused by zz_freeze_guard, and this DDL is refused as a whole inside
-- :50-:03 UTC; if refused, run it once after :03. Replay-safe: the replaced
-- functions are skipped when already at their postimage, the new objects are
-- CREATE OR REPLACE, and the backfill only touches a pair still missing.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_require_explicit_club_membership_source()'::regprocedure)) = 'f694fef84a37560028281eead6f45257')
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_enforce_four_club_limit()'::regprocedure)) = '7c79db5e707510912f4fa3c6f9ff7cb5')
-- @live-proof: (SELECT count(*) = 3 FROM pg_trigger t WHERE t.tgenabled = 'O' AND ((t.tgrelid = 'public.union_clubs'::regclass AND t.tgname = 'trg_union_owner_joins_every_club') OR (t.tgrelid = 'public.unions'::regclass AND t.tgname = 'trg_union_new_owner_joins_every_club') OR (t.tgrelid = 'public.club_members'::regclass AND t.tgname = 'trg_union_owner_membership_is_kept')))
-- @live-proof: (SELECT to_regprocedure('public.fn_union_owner_holds_membership(uuid,uuid)') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc JOIN public.unions u ON u.id = uc.union_id JOIN public.clubs c ON c.id = uc.club_id WHERE uc.club_id <> uc.union_id AND NOT COALESCE(c.is_union, false) AND c.asset IS DISTINCT FROM 'diamonds' AND NOT EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id = uc.club_id AND cm.user_id = u.owner_id AND cm.membership_lifecycle_status = 'active' AND COALESCE(cm.status, 'active') IN ('active', 'approved') AND COALESCE(cm.is_active, true))))

BEGIN;
SET LOCAL lock_timeout = '1500ms';
SET LOCAL statement_timeout = '120s';

-- club_members is written by the engine all the time. Take the three locks
-- first, together, in short bounded attempts, so no writer waits more than
-- one attempt behind this transaction (20261001204429). Everything after it
-- is short.
DO $lock$
DECLARE attempt int;
BEGIN
  FOR attempt IN 1..40 LOOP
    BEGIN
      LOCK TABLE public.unions, public.union_clubs, public.club_members IN SHARE ROW EXCLUSIVE MODE;
      RAISE NOTICE 'union_owner_membership: tables locked on attempt %', attempt;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(0.4);
    END;
  END LOOP;
  RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_LOCK: club_members could not be locked in 40 bounded attempts'
    USING ERRCODE = '55P03';
END
$lock$;

-- 5. The two gates a system-created membership has to pass.
DO $source$
DECLARE
  v_oid oid := 'public.fn_require_explicit_club_membership_source()'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_require_explicit_club_membership_source()'::regprocedure);
  v_meta jsonb;
  v_anchor text := $a$  IF v_source NOT IN ('join_club', 'club_owner_create') THEN
$a$;
  v_new text := $w$  IF v_source NOT IN ('join_club', 'club_owner_create', 'union_owner_membership') THEN
$w$;
  v_n int;
BEGIN
  IF md5(v_def) = 'f694fef84a37560028281eead6f45257' THEN
    RAISE NOTICE 'fn_require_explicit_club_membership_source already admits union_owner_membership; skipping';
    RETURN;
  END IF;
  IF md5(v_def) <> '3c4e9aa515a8b8c8226fdf18332156a3' THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_PREIMAGE_CHANGED: fn_require_explicit_club_membership_source md5 %', md5(v_def)
      USING ERRCODE = '55000';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_ANCHOR: source gate anchor found % time(s)', v_n USING ERRCODE = '55000';
  END IF;
  SELECT to_jsonb(p) - 'prosrc' INTO v_meta FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE replace(v_def, v_anchor, v_new);
  IF md5(pg_get_functiondef(v_oid)) <> 'f694fef84a37560028281eead6f45257' THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_POSTIMAGE: fn_require_explicit_club_membership_source md5 %',
      md5(pg_get_functiondef(v_oid)) USING ERRCODE = '55000';
  END IF;
  IF (SELECT to_jsonb(p) - 'prosrc' FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_meta THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_METADATA: the source gate''s owner, grants or settings moved'
      USING ERRCODE = '55000';
  END IF;
END
$source$;

DO $cap$
DECLARE
  v_oid oid := 'public.fn_enforce_four_club_limit()'::regprocedure;
  v_def text := pg_get_functiondef('public.fn_enforce_four_club_limit()'::regprocedure);
  v_meta jsonb;
  v_anchor text := $a$  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.user_id AND COALESCE(is_horse, false)
  ) THEN
    RETURN NEW;
  END IF;
$a$;
  v_new text := $w$  -- THE UNION OWNER IS A MEMBER OF EVERY CLUB (2026-10-12): the membership
  -- the union rule makes is the platform's, not a club the owner chose, so the
  -- personal club cap does not refuse it (fn_union_owner_holds_membership).
  IF COALESCE(current_setting('app.club_membership_source', true), '') = 'union_owner_membership' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles WHERE id = NEW.user_id AND COALESCE(is_horse, false)
  ) THEN
    RETURN NEW;
  END IF;
$w$;
  v_n int;
BEGIN
  IF md5(v_def) = '7c79db5e707510912f4fa3c6f9ff7cb5' THEN
    RAISE NOTICE 'fn_enforce_four_club_limit already admits union_owner_membership; skipping';
    RETURN;
  END IF;
  IF md5(v_def) <> '6df4cf3478e10b3f108357567c25c98b' THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_PREIMAGE_CHANGED: fn_enforce_four_club_limit md5 %', md5(v_def)
      USING ERRCODE = '55000';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_ANCHOR: club cap anchor found % time(s)', v_n USING ERRCODE = '55000';
  END IF;
  SELECT to_jsonb(p) - 'prosrc' INTO v_meta FROM pg_proc p WHERE p.oid = v_oid;
  EXECUTE replace(v_def, v_anchor, v_new);
  IF md5(pg_get_functiondef(v_oid)) <> '7c79db5e707510912f4fa3c6f9ff7cb5' THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_POSTIMAGE: fn_enforce_four_club_limit md5 %',
      md5(pg_get_functiondef(v_oid)) USING ERRCODE = '55000';
  END IF;
  IF (SELECT to_jsonb(p) - 'prosrc' FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM v_meta THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_METADATA: the club cap''s owner, grants or settings moved'
      USING ERRCODE = '55000';
  END IF;
END
$cap$;

-- Register before CREATE FUNCTION: the production DDL guard also classifies
-- a zero-chip club_members INSERT as a balance writer. No chips move.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_union_owner_holds_membership', 'system',
        'Union join and owner-transfer trigger helper. Creates only a zero-chip player membership or reactivates an existing row without changing its balance. Locks the membership lane and row; refuses active bans or suspensions; grants no staff or finance rights.')
ON CONFLICT (proname) DO NOTHING;

-- 1. The one door that makes the union owner a member of one club.
CREATE OR REPLACE FUNCTION public.fn_union_owner_holds_membership(p_union_id uuid, p_club_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_is_union boolean;
  v_asset text;
  v_row public.club_members%ROWTYPE;
  v_exists boolean;
  v_prev_source text := COALESCE(current_setting('app.club_membership_source', true), '');
  v_prev_lifecycle text := COALESCE(current_setting('app.club_membership_lifecycle_write', true), '');
  v_result text;
BEGIN
  SELECT u.owner_id INTO v_owner FROM public.unions u WHERE u.id = p_union_id;
  IF v_owner IS NULL THEN
    RETURN 'no_owner';
  END IF;

  SELECT COALESCE(c.is_union, false), c.asset INTO v_is_union, v_asset
    FROM public.clubs c WHERE c.id = p_club_id;
  IF NOT FOUND OR v_is_union OR p_club_id = p_union_id OR v_asset = 'diamonds' THEN
    RETURN 'not_a_member_club';
  END IF;

  -- The cap's own lock, then the row: the same order as Join A Club.
  PERFORM public.fn_club_membership_lock(v_owner);
  SELECT * INTO v_row FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_owner
   FOR UPDATE;
  v_exists := FOUND;

  IF v_exists THEN
    IF v_row.membership_lifecycle_status = 'active'
       AND COALESCE(v_row.status, 'active') IN ('active', 'approved')
       AND COALESCE(v_row.is_active, true) THEN
      RETURN 'kept';
    END IF;
    IF v_row.membership_lifecycle_status = 'active' AND v_row.status = 'banned' THEN
      RAISE EXCEPTION 'UNION_OWNER_BANNED_IN_CLUB: The Union Owner Is Banned In This Club, So It Cannot Join The Union'
        USING ERRCODE = 'check_violation',
              HINT = 'The club unbans the union owner first; a ban is never lifted silently.';
    END IF;
    IF v_row.membership_lifecycle_status = 'active' AND v_row.status = 'suspended' THEN
      RAISE EXCEPTION 'UNION_OWNER_SUSPENDED_IN_CLUB: The Union Owner Is Suspended In This Club, So It Cannot Join The Union'
        USING ERRCODE = 'check_violation',
              HINT = 'The club reinstates the union owner first; a suspension is never lifted silently.';
    END IF;
  END IF;

  PERFORM set_config('app.club_membership_source', 'union_owner_membership', true);
  PERFORM set_config('app.club_membership_lifecycle_write', 'rejoin', true);
  BEGIN
    IF v_exists THEN
      -- Pending, inactive or departed: activated, role kept, exactly as the
      -- ordinary rejoin (fn_join_club) keeps it.
      UPDATE public.club_members cm
         SET membership_lifecycle_status = 'active',
             status = 'active',
             is_active = true,
             departed_at = NULL,
             departed_by = NULL,
             departure_reason = NULL,
             updated_at = clock_timestamp()
       WHERE cm.club_id = p_club_id
         AND cm.user_id = v_owner;
      v_result := 'activated';
    ELSE
      INSERT INTO public.club_members (club_id, user_id, role, status, is_active, chip_balance)
      VALUES (p_club_id, v_owner, 'player', 'active', true, 0);
      v_result := 'inserted';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_prev_source, true);
    PERFORM set_config('app.club_membership_lifecycle_write', v_prev_lifecycle, true);
    RAISE;
  END;
  PERFORM set_config('app.club_membership_source', v_prev_source, true);
  PERFORM set_config('app.club_membership_lifecycle_write', v_prev_lifecycle, true);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_owner_holds_membership(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_owner_holds_membership(uuid, uuid) TO service_role;

-- 2. A club joins: its union's owner joins it, in the same transaction.
CREATE OR REPLACE FUNCTION public.fn_union_clubs_owner_joins_the_club()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.union_id, NEW.club_id) IS NOT DISTINCT FROM (OLD.union_id, OLD.club_id) THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_union_owner_holds_membership(NEW.union_id, NEW.club_id);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_clubs_owner_joins_the_club() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_union_owner_joins_every_club
  AFTER INSERT OR UPDATE OF union_id, club_id ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_clubs_owner_joins_the_club();

-- 3. A union changes hands: the new owner joins every club in it.
CREATE OR REPLACE FUNCTION public.fn_unions_new_owner_joins_every_club()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT uc.club_id FROM public.union_clubs uc
            WHERE uc.union_id = NEW.id ORDER BY uc.club_id LOOP
    PERFORM public.fn_union_owner_holds_membership(NEW.id, r.club_id);
  END LOOP;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_unions_new_owner_joins_every_club() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_union_new_owner_joins_every_club
  AFTER UPDATE OF owner_id ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_unions_new_owner_joins_every_club();

-- 4. While the club is in the union, the owner's membership stays.
CREATE OR REPLACE FUNCTION public.fn_union_owner_membership_is_kept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only a change that ends or moves an ACTIVE membership matters; a role
    -- change, a balance or a reactivation is not a removal.
    IF NOT (OLD.membership_lifecycle_status = 'active'
            AND COALESCE(OLD.status, 'active') IN ('active', 'approved')
            AND COALESCE(OLD.is_active, true)) THEN
      RETURN NEW;
    END IF;
    IF NEW.club_id = OLD.club_id AND NEW.user_id = OLD.user_id
       AND NEW.membership_lifecycle_status = 'active'
       AND COALESCE(NEW.status, 'active') IN ('active', 'approved')
       AND COALESCE(NEW.is_active, true) THEN
      RETURN NEW;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = OLD.club_id)
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.user_id) THEN
    -- The club or the person itself is being deleted (ON DELETE CASCADE).
    RETURN OLD;
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_clubs uc
               JOIN public.unions u ON u.id = uc.union_id
              WHERE uc.club_id = OLD.club_id
                AND u.owner_id = OLD.user_id) THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_REQUIRED: The Union Owner Must Stay A Member Of Every Club In The Union'
      USING ERRCODE = 'check_violation',
            HINT = 'Take the club out of the union, or transfer the union, before this membership can end.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_owner_membership_is_kept() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_union_owner_membership_is_kept
  BEFORE UPDATE OR DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_union_owner_membership_is_kept();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('club_members', 'trg_union_owner_membership_is_kept',
        'The union owner is a member of every club (20261012112707): refuses ending the union owner''s active membership in a club of their union; reads no money column and writes nothing')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

-- 6. Backfill: every club now in a union holds its union owner.
DO $backfill$
DECLARE
  r record;
  v_missing int;
  v_inserted int := 0;
  v_activated int := 0;
  v_kept int := 0;
  v_result text;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.union_clubs uc
    JOIN public.unions u ON u.id = uc.union_id
    JOIN public.clubs c ON c.id = uc.club_id
   WHERE uc.club_id <> uc.union_id
     AND NOT COALESCE(c.is_union, false)
     AND c.asset IS DISTINCT FROM 'diamonds'
     AND NOT EXISTS (SELECT 1 FROM public.club_members cm
                      WHERE cm.club_id = uc.club_id AND cm.user_id = u.owner_id
                        AND cm.membership_lifecycle_status = 'active'
                        AND COALESCE(cm.status, 'active') IN ('active', 'approved')
                        AND COALESCE(cm.is_active, true));

  FOR r IN SELECT uc.union_id, uc.club_id FROM public.union_clubs uc
            ORDER BY uc.union_id, uc.club_id LOOP
    v_result := public.fn_union_owner_holds_membership(r.union_id, r.club_id);
    IF v_result = 'inserted' THEN v_inserted := v_inserted + 1;
    ELSIF v_result = 'activated' THEN v_activated := v_activated + 1;
    ELSIF v_result = 'kept' THEN v_kept := v_kept + 1;
    END IF;
  END LOOP;

  IF v_inserted + v_activated <> v_missing THEN
    RAISE EXCEPTION 'UNION_OWNER_MEMBERSHIP_BACKFILL: % missing but % inserted and % activated',
      v_missing, v_inserted, v_activated USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'union_owner_membership: backfill inserted %, activated %, already members %',
    v_inserted, v_activated, v_kept;
END
$backfill$;

COMMIT;
