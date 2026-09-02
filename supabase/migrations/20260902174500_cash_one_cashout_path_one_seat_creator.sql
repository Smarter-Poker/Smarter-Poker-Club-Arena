-- ═══════════════════════════════════════════════════════════════════════════════
--  CASH: ONE CASH-OUT PATH, ONE SEAT CREATOR, A REBUY THAT CANNOT BE ERASED
--  Lane D of the Chip Accounting Standard swarm (docs/CHIP-ACCOUNTING-STANDARD.md
--  section 2.3, defects C1 C2 C3 C5). 2026-09-02.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Every function replaced here was read from pg_proc.prosrc on 2026-09-02
-- ~17:15 UTC before it was rewritten; the md5 of the live body it replaces is
-- recorded beside each one so a reviewer can see exactly which production body
-- this migration assumed. Behaviour not named below is carried over unchanged.
--
-- C3  atomic_table_rebuy no longer touches table_seats.stack. It debits the
--     wallet and writes a table_pending_addons row (kind = 'rebuy') in the same
--     transaction, exactly as the mid-hand add-on does. The engine resolves the
--     row through resolve_pending_addon (unchanged, mirrored in the companion
--     migration) and mirrors the result into memory BEFORE it next persists
--     stacks absolutely, so a rebuy that lands between loadSeatedPlayers and
--     the next syncStacks can no longer be overwritten while the wallet stays
--     debited. The five-second bust pause is untouched; the engine now counts
--     a pending row as "the player answered".
--       md5(prosrc) replaced: cc19dc421df16f31e539920aa654b02e
--
-- C1  atomic_table_cashout becomes a thin wrapper over atomic_seat_cashout_locked
--     (keyed per seat occupancy, the function the engine already uses), so the
--     keyed path is the ONLY cash-out path. EXECUTE was already revoked from
--     authenticated/anon on 2026-08-26; the two dead browser callers are removed
--     from src/ in the same PR.
--       md5(prosrc) replaced: b1ef7d3e582882a24517ff7cea64c423
--     atomic_table_withdraw gains an idempotency key. It passed NULL to
--     atomic_credit_wallet_and_log, so a retry of a committed-but-unacknowledged
--     call credited twice. The engine now supplies a key it mints once per
--     invocation and retries under; when a caller passes none the key is derived
--     as withdraw:<seat id>:<joined_at>:<amount>. The key is checked BEFORE the
--     stack is reduced, so a replay touches nothing and returns the balance.
--     Adding the parameter is an overload change (Tier 3): the four-argument
--     signature is dropped so PostgREST cannot see two candidates.
--       md5(prosrc) replaced: be9a68780ec6e406d8524a7aacf7806f
--
-- C2  A BEFORE INSERT OR UPDATE OF left_at trigger on table_seats refuses to
--     create (or resurrect) a seat with a positive stack unless the caller is
--     the engine (service_role, or no JWT at all - see fn_caller_is_engine) or a
--     sanctioned money RPC has declared itself via the app.money_path GUC. The
--     sanctioned RPCs are patched in place - one PERFORM set_config(...) line
--     after their first BEGIN - with an md5 guard so the patch refuses to run
--     on a body that differs from the one it was written against.
--     seat_horse(uuid,uuid,integer,numeric) - a seat creator that took its stack
--     from a parameter and debited nobody, zero callers in either repo, no cron,
--     no pg_proc reference - is dropped. Its body is in the ROLLBACK section.
--
-- C5  player_leave_table now delegates to atomic_seat_cashout_locked (one
--     cash-out function; its tournament short-circuit is preserved there) and
--     declares the ledger before the credit through fn_ca_declare_ledger, so a
--     cron eviction lands in chip_ledger as table_cashout / table_stack rather
--     than as an anonymous adjustment (565 such rows in the trailing 24h).
--     fn_cashout_seats_for_closing_table does the same per seat and keeps its
--     "no resolvable wallet means STOP, not release" rule.
--       md5(prosrc) replaced: 0738357084014ba3a8c6278d092c8359 (player_leave_table)
--       md5(prosrc) replaced: 417958fdbdf91547e4ded461e76562c3 (fn_cashout_seats_for_closing_table)
--
-- The category is 'table_cashout', not 'cashout': it is what every engine
-- cash-out already writes through atomic_credit_wallet_and_log (1,865 rows in
-- 24h), and splitting the same movement across two categories would make the
-- trial balance lie in a new way.
--
-- ONE TRANSACTION, ONE TABLE LOCK. Every DDL statement below fires
-- pgrst_ddl_watch; inside one transaction Postgres coalesces the reloads
-- (CLAUDE.md section 2). Applied once.
--
-- WHY THE table_seats TRIGGER IS NOT IN THIS FILE. The first rolled-back dry
-- run of this migration (2026-09-02 17:39 UTC) hit `deadlock detected` on the
-- CREATE TRIGGER: this transaction held AccessExclusiveLock on
-- table_pending_addons (the ALTER above) and waited for the same lock on
-- table_seats, while a live engine statement held table_seats and waited on
-- table_pending_addons - resolve_pending_addon locks the pending row and then
-- the seat, hundreds of times a minute. Two hot tables under exclusive lock in
-- one transaction is a deadlock waiting for a hand to end. So this file takes
-- exactly one table lock (table_pending_addons, first, while it holds nothing
-- else), and the trigger takes its own lock alone in
-- 20260902174600_the_seat_guard_takes_its_lock_alone.sql. lock_timeout bounds
-- the wait so a queued exclusive lock can never stall the fleet behind it.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 0a. The one table lock, taken first while this transaction holds nothing else.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.table_pending_addons
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'addon';

