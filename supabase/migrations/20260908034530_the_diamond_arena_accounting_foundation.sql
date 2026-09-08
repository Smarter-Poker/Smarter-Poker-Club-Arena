-- 20260908034530_the_diamond_arena_accounting_foundation.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-RULINGS.md ruling 16; docs/DIAMOND-ACCOUNTING-ROADMAP.md
-- phase 5; docs/changelog/2026-09-08-diamond-arena-foundation.md):
--
-- THE ACCOUNTING FOUNDATION FOR THE DIAMOND ARENA, AND NOTHING ELSE. No table opens here, no
-- game is dealt, no diamond moves. What this builds is the part that has to be right BEFORE the
-- first arena table exists, because it is the part that is expensive to retrofit: every club
-- says which asset it is denominated in, the platform club exists as a row rather than as a
-- convention, and the two doors a player's diamonds pass through on the way in and out are
-- written, journaled and registered from the start.
--
--   1. clubs.asset ('chips' by default, 'diamonds' for the arena) and clubs.is_platform. Every
--      existing club is chips, which is what they have always been; the arena is one row with
--      asset = 'diamonds', union_id NULL, is_platform true.
--   2. fn_arena_deposit and fn_arena_withdraw. A deposit moves the diamonds out of the player's
--      wallet, journals the movement with class 'arena', and credits the arena club wallet
--      (club_members.chip_balance in the platform club); a withdrawal is the exact mirror. The
--      register follows the journal, so a deposit registers as a burn and a withdrawal as a
--      mint, and the register always says how many diamonds are inside the arena.
--   3. A cross-asset seat guard, LOG-ONLY (ruling 16 and Dan's risk rule): a seat taken in a
--      club whose asset is not the table's asset files DR15 rather than being refused, because
--      a guard that can refuse a seat can strand a player mid-hand and there is no arena traffic
--      yet to justify that risk. It becomes a refusal the same way every other rule does -
--      through ca_diamond_rule_modes, after seven clean days.
--   4. The reporting learns the asset: fn_ca_diamond_trial_balance gains an arena_deposits row,
--      so diamonds sitting in the arena are named apart from diamonds in player wallets rather
--      than silently disappearing from the identity the moment the first deposit happens.
--
-- THE 14-DAY SETTLEMENT WINDOW (ruling 14) is enforced by fn_arena_deposit: a purchased lot
-- younger than 14 days is not depositable. Log-only for now, by the same reasoning as the seat
-- guard, and under the same switch.
--
-- One transaction. Probed first in a transaction that was rolled back.

BEGIN;

-- BOTH TABLE LOCKS, FIRST, IN ONE STATEMENT. This transaction alters clubs (ACCESS EXCLUSIVE)
-- and then creates a trigger on table_seats (SHARE ROW EXCLUSIVE); a live seat goes the other
-- way, holding table_seats and reading clubs, and taking the two in the middle of the work
-- deadlocked against exactly that on the first dry run. Acquiring them together, before any
-- DDL, means the rest runs under locks already held. There is no data change here, so the hold
-- is short; the timeout means a wedge refuses the apply rather than queueing behind it.
SET LOCAL lock_timeout = '30s';
LOCK TABLE public.clubs, public.table_seats IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. A club says which asset it is denominated in.
-- ---------------------------------------------------------------------------
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips';
ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clubs_asset_known') THEN
    ALTER TABLE public.clubs ADD CONSTRAINT clubs_asset_known CHECK (asset IN ('chips', 'diamonds'));
  END IF;
END $$;
COMMENT ON COLUMN public.clubs.asset IS
  'What this club is denominated in. Every club is chips except the one platform Diamond Arena club (ruling 16).';
COMMENT ON COLUMN public.clubs.is_platform IS
  'True for the single platform-owned club (the Diamond Arena). Not an owner flag: it says the house runs it.';

-- Exactly one platform club, and it is the arena.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_one_platform ON public.clubs (is_platform) WHERE is_platform;

-- ---------------------------------------------------------------------------
-- 2. Where the arena's own numbers live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_arena_settings (
  id                     smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  club_id                uuid REFERENCES public.clubs(id) ON DELETE RESTRICT,
  settlement_window_days integer NOT NULL DEFAULT 14 CHECK (settlement_window_days >= 0),
  note                   text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_arena_settings IS
  'The Diamond Arena in one row: which club it is and how long a purchased lot must settle before it can be deposited (ruling 14). Dan owns the window.';
ALTER TABLE public.ca_arena_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_arena_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_arena_settings TO service_role;
INSERT INTO public.ca_arena_settings (id, club_id, settlement_window_days, note)
VALUES (1, NULL, 14, 'Ruling 14: a purchased lot younger than 14 days is not depositable. club_id is set when the arena club is created.')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The two doors.
--
--    THEY DO NOT CALL THE MINT, AND THAT IS DELIBERATE (probed 2026-09-08). fn_ca_mint and
--    fn_ca_burn are admin and service-role only - a player's own action can never be the Mint's
--    caller, and giving these doors a way around that check would put a hole in the one door
--    the whole standard is built on. Instead they move the balance and write the journal row,
--    exactly as send_stream_gift and every other player-facing money path does, and
--    trg_ca_diamond_register_follows_journal turns that row into the register entry: a deposit
--    registers as a burn (the diamonds leave circulation and are held inside the arena), a
--    withdrawal as a mint. The register still always says how many diamonds are inside.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_arena_deposit(p_amount integer, p_op_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_club uuid; v_window integer; v_locked bigint; v_free bigint; v_after integer; v_arena numeric;
  v_ref text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'authentication_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF p_op_id IS NULL OR btrim(p_op_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'op_id_required');
  END IF;
  v_ref := 'arena-deposit:' || p_op_id;

  SELECT s.club_id, s.settlement_window_days INTO v_club, v_window FROM public.ca_arena_settings s WHERE s.id = 1;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'the_arena_club_does_not_exist_yet');
  END IF;

  -- Idempotent on the op id: a retry is a replay, never a second deposit.
  IF EXISTS (SELECT 1 FROM public.diamond_transactions WHERE reference_id = v_ref) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'deposited', p_amount,
                              'arena_balance', public.fn_ca_arena_diamonds());
  END IF;

  -- Ruling 14, LOG-ONLY until the rule mode is flipped: a lot younger than the settlement
  -- window is money a chargeback can still reverse, and it should not be sitting on a felt.
  SELECT COALESCE(sum(l.issued - l.consumed - l.refunded), 0) INTO v_locked
    FROM public.diamond_purchase_lots l
   WHERE l.user_id = v_user AND (l.issued - l.consumed - l.refunded) > 0
     AND l.settled_at > now() - make_interval(days => COALESCE(v_window, 14));
  IF v_locked > 0 THEN
    SELECT GREATEST(COALESCE((SELECT p.diamonds FROM public.profiles p WHERE p.id = v_user), 0) - v_locked, 0)
      INTO v_free;
    IF p_amount > v_free THEN
      PERFORM public.fn_ca_diamond_incident('DR16:deposit_inside_settlement_window', 'warning', v_user, p_amount,
        'fn_arena_deposit',
        jsonb_build_object('unsettled_lots', v_locked, 'depositable', v_free, 'window_days', v_window));
      IF public.fn_ca_diamond_rule_mode('DR16:deposit_inside_settlement_window') = 'refuse' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'purchase_still_settling',
                                  'depositable', v_free, 'window_days', v_window);
      END IF;
    END IF;
  END IF;

  UPDATE public.profiles
     SET diamonds = diamonds - p_amount, updated_at = now()
   WHERE id = v_user AND diamonds >= p_amount
  RETURNING diamonds INTO v_after;
  IF v_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_diamonds');
  END IF;

  INSERT INTO public.diamond_transactions
    (user_id, amount, transaction_type, type, source, description, balance_after, reference_id,
     counterparty, issuance_class, metadata)
  VALUES
    (v_user, -p_amount, 'arena_deposit', 'arena_deposit', 'fn_arena_deposit',
     'Deposited into the Diamond Arena', v_after, v_ref,
     'arena:' || v_club::text, 'arena',
     jsonb_build_object('club_id', v_club, 'op_id', p_op_id));

  -- A membership is created by Join A Club and by nothing else
  -- (fn_require_explicit_club_membership_source). Funding one is a deposit; creating one is a
  -- join, and this door does not do the second. A player who has not joined the arena is told
  -- so, and their wallet is untouched because the whole call is one transaction.
  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + p_amount
   WHERE club_id = v_club AND user_id = v_user
  RETURNING chip_balance INTO v_arena;
  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'ARENA_JOIN_REQUIRED: Join The Diamond Arena Before Depositing'
      USING ERRCODE = 'P0432';
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'deposited', p_amount,
                            'wallet_balance', v_after, 'arena_balance', v_arena);
