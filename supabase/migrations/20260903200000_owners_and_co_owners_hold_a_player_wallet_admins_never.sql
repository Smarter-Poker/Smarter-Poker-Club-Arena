-- 20260903200000_owners_and_co_owners_hold_a_player_wallet_admins_never.sql
-- Dan 2026-09-03: "All club owners and co owners should have a player wallet.
-- add player wallets now to all those roles for clubs only, not for unions.
-- admin's should never have a player wallet. add this in for all current
-- clubs, and new clubs that haven't been created yet."
--
-- WHAT A PLAYER WALLET IS. It is club_members.chip_balance on the member's
-- own membership row in that club (WalletService.ts: PLAYER =
-- club_members.chip_balance). There is no separate row to create. Owning a
-- player wallet therefore means: an ACTIVE membership row exists for that
-- user in that club, and the role is one that is allowed to hold chips there.
--
-- WHAT ALREADY EXISTED (2026-09-02, #2719): the wallet panel shows the Player
-- Wallet row to every role except admin (walletRows.ts), fn_club_bank_send
-- refuses a player-wallet credit to an admin, and fn_create_club_atomic gives
-- the creator an owner membership row. Measured today: every club owner has
-- an active membership row, there are no co-owners or admins yet, and no
-- admin row holds chips.
--
-- WHAT WAS MISSING - the rule lived in two functions and one TS file, not in
-- the data. This migration puts it in the table itself so every present and
-- future club obeys it whatever path the chips take:
--
--   1. fn_has_player_wallet(club, user): the one predicate. Active membership,
--      role <> 'admin', club is not a union's house row.
--   2. An owner ALWAYS has a membership row. AFTER INSERT OR UPDATE OF owner_id
--      on clubs (non-union) upserts the owner's row as role 'owner', status
--      'active', chips 0. Covers creation paths that skip fn_create_club_atomic
--      and ownership transfers. A player wallet starts at 0 and only ever fills
--      by the owner's own sends (20260901004500: opening chips belong to the
--      Club Bank, never the owner wallet).
--   3. An admin NEVER holds chips. BEFORE UPDATE on club_members (non-union
--      club): a role change TO admin is refused while the member holds chips,
--      locked chips, held chips or promo in that club ("cash out first"), and
--      any write that would leave an admin row with a positive chip_balance is
--      refused. Every money RPC hits this, not just the one that remembered.
--   4. Backfill every club, assert zero drift.
--
-- Unions untouched: the guards return early for clubs with is_union = true,
-- and union_wallets / union_members are not read or written.

BEGIN;

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

-- ── 2. every club owner has a membership row ──────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_club_owner_has_a_player_wallet()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) THEN RETURN NULL; END IF;
  -- A constraint trigger cannot say UPDATE OF owner_id, so say it here: every
  -- member change updates clubs (fn_apply_club_ladder), and none of those
  -- updates can affect who the owner is.
  IF TG_OP = 'UPDATE' AND OLD.owner_id IS NOT DISTINCT FROM NEW.owner_id THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_members cm
              WHERE cm.club_id = NEW.id AND cm.user_id = NEW.owner_id) THEN
    -- Row exists: make sure it is live and carries owner authority.
    UPDATE public.club_members
       SET status = CASE WHEN COALESCE(status, 'active') IN ('active', 'approved') THEN status ELSE 'active' END,
           role   = CASE WHEN role IN ('owner', 'co_owner') THEN role ELSE 'owner' END,
           updated_at = now()
     WHERE club_id = NEW.id AND user_id = NEW.owner_id
       AND (COALESCE(status, 'active') NOT IN ('active', 'approved') OR role NOT IN ('owner', 'co_owner'));
    RETURN NULL;
  END IF;

  -- No row: create the owner's membership (and with it the player wallet, at 0).
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

-- DEFERRED, and that is the whole point. fn_create_club_atomic_membership_impl
-- inserts the owner's membership row with a BARE INSERT, no ON CONFLICT. An
-- immediate AFTER INSERT trigger here would create that row first and the
-- creator's own INSERT would then fail on the unique key - club creation would
-- break for everybody. Deferred to commit, this sees the row the creator
-- already made and does nothing; it only acts when no path made one.
-- Created only if absent, never DROP + CREATE: DROP TRIGGER takes ACCESS
-- EXCLUSIVE on clubs and deadlocked against live traffic on the first apply,
-- while plain CREATE takes SHARE ROW EXCLUSIVE and lets readers through.
-- (CREATE OR REPLACE is not supported for a CONSTRAINT trigger, hence the
-- existence check rather than the one-liner.)
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

-- ── 3. an admin never holds chips in a player wallet ──────────────────────

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

  -- Becoming an admin while holding a playing balance: cash out first.
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

  -- Any credit that would leave an admin holding a playing balance.
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

-- ── 4. backfill + prove ───────────────────────────────────────────────────

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

COMMIT;