-- ─────────────────────────────────────────────────────────────────────────────
-- 0b. Pre-flight: the bodies this migration patches in place must be the ones
--     it was written against. A mismatch aborts BEFORE anything else is changed.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  v_expect jsonb := jsonb_build_object(
    'atomic_table_buyin',               '56b34e8bed8b27f00caade7fb749525a',
    'fn_take_seat_and_buy_in',          '5d1cc3ec7161498137b007bd3861a14a',
    'fn_seat_horse_in_seat_first_game', 'f73ecc9de8db8a2545857bc33f379e9b',
    'fn_seat_late_registrant',          '5a11b790a46311a149a275eb32e94da2',
    'fn_horse_seat_from_treasury',      '36d2eeb31599aadaaf1fae21c53d618c'
  );
  v_live text;
BEGIN
  FOR r IN SELECT key AS fn, value #>> '{}' AS md5 FROM jsonb_each(v_expect) LOOP
    SELECT md5(p.prosrc) INTO v_live
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;
    IF v_live IS NULL THEN
      RAISE EXCEPTION 'pre-flight: % is not in production', r.fn;
    END IF;
    -- Already patched (a re-run) is fine; a DIFFERENT body is not.
    IF v_live <> r.md5 AND NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = r.fn
            AND p.prosrc ~ 'app\.money_path') THEN
      RAISE EXCEPTION 'pre-flight: % body md5 % differs from the % this migration was written against - re-read prosrc and re-derive the patch',
        r.fn, v_live, r.md5;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. C3 - a rebuy is a pending add-on of kind 'rebuy'
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.table_pending_addons'::regclass
                    AND conname = 'table_pending_addons_kind_check') THEN
    ALTER TABLE public.table_pending_addons
      ADD CONSTRAINT table_pending_addons_kind_check CHECK (kind IN ('addon', 'rebuy'));
  END IF;
END $$;

COMMENT ON COLUMN public.table_pending_addons.kind IS
  'addon = mid-hand top-up (atomic_table_addon, apply_to_seat=false); rebuy = bust rebuy (atomic_table_rebuy). Both are debited at insert and delivered to the seat only by resolve_pending_addon, so an absolute stack write from engine memory can never erase them.';

CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(
  p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
  v_seat_id uuid; v_pending uuid;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player';
  END IF;

  PERFORM set_config('app.money_path', 'atomic_table_rebuy', true);
  PERFORM set_config('app.ledger_category', 'rebuy', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
    VALUES (p_idempotency_key, p_user_id, 'atomic_table_rebuy', p_amount) ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RETURN (SELECT chip_balance FROM club_members WHERE user_id = p_user_id AND club_id = (SELECT club_id FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL LIMIT 1)); END IF;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  /* ZERO-DRIFT (2026-08-31): lock the seat so it cannot vacate between this
     check and the debit below. */
  SELECT ts.id, ts.club_id INTO v_seat_id, v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id WHERE t.id = p_table_id LIMIT 1;
  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this rebuy';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
  END IF;

  /* CHIP STANDARD C3 (2026-09-02): the chips do NOT go onto the seat here.
     This used to be a relative `stack + p_amount` UPDATE on table_seats,
     racing the engine's absolute writes: a rebuy committing after
     loadSeatedPlayers and before the next syncStacks was erased from the felt
     while the wallet stayed debited. The debit and this row land in ONE
     transaction; the engine's resolve_pending_addon delivers the chips into its
     own memory first and only then persists, so nothing can overwrite them. */
  INSERT INTO public.table_pending_addons (table_id, user_id, amount, kind)
  VALUES (p_table_id, p_user_id, p_amount, 'rebuy')
  RETURNING id INTO v_pending;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. C1 - atomic_table_cashout is a wrapper; atomic_table_withdraw is keyed
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_table_cashout(
  p_user_id uuid, p_table_id uuid, p_seat_number integer DEFAULT NULL::integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_res jsonb;
BEGIN
  /* CHIP STANDARD C1 (2026-09-02): one cash-out path. This function used to
     carry its own unkeyed copy of the credit (a direct club_members write plus
     its own wallet_transactions row), so a retry of a committed-but-unacknowledged call
     credited twice. atomic_seat_cashout_locked keys the credit per seat
     occupancy (cashout:<seat id>:<joined_at>), locks the seat, closes it, and
     treats a tournament stack as play chips (no credit) - the same three
     rules this body had, minus the second copy of the money. The caller
     guard stays here so the error text is unchanged for callers. */
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot cash out for another user';
  END IF;

  PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);

  v_res := public.atomic_seat_cashout_locked(p_user_id, p_table_id, p_seat_number);

  IF COALESCE(v_res->>'reason', '') = 'no_active_seat' THEN
    RAISE EXCEPTION 'Active seat not found for cash-out';
  END IF;

  RETURN COALESCE((v_res->>'stack')::numeric, 0);
END;
$function$;

-- Tier 3: overload change. The 4-argument signature is dropped so the
-- 5-argument one (last parameter defaulted) is the only candidate PostgREST
-- can resolve for the engine's existing named-argument call.
DROP FUNCTION IF EXISTS public.atomic_table_withdraw(uuid, uuid, numeric, boolean);

CREATE FUNCTION public.atomic_table_withdraw(
  p_user_id uuid, p_table_id uuid, p_amount numeric, p_apply_to_seat boolean DEFAULT true,
  p_idempotency_key text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_new_balance numeric;
  v_seat record;
  v_club_id uuid;
  v_key text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Withdraw amount must be positive';
  END IF;

  PERFORM set_config('app.money_path', 'atomic_table_withdraw', true);

  SELECT id, stack, joined_at, club_id INTO v_seat FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table';
  END IF;

  /* CHIP STANDARD C1 (2026-09-02): keyed, and the key is checked BEFORE the
     stack moves. The engine mints one key per invocation and retries under it;
     a caller that passes none gets a key derived from the seat occupancy and
     the amount, which de-duplicates a straight retry but ALSO collapses two
     genuine same-amount withdraws in one sitting - so pass a key. */
  v_key := COALESCE(
    NULLIF(btrim(p_idempotency_key), ''),
    'withdraw:' || v_seat.id || ':' || btrim(to_json(v_seat.joined_at)::text, '"')
      || ':' || p_amount::text);

  v_club_id := v_seat.club_id;
  IF v_club_id IS NULL THEN
    v_club_id := public.fn_player_home_club(p_user_id, NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = v_key) THEN
    -- Replay: the earlier call committed. Nothing moves; report the balance.
    IF v_club_id IS NOT NULL THEN
      SELECT COALESCE(chip_balance, 0) INTO v_new_balance
        FROM club_members WHERE user_id = p_user_id AND club_id = v_club_id;
    END IF;
    RETURN COALESCE(v_new_balance, 0);
  END IF;

  -- Reject over-withdraw: cannot cash out more than the seated stack.
  IF p_amount > COALESCE(v_seat.stack, 0) THEN
    RAISE EXCEPTION 'Withdraw exceeds seated stack';
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats
       SET stack = stack - p_amount
     WHERE id = v_seat.id AND left_at IS NULL;
  END IF;

  -- DEAD POOL FIX 2026-08-27: credit the LIVE pool through the audited path.
  -- It writes wallet_transactions itself for category 'cashout', so the
  -- ledger line this function always produced is preserved. It also declares
  -- app.ledger_category = table_cashout / counterparty table_stack itself.
  PERFORM public.atomic_credit_wallet_and_log(
    p_user_id, p_amount, 'cashout',
    'Table withdraw (partial cash-out)', p_table_id, NULL, NULL, v_key);

  IF v_club_id IS NOT NULL THEN
    SELECT COALESCE(chip_balance, 0) INTO v_new_balance
      FROM club_members WHERE user_id = p_user_id AND club_id = v_club_id;
  ELSE
    SELECT COALESCE(balance, 0) INTO v_new_balance
      FROM wallets WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  END IF;

  RETURN COALESCE(v_new_balance, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. C2 - one seat creator. The guard, then the sanctioned RPCs declare themselves.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_creating boolean;
BEGIN
  /* A seat that appears (INSERT) or comes back to life (left_at NOT NULL ->
     NULL) carrying chips is money arriving on the felt. Only two things may
     put it there: the engine (service_role, or a session with no JWT at all -
     psql, pg_cron, a migration; see fn_caller_is_engine), or a money RPC that
     has debited a wallet or a treasury for it and says so through
     app.money_path. A browser JWT reaching this row through any other
     SECURITY DEFINER body is a mint, and is refused. */
  v_creating := (TG_OP = 'INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP = 'UPDATE' AND OLD.left_at IS NOT NULL AND NEW.left_at IS NULL);
  IF NOT v_creating OR COALESCE(NEW.stack, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;

  v_path := current_setting('app.money_path', true);
  IF v_path IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'table_seats: a funded seat (stack %) can only be created by atomic_table_buyin, fn_take_seat_and_buy_in, fn_seat_late_registrant, fn_seat_horse_in_seat_first_game, fn_horse_seat_from_treasury or the engine - caller path % refused (table %, seat %)',
    NEW.stack, COALESCE(NULLIF(v_path, ''), '<none>'), NEW.table_id, NEW.seat_number
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

-- The trigger itself (trg_ca_guard_seat_creation ON table_seats) is created by
-- 20260902174600_the_seat_guard_takes_its_lock_alone.sql - see the header.

-- The sanctioned creators declare themselves: one line after the first BEGIN
-- of each live body, reconstructed from pg_get_functiondef so nothing else in
-- the body changes. The pre-flight above already proved the bodies match.
DO $$
DECLARE
  r record;
  v_def text;
  v_src text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('atomic_table_buyin', 'fn_take_seat_and_buy_in',
                         'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                         'fn_horse_seat_from_treasury')
  LOOP
    IF r.prosrc ~ 'app\.money_path' THEN
      CONTINUE; -- already declares itself
    END IF;
    v_src := r.prosrc;
    -- Literal newlines on both sides (E'\n'), so the regex engine never sees a
    -- backslash it could read as a back-reference. First match only (no 'g').
    v_new := regexp_replace(
      v_src,
      E'\nBEGIN\n',
      E'\nBEGIN\n  PERFORM set_config(''app.money_path'', ''' || r.proname
        || E''', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)\n');
    IF v_new = v_src THEN
      RAISE EXCEPTION 'could not find the body BEGIN of % to patch', r.proname;
    END IF;
    v_def := pg_get_functiondef(r.oid);
    IF position(v_src IN v_def) = 0 THEN
      RAISE EXCEPTION 'prosrc of % is not embedded verbatim in its functiondef', r.proname;
    END IF;
    EXECUTE replace(v_def, v_src, v_new);
  END LOOP;
END $$;

-- seat_horse: a seat creator that took its stack from a parameter and debited
-- nobody. No caller in club-arena src/, server/src, the World Hub API, pg_proc
-- or cron.job (verified 2026-09-02). Body preserved in the ROLLBACK section.
DROP FUNCTION IF EXISTS public.seat_horse(uuid, uuid, integer, numeric);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. C5 - the eviction and table-close cash-outs go through the one function
--    and declare the ledger before the credit
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.player_leave_table(p_table_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_seat_number   integer;
  v_tournament_id uuid;
BEGIN
  SELECT seat_number
    INTO v_seat_number
    FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT tournament_id INTO v_tournament_id FROM tables WHERE id = p_table_id;

  /* CHIP STANDARD C5 (2026-09-02). This used to credit through a bare wallet
     add (no ledger declaration, so the cron eviction's cash-out landed in
     chip_ledger as an anonymous 'adjustment') and then log_wallet_transaction,
     with no idempotency key on either. It now declares the movement and
     delegates to atomic_seat_cashout_locked - the one cash-out function -
     which keys the credit per seat occupancy, locks the seat, and treats a
     tournament stack as play chips (no credit). The tournament short-circuit
     this body always had therefore still holds: a tournament seat closes with
     nothing credited. */
  IF v_tournament_id IS NULL THEN
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);
  END IF;

  PERFORM public.atomic_seat_cashout_locked(p_user_id, p_table_id, v_seat_number);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(
  p_table_id uuid, p_reason text DEFAULT 'table closed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_tournament boolean;
  v_seat          record;
  v_club          uuid;
  v_res           jsonb;
  v_count         int := 0;
  v_total         numeric := 0;
BEGIN
  IF p_table_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'p_table_id required');
  END IF;

  SELECT (t.tournament_id IS NOT NULL) INTO v_is_tournament
    FROM public.tables t WHERE t.id = p_table_id;

  IF v_is_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  -- A tournament stack is not wallet money; it is settled by the payout
  -- structure, never handed back at a table close.
  IF v_is_tournament THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'tournament_table');
  END IF;

  FOR v_seat IN
    SELECT id, user_id, seat_number, stack, club_id
      FROM public.table_seats
     WHERE table_id = p_table_id
       AND left_at IS NULL
       AND user_id IS NOT NULL
       AND COALESCE(stack, 0) > 0
     FOR UPDATE
  LOOP
    v_club := v_seat.club_id;
    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(v_seat.user_id, NULL);
    END IF;

    -- No resolvable wallet is a reason to STOP, not to release the seat and
    -- lose the chips. Leaving it seated keeps the money visible and the seat
    -- recoverable; the caller reports and a human settles it.
    IF v_club IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(v_seat.user_id, v_club);

    /* CHIP STANDARD C5 (2026-09-02): declare the movement BEFORE the credit,
       and make the credit through the one cash-out function. This body used
       to set app.ledger_category to 'cashout' around its own UPDATE and clear
       it again before the counterparty was ever named; the ledger row came
       out half-described. atomic_seat_cashout_locked keys the credit per seat
       occupancy (so a re-run of a close pays nobody twice) and closes the
       seat; the callers' own UPDATE ... SET left_at afterwards simply finds
       nothing left to close. */
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);

    v_res := public.atomic_seat_cashout_locked(v_seat.user_id, p_table_id, v_seat.seat_number);

    IF COALESCE((v_res->>'credited')::boolean, false) THEN
      v_count := v_count + 1;
      v_total := v_total + COALESCE((v_res->>'stack')::numeric, 0);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'players_paid', v_count, 'chips_returned', v_total,
                            'reason_text', COALESCE(p_reason, 'table closed'));
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Post-apply assertions - the transaction aborts if any of these is false
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n int;
  r record;
BEGIN
  -- kind column + check
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'table_pending_addons'
                    AND column_name = 'kind') THEN
    RAISE EXCEPTION 'post-apply: table_pending_addons.kind missing';
  END IF;

  -- rebuy writes the pending table and never the stack
  SELECT prosrc INTO r FROM pg_proc WHERE proname = 'atomic_table_rebuy';
  IF r.prosrc !~ 'INSERT INTO public\.table_pending_addons' OR r.prosrc ~* 'SET\s+stack\s*=' THEN
    RAISE EXCEPTION 'post-apply: atomic_table_rebuy must write table_pending_addons and not table_seats.stack';
  END IF;

  -- exactly one atomic_table_withdraw, five args, engine-only
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_withdraw';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'post-apply: expected exactly one atomic_table_withdraw overload, found %', v_n;
  END IF;
  IF has_function_privilege('authenticated',
       'public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-apply: authenticated can still EXECUTE atomic_table_withdraw';
  END IF;

  -- the wrapper delegates
  SELECT prosrc INTO r FROM pg_proc WHERE proname = 'atomic_table_cashout';
  IF r.prosrc !~ 'atomic_seat_cashout_locked' OR r.prosrc ~* 'UPDATE club_members' THEN
    RAISE EXCEPTION 'post-apply: atomic_table_cashout must delegate and carry no credit of its own';
  END IF;

  -- every sanctioned creator declares itself
  FOR r IN SELECT unnest(ARRAY['atomic_table_buyin', 'fn_take_seat_and_buy_in',
                               'fn_seat_horse_in_seat_first_game', 'fn_seat_late_registrant',
                               'fn_horse_seat_from_treasury']) AS fn LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = r.fn
                      AND p.prosrc ~ ('app\.money_path'', ''' || r.fn || '''')) THEN
      RAISE EXCEPTION 'post-apply: % does not declare app.money_path', r.fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_guard_seat_creation') THEN
    RAISE EXCEPTION 'post-apply: fn_ca_guard_seat_creation missing';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'seat_horse') THEN
    RAISE EXCEPTION 'post-apply: seat_horse still exists';
  END IF;

  -- the two C5 bodies delegate and declare
  FOR r IN SELECT proname, prosrc FROM pg_proc
            WHERE proname IN ('player_leave_table', 'fn_cashout_seats_for_closing_table') LOOP
    IF r.prosrc !~ 'fn_ca_declare_ledger\(''table_cashout'', ''table_stack''' THEN
      RAISE EXCEPTION 'post-apply: % does not declare the ledger', r.proname;
    END IF;
    IF r.prosrc !~ 'atomic_seat_cashout_locked' OR r.prosrc ~ 'fn_add_chips' OR r.prosrc ~* 'UPDATE public\.club_members' THEN
      RAISE EXCEPTION 'post-apply: % must delegate to atomic_seat_cashout_locked', r.proname;
    END IF;
  END LOOP;

  RAISE NOTICE 'cash_one_cashout_path_one_seat_creator: all post-apply assertions passed';
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
--  ROLLBACK (Tier 3 - two DROPs above). Not run by this file.
-- ═══════════════════════════════════════════════════════════════════════════════
-- BEGIN;
-- -- (the trigger is rolled back by its own file's ROLLBACK section first)
-- DROP FUNCTION IF EXISTS public.fn_ca_guard_seat_creation();
-- DROP FUNCTION IF EXISTS public.atomic_table_withdraw(uuid, uuid, numeric, boolean, text);
-- -- then re-create the four-argument atomic_table_withdraw, atomic_table_rebuy,
-- -- atomic_table_cashout, player_leave_table and
-- -- fn_cashout_seats_for_closing_table from the bodies whose md5s are in the
-- -- header (they are reproduced verbatim in the PR body of this change), and
-- -- remove the one injected PERFORM set_config('app.money_path', ...) line
-- -- from the five sanctioned creators.
-- -- seat_horse, as it was:
-- CREATE OR REPLACE FUNCTION public.seat_horse(p_table_id uuid, p_horse_id uuid, p_seat integer, p_stack numeric)
--  RETURNS boolean LANGUAGE plpgsql SET search_path TO 'public', 'extensions'
-- AS $function$
-- BEGIN
--     IF EXISTS (SELECT 1 FROM table_seats WHERE table_id = p_table_id AND seat_number = p_seat AND status = 'active') THEN
--         RETURN FALSE;
--     END IF;
--     INSERT INTO table_seats (table_id, user_id, seat_number, stack, status, joined_at)
--     VALUES (p_table_id, p_horse_id, p_seat, p_stack, 'active', NOW());
--     RETURN TRUE;
-- END; $function$;
-- ALTER TABLE public.table_pending_addons DROP COLUMN IF EXISTS kind;
-- COMMIT;