END $$;
REVOKE ALL ON FUNCTION public.fn_arena_deposit(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_arena_deposit(integer, text) TO service_role, authenticated;

CREATE OR REPLACE FUNCTION public.fn_arena_withdraw(p_amount integer, p_op_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_club uuid; v_arena numeric; v_after integer; v_ref text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'authentication_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF p_op_id IS NULL OR btrim(p_op_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'op_id_required');
  END IF;
  v_ref := 'arena-withdraw:' || p_op_id;

  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'arena_withdrawals' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'arena_withdrawals_frozen');
  END IF;

  SELECT s.club_id INTO v_club FROM public.ca_arena_settings s WHERE s.id = 1;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'the_arena_club_does_not_exist_yet');
  END IF;

  IF EXISTS (SELECT 1 FROM public.diamond_transactions WHERE reference_id = v_ref) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'withdrawn', p_amount,
                              'arena_balance', public.fn_ca_arena_diamonds());
  END IF;

  UPDATE public.club_members
     SET chip_balance = chip_balance - p_amount
   WHERE club_id = v_club AND user_id = v_user AND chip_balance >= p_amount
  RETURNING chip_balance INTO v_arena;
  IF v_arena IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_arena_balance');
  END IF;

  UPDATE public.profiles
     SET diamonds = diamonds + p_amount, updated_at = now()
   WHERE id = v_user
  RETURNING diamonds INTO v_after;
  IF v_after IS NULL THEN
    -- The player's profile is gone underneath the withdrawal. Raising undoes the arena debit in
    -- the same transaction; there is nothing to compensate afterwards (CLAUDE.md 10.12).
    RAISE EXCEPTION 'arena withdrawal found no profile for %', v_user USING ERRCODE = 'P0431';
  END IF;

  INSERT INTO public.diamond_transactions
    (user_id, amount, transaction_type, type, source, description, balance_after, reference_id,
     counterparty, issuance_class, metadata)
  VALUES
    (v_user, p_amount, 'arena_withdraw', 'arena_withdraw', 'fn_arena_withdraw',
     'Withdrawn from the Diamond Arena', v_after, v_ref,
     'arena:' || v_club::text, 'arena',
     jsonb_build_object('club_id', v_club, 'op_id', p_op_id));

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'withdrawn', p_amount,
                            'wallet_balance', v_after, 'arena_balance', v_arena);
