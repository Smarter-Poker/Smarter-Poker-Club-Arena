-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904081210; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904081210   (the stamp IS the apply time, UTC: 2026-09-04 08:12:10)
--   name        owners_and_co_owners_hold_a_player_wallet_admins_never
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 7070 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904081210 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        trg_admin_holds_no_player_wallet
--     FUNCTION       public.fn_has_player_wallet, public.fn_club_owner_has_a_player_wallet, public.fn_admin_holds_no_player_wallet
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

SET LOCAL lock_timeout = '20s';

CREATE OR REPLACE FUNCTION public.fn_has_player_wallet(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.club_members cm
      JOIN public.clubs c ON c.id = cm.club_id
     WHERE cm.club_id = p_club_id
       AND cm.user_id = p_user_id
       AND COALESCE(cm.status, 'active') IN ('active', 'approved')
       AND COALESCE(cm.role, 'player') <> 'admin'
       AND NOT COALESCE(c.is_union, false)
  );
$function$;

REVOKE ALL ON FUNCTION public.fn_has_player_wallet(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_has_player_wallet(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_has_player_wallet(uuid, uuid) IS
  'Dan 2026-09-03: owners, co-owners, agents and players hold a player wallet (club_members.chip_balance) in a club; admins never do; unions have no player wallets.';

CREATE OR REPLACE FUNCTION public.fn_club_owner_has_a_player_wallet()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.owner_id IS NOT DISTINCT FROM NEW.owner_id THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_members cm
              WHERE cm.club_id = NEW.id AND cm.user_id = NEW.owner_id) THEN
    UPDATE public.club_members
       SET status = CASE WHEN COALESCE(status, 'active') IN ('active', 'approved') THEN status ELSE 'active' END,
           role   = CASE WHEN role IN ('owner', 'co_owner') THEN role ELSE 'owner' END,
           updated_at = now()
     WHERE club_id = NEW.id AND user_id = NEW.owner_id
       AND (COALESCE(status, 'active') NOT IN ('active', 'approved') OR role NOT IN ('owner', 'co_owner'));
    RETURN NULL;
  END IF;

  PERFORM set_config('app.club_membership_source', 'club_owner_create', true);
  PERFORM set_config('app.club_role_change', 'on', true);
  BEGIN
    INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance)
    VALUES (NEW.id, NEW.owner_id, 'owner', 'active', 0)
    ON CONFLICT (club_id, user_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous, true);
    RAISE;
  END;
  PERFORM set_config('app.club_membership_source', v_previous, true);
  RETURN NULL;
END;
$function$;

DO $trg$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.clubs'::regclass
       AND tgname = 'trg_club_owner_has_a_player_wallet'
  ) THEN
    EXECUTE 'CREATE CONSTRAINT TRIGGER trg_club_owner_has_a_player_wallet'
            ' AFTER INSERT OR UPDATE ON public.clubs'
            ' DEFERRABLE INITIALLY DEFERRED'
            ' FOR EACH ROW EXECUTE FUNCTION public.fn_club_owner_has_a_player_wallet()';
  END IF;
END;
$trg$;

CREATE OR REPLACE FUNCTION public.fn_admin_holds_no_player_wallet()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_is_union boolean;
BEGIN
  IF COALESCE(NEW.role, 'player') <> 'admin' THEN RETURN NEW; END IF;

  SELECT COALESCE(c.is_union, false) INTO v_is_union FROM public.clubs c WHERE c.id = NEW.club_id;
  IF COALESCE(v_is_union, false) THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role
     AND (COALESCE(NEW.chip_balance, 0) <> 0
          OR COALESCE(NEW.locked_chips, 0) <> 0
          OR COALESCE(NEW.held_chips, 0) <> 0
          OR COALESCE(NEW.promo_balance, 0) <> 0) THEN
    RAISE EXCEPTION 'Cash Out The Player Wallet Before Making This Member An Admin'
      USING ERRCODE = 'check_violation',
            DETAIL = format('chip_balance %s, locked %s, held %s, promo %s',
                            COALESCE(NEW.chip_balance, 0), COALESCE(NEW.locked_chips, 0),
                            COALESCE(NEW.held_chips, 0), COALESCE(NEW.promo_balance, 0));
  END IF;

  IF COALESCE(NEW.chip_balance, 0) > 0
     AND (TG_OP = 'INSERT' OR COALESCE(NEW.chip_balance, 0) > COALESCE(OLD.chip_balance, 0)) THEN
    RAISE EXCEPTION 'An Admin Does Not Hold A Player Wallet'
      USING ERRCODE = 'check_violation',
            HINT = 'Send To The Agent Wallet Or The Club Bank Instead.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_admin_holds_no_player_wallet
  BEFORE INSERT OR UPDATE OF role, chip_balance ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_admin_holds_no_player_wallet();

DO $backfill$
DECLARE r record; v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  PERFORM set_config('app.club_membership_source', 'club_owner_create', true);
  PERFORM set_config('app.club_role_change', 'on', true);
  FOR r IN
    SELECT c.id, c.owner_id
      FROM public.clubs c
     WHERE c.owner_id IS NOT NULL AND NOT COALESCE(c.is_union, false)
       AND NOT EXISTS (SELECT 1 FROM public.club_members cm
                        WHERE cm.club_id = c.id AND cm.user_id = c.owner_id)
  LOOP
    INSERT INTO public.club_members (club_id, user_id, role, status, chip_balance)
    VALUES (r.id, r.owner_id, 'owner', 'active', 0)
    ON CONFLICT (club_id, user_id) DO NOTHING;
  END LOOP;
  UPDATE public.club_members cm
     SET status = 'active', updated_at = now()
    FROM public.clubs c
   WHERE c.id = cm.club_id AND c.owner_id = cm.user_id
     AND NOT COALESCE(c.is_union, false)
     AND COALESCE(cm.status, 'active') NOT IN ('active', 'approved');
  PERFORM set_config('app.club_membership_source', v_previous, true);
END;
$backfill$;

DO $assert$
DECLARE v_owners_without bigint; v_admins_with_chips bigint;
BEGIN
  SELECT count(*) INTO v_owners_without
    FROM public.clubs c
   WHERE c.owner_id IS NOT NULL AND NOT COALESCE(c.is_union, false)
     AND NOT public.fn_has_player_wallet(c.id, c.owner_id);

  SELECT count(*) INTO v_admins_with_chips
    FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
   WHERE NOT COALESCE(c.is_union, false) AND cm.role = 'admin'
     AND COALESCE(cm.chip_balance, 0) <> 0;

  RAISE NOTICE 'owners without a player wallet=% admins holding chips=%',
    v_owners_without, v_admins_with_chips;

  IF v_owners_without <> 0 THEN
    RAISE EXCEPTION '% club owners still have no player wallet', v_owners_without;
  END IF;
  IF v_admins_with_chips <> 0 THEN
    RAISE EXCEPTION '% admins still hold chips in a player wallet', v_admins_with_chips;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.clubs'::regclass
                  AND tgname = 'trg_club_owner_has_a_player_wallet' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.club_members'::regclass
                  AND tgname = 'trg_admin_holds_no_player_wallet' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'player wallet guards are not attached';
  END IF;
END;
$assert$;