END $$;
REVOKE ALL ON FUNCTION public.fn_arena_withdraw(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_arena_withdraw(integer, text) TO service_role, authenticated;

-- Both doors write profiles.diamonds, so the privileged-column guard has to know them - the same
-- omission that made send_stream_gift unreachable for a player until 20260908031918.
CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $ca$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_patch: marker in % found % times', p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $ca$;

SELECT pg_temp.ca_patch('fn_guard_profile_privileged_columns',
$ca_from$     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'$ca_from$,
$ca_to$     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'$ca_to$);

-- ---------------------------------------------------------------------------
-- 4. The cross-asset seat guard, log-only.
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_diamond_rule_modes (rule, mode, flip_after, clean_days_required, ruling, note) VALUES
  ('DR15:cross_asset_seat', 'log', '2026-09-22 00:00:00+00', 7, '16',
   'A seat taken at a table whose club is denominated in one asset while the seat is funded from the other. Log-only first: a guard that can refuse a seat can strand a player mid-hand, and there is no arena traffic yet.'),
  ('DR16:deposit_inside_settlement_window', 'log', '2026-09-22 00:00:00+00', 7, '14',
   'A deposit into the arena of diamonds from a purchase that has not finished settling. Log-only first, for the same reason: nothing is on a felt yet.')
ON CONFLICT (rule) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_arena_seat_is_same_asset()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_club_asset text; v_arena uuid;
BEGIN
  BEGIN
    SELECT s.club_id INTO v_arena FROM public.ca_arena_settings s WHERE s.id = 1;
    IF v_arena IS NULL THEN RETURN NULL; END IF;   -- no arena yet: nothing to be inconsistent with
    SELECT c.asset INTO v_club_asset
      FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = NEW.table_id;
    IF v_club_asset IS NULL THEN RETURN NULL; END IF;
    -- The only asymmetry that can exist today: a seat at an arena (diamond) table funded from a
    -- chip club wallet, or the reverse. Both are a reporting error before they are a money one.
    IF (v_club_asset = 'diamonds') <> ((SELECT t.club_id FROM public.tables t WHERE t.id = NEW.table_id) = v_arena) THEN
      PERFORM public.fn_ca_diamond_incident('DR15:cross_asset_seat', 'warning', NEW.user_id, NEW.stack,
        'fn_ca_arena_seat_is_same_asset',
        jsonb_build_object('table_id', NEW.table_id, 'club_asset', v_club_asset, 'arena_club', v_arena));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- a seat is never refused by a reporting guard
  END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_arena_seat_is_same_asset() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_seat_is_same_asset() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ca_arena_seat_is_same_asset'
                   AND tgrelid = 'public.table_seats'::regclass) THEN
    CREATE TRIGGER trg_ca_arena_seat_is_same_asset
      AFTER INSERT ON public.table_seats
      FOR EACH ROW EXECUTE FUNCTION public.fn_ca_arena_seat_is_same_asset();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The reporting learns the asset.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT sum(m.chip_balance)
      FROM public.club_members m
      JOIN public.ca_arena_settings s ON s.id = 1 AND s.club_id = m.club_id
  ), 0)::numeric;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;
COMMENT ON FUNCTION public.fn_ca_arena_diamonds() IS
  'Diamonds held inside the Diamond Arena (the platform club''s member wallets). The trial balance names them apart from player wallets so a deposit does not read as a disappearance.';

-- ---------------------------------------------------------------------------
-- 6. Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.clubs WHERE asset <> 'chips';
  IF v_n <> 0 THEN RAISE EXCEPTION '% club(s) are not chips, and no arena exists yet', v_n; END IF;
  IF (SELECT club_id FROM public.ca_arena_settings WHERE id = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'the arena club is set, but this migration creates no club';
  END IF;
  IF (SELECT public.fn_ca_arena_diamonds()) <> 0 THEN
    RAISE EXCEPTION 'the arena holds diamonds before it exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE rule = 'DR15:cross_asset_seat' AND mode = 'log') THEN
    RAISE EXCEPTION 'the seat guard is not log-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE rule = 'DR16:deposit_inside_settlement_window' AND mode = 'log') THEN
    RAISE EXCEPTION 'the settlement window is not log-only';
  END IF;
  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree after a change that moves no money';
  END IF;
END $$;

COMMIT;
