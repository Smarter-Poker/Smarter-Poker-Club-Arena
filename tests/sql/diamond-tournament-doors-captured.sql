-- ============================================================================
-- THE INSTALLED DIAMOND TOURNAMENT DOORS, CAPTURED
-- ============================================================================
--
-- This file is a CAPTURE, not a migration and not an authored implementation.
-- Every statement below is the exact text PostgreSQL returns for
-- pg_get_functiondef() on the production database, read read-only on
-- 2026-09-20, plus the REVOKE/GRANT pair that restates that function's live
-- ACL. Nothing here is edited by hand, and nothing here may be edited by
-- hand: each door carries the md5 of its own installed definition on the
-- line above it, and the block at the foot of this file refuses to finish if
-- the database it was just loaded into disagrees with a single one of them.
--
-- WHY A CAPTURE AND NOT A MIGRATION REPLAY. The ten Diamond tournament
-- migrations edit live function text in place and pin the md5 of the text
-- they were written against. Replaying them onto any base that is not that
-- exact preimage fails the pin, by design - that pin is the thing standing
-- between an in-place edit and a silently different function. A fixture
-- therefore captures the RESULT, and the pins in this file are what make the
-- capture checkable. Never weaken, stub or bypass an md5 guard to make a
-- fixture build.
--
-- SCOPE. These are the functions the Diamond tournament entry-and-obligation
-- path reaches: the doors the ten Phase 8 migrations created or edited, and
-- everything those doors call, to closure. See the README beside this file
-- for the two closure members deliberately left out and why.
--
-- Load order does not matter: check_function_bodies is off, exactly as
-- pg_dump and the estate's other captured overlays load functions.
-- ============================================================================
SET check_function_bodies = off;
SET search_path = public, extensions, pg_catalog;

-- @@DOOR atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_table_id uuid, p_hand_id uuid, p_related_entity_id uuid)
-- @@PIN md5=ab3d8e4c0baac59e7194319ffceba71e len=5486 owner=postgres
CREATE OR REPLACE FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'debit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric;
  v_club_id uuid;
  v_context_club uuid;
  v_context_tournament uuid;
  v_declared_club uuid;
  v_declared_text text;
  v_has_club boolean;
BEGIN
  IF p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount <> round(p_amount,2) THEN
    RAISE EXCEPTION 'wallet debit requires a positive two-decimal amount'
      USING ERRCODE='22023';
  END IF;

  v_declared_text:=NULLIF(current_setting('app.ledger_club_id',true),'');
  IF v_declared_text IS NOT NULL THEN
    BEGIN
      v_declared_club:=v_declared_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'wallet debit declared club is not a UUID'
        USING ERRCODE='22023';
    END;
    v_club_id:=v_declared_club;
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT t.club_id, t.tournament_id INTO v_context_club, v_context_tournament
      FROM public.tables t
     WHERE t.id=p_table_id;
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'wallet debit table % has no club context',p_table_id
        USING ERRCODE='P0002';
    END IF;
    IF v_context_tournament IS NOT NULL THEN
      -- THE ENTRY IS CHARGED TO THE WALLET THE ENTRY IS STAMPED WITH
      -- (2026-09-10): a tournament table resolves the wallet the way the
      -- entry stamp does, so a rebuy at a union event comes from the same
      -- member-club wallet the buy-in came from.
      v_context_club:=public.fn_tournament_club_for_user(
        p_user_id,v_context_tournament,v_club_id);
      IF v_context_club IS NULL THEN
        RAISE EXCEPTION 'no club wallet in the union of tournament % resolves for player %',
          v_context_tournament,p_user_id USING ERRCODE='42501';
      END IF;
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own table %',p_table_id
        USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF p_related_entity_id IS NOT NULL
     AND lower(COALESCE(p_category,'')) IN
       ('tournament_buyin','tournament_rebuy','rebuy','reentry','addon') THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=p_related_entity_id
                     AND t.club_id IS NOT NULL) THEN
      RAISE EXCEPTION 'wallet debit tournament % has no club context',
        p_related_entity_id USING ERRCODE='P0002';
    END IF;
    -- THE ENTRY IS CHARGED TO THE WALLET THE ENTRY IS STAMPED WITH
    -- (2026-09-10). trg_tournament_players_stamp_club stamps the entry with
    -- fn_tournament_club_for_user; the debit reads the same function with the
    -- same preferred club, so the wallet a prize returns to is the wallet the
    -- buy-in left. Reading tournaments.club_id here charged the union's house
    -- club for every union-hosted entry (3,232 entries / 73,659.00 in 24h).
    v_context_club:=public.fn_tournament_club_for_user(
      p_user_id,p_related_entity_id,v_club_id);
    IF v_context_club IS NULL THEN
      RAISE EXCEPTION 'no club wallet in the union of tournament % resolves for player %',
        p_related_entity_id,p_user_id USING ERRCODE='42501';
    END IF;
    IF v_club_id IS NOT NULL AND v_club_id<>v_context_club THEN
      RAISE EXCEPTION 'wallet debit declared club does not own tournament %',
        p_related_entity_id USING ERRCODE='22023';
    END IF;
    v_club_id:=v_context_club;
  END IF;

  IF v_club_id IS NULL THEN
    v_club_id:=public.fn_player_home_club(p_user_id,NULL);
  END IF;

  IF v_club_id IS NOT NULL THEN
    IF public.fn_ensure_club_wallet(p_user_id,v_club_id) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'player % has no active wallet at club %',p_user_id,v_club_id
        USING ERRCODE='42501';
    END IF;
    SELECT cm.chip_balance INTO v_balance
      FROM public.club_members cm
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
     FOR UPDATE;
    IF v_balance IS NULL OR v_balance<p_amount THEN
      RETURN false;
    END IF;
    UPDATE public.club_members cm
       SET chip_balance=cm.chip_balance-p_amount,updated_at=now()
     WHERE cm.user_id=p_user_id AND cm.club_id=v_club_id
       AND cm.status IN ('active','approved')
       AND cm.chip_balance>=p_amount;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    INSERT INTO public.chip_transactions(
      club_id,from_user_id,amount,transaction_type,notes
    ) VALUES (
      v_club_id,p_user_id,p_amount,p_category,
      COALESCE(NULLIF(p_description,''),'Wallet debit')
    );
    RETURN true;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.club_members cm WHERE cm.user_id=p_user_id
  ) INTO v_has_club;
  IF v_has_club THEN
    RAISE EXCEPTION 'No active club wallet resolves for Club Arena debit from player %',
      p_user_id USING ERRCODE='42501';
  END IF;

  UPDATE public.wallets w
     SET balance=w.balance-p_amount,updated_at=now()
   WHERE w.user_id=p_user_id AND w.wallet_type='PLAYER'
     AND w.balance>=p_amount;
  RETURN FOUND;
END;
$function$;
ALTER FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_table_id uuid, p_hand_id uuid, p_related_entity_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_table_id uuid, p_hand_id uuid, p_related_entity_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_table_id uuid, p_hand_id uuid, p_related_entity_id uuid) TO service_role;
-- @@END atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_table_id uuid, p_hand_id uuid, p_related_entity_id uuid)

-- @@DOOR fn_active_maintenance_release_boundary()
-- @@PIN md5=0d9548e27105b7172d83be4f7d10ea47 len=2542 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$;
ALTER FUNCTION public.fn_active_maintenance_release_boundary() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_active_maintenance_release_boundary() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO anon, authenticated, service_role;
-- @@END fn_active_maintenance_release_boundary()

-- @@DOOR fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid, p_settlement_id uuid, p_idempotency_key text, p_autoskip_tables text[])
-- @@PIN md5=1991d9f52317f33a4b9cf560d6fc91d5 len=2151 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid DEFAULT NULL::uuid, p_settlement_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_autoskip_tables text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t text;
BEGIN
  -- validate against the LIVE vocabulary so this can never lag a CHECK change
  IF p_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_category || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: category % is not in the ledger vocabulary - add it to chip_ledger_category_check FIRST, then declare it', p_category;
  END IF;
  IF p_counterparty IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_counterparty || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: counterparty % is not in the ledger vocabulary - add it to the from/to type CHECKs FIRST, then declare it', p_counterparty;
  END IF;

  PERFORM set_config('app.ledger_category', p_category, true);
  PERFORM set_config('app.ledger_counterparty', p_counterparty, true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  IF p_settlement_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_settlement', p_settlement_id::text, true);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM set_config('app.ledger_idempotency_key', p_idempotency_key, true);
  END IF;
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_autoskip_tables LOOP
      IF v_t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_declare_ledger: bad autoskip table name %', v_t;
      END IF;
      PERFORM set_config('app.ledger_autoskip_' || v_t, '1', true);
    END LOOP;
  END IF;
END $function$;
ALTER FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid, p_settlement_id uuid, p_idempotency_key text, p_autoskip_tables text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid, p_settlement_id uuid, p_idempotency_key text, p_autoskip_tables text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid, p_settlement_id uuid, p_idempotency_key text, p_autoskip_tables text[]) TO service_role;
-- @@END fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid, p_settlement_id uuid, p_idempotency_key text, p_autoskip_tables text[])

-- @@DOOR fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text)
-- @@PIN md5=918b4dccaf2255fe90a7153cc600890d len=1233 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  WITH v AS (
    SELECT lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), '')) AS kind,
           lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), '')) AS class,
           lower(COALESCE(NULLIF(btrim(p_source), ''), '')) AS src
  )
  SELECT CASE
    -- The Mint's own doors register their own rows; the seed door writes its
    -- own 'seed:<id>' row. Neither is a transfer and neither may be judged as
    -- one. Same order, same reasons, as fn_ca_diamond_journal_origin.
    WHEN v.src = 'the_mint' THEN false
    WHEN v.kind = 'signup_bonus' OR v.src = 'handle_new_user' THEN false
    ELSE v.class = 'transferred'
      OR v.kind IN ('transfer', 'diamond_gift_sent', 'diamond_gift_received', 'diamond_received',
                    'live_gift_sent', 'live_gift_received', 'wallet_transfer',
                    'wallet_diamond_transfer', 'stream_gift', 'union_grant_transfer')
      OR v.kind LIKE '%gift%' OR v.kind LIKE '%transfer%'
  END
  FROM v;
$function$;
ALTER FUNCTION public.fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text) TO authenticated, service_role;
-- @@END fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text)

-- @@DOOR fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
-- @@PIN md5=ba8e79dfa3ce176381524eb5fb90f3fa len=3432 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind  text := lower(COALESCE(NULLIF(btrim(p_transaction_type), ''), NULLIF(btrim(p_type), ''), ''));
  v_class text := lower(COALESCE(NULLIF(btrim(p_issuance_class), ''), ''));
  v_src   text := lower(COALESCE(NULLIF(btrim(p_source), ''), ''));
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN RETURN NULL; END IF;
  -- The Mint's own doors register their own rows.
  IF v_src = 'the_mint' THEN RETURN NULL; END IF;
  -- SO DOES THE SEED DOOR. fn_ca_diamond_born_with_balance writes the
  -- 'seed:<id>' register row for the signup grant and then the journal row.
  -- Registering it here as well counts one movement twice (2026-09-05: 18
  -- duplicate pairs, 9,000 diamonds). Named writer, not a class: every OTHER
  -- promotional credit still registers here.
  IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;
  -- Player to player: supply moves, none is created or retired.
  IF public.fn_ca_diamond_journal_is_transfer(p_type, p_transaction_type, p_source, p_issuance_class) THEN
    RETURN NULL;
  END IF;
  -- THE ARENA DOORS MOVE MONEY, THEY DO NOT ISSUE IT. A deposit takes diamonds out of
  -- profiles.diamonds and puts them in the platform club's member wallet; a withdrawal is the
  -- mirror. The player still owns them and the supply is unchanged, so the register must not
  -- follow either leg - the same treatment, for the same reason, as a player-to-player transfer
  -- above. Classified as 'spend' (deposit) and 'arena' (withdrawal), the register would have
  -- burned the float on the way in and minted it on the way out (2026-09-08).
  IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;
  -- The deletion door writes its own register row.
  IF v_class = 'deletion' THEN RETURN NULL; END IF;
  -- A test fixture row is not supply the Mint issued.
  IF v_kind LIKE 'test%' THEN RETURN NULL; END IF;

  IF p_amount > 0 THEN
    IF v_class = 'purchased' OR v_kind IN ('purchase', 'stripe_purchase', 'diamond_purchase') THEN
      RETURN 'purchase';
    ELSIF v_class = 'refund' OR v_kind LIKE '%refund%' OR v_kind = 'diamond_refund' THEN
      RETURN 'refund';
    ELSIF v_class = 'promotional' OR v_kind IN ('union_grant', 'bonus', 'promo',
                                                 'promo_purchased', 'easter_egg', 'vip_daily',
                                                 'vip_stipend', 'vip_monthly') THEN
      RETURN 'promotion';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN
      RETURN 'adjustment';
    -- 'arcade%' only. The 'arena' CLASS now belongs to the arena doors, which are handled
    -- as transfers above; leaving it here would have made a withdrawal mint.
    ELSIF v_kind LIKE 'arcade%' THEN
      RETURN 'arena';
    ELSE
      RETURN 'reward';
    END IF;
  ELSE
    IF v_kind IN ('chip_mint', 'chip_purchase', 'mint_chips', 'diamonds_to_chips') OR v_class = 'bridge' THEN
      RETURN 'bridge';
    ELSIF v_class = 'admin' OR v_kind IN ('adjustment', 'reconciliation', 'admin', 'chargeback', 'clawback') THEN
      RETURN 'adjustment';
    ELSE
      RETURN 'spend';
    END IF;
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric) TO service_role;
-- @@END fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)

-- @@DOOR fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)
-- @@PIN md5=22e286701d8e4ce9a256efb74ae1dbb5 len=2053 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union boolean; v_club_union uuid;
BEGIN
  IF p_user_id IS NULL OR p_tournament_club IS NULL THEN
    RETURN false;
  END IF;
  -- The Diamond arena has no membership rows by design: every account with a
  -- profile is a member. A retired or missing profile is not.
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id = p_tournament_club AND c.asset = 'diamonds'
                AND c.is_platform IS TRUE AND c.union_id IS NULL) THEN
    RETURN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id);
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_tournament_club) INTO v_is_union;
  IF v_is_union THEN
    -- Union-scoped tournament: member of any club in that union.
    RETURN EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.user_id = p_user_id
         AND (c.union_id = p_tournament_club
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = p_tournament_club)));
  END IF;
  SELECT c.union_id INTO v_club_union FROM public.clubs c WHERE c.id = p_tournament_club;
  IF v_club_union IS NOT NULL THEN
    -- Club in a union: member of the club itself or any sibling club in the union.
    RETURN EXISTS (
      SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
       WHERE cm.user_id = p_user_id
         AND (c.id = p_tournament_club
              OR c.union_id = v_club_union
              OR EXISTS (SELECT 1 FROM public.union_clubs uc
                          WHERE uc.club_id = c.id AND uc.union_id = v_club_union)));
  END IF;
  -- Standalone club: members only.
  RETURN EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = p_user_id AND cm.club_id = p_tournament_club);
END $function$;
ALTER FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid) TO authenticated, service_role;
-- @@END fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)

-- @@DOOR fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric, p_fee_entries_in numeric, p_satellite_fee_in numeric, p_bounty_in numeric, p_overlay_in numeric, p_satellite_in numeric, p_prize_out numeric, p_bounty_out numeric, p_fee_out numeric, p_refund numeric, p_reserve_out numeric, p_reserve_in numeric)
-- @@PIN md5=c6c26c25ab8a8b1222d375c7d6df0d2f len=7016 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_spin boolean; e record; v_sat_fee numeric;
  v_prize_in numeric; v_tot numeric; r_p numeric := 0; r_b numeric := 0; r_f numeric := 0;
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0;
  r_out numeric := 0; r_in numeric := 0;
  v_sp_prize numeric; v_sp_bounty numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false)) INTO v_spin
      FROM public.tournaments t WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(p_tournament_id);
    SELECT COALESCE(sum(rr.rake_amount), 0) INTO v_sat_fee FROM public.rake_records rr
     WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament AND rr.source = 'fn_award_satellite_seat';
    v_prize_in := e.prize_in; v_tot := e.prize_in + e.satellite_in + e.bounty_in + e.fee_in;
    IF v_tot > 0 THEN
      r_p := round(e.refund_out * (e.prize_in + e.satellite_in) / v_tot, 2);
      r_b := round(e.refund_out * e.bounty_in / v_tot, 2);
    ELSE
      r_p := e.refund_out;
    END IF;
    r_f := round(e.refund_out - r_p - r_b, 2);
    /* PHASE 5.2: a spin's prize bank also moves through the reserve.
       2026-09-07: read from spin_reserve_ledger, not from the chip_ledger
       spin_entry / spin_prize legs it used to read. Those legs are the DERIVED
       record and one pair of them went missing: on 2026-09-06 at 12:50:38 both
       legs of tournament afa045db landed as `adjustment` rows into
       settlement_suspense with a NULL entity, their intended category
       surviving only inside the description text. The escrow therefore never
       learned that 60.00 had been drawn for a 60.00 prize, and
       fn_settle_tournament_obligation refused the winner's last 4.80 as
       escrow_short - for a day, with an open critical alert nobody could act
       on. spin_reserve_ledger is the record the pool balance itself moved by;
       it cannot be missing while the money has moved. Verified across 18,318
       escrow rows: 0 disagree with it, 1 was missing the legs entirely. */
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'contribution'), 0),
           COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0)
      INTO r_out, r_in
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind IN ('contribution', 'jackpot_draw');
    INSERT INTO public.tournament_escrow
      (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
       prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
       prize_balance, bounty_balance, fee_balance, opened_from)
    VALUES
      (p_tournament_id, true,
       round(e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee), 2), round(e.fee_in - v_sat_fee, 2), round(v_sat_fee, 2),
       e.bounty_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out, e.fee_out, r_p, r_b, r_f, round(r_out, 2), round(r_in, 2),
       round(e.prize_balance - r_out + r_in, 2), e.bounty_balance, e.fee_balance,
       'shadow at first sight (' || p_what || ')')
    ON CONFLICT (tournament_id) DO NOTHING;
    RETURN;
  END IF;

  IF COALESCE(p_refund, 0) > 0 THEN
    v_prize_in := v.gross_in - v.fee_entries_in - v.bounty_in + v.satellite_in;
    v_tot := v.gross_in + v.satellite_in + v.satellite_fee_in;
    IF v_tot > 0 THEN
      r_p := round(p_refund * v_prize_in / v_tot, 2);
      r_b := round(p_refund * v.bounty_in / v_tot, 2);
    ELSE
      SELECT s.prize, s.bounty INTO v_sp_prize, v_sp_bounty
        FROM public.tournaments t2
        CROSS JOIN LATERAL public.fn_tournament_entry_split(t2.buy_in_amount, t2.buy_in_fee, t2.bounty_amount,
               COALESCE(t2.is_bounty, false) OR COALESCE(t2.is_pko, false) OR COALESCE(t2.is_mystery_bounty, false)) s
       WHERE t2.id = p_tournament_id;
      IF COALESCE(v_sp_prize, 0) + COALESCE(v_sp_bounty, 0) > 0 THEN
        r_p := round(p_refund * v_sp_prize / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
        r_b := round(p_refund * v_sp_bounty / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
      ELSE
        r_p := p_refund;
      END IF;
    END IF;
    r_f := round(p_refund - r_p - r_b, 2);
  END IF;

  UPDATE public.tournament_escrow
     SET gross_in = gross_in + COALESCE(p_gross_in, 0),
         fee_entries_in = fee_entries_in + COALESCE(p_fee_entries_in, 0),
         satellite_fee_in = satellite_fee_in + COALESCE(p_satellite_fee_in, 0),
         bounty_in = bounty_in + COALESCE(p_bounty_in, 0),
         overlay_in = overlay_in + COALESCE(p_overlay_in, 0),
         satellite_in = satellite_in + COALESCE(p_satellite_in, 0),
         prize_out = prize_out + COALESCE(p_prize_out, 0),
         bounty_out = bounty_out + COALESCE(p_bounty_out, 0),
         fee_out = fee_out + COALESCE(p_fee_out, 0),
         refund_prize = refund_prize + r_p, refund_bounty = refund_bounty + r_b, refund_fee = refund_fee + r_f,
         reserve_out = reserve_out + COALESCE(p_reserve_out, 0), reserve_in = reserve_in + COALESCE(p_reserve_in, 0),
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_escrow
     SET prize_balance  = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize, 2),
         bounty_balance = round(bounty_in - bounty_out - refund_bounty, 2),
         fee_balance    = round(fee_entries_in + satellite_fee_in - fee_out - refund_fee, 2)
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;

  IF v.enforced AND v_outflow
     AND (v.prize_balance < -0.005 OR v.bounty_balance < -0.005 OR v.fee_balance < -0.005) THEN
    RAISE EXCEPTION 'escrow_short: tournament % cannot pay this % - it would leave prize %, bounty %, fee % (chip standard Phase 5.1: an event pays only what it holds)',
      p_tournament_id, p_what, v.prize_balance, v.bounty_balance, v.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric, p_fee_entries_in numeric, p_satellite_fee_in numeric, p_bounty_in numeric, p_overlay_in numeric, p_satellite_in numeric, p_prize_out numeric, p_bounty_out numeric, p_fee_out numeric, p_refund numeric, p_reserve_out numeric, p_reserve_in numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric, p_fee_entries_in numeric, p_satellite_fee_in numeric, p_bounty_in numeric, p_overlay_in numeric, p_satellite_in numeric, p_prize_out numeric, p_bounty_out numeric, p_fee_out numeric, p_refund numeric, p_reserve_out numeric, p_reserve_in numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric, p_fee_entries_in numeric, p_satellite_fee_in numeric, p_bounty_in numeric, p_overlay_in numeric, p_satellite_in numeric, p_prize_out numeric, p_bounty_out numeric, p_fee_out numeric, p_refund numeric, p_reserve_out numeric, p_reserve_in numeric) TO service_role;
-- @@END fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric, p_fee_entries_in numeric, p_satellite_fee_in numeric, p_bounty_in numeric, p_overlay_in numeric, p_satellite_in numeric, p_prize_out numeric, p_bounty_out numeric, p_fee_out numeric, p_refund numeric, p_reserve_out numeric, p_reserve_in numeric)

-- @@DOOR fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)
-- @@PIN md5=44534508da577df94a34d2055e99b1d6 len=1701 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.tournament_escrow%ROWTYPE; v_have numeric; d record;
BEGIN
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    SELECT * INTO d FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
    v_have := CASE WHEN p_kind IN ('bounty', 'mystery_bounty', 'bounty_residual') THEN d.bounty_balance
                   WHEN p_kind = 'refund' THEN d.prize_balance + d.bounty_balance + d.fee_balance
                   ELSE d.prize_balance END;
    RETURN jsonb_build_object('known', true, 'enforced', true, 'available', v_have,
                              'ok', p_amount <= v_have, 'asset', 'diamonds',
                              'prize_balance', d.prize_balance, 'bounty_balance', d.bounty_balance, 'fee_balance', d.fee_balance);
  END IF;
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('known', false);
  END IF;
  v_have := CASE WHEN p_kind IN ('bounty', 'mystery_bounty', 'bounty_residual') THEN v.bounty_balance
                 WHEN p_kind = 'refund' THEN v.prize_balance + v.bounty_balance + v.fee_balance
                 ELSE v.prize_balance END;
  RETURN jsonb_build_object('known', true, 'enforced', v.enforced, 'available', v_have,
                            'ok', (NOT v.enforced) OR p_amount <= v_have + 0.005,
                            'prize_balance', v.prize_balance, 'bounty_balance', v.bounty_balance, 'fee_balance', v.fee_balance);
END;
$function$;
ALTER FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric) TO service_role;
-- @@END fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)

-- @@DOOR fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)
-- @@PIN md5=bc9acd00e516e3336b339349063b380d len=10256 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid:=p_beneficiary_id;
  v_t public.tournaments%ROWTYPE;
  v_split record;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_is_bounty boolean;
  v_candidate_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR v_uid IS NULL THEN
    RAISE EXCEPTION 'tournament and beneficiary ids are required'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_found','ticket_id',NULL);
  END IF;
  v_is_bounty:=COALESCE(v_t.is_bounty,false)
            OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false);
  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount,v_t.buy_in_fee,v_t.bounty_amount,v_is_bounty);
  IF v_split.charge IS NULL OR v_split.prize IS NULL
     OR v_split.bounty IS NULL OR v_split.rake IS NULL
     OR v_split.charge::text IN ('NaN','Infinity','-Infinity')
     OR v_split.prize::text IN ('NaN','Infinity','-Infinity')
     OR v_split.bounty::text IN ('NaN','Infinity','-Infinity')
     OR v_split.rake::text IN ('NaN','Infinity','-Infinity')
     OR v_split.charge<0 OR v_split.prize<0
     OR v_split.bounty<0 OR v_split.rake<0
     OR v_split.charge IS DISTINCT FROM
          round(v_split.prize+v_split.bounty+v_split.rake,2) THEN
    RAISE EXCEPTION 'tournament % has no finite ticket contract',p_tournament_id
      USING ERRCODE='P0404';
  END IF;
  IF v_split.charge=0 THEN
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;

  -- Presence and validity are separate facts. If an exact-price ticket exists
  -- but its issue proof or scope is unreadable, do not erase it through an
  -- inner join and silently charge the wallet instead.
  SELECT count(*) INTO v_candidate_count
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND (tk.source_refund_entitlement_id IS NOT NULL
          OR tk.source_tournament_id=p_tournament_id)
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id;

  SELECT tk.* INTO v_ticket
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_uid
     AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only'
     AND tk.value=v_split.charge
     AND tk.entry_prize=v_split.prize
     AND tk.entry_bounty=v_split.bounty
     AND tk.entry_fee=v_split.rake
     AND EXISTS(
       SELECT 1 FROM public.club_members m
        WHERE m.club_id=tk.club_id AND m.user_id=v_uid
          AND COALESCE(m.status,'active') IN ('active','approved'))
     AND (v_t.union_id IS NOT NULL OR v_t.club_id IS NULL OR tk.club_id=v_t.club_id)
     AND (v_t.union_id IS NULL OR tk.club_id=v_t.club_id OR EXISTS(
       SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_t.union_id AND uc.club_id=tk.club_id))
     AND public.fn_tournament_club_for_user(
           v_uid,p_tournament_id,tk.club_id) IS NOT DISTINCT FROM tk.club_id
     AND (
       (tk.source_refund_entitlement_id IS NOT NULL
        AND tk.source_satellite_award_place IS NULL
        AND EXISTS(
          SELECT 1
            FROM public.tournament_refund_entitlements source_e
            JOIN public.chip_ledger issue_l
              ON issue_l.idempotency_key='tourney:'
                   ||source_e.tournament_id::text
                   ||':satellite-ticket-return:'||source_e.id::text
             AND issue_l.from_type='prize_liability'
             AND issue_l.from_entity_id=source_e.tournament_id
             AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
             AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
             AND issue_l.category='ticket_issue'
           WHERE source_e.id=tk.source_refund_entitlement_id
             AND source_e.user_id=v_uid
             AND source_e.entitlement_kind IN
                   ('satellite_seat','tournament_ticket')
             AND source_e.gross=tk.value
             AND source_e.refund_prize=tk.entry_prize
             AND source_e.refund_bounty=tk.entry_bounty
             AND source_e.refund_fee=tk.entry_fee
             AND source_e.source_satellite_id=tk.source_satellite_id
             AND source_e.tournament_id=tk.source_tournament_id
             AND NOT EXISTS(
               SELECT 1 FROM public.tournament_refund_tranches tr
                WHERE tr.entitlement_id=source_e.id)
             AND (SELECT count(*)
                    FROM public.chip_transactions issue_tx
                   WHERE issue_tx.transaction_type='tournament_ticket_issue'
                     AND issue_tx.club_id=tk.club_id
                     AND issue_tx.from_user_id IS NULL
                     AND issue_tx.to_user_id=v_uid
                     AND issue_tx.amount=tk.value
                     AND issue_tx.metadata->>'ticket_id'=tk.id::text
                     AND issue_tx.metadata->>'entitlement_id'=source_e.id::text
                     AND issue_tx.metadata->>'ledger_id'=issue_l.id::text)=1))
       OR
       (tk.source_refund_entitlement_id IS NULL
        AND tk.source_satellite_award_place IS NOT NULL
        AND tk.source_tournament_id=p_tournament_id
        AND EXISTS(
          SELECT 1
            FROM public.tournament_satellite_awards source_a
            JOIN public.tournament_satellite_settlements source_h
              ON source_h.tournament_id=source_a.tournament_id
             AND source_h.target_id=p_tournament_id
            JOIN public.tournament_payouts source_p
              ON source_p.id=source_a.payout_id
             AND source_p.tournament_id=source_a.tournament_id
             AND source_p.user_id=source_a.user_id
             AND source_p."position"=source_a.place
             AND source_p.amount=source_a.amount
             AND source_p.source=source_a.payout_source
             AND source_p.idempotency_key=source_a.idempotency_key
            JOIN public.chip_ledger issue_l
              ON issue_l.idempotency_key=source_a.idempotency_key
                                            ||':ticket_escrow'
             AND issue_l.from_type='prize_liability'
             AND issue_l.from_entity_id=source_a.tournament_id
             AND issue_l.to_type='escrow' AND issue_l.to_entity_id=tk.id
             AND issue_l.club_id=tk.club_id AND issue_l.amount=tk.value
             AND issue_l.category='ticket_issue'
             AND issue_l.tournament_id=source_a.tournament_id
             AND issue_l.metadata->>'kind'='direct_satellite_entry_ticket'
             AND issue_l.metadata->>'ticket_id'=tk.id::text
             AND issue_l.metadata->>'payout_id'=source_a.payout_id::text
             AND issue_l.metadata->>'satellite_target_id'=
                   p_tournament_id::text
             AND issue_l.metadata->>'user_id'=source_a.user_id::text
             AND issue_l.metadata->>'position'=source_a.place::text
           WHERE source_a.tournament_id=tk.source_satellite_id
             AND source_a.place=tk.source_satellite_award_place
             AND source_a.user_id=v_uid
             AND source_a.delivery_kind='ticket'
             AND source_a.ticket_id=tk.id
             AND source_a.amount=tk.value
             AND source_a.payout_source='satellite_ticket'
             AND source_h.ticket_cost=tk.value
             AND source_h.target_buy_in=tk.entry_prize
             AND source_h.target_fee=tk.entry_fee
             AND tk.entry_bounty=0
             AND NOT EXISTS(
               SELECT 1 FROM public.wallet_credit_idempotency wallet_key
                WHERE wallet_key.key=source_a.idempotency_key)
             AND (SELECT count(*)
                    FROM public.chip_transactions issue_tx
                   WHERE issue_tx.transaction_type='tournament_ticket_issue'
                     AND issue_tx.club_id=tk.club_id
                     AND issue_tx.from_user_id IS NULL
                     AND issue_tx.to_user_id=v_uid
                     AND issue_tx.amount=tk.value
                     AND issue_tx.metadata->>'ticket_id'=tk.id::text
                     AND issue_tx.metadata->>'source_tournament_id'=
                           p_tournament_id::text
                     AND issue_tx.metadata->>'source_satellite_id'=
                           source_a.tournament_id::text
                     AND issue_tx.metadata->>'source_award_place'=
                           source_a.place::text
                     AND issue_tx.metadata->>'payout_id'=source_a.payout_id::text
                     AND issue_tx.metadata->>'ledger_id'=issue_l.id::text
                     AND issue_tx.metadata->>'idempotency_key'=
                           source_a.idempotency_key)=1))
     )
   ORDER BY tk.created_at,tk.id
   LIMIT 1;

  IF v_ticket.id IS NULL THEN
    IF v_candidate_count>0 THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','matching_tournament_ticket_unavailable',
        'ticket_id',NULL);
    END IF;
    RETURN jsonb_build_object('ok',true,'ticket_id',NULL);
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'ticket_id',v_ticket.id,'ticket_value',v_ticket.value,
    'entry_prize',v_ticket.entry_prize,
    'entry_bounty',v_ticket.entry_bounty,'entry_fee',v_ticket.entry_fee,
    'source_satellite_id',v_ticket.source_satellite_id);
END;
$function$;
ALTER FUNCTION public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)

-- @@DOOR fn_ca_guard_watchlist()
-- @@PIN md5=92ee208d0887728444bda396d0b4d442 len=2772 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;
ALTER FUNCTION public.fn_ca_guard_watchlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO service_role;
-- @@END fn_ca_guard_watchlist()

-- @@DOOR fn_ca_is_new_mtt(p_row jsonb)
-- @@PIN md5=dff4202458ea4b5b940e78050e6de91c len=1912 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_is_new_mtt(p_row jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN false
    -- A genuine satellite target has product meaning; an empty object does not.
    WHEN (jsonb_typeof(p_row->'satellite_target_id')='string'
          AND NULLIF(btrim(p_row->>'satellite_target_id'),'') IS NOT NULL)
      OR (jsonb_typeof(p_row->'satelliteTargetId')='string'
          AND NULLIF(btrim(p_row->>'satelliteTargetId'),'') IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM (VALUES(p_row->'satellite_target'),(p_row->'satelliteTarget')) s(target)
         WHERE (jsonb_typeof(target)='string'
                AND NULLIF(btrim(target#>>'{}'),'') IS NOT NULL)
            OR (jsonb_typeof(target)='object' AND (
                 (jsonb_typeof(target->'tournamentId')='string'
                  AND NULLIF(btrim(target->>'tournamentId'),'') IS NOT NULL)
                 OR (jsonb_typeof(target->'tournament_id')='string'
                  AND NULLIF(btrim(target->>'tournament_id'),'') IS NOT NULL)))
      ) THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry') THEN true
    WHEN lower(btrim(COALESCE(p_row->>'tournament_type',p_row->>'tournamentType',p_row->>'type','')))
      IN ('sng','spin','hu_sng','heads_up') THEN false
    ELSE lower(btrim(COALESCE(p_row->>'variant',''))) IN ('mtt','xmtt','satellite','freezeout','bounty','progressive','progressive_bounty','pko','mystery','mystery_bounty','rebuy','reentry','mtt_freezeout','mtt_free_buy','mtt_rebuy','mtt_reentry')
  END;
$function$;
ALTER FUNCTION public.fn_ca_is_new_mtt(p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_is_new_mtt(p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_is_new_mtt(p_row jsonb)

-- @@DOOR fn_ca_lock_mtt_admission_contract()
-- @@PIN md5=10644d522bb50245f76942ecce735cbc len=498 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_lock_mtt_admission_contract()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
  SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE;
  IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
    RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
  END IF;
  RETURN v_abi;
END $function$;
ALTER FUNCTION public.fn_ca_lock_mtt_admission_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_mtt_admission_contract() FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_lock_mtt_admission_contract()

-- @@DOOR fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)
-- @@PIN md5=76e4c6b5291bab20f0cfc65dd060022b len=3172 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  -- Unknown until the row proves it is a plain tournament: the whole lane.
  v_satellite boolean := true;
BEGIN
  -- Re-entry: this transaction already holds a finish lane. Every key below
  -- is already held by this backend, so nothing waits; a second tournament
  -- is refused, a transaction never holds two tournaments' lanes.
  IF v_held <> '' THEN
    IF p_tournament_id IS NOT NULL AND v_held <> p_tournament_id::text THEN
      RAISE EXCEPTION 'finish lane is held for tournament %, refused for %',
        v_held, p_tournament_id USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-finish-lane:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_held, 0));
    RETURN;
  END IF;

  -- Resolve the tournament before any lock. variant, tournament_type and the
  -- satellite target are fixed for the life of the row, so reading them
  -- unlocked gives the answer reading them under the lane would.
  IF p_tournament_id IS NOT NULL THEN
    SELECT (lower(COALESCE(t.variant::text, '')) = 'satellite'
            OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
            OR t.satellite_target_id IS NOT NULL
            OR t.satellite_target IS NOT NULL)
      INTO v_satellite
      FROM public.tournaments t
     WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      v_satellite := true;
    END IF;
  END IF;

  -- A satellite finish writes the target tournament's rows, and an unknown
  -- tournament cannot be scoped: the whole lane, as it always was.
  IF v_satellite THEN
    PERFORM public.fn_ca_lock_settlement_lane_global();
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, the rare global authorities (G
  -- exclusive) and nothing else. Hands and rolling authorities of other
  -- tournaments run beside this finish.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  -- F EXCLUSIVE: one finish on the platform at a time, so finish-against-
  -- finish wallet order is what it was under G exclusive.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-finish-lane:v1', 0));
  -- T(id) EXCLUSIVE: this tournament's hands (T shared) and rolling
  -- authorities (T exclusive) wait for the finish, and the proof-of-
  -- authority guards read it as this backend's authority over the rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  -- The rest of this transaction re-enters this lane through
  -- fn_ca_lock_settlement_lane_global; transaction-local, gone at commit.
  PERFORM set_config('ca.finish_lane_tournament', p_tournament_id::text, true);
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid) TO service_role;
-- @@END fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)

-- @@DOOR fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid)
-- @@PIN md5=9877846ffabee004690e6b24a3ddcee2 len=1676 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid := p_tournament_id;
BEGIN
  -- Resolve the tournament before any lock, so G's mode can depend on it.
  -- tables.tournament_id is fixed for the life of a table: reading it here
  -- gives the answer reading it under G did.
  IF v_tournament_id IS NULL AND p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb
    WHERE tb.id = p_table_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    -- Nothing to scope to: the whole lane, as it always was - G exclusive,
    -- then B exclusive (the shape of fn_ca_lock_settlement_lane_global).
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:hand-settlement-barrier:v1', 0));
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, terminal authorities (G exclusive)
  -- and nothing else. Rolling authorities of different tournaments run side
  -- by side; the trigger guards take T(id) held exclusively as their proof.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));

  -- T(id) EXCLUSIVE: one rolling authority per tournament at a time, and
  -- this tournament's hand settlements (T(id) shared) wait for it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid) TO service_role;
-- @@END fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid)

-- @@DOOR fn_ca_lock_settlement_lane_global()
-- @@PIN md5=7c759bb7a639c3124de2607bdbf12577 len=1056 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Inside a non-satellite finish (2026-09-17) this transaction already
  -- holds that finish's lane: G shared, F exclusive, T(id) exclusive. The
  -- finish body and the settle functions still call this helper; re-enter
  -- the lane that is held instead of requesting G exclusively, which would
  -- be an upgrade of a shared hold (2026-09-10: no upgrades, they deadlock).
  IF COALESCE(current_setting('ca.finish_lane_tournament', true), '') <> '' THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
    RETURN;
  END IF;
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_settlement_lane_global() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_settlement_lane_global() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_lock_settlement_lane_global() TO service_role;
-- @@END fn_ca_lock_settlement_lane_global()

-- @@DOOR fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
-- @@PIN md5=2d8c9bd676a8ee02e009dd470fbfd585 len=2464 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid:=p_tournament_id;
  v_table_tournament_id uuid;
  v_status text;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id, p_table_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  PERFORM public.fn_ca_lock_mtt_admission_contract();

  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  IF p_user_id IS NOT NULL THEN
    PERFORM public.fn_lock_daily_mission_user(p_user_id);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT tb.tournament_id INTO v_table_tournament_id
      FROM public.tables tb
     WHERE tb.id=p_table_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'reason','table_not_found');
    END IF;
    IF v_table_tournament_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_a_tournament_table');
    END IF;
    IF v_tournament_id IS NOT NULL
       AND v_tournament_id IS DISTINCT FROM v_table_tournament_id THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','table_tournament_mismatch');
    END IF;
    v_tournament_id:=v_table_tournament_id;
  END IF;

  IF v_tournament_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_or_table_required');
  END IF;

  -- Launch completion already owns receipt -> tournament. Re-entering these
  -- locks from every seat root makes the historical aa_ launch-proof trigger
  -- a no-op lock acquisition rather than a late inversion.
  PERFORM r.tournament_id
    FROM public.tournament_launch_receipts r
   WHERE r.tournament_id=v_tournament_id
   ORDER BY r.tournament_id
   FOR UPDATE;

  SELECT upper(COALESCE(t.status::text,'')) INTO v_status
    FROM public.tournaments t
   WHERE t.id=v_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF v_status NOT IN ('ANNOUNCED','REGISTERING','RUNNING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_not_seatable','status',v_status);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',v_tournament_id,
    'table_id',p_table_id,'status',v_status);
END;
$function$;
ALTER FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)

-- @@DOOR fn_ca_mint_supply(p_asset text)
-- @@PIN md5=b735bae7649d0b0753352abf5439f8d9 len=323 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_mint_supply(p_asset text)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    FROM public.ca_mint_ledger WHERE asset = p_asset;
$function$;
ALTER FUNCTION public.fn_ca_mint_supply(p_asset text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_mint_supply(p_asset text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_supply(p_asset text) TO service_role;
-- @@END fn_ca_mint_supply(p_asset text)

-- @@DOOR fn_ca_new_tournament_is_unlimited(p_config jsonb)
-- @@PIN md5=34b80f98d9d110072ae6951bb4377ee0 len=408 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_new_tournament_is_unlimited(p_config jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 RETURN v_abi='unlimited-mtt-v2' AND public.fn_ca_is_new_mtt(p_config);
END $function$;
ALTER FUNCTION public.fn_ca_new_tournament_is_unlimited(p_config jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_new_tournament_is_unlimited(p_config jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_new_tournament_is_unlimited(p_config jsonb) TO authenticated, service_role;
-- @@END fn_ca_new_tournament_is_unlimited(p_config jsonb)

-- @@DOOR fn_ca_record_tournament_participant_funding(p_registration uuid, p_operation text, p_key text, p_amount numeric, p_asset text, p_entitlement uuid, p_wallet uuid, p_custody jsonb)
-- @@PIN md5=6cfd4af7307ce31460fd62c5b3f38bef len=2770 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_record_tournament_participant_funding(p_registration uuid, p_operation text, p_key text, p_amount numeric, p_asset text, p_entitlement uuid, p_wallet uuid, p_custody jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_p jsonb;v_t jsonb;v_e public.tournament_refund_entitlements%ROWTYPE;v_l jsonb;v_w jsonb;
BEGIN
 SELECT to_jsonb(p),to_jsonb(t) INTO v_p,v_t FROM public.tournament_players p
 JOIN public.tournaments t ON t.id=p.tournament_id WHERE p.id=p_registration;
 IF v_p IS NULL THEN RAISE EXCEPTION 'Original tournament registration is missing' USING ERRCODE='55000'; END IF;
 IF p_asset='chips' AND p_amount>0 THEN
   SELECT * INTO v_e FROM public.tournament_refund_entitlements WHERE id=p_entitlement;
   SELECT to_jsonb(l) INTO v_l FROM public.chip_ledger l WHERE id=v_e.source_ledger_id;
   SELECT to_jsonb(w) INTO v_w FROM public.wallet_transactions w WHERE id=p_wallet;
   IF v_e.id IS NULL OR v_e.entitlement_kind<>'wallet_charge'
      OR v_e.tournament_id IS DISTINCT FROM (v_p->>'tournament_id')::uuid
      OR v_e.user_id IS DISTINCT FROM (v_p->>'user_id')::uuid
      OR v_e.gross IS DISTINCT FROM p_amount OR v_l IS NULL OR v_w IS NULL
      OR v_e.charge_category IS DISTINCT FROM (CASE WHEN p_operation='entry' THEN 'tournament_buyin' WHEN p_operation='addon' THEN 'addon' ELSE 'rebuy' END)
      OR (v_l->>'amount')::numeric IS DISTINCT FROM p_amount
      OR v_l->>'club_id' IS DISTINCT FROM v_e.refund_wallet_club_id::text
      OR v_l->>'from_entity_id' IS DISTINCT FROM v_e.user_id::text
      OR v_l->>'from_type' IS DISTINCT FROM 'player_wallet'
      OR v_l->>'to_type' IS DISTINCT FROM 'prize_liability'
      OR v_l->>'to_entity_id' IS DISTINCT FROM v_e.tournament_id::text
      OR v_w->>'user_id' IS DISTINCT FROM v_e.user_id::text
      OR v_w->>'related_entity_id' IS DISTINCT FROM v_e.tournament_id::text
      OR v_w->>'type' IS DISTINCT FROM 'debit'
      OR (v_w->>'amount')::numeric IS DISTINCT FROM p_amount THEN
     RAISE EXCEPTION 'Original tournament funding references do not match' USING ERRCODE='23514';
   END IF;
 END IF;
 INSERT INTO public.tournament_participant_funding_receipts(
 registration_id,tournament_id,user_id,operation,purchase_key,asset,amount,
 entitlement_id,ledger_id,wallet_transaction_id,funding_club_id,
 registration_snapshot,tournament_snapshot,entitlement_snapshot,ledger_snapshot,wallet_snapshot,custody_result)
 VALUES(p_registration,(v_p->>'tournament_id')::uuid,(v_p->>'user_id')::uuid,p_operation,p_key,p_asset,p_amount,
 v_e.id,v_e.source_ledger_id,p_wallet,v_e.refund_wallet_club_id,v_p,v_t,
 CASE WHEN v_e.id IS NOT NULL THEN to_jsonb(v_e) END,v_l,v_w,p_custody);
END $function$;
ALTER FUNCTION public.fn_ca_record_tournament_participant_funding(p_registration uuid, p_operation text, p_key text, p_amount numeric, p_asset text, p_entitlement uuid, p_wallet uuid, p_custody jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_record_tournament_participant_funding(p_registration uuid, p_operation text, p_key text, p_amount numeric, p_asset text, p_entitlement uuid, p_wallet uuid, p_custody jsonb) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_record_tournament_participant_funding(p_registration uuid, p_operation text, p_key text, p_amount numeric, p_asset text, p_entitlement uuid, p_wallet uuid, p_custody jsonb)

-- @@DOOR fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer)
-- @@PIN md5=3960a8bc558ead330e1e47e7a38e31c4 len=633 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer DEFAULT 1)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_gross_cents IS NULL OR p_gross_cents <= 0 THEN 0
    WHEN p_ratio IS NULL THEN NULL
    WHEN p_ratio <= 0 THEN 0
    ELSE LEAST(
      public.fn_ca_unit_floor_cents(
        trunc(p_gross_cents::numeric * p_ratio + 0.000001)::bigint, p_unit_cents),
      public.fn_ca_unit_floor_cents(
        trunc(p_gross_cents::numeric * 0.1 + 0.000001)::bigint, p_unit_cents))
  END;
$function$;
ALTER FUNCTION public.fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer)

-- @@DOOR fn_ca_register_diamond_journal_row(p_tx_id uuid)
-- @@PIN md5=0f64c74772d556971760abc3962e7a6a len=3314 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t record; v_origin text; v_action text; v_label text; v_actorlb text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_actor uuid := auth.uid();
BEGIN
  SELECT * INTO t FROM public.diamond_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.diamond_tx_id = t.id) THEN
    RETURN false;
  END IF;
  v_origin := public.fn_ca_diamond_journal_origin(t.type, t.transaction_type, t.source, t.issuance_class, t.amount);
  IF v_origin IS NULL THEN RETURN false; END IF;

  v_action := CASE WHEN t.amount > 0 THEN 'mint' ELSE 'burn' END;
  v_after  := COALESCE(t.balance_after, 0);
  v_before := v_after - t.amount;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = t.user_id;
  v_label := COALESCE(v_label, t.user_id::text);
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_actorlb FROM public.profiles p WHERE p.id = v_actor;
  v_op := 'diamond-journal:' || v_origin || ':' || t.id::text;
  v_reason := CASE v_action
                WHEN 'mint' THEN 'The Mint issued ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
                ELSE 'The Mint retired ' || abs(t.amount)::text || ' diamonds (' || v_origin || '): '
              END
              || COALESCE(NULLIF(btrim(t.description), ''), COALESCE(t.transaction_type, t.type, 'diamond movement'));

  -- NO GLOBAL LOCK ON THIS PATH. It used to hold pg_advisory_xact_lock('ca_mint_ledger:diamonds')
  -- to make supply_after an exact running total. An xact-scoped lock is held until the CALLER
  -- commits, so every diamond movement serialised the whole economy behind whatever transaction
  -- happened to be moving diamonds - and on 2026-09-08, once one transaction could claim several
  -- challenges at once, twenty-four movements died on lock_timeout and went unrecorded.
  --
  -- supply_after is therefore the supply OBSERVED as this row was written, not a serialised
  -- running total: two simultaneous movements may each omit the other. Nothing reads it. The
  -- authority on supply is fn_ca_mint_supply(), which sums the movements, and the identity that
  -- matters - that sum equals what players hold - does not depend on this column at all.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  v_supply := v_supply + CASE WHEN v_action = 'mint' THEN abs(t.amount) ELSE -abs(t.amount) END;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id, created_at)
  VALUES
    (v_op, v_action, 'diamonds', 'player', t.user_id, v_label, abs(t.amount),
     v_before, v_after, v_supply, v_reason,
     v_actor, v_actorlb, NULL, t.id, COALESCE(t.created_at, now()))
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END $function$;
ALTER FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_register_diamond_journal_row(p_tx_id uuid) TO service_role;
-- @@END fn_ca_register_diamond_journal_row(p_tx_id uuid)

-- @@DOOR fn_ca_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid)
-- @@PIN md5=cf0bf7f56e2e50376626c37b59cfaca8 len=21292 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_h public.tournament_cancellation_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_e public.tournament_escrow%ROWTYPE;
  v_ids uuid[];
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'cancellation receipt requires a tournament id'
      USING ERRCODE='22004';
  END IF;
  SELECT * INTO v_h FROM public.tournament_cancellation_receipts h
   WHERE h.tournament_id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable cancellation receipt',
      p_tournament_id USING ERRCODE='P0404';
  END IF;
  -- DIAMOND PHASE 8: a Diamond event's receipt is proved against custody,
  -- the Diamond ledger and the wallet journal, never against chip rails.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id,p_observed_actor_id);
  END IF;
  IF p_observed_actor_id IS NOT NULL
     AND v_h.actor_id IS DISTINCT FROM p_observed_actor_id THEN
    RAISE EXCEPTION 'cancellation actor disagrees with stored receipt'
      USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  SELECT * INTO v_e FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  IF v_t.id IS NULL
     OR upper(COALESCE(v_t.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     OR v_t.ended_at IS DISTINCT FROM v_h.settled_at
     OR v_t.current_players IS DISTINCT FROM 0
     OR v_t.prize_pool IS DISTINCT FROM 0::numeric
     OR v_t.bounty_pool IS DISTINCT FROM 0::numeric
     OR v_t.total_rake IS DISTINCT FROM v_h.total_rake_after
     OR v_t.on_break IS DISTINCT FROM false
     OR v_t.break_started_at IS NOT NULL OR v_t.break_ends_at IS NOT NULL
     OR v_e.tournament_id IS NULL OR v_e.enforced IS DISTINCT FROM true
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR v_e.closed_at IS DISTINCT FROM v_h.escrow_closed_at
     OR v_e.close_note IS DISTINCT FROM v_h.escrow_close_note THEN
    RAISE EXCEPTION 'cancellation receipt lost its terminal parent or escrow state'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_player_ids OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND (tp.status::text IS DISTINCT FROM 'eliminated'
         OR tp.eliminated_at IS DISTINCT FROM v_h.settled_at
         OR COALESCE(tp.chips,0)<>0 OR COALESCE(tp.current_bounty,0)<>0)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen roster'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.closed_table_ids OR EXISTS (
    SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id
      AND (lower(COALESCE(tb.status::text,''))<>'closed'
        OR lower(COALESCE(tb.lifecycle,''))<>'closed'
        OR tb.current_players IS DISTINCT FROM 0
        OR tb.terminal_closed_at IS DISTINCT FROM v_h.settled_at)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen tables'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_seat_ids OR EXISTS (
    SELECT 1 FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'
         OR s.leave_pending IS DISTINCT FROM false
         OR s.is_sitting_out IS DISTINCT FROM false
         OR s.is_away IS DISTINCT FROM false OR s.sit_out_at IS NOT NULL
         OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen seats'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id
     AND s.left_at IS NOT DISTINCT FROM v_h.settled_at;
  IF v_ids IS DISTINCT FROM v_h.released_seat_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its released-seat identity'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(x.registration_id ORDER BY x.registration_id),
                  ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT DISTINCT (line->>'registration_id')::uuid AS registration_id
        FROM jsonb_array_elements(v_h.receipt->'refunds') line
      UNION
      SELECT DISTINCT (line->>'registration_id')::uuid AS registration_id
        FROM jsonb_array_elements(v_h.receipt->'ticket_returns') line
    ) x;
  IF v_ids IS DISTINCT FROM v_h.refunded_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its disposition roster'
      USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(x.id ORDER BY x.id),ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT unnest(v_h.source_player_ids) AS id
      EXCEPT SELECT unnest(v_h.refunded_registration_ids)
    ) x;
  IF v_ids IS DISTINCT FROM v_h.zero_refund_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its zero-disposition roster'
      USING ERRCODE='P0404';
  END IF;

  IF (SELECT count(*) FROM public.tournament_refund_tranches tr
       WHERE tr.tournament_id=p_tournament_id
         AND tr.source='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.refund_line_count
     OR (SELECT round(COALESCE(sum(tr.amount_paid_now),0),2)
           FROM public.tournament_refund_tranches tr
          WHERE tr.tournament_id=p_tournament_id
            AND tr.source='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.total_refunded
     OR EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(
           registration_id uuid,user_id uuid,entitlement_id uuid,
           entitlement_kind text,source_wallet_club_id uuid,
           gross_paid numeric,amount_paid_before numeric,amount_paid_now numeric,
           refund_prize numeric,refund_bounty numeric,refund_fee numeric,
           obligation_id uuid,idempotency_key text,credit_ledger_id uuid,
           wallet_transaction_id uuid)
         LEFT JOIN public.tournament_players tp ON tp.id=line.registration_id
         LEFT JOIN public.tournament_refund_entitlements e
           ON e.id=line.entitlement_id
         LEFT JOIN public.tournament_refund_tranches tr
           ON tr.wallet_transaction_id=line.wallet_transaction_id
         LEFT JOIN public.tournament_obligations o ON o.id=line.obligation_id
         LEFT JOIN public.wallet_transactions w ON w.id=line.wallet_transaction_id
         LEFT JOIN public.wallet_credit_idempotency k ON k.key=line.idempotency_key
         LEFT JOIN public.chip_ledger l ON l.id=line.credit_ledger_id
        WHERE tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
           OR tp.user_id IS DISTINCT FROM line.user_id
           OR e.id IS NULL OR e.tournament_id IS DISTINCT FROM p_tournament_id
           OR e.user_id IS DISTINCT FROM line.user_id
           OR e.entitlement_kind NOT IN ('wallet_charge','satellite_seat','tournament_ticket')
           OR e.entitlement_kind IS DISTINCT FROM line.entitlement_kind
           OR e.refund_wallet_club_id IS DISTINCT FROM line.source_wallet_club_id
           OR e.gross IS DISTINCT FROM line.amount_paid_now
           OR e.refund_prize IS DISTINCT FROM line.refund_prize
           OR e.refund_bounty IS DISTINCT FROM line.refund_bounty
           OR e.refund_fee IS DISTINCT FROM line.refund_fee
           OR (e.entitlement_kind IN ('satellite_seat','tournament_ticket')
               AND e.registration_id IS DISTINCT FROM line.registration_id)
           OR line.gross_paid IS DISTINCT FROM line.amount_paid_now
           OR line.amount_paid_now IS DISTINCT FROM
                round(line.refund_prize+line.refund_bounty+line.refund_fee,2)
           OR tr.wallet_transaction_id IS NULL
           OR tr.idempotency_key IS DISTINCT FROM line.idempotency_key
           OR tr.tournament_id IS DISTINCT FROM p_tournament_id
           OR tr.obligation_id IS DISTINCT FROM line.obligation_id
           OR tr.user_id IS DISTINCT FROM line.user_id
           OR tr.source_wallet_club_id IS DISTINCT FROM line.source_wallet_club_id
           OR tr.entitlement_id IS DISTINCT FROM line.entitlement_id
           OR tr.credit_ledger_id IS DISTINCT FROM line.credit_ledger_id
           OR tr.amount_paid_before IS DISTINCT FROM line.amount_paid_before
           OR tr.amount_paid_now IS DISTINCT FROM line.amount_paid_now
           OR tr.refund_prize IS DISTINCT FROM line.refund_prize
           OR tr.refund_bounty IS DISTINCT FROM line.refund_bounty
           OR tr.refund_fee IS DISTINCT FROM line.refund_fee
           OR tr.source IS DISTINCT FROM 'atomic_cancel_tournament'
           OR o.id IS NULL OR o.tournament_id IS DISTINCT FROM p_tournament_id
           OR o.kind IS DISTINCT FROM 'refund' OR o.place IS NOT NULL
           OR o.user_id IS DISTINCT FROM line.user_id OR o.settled_at IS NULL
           OR o.amount_paid IS DISTINCT FROM o.amount_owed
           OR o.amount_paid IS DISTINCT FROM (
             SELECT round(COALESCE(sum(all_tr.amount_paid_now),0),2)
               FROM public.tournament_refund_tranches all_tr
              WHERE all_tr.obligation_id=o.id)
           OR w.id IS NULL OR w.user_id IS DISTINCT FROM line.user_id
           OR w.related_entity_id IS DISTINCT FROM p_tournament_id
           OR w.type IS DISTINCT FROM 'credit' OR lower(w.category)<>'refund'
           OR w.amount IS DISTINCT FROM line.amount_paid_now
           OR k.key IS NULL OR k.user_id IS DISTINCT FROM line.user_id
           OR k.amount IS DISTINCT FROM line.amount_paid_now
           OR l.id IS NULL OR l.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR l.from_type IS DISTINCT FROM 'prize_liability'
           OR l.from_entity_id IS DISTINCT FROM p_tournament_id
           OR l.to_type IS DISTINCT FROM 'player_wallet'
           OR l.to_entity_id IS DISTINCT FROM line.user_id
           OR l.amount IS DISTINCT FROM line.amount_paid_now)
     OR EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.tournament_id=p_tournament_id
          AND tr.source='atomic_cancel_tournament'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(
              wallet_transaction_id uuid)
             WHERE line.wallet_transaction_id=tr.wallet_transaction_id)) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact refund evidence'
      USING ERRCODE='P0404';
  END IF;

  IF (SELECT count(*) FROM public.tournament_tickets tk
       WHERE tk.id=ANY(v_h.ticket_return_ids))
       IS DISTINCT FROM v_h.ticket_return_count
     OR (SELECT round(COALESCE(sum(tk.value),0),2)
           FROM public.tournament_tickets tk
          WHERE tk.id=ANY(v_h.ticket_return_ids))
       IS DISTINCT FROM v_h.total_ticket_returned
     OR EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_h.receipt->'ticket_returns') AS line(
           registration_id uuid,user_id uuid,entitlement_id uuid,
           entitlement_kind text,ticket_id uuid,
           value numeric,source_wallet_club_id uuid,source_satellite_id uuid,
           refund_prize numeric,refund_bounty numeric,refund_fee numeric,
           ledger_id uuid,transaction_id uuid)
         LEFT JOIN public.tournament_players tp ON tp.id=line.registration_id
         LEFT JOIN public.tournament_refund_entitlements e
           ON e.id=line.entitlement_id
         LEFT JOIN public.tournament_tickets tk ON tk.id=line.ticket_id
         LEFT JOIN public.chip_ledger l ON l.id=line.ledger_id
         LEFT JOIN public.chip_transactions ct ON ct.id=line.transaction_id
        WHERE tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
           OR tp.user_id IS DISTINCT FROM line.user_id
           OR e.id IS NULL OR e.tournament_id IS DISTINCT FROM p_tournament_id
           OR e.user_id IS DISTINCT FROM line.user_id
           OR e.entitlement_kind NOT IN ('satellite_seat','tournament_ticket')
           OR e.entitlement_kind IS DISTINCT FROM line.entitlement_kind
           OR e.registration_id IS DISTINCT FROM line.registration_id
           OR e.source_satellite_id IS DISTINCT FROM line.source_satellite_id
           OR e.refund_wallet_club_id IS DISTINCT FROM line.source_wallet_club_id
           OR e.gross IS DISTINCT FROM line.value
           OR e.refund_prize IS DISTINCT FROM line.refund_prize
           OR e.refund_bounty IS DISTINCT FROM line.refund_bounty
           OR e.refund_fee IS DISTINCT FROM line.refund_fee
           OR EXISTS (SELECT 1 FROM public.tournament_refund_tranches tr
                       WHERE tr.entitlement_id=line.entitlement_id)
           OR tk.id IS NULL OR tk.id<>ALL(v_h.ticket_return_ids)
           OR tk.source_refund_entitlement_id IS DISTINCT FROM line.entitlement_id
           OR tk.source_tournament_id IS DISTINCT FROM p_tournament_id
           OR tk.source_satellite_id IS DISTINCT FROM line.source_satellite_id
           OR tk.holder_id IS DISTINCT FROM line.user_id
           OR tk.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR tk.value IS DISTINCT FROM line.value
           OR tk.status NOT IN ('issued','redeemed')
           OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
           OR tk.entry_prize IS DISTINCT FROM line.refund_prize
           OR tk.entry_bounty IS DISTINCT FROM line.refund_bounty
           OR tk.entry_fee IS DISTINCT FROM line.refund_fee
           OR l.id IS NULL
           OR l.idempotency_key IS DISTINCT FROM
                'tourney:'||p_tournament_id::text
                  ||':satellite-ticket-return:'||line.entitlement_id::text
           OR l.tournament_id IS DISTINCT FROM p_tournament_id
           OR l.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR l.from_type IS DISTINCT FROM 'prize_liability'
           OR l.from_entity_id IS DISTINCT FROM p_tournament_id
           OR l.to_type IS DISTINCT FROM 'escrow'
           OR l.to_entity_id IS DISTINCT FROM line.ticket_id
           OR l.category IS DISTINCT FROM 'ticket_issue'
           OR l.amount IS DISTINCT FROM line.value
           OR l.metadata->>'entitlement_kind'
                IS DISTINCT FROM line.entitlement_kind
           OR ct.id IS NULL OR ct.club_id IS DISTINCT FROM line.source_wallet_club_id
           OR ct.to_user_id IS DISTINCT FROM line.user_id
           OR ct.amount IS DISTINCT FROM line.value
           OR ct.transaction_type IS DISTINCT FROM 'tournament_ticket_issue'
           OR ct.metadata->>'ticket_id' IS DISTINCT FROM line.ticket_id::text
           OR ct.metadata->>'entitlement_id' IS DISTINCT FROM line.entitlement_id::text
           OR ct.metadata->>'entitlement_kind'
                IS DISTINCT FROM line.entitlement_kind
           OR ct.metadata->>'ledger_id' IS DISTINCT FROM line.ledger_id::text)
     OR EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.id=ANY(v_h.ticket_return_ids)
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(
              v_h.receipt->'ticket_returns') AS line(ticket_id uuid)
             WHERE line.ticket_id=tk.id)) THEN
    RAISE EXCEPTION 'cancellation receipt lost satellite entry-ticket evidence'
      USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(r.id ORDER BY r.id),ARRAY[]::uuid[])
    INTO v_ids FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id
     AND r.source='atomic_cancel_tournament';
  IF v_ids IS DISTINCT FROM v_h.fee_reversal_ids
     OR (SELECT round(COALESCE(sum(r.rake_amount),0),2)
           FROM public.rake_records r
          WHERE r.tournament_id=p_tournament_id AND r.is_tournament)
        IS DISTINCT FROM v_h.total_rake_after
     OR (SELECT round(COALESCE(-sum(r.rake_amount),0),2)
           FROM public.rake_records r WHERE r.id=ANY(v_h.fee_reversal_ids))
        IS DISTINCT FROM v_h.fees_reversed
     OR EXISTS (
       SELECT 1 FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_h.fee_reversal_ids)
          AND (reversal.rake_amount>=0
            OR reversal.club_id IS NULL
            OR reversal.source IS DISTINCT FROM 'atomic_cancel_tournament'
            OR reversal.metadata->>'kind' NOT IN (
                 'tournament_fee_refund','spin_rake_refund')
            OR (reversal.metadata->>'kind'='tournament_fee_refund' AND (
              jsonb_typeof(reversal.metadata->'original_rake_record_ids')
                IS DISTINCT FROM 'array'
              OR jsonb_array_length(
                   reversal.metadata->'original_rake_record_ids')
                 IS DISTINCT FROM (
                   SELECT count(*)::integer
                     FROM jsonb_array_elements_text(
                       reversal.metadata->'original_rake_record_ids') source(id)
                     JOIN public.rake_records original
                       ON original.id=source.id::uuid
                    WHERE original.tournament_id=p_tournament_id
                      AND original.club_id=reversal.club_id
                      AND original.metadata->>'user_id'=
                          reversal.metadata->>'user_id')
              OR (SELECT round(COALESCE(sum(original.rake_amount),0),2)
                    FROM jsonb_array_elements_text(
                      reversal.metadata->'original_rake_record_ids') source(id)
                    JOIN public.rake_records original ON original.id=source.id::uuid
                   WHERE original.tournament_id=p_tournament_id
                     AND original.club_id=reversal.club_id
                     AND original.metadata->>'user_id'=
                         reversal.metadata->>'user_id')
                 IS DISTINCT FROM -reversal.rake_amount))
            OR (reversal.metadata->>'kind'='spin_rake_refund' AND NOT EXISTS (
              SELECT 1 FROM public.rake_records original
               WHERE original.id::text=
                       reversal.metadata->>'original_rake_record_id'
                 AND original.tournament_id=p_tournament_id
                 AND original.club_id=reversal.club_id
                 AND original.source IN (
                       'fn_spin_book_entry','fn_spin_settle_game')
                 AND original.rake_amount=-reversal.rake_amount)))) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact fee evidence'
      USING ERRCODE='P0404';
  END IF;

  IF v_h.spin_unwind_tournament_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tournament_spin_cancellation_unwinds u
    JOIN public.spin_reserve_ledger c ON c.id=u.original_contribution_id
    JOIN public.spin_reserve_ledger cr ON cr.id=u.contribution_reversal_id
    JOIN public.chip_ledger cj ON cj.id=u.original_entry_journal_id
    JOIN public.chip_ledger crj ON crj.id=u.contribution_reversal_journal_id
     WHERE u.tournament_id=p_tournament_id AND c.kind='contribution'
       AND cr.kind='contribution_reversal' AND cr.amount=-c.amount
       AND cj.category='spin_entry' AND cj.amount=c.amount
       AND crj.category='reversal' AND crj.amount=c.amount
       AND crj.idempotency_key='spin:'||p_tournament_id::text||':cancel:entry'
       AND ((u.draw_amount=0 AND u.original_draw_id IS NULL
             AND u.draw_reversal_id IS NULL)
         OR (u.draw_amount>0 AND EXISTS (
           SELECT 1 FROM public.spin_reserve_ledger d
           JOIN public.spin_reserve_ledger dr ON dr.id=u.draw_reversal_id
           JOIN public.chip_ledger dj ON dj.id=u.original_draw_journal_id
           JOIN public.chip_ledger drj ON drj.id=u.draw_reversal_journal_id
            WHERE d.id=u.original_draw_id AND d.kind='jackpot_draw'
              AND dr.kind='draw_reversal' AND dr.amount=-d.amount
              AND dj.category='spin_prize' AND dj.amount=-d.amount
              AND drj.category='reversal' AND drj.amount=-d.amount
              AND drj.idempotency_key=
                  'spin:'||p_tournament_id::text||':cancel:draw')))) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact Spin unwind evidence'
      USING ERRCODE='P0404';
  END IF;
  IF v_h.spin_unwind_tournament_id IS NULL AND EXISTS (
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.kind='contribution') THEN
    RAISE EXCEPTION 'cancellation receipt omitted the Spin contribution unwind'
      USING ERRCODE='P0404';
  END IF;
  RETURN v_h.receipt;
END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid)

-- @@DOOR fn_ca_tournament_escrow(p_tournament_id uuid)
-- @@PIN md5=707b4cbeb6f4906c2216cefea6635ca8 len=711 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)
   WHERE public.fn_poker_diamond_tournament(p_tournament_id)
  UNION ALL
  SELECT * FROM public.fn_ca_tournament_escrow_chips(p_tournament_id)
   WHERE NOT public.fn_poker_diamond_tournament(p_tournament_id);
$function$;
ALTER FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid) TO service_role;
-- @@END fn_ca_tournament_escrow(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_escrow_chips(p_tournament_id uuid)
-- @@PIN md5=bf70fec2d07ab459fe1da245bfb59ee7 len=7796 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow_chips(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH t AS (
  SELECT id,COALESCE(buy_in_amount,0) AS buy_in_amount,
         COALESCE(buy_in_fee,0) AS buy_in_fee,
         COALESCE(bounty_amount,0) AS bounty_amount,
         (COALESCE(is_bounty,false) OR COALESCE(is_pko,false)
          OR COALESCE(is_mystery_bounty,false)) AS is_b
    FROM public.tournaments WHERE id=p_tournament_id
), w AS (
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type='debit'
      AND category IN ('tournament_buyin','rebuy','addon')),0) AS gross_in,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='prize'),0)
      - COALESCE(sum(amount) FILTER (WHERE type='debit'
          AND category IN ('prize','prize_reversal')),0) AS prize_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='bounty'),0)
      AS bounty_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit'
      AND category IN ('refund','tournament_refund')),0) AS refund_out
  FROM public.wallet_transactions WHERE related_entity_id=p_tournament_id
), direct_bounty AS (
  SELECT round(COALESCE(sum(CASE
    WHEN NOT t.is_b OR lower(l.category)='addon' THEN 0
    WHEN lower(l.category)='tournament_buyin' THEN round(t.bounty_amount,2)
    ELSE public.fn_ca_unit_floor_cents(
      round(LEAST(
        GREATEST(0,round(t.bounty_amount,2)),
        round(l.amount,2)-public.fn_ca_recovery_fee_cents(
          round(round(l.amount,2)*100)::bigint,
          public.fn_ca_tournament_fee_ratio(t.buy_in_amount,t.buy_in_fee),
          public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100
      )*100)::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100    END),0),2) AS amount
  FROM t JOIN public.chip_ledger l
    ON l.tournament_id=p_tournament_id
   AND l.from_type='player_wallet' AND l.to_type='prize_liability'
   AND l.to_entity_id=p_tournament_id
   AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
), rr AS (
  SELECT
    COALESCE(sum(rake_amount),0) AS fee_in,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS fee_sat,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'
        AND metadata->>'entry_split_version'='2'),0) AS fee_sat_split,
    COALESCE(sum(COALESCE(pot_size,0)-rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS satellite_in
  FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament
    AND NOT (rake_amount<0 AND source IN (
      'atomic_cancel_tournament','fn_unregister_from_tournament'))
), ov AS (
  SELECT COALESCE(sum(a.amount),0) AS ledger_overlay
    FROM public.chip_ledger a
   WHERE a.to_entity_id=p_tournament_id
     AND a.to_type='prize_liability'
     AND (a.category='overlay' OR
       (a.category='correction' AND a.from_type IN ('union_bank','club_treasury')))
     AND NOT (COALESCE(a.description,'') LIKE 'auto-ledgered%'
       AND EXISTS (
         SELECT 1 FROM public.chip_ledger b
          WHERE b.to_entity_id=a.to_entity_id AND b.category='overlay'
            AND b.to_type='prize_liability' AND b.id<>a.id
            AND b.amount=a.amount
            AND COALESCE(b.description,'') NOT LIKE 'auto-ledgered%'
            AND abs(extract(epoch FROM (b.created_at-a.created_at)))<5))
), stl AS (
  SELECT COALESCE(sum(amount),0) AS moved,
    COALESCE(sum(amount) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_moved,
    COALESCE(sum((metadata->>'entry_fee')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_fee,
    COALESCE(sum((metadata->>'entry_bounty')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_bounty
  FROM public.chip_ledger
  WHERE to_entity_id=p_tournament_id AND to_type='prize_liability'
    AND idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'
), tk AS (
  /* A TICKET ENTRY IS AN ENTRY (2026-09-10): a tournament-entry ticket
     redeemed into this event moves its value escrow -> prize_liability
     with no wallet debit and no pool transfer; the escrow triggers count
     it as an entry and so must the shadow. */
  SELECT COALESCE(sum(amount),0) AS ticket_in
    FROM public.chip_ledger
   WHERE to_entity_id=p_tournament_id AND to_type='prize_liability'
     AND from_type='escrow' AND category='ticket_redeem'
), tgo AS (
  SELECT COALESCE(sum(amount),0) AS tgo_amount
    FROM public.tournament_guarantee_overlays
   WHERE tournament_id=p_tournament_id
), sat AS (
  SELECT COALESCE(sum(p.amount),0) AS funded_awards_out
    FROM public.tournament_payouts p
    LEFT JOIN public.tournament_satellite_awards a
      ON a.payout_id=p.id
     AND a.tournament_id=p.tournament_id
     AND a.delivery_kind='ticket'
   WHERE p.tournament_id=p_tournament_id
     AND (p.source='satellite_seat'
       OR (p.source='satellite_ticket' AND a.payout_id IS NOT NULL))
), fo AS (
  SELECT COALESCE(sum(amount),0) AS fee_out
    FROM public.tournament_rake_settlements
   WHERE tournament_id=p_tournament_id AND settled_at IS NOT NULL
), exact_refunds AS (
  SELECT COALESCE(sum(amount_paid_now),0) AS total,
         COALESCE(sum(refund_prize),0) AS prize,
         COALESCE(sum(refund_bounty),0) AS bounty,
         COALESCE(sum(refund_fee),0) AS fee
    FROM public.tournament_refund_tranches
   WHERE tournament_id=p_tournament_id
), calc AS (
  SELECT
    round(w.gross_in+stl.split_moved-stl.split_fee+tk.ticket_in,2) AS gross_in,
    round(rr.fee_in,2) AS fee_in,
    round(rr.fee_in-rr.fee_sat,2) AS fee_entries,
    round(direct_bounty.amount+stl.split_bounty,2) AS bounty_in,
    round(CASE WHEN ov.ledger_overlay>0 THEN ov.ledger_overlay
      ELSE tgo.tgo_amount END,2) AS overlay_in,
    round(stl.moved-stl.split_moved-rr.fee_sat+rr.fee_sat_split,2)
      AS satellite_in,
    round(w.prize_out+sat.funded_awards_out,2) AS prize_out,
    round(w.bounty_out,2) AS bounty_out,
    round(fo.fee_out,2) AS fee_out,
    round(w.refund_out,2) AS refund_out,
    round(exact_refunds.total,2) AS exact_total,
    round(exact_refunds.prize,2) AS exact_prize,
    round(exact_refunds.bounty,2) AS exact_bounty,
    round(exact_refunds.fee,2) AS exact_fee
  FROM t,w,direct_bounty,rr,stl,ov,tk,tgo,sat,fo,exact_refunds
), split AS (
  SELECT c.*,round(c.gross_in-c.fee_entries-c.bounty_in,2) AS prize_in,
         round(c.refund_out-c.exact_total,2) AS legacy_refund
    FROM calc c
), apportioned AS (
  SELECT s.*,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*(s.prize_in+s.satellite_in)
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE s.legacy_refund END AS legacy_prize,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*s.bounty_in
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE 0 END AS legacy_bounty
  FROM split s
)
SELECT a.prize_in,a.bounty_in,a.fee_in,a.overlay_in,a.satellite_in,
       a.prize_out,a.bounty_out,a.fee_out,a.refund_out,
       round(a.prize_in+a.overlay_in+a.satellite_in-a.prize_out
         -a.legacy_prize-a.exact_prize,2) AS prize_balance,
       round(a.bounty_in-a.bounty_out-a.legacy_bounty-a.exact_bounty,2)
         AS bounty_balance,
       round(a.fee_in-a.fee_out
         -(a.legacy_refund-a.legacy_prize-a.legacy_bounty)-a.exact_fee,2)
         AS fee_balance
  FROM apportioned a;
$function$;
ALTER FUNCTION public.fn_ca_tournament_escrow_chips(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow_chips(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow_chips(p_tournament_id uuid) TO service_role;
-- @@END fn_ca_tournament_escrow_chips(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric)
-- @@PIN md5=858c3f3cda609a0b427f294d1c9edf36 len=397 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_buy_in,0) + COALESCE(p_buy_in_fee,0) > 0
         AND COALESCE(p_buy_in_fee,0) > 0
      THEN p_buy_in_fee / (p_buy_in + p_buy_in_fee)
    ELSE 0.1
  END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric)

-- @@DOOR fn_ca_tournament_is_unlimited(p_tournament_id uuid)
-- @@PIN md5=fd66c28075f1d7c63b9d763632592471 len=436 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
 v_abi:=public.fn_ca_lock_mtt_admission_contract();
 IF v_abi='legacy-capacity-v1' THEN RETURN false; END IF;
 RETURN public.fn_ca_tournament_recorded_format(p_tournament_id) IN ('mtt-v1','mtt-v2');
END $function$;
ALTER FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_is_unlimited(p_tournament_id uuid) TO authenticated, service_role;
-- @@END fn_ca_tournament_is_unlimited(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_recorded_format(p_tournament_id uuid)
-- @@PIN md5=a7357dd1366f930eba6cd7f404090bbd len=568 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_format text;
BEGIN
  SELECT format_contract INTO v_format FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND OR v_format IS NULL OR v_format NOT IN
     ('mtt-v1','mtt-v2','seat-first-satellite-v1','sng-v1','spin-v1') THEN
    RAISE EXCEPTION 'TOURNAMENT_FORMAT_NOT_PROVEN' USING ERRCODE='55000';
  END IF;
  RETURN v_format;
END $function$;
ALTER FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_recorded_format(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_recorded_format(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_unit_cents(p_tournament_id uuid)
-- @@PIN md5=426ba550ff84f4210906a0071538803b len=441 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id
       AND c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
  ) THEN 100 ELSE 1 END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_unit_cents(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_unit_cents(p_tournament_id uuid)

-- @@DOOR fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_request_id uuid)
-- @@PIN md5=a1eb3a788f88279d07cd421e5fee5a69 len=14315 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid DEFAULT NULL::uuid, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_r public.tournament_unregistration_receipts%ROWTYPE;
  v_entitlement_count integer;
  v_fee_entitlement_count integer;
  v_entitlement_total numeric;
  v_entitlement_fee numeric;
  v_source_count integer;
  v_wallet_count integer;
  v_wallet_total numeric;
  v_ticket_count integer;
  v_ticket_total numeric;
  v_ticket_ledger_count integer;
  v_ticket_transaction_count integer;
  v_fee_reversal_count integer;
  v_fee_reversal_total numeric;
  v_fee_source_ids uuid[];
  v_fee_mapping_count integer;
  v_fee_mapping_entitlement_count integer;
  v_fee_mapping_ids uuid[];
BEGIN
  SELECT * INTO v_r
    FROM public.tournament_unregistration_receipts r
   WHERE r.tournament_id=p_tournament_id AND r.user_id=p_user_id
     AND r.source_table_id IS NOT DISTINCT FROM p_source_table_id
     AND (p_request_id IS NULL OR r.request_id=p_request_id)
   ORDER BY r.settled_at DESC,r.registration_id DESC
   LIMIT 1;
  IF v_r.registration_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A later registration, including an eliminated one, makes an unkeyed
  -- "latest receipt" unsafe. The exact request-key path is also refused while
  -- any later registration row exists: a replay is an outcome read, never an
  -- operation against a new lifecycle.
  IF EXISTS(
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=v_r.tournament_id AND tp.user_id=v_r.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*),count(*) FILTER (WHERE e.refund_fee>0),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.refund_fee),0),2)
    INTO v_entitlement_count,v_fee_entitlement_count,
         v_entitlement_total,v_entitlement_fee
    FROM public.tournament_refund_entitlements e
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*) INTO v_source_count
    FROM unnest(v_r.entitlement_ids) WITH ORDINALITY entitlement(id,n)
    JOIN unnest(v_r.source_wallet_club_ids) WITH ORDINALITY source(club_id,n)
      USING(n)
    JOIN public.tournament_refund_entitlements e
      ON e.id=entitlement.id AND e.refund_wallet_club_id=source.club_id
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind IN ('wallet_charge','satellite_seat','tournament_ticket')
     AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
     AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
     AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tk.value),0),2)
    INTO v_ticket_count,v_ticket_total
    FROM public.tournament_tickets tk
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND tk.redemption_mode='tournament_entry_only'
     AND e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id
     AND tk.value=e.gross;
  SELECT count(*) INTO v_ticket_ledger_count
    FROM public.chip_ledger l
    JOIN public.tournament_tickets tk ON tk.id=l.to_entity_id
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text
     AND l.from_type='prize_liability'
     AND l.from_entity_id=e.tournament_id
     AND l.to_type='escrow' AND l.to_entity_id=tk.id
     AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross;
  SELECT count(*) INTO v_ticket_transaction_count
    FROM public.chip_transactions ct
    JOIN public.tournament_tickets tk
      ON tk.id::text=ct.metadata->>'ticket_id'
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
    JOIN public.chip_ledger l
      ON l.id::text=ct.metadata->>'ledger_id'
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND ct.transaction_type='tournament_ticket_issue'
     AND ct.club_id=e.refund_wallet_club_id
     AND ct.from_user_id IS NULL AND ct.to_user_id=e.user_id
     AND ct.amount=e.gross
     AND ct.metadata->>'entitlement_id'=e.id::text
     AND l.to_entity_id=tk.id
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text;

  SELECT count(*),round(COALESCE(-sum(reversal.rake_amount),0),2)
    INTO v_fee_reversal_count,v_fee_reversal_total
    FROM public.rake_records reversal
   WHERE reversal.id=ANY(v_r.fee_reversal_ids)
     AND reversal.tournament_id=v_r.tournament_id
     AND reversal.is_tournament IS TRUE
     AND reversal.source='fn_unregister_from_tournament'
     AND reversal.rake_amount<0
     AND reversal.metadata->>'kind'='tournament_fee_refund'
     AND reversal.metadata->>'user_id'=v_r.user_id::text
     AND reversal.metadata->>'registration_id'=v_r.registration_id::text;
  SELECT COALESCE(array_agg(source.id ORDER BY source.id),ARRAY[]::uuid[])
    INTO v_fee_source_ids
    FROM public.rake_records reversal
   CROSS JOIN LATERAL jsonb_array_elements_text(
     reversal.metadata->'original_rake_record_ids') raw(id)
   JOIN LATERAL (SELECT raw.id::uuid AS id) source ON true
   WHERE reversal.id=ANY(v_r.fee_reversal_ids);
  WITH exact_fee_mapping AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.id=ANY(v_r.fee_source_rake_record_ids)
       AND r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_r.registration_id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_r.entitlement_ids) AND e.refund_fee>0
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_mapping_count,v_fee_mapping_entitlement_count,v_fee_mapping_ids
    FROM exact_fee_mapping;

  IF (v_r.start_authority='scheduled_clock'
       AND v_r.settled_at>=v_r.scheduled_start_at)
     OR (v_r.start_authority IN (
           'spin_actual_start','heads_up_sng_actual_start','launch_release')
       AND EXISTS (
         SELECT 1
           FROM public.tournament_launch_receipts launch
          WHERE launch.tournament_id=v_r.tournament_id
            AND launch.completed_at IS NOT NULL
            AND launch.completed_at<=v_r.settled_at))
     OR (v_r.start_authority='spin_actual_start'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id=v_r.tournament_id
            AND t.satellite_target_id IS NULL
            AND upper(COALESCE(t.tournament_type::text,''))<>'SATELLITE'
            AND (lower(COALESCE(t.variant::text,''))='spin'
              OR upper(COALESCE(t.tournament_type::text,''))='SPIN')))
     OR (v_r.start_authority='heads_up_sng_actual_start'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournaments t
          WHERE t.id=v_r.tournament_id
            AND t.satellite_target_id IS NULL
            AND upper(COALESCE(t.tournament_type::text,''))='SNG'
            AND lower(COALESCE(t.variant::text,''))<>'spin'
            AND COALESCE(t.max_players,0)=2))
     OR v_r.start_authority NOT IN (
          'scheduled_clock','spin_actual_start','heads_up_sng_actual_start',
          'launch_release')
     OR v_entitlement_count<>cardinality(v_r.entitlement_ids)
     OR v_source_count<>cardinality(v_r.entitlement_ids)
     OR v_entitlement_total IS DISTINCT FROM
          round(v_r.refunded_chips+v_r.returned_ticket_value,2)
     OR v_wallet_count<>cardinality(v_r.wallet_transaction_ids)
     OR v_wallet_total IS DISTINCT FROM v_r.refunded_chips
     OR v_ticket_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_total IS DISTINCT FROM v_r.returned_ticket_value
     OR v_ticket_ledger_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_transaction_count<>cardinality(v_r.ticket_ids)
     OR v_r.fees_reversed IS DISTINCT FROM v_entitlement_fee
     OR v_fee_reversal_count<>cardinality(v_r.fee_reversal_ids)
     OR v_fee_reversal_total IS DISTINCT FROM v_r.fees_reversed
     OR v_fee_source_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_count<>v_fee_entitlement_count
     OR v_fee_mapping_entitlement_count<>v_fee_entitlement_count
     OR cardinality(v_fee_source_ids)<>(
       SELECT count(DISTINCT id) FROM unnest(v_fee_source_ids) source(id))
     OR EXISTS (
       SELECT 1 FROM public.tournament_unregistration_receipts other
        WHERE other.registration_id<>v_r.registration_id
          AND (other.fee_reversal_ids && v_r.fee_reversal_ids
            OR other.fee_source_rake_record_ids
                 && v_r.fee_source_rake_record_ids))
     OR EXISTS (
       SELECT 1
         FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_r.fee_reversal_ids)
          AND (
            jsonb_typeof(reversal.metadata->'original_rake_record_ids')
              IS DISTINCT FROM 'array'
            OR jsonb_array_length(
                 reversal.metadata->'original_rake_record_ids')=0
            OR (SELECT round(COALESCE(sum(original.rake_amount),0),2)
                  FROM jsonb_array_elements_text(
                    reversal.metadata->'original_rake_record_ids') raw(id)
                  JOIN public.rake_records original
                    ON original.id=raw.id::uuid
                 WHERE original.tournament_id=v_r.tournament_id
                   AND original.club_id=reversal.club_id
                   AND original.is_tournament IS TRUE
                   AND original.rake_amount>0
                   AND original.metadata->>'user_id'=v_r.user_id::text
                   AND (
                     (original.source IN (
                        'fn_register_for_tournament',
                        'fn_register_horse_for_tournament')
                       AND original.metadata->>'kind'='tournament_entry_fee')
                     OR (original.source='process_tournament_rebuy'
                       AND original.metadata->>'kind' IN (
                         'tournament_rebuy_fee','tournament_reentry_fee'))
                     OR (original.source=
                           'fn_register_for_tournament_with_ticket'
                       AND original.metadata->>'kind'=
                           'tournament_ticket_entry_fee')
                     OR (original.source='fn_award_satellite_seat'
                       AND original.metadata->>'kind'=
                           'satellite_seat_entry_fee')))
                IS DISTINCT FROM -reversal.rake_amount))
     OR (v_r.source_table_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=v_r.source_table_id
          AND tb.tournament_id=v_r.tournament_id)) THEN
    RAISE EXCEPTION 'tournament unregistration receipt % is not exact',
      v_r.registration_id USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'request_id',v_r.request_id,
    'registration_id',v_r.registration_id,
    'refunded_chips',v_r.refunded_chips,
    'returned_ticket_value',v_r.returned_ticket_value,
    'wallet_chips_from_satellite_entitlements',(
      SELECT COALESCE(sum(tr.amount_paid_now),0)
        FROM public.tournament_refund_tranches tr
        JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
       WHERE e.id=ANY(v_r.entitlement_ids)
         AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
         AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
         AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
         AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id),
    'entitlement_ids',to_jsonb(v_r.entitlement_ids),
    'ticket_ids',to_jsonb(v_r.ticket_ids),
    'source_wallet_club_ids',to_jsonb(v_r.source_wallet_club_ids),
    'credit_ledger_ids',to_jsonb(v_r.credit_ledger_ids),
    'wallet_transaction_ids',to_jsonb(v_r.wallet_transaction_ids),
    'fees_reversed',v_r.fees_reversed,
    'fee_reversal_ids',to_jsonb(v_r.fee_reversal_ids),
    'fee_source_rake_record_ids',to_jsonb(v_r.fee_source_rake_record_ids),
    'seat_number',v_r.seat_number,'seats_taken',v_r.seats_taken,
    'scheduled_start_at',v_r.scheduled_start_at,
    'start_authority',v_r.start_authority,
    'settled_at',v_r.settled_at);
END;
$function$;
ALTER FUNCTION public.fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_request_id uuid)

-- @@DOOR fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer)
-- @@PIN md5=1aee5e7fa9aa60b575aeccd2793bd215 len=605 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer DEFAULT 1)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_cents IS NULL THEN NULL
    WHEN p_cents <= 0 THEN 0
    ELSE (trunc(p_cents::numeric
                / (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                        THEN p_unit_cents::numeric ELSE 1 END))
          * (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                  THEN p_unit_cents::numeric ELSE 1 END))::bigint
  END;
$function$;
ALTER FUNCTION public.fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer)

-- @@DOOR fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid, p_description text, p_request_id uuid)
-- @@PIN md5=3fc3f147808ab3ecc50982f5b6968bff len=30215 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
  v_receipt jsonb;
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
  v_players_before integer;
  v_rows integer;
  v_seat_number integer;
  v_seats_taken integer;
  v_non_cash_count integer;
  v_wallet_debits numeric:=0;
  v_wallet_refunds_before numeric:=0;
  v_wallet_refunds_after numeric:=0;
  v_entitled_wallet_total numeric:=0;
  v_tranche_total numeric:=0;
  v_refund_prize numeric:=0;
  v_refund_bounty numeric:=0;
  v_refund_fee numeric:=0;
  v_refund_total numeric:=0;
  v_wallet_amount numeric:=0;
  v_ticket_amount numeric:=0;
  v_running_owed numeric:=0;
  v_rake_before numeric:=0;
  v_rake_after numeric:=0;
  v_fees_reversed numeric:=0;
  v_entitlement_ids uuid[]:='{}'::uuid[];
  v_ticket_ids uuid[]:='{}'::uuid[];
  v_credit_ledger_ids uuid[]:='{}'::uuid[];
  v_wallet_transaction_ids uuid[]:='{}'::uuid[];
  v_source_wallet_club_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_ids uuid[]:='{}'::uuid[];
  v_fee_source_rake_record_ids uuid[]:='{}'::uuid[];
  v_fee_entitlement_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_id uuid;
  v_fee_source_count integer:=0;
  v_fee_source_entitlement_count integer:=0;
  v_fee_source_amount numeric:=0;
  v_request_id uuid:=COALESCE(p_request_id,gen_random_uuid());
  v_start_authority text:='scheduled_clock';
  v_launch_completed_at timestamptz;
  v_persisted_hand_exists boolean:=false;
  v_actual_status text;
  v_actual_started_at timestamptz;
  v_unregistered_at timestamptz;
  v_description text:=COALESCE(
    NULLIF(btrim(p_description),''),'Tournament unregistration refund');
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required'
      USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  -- DIAMOND PHASE 8: a Diamond entry never rode the chip rails. Every
  -- caller of this authority (the lobby, the seat, the administrator, the
  -- launch) sends it home through its own door before a chip rail is
  -- touched. A caller that named no request id is given one exactly as
  -- this authority mints its own. A seat exit naming a table the player
  -- does not sit at answers not_seated unless its request id is already
  -- settled, in which case the door replays that receipt.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    IF p_expected_table_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id AND s.left_at IS NULL)
       AND NOT (p_request_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.poker_diamond_tournament_ledger l
                   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
                     AND l.request->>'request_id'=p_request_id::text)) THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
    RETURN public.fn_poker_diamond_tournament_unregister(
      p_tournament_id, p_user_id, COALESCE(p_request_id, gen_random_uuid()));
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- Spins and Heads-Up Sit & Gos are separate products, but both are
  -- seat-first: start_time is only their human fill-window deadline. Neither
  -- product has a scheduled start. Satellite feeders remain outside this
  -- change and retain the existing scheduled-clock contract.
  IF v_t.format_contract='spin-v1' THEN
    v_start_authority:='spin_actual_start';
  ELSIF v_t.format_contract='sng-v1'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_start_authority:='heads_up_sng_actual_start';
  END IF;
  /* A release performed by the launch that holds this event's INCOMPLETE
     launch receipt has its own start authority. The clock has passed
     start_time, but no hand has been dealt (checked below, fails closed)
     and the receipt has not been completed, so the seat-first proofs -
     started_at unset, launch not completed - are the right ones and the
     receipt records launch_release. The launch names its receipt through
     the transaction-local app.ca_launch_release_launch_id, set only by
     fn_ca_release_unseatable_registrant_at_launch. */
  IF v_start_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(
            current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_start_authority:='launch_release';
  END IF;

  -- A caller-supplied request id is a durable operation identity. It may only
  -- name this exact player/event/endpoint scope. If its pre-start outcome is
  -- already committed, replay that immutable outcome even when the wall clock
  -- is now past the start; this branch performs no new unregistration writes.
  IF p_request_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id
         AND (r.tournament_id IS DISTINCT FROM p_tournament_id
           OR r.user_id IS DISTINCT FROM p_user_id
           OR r.source_table_id IS DISTINCT FROM p_expected_table_id)) THEN
      RAISE EXCEPTION 'unregistration request id belongs to another intent'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id) THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,p_request_id);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
      RAISE EXCEPTION
        'unregistration request id belongs to a prior registration lifecycle'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status::text IN ('registered','playing')
   ORDER BY tp.id LIMIT 1 FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);

  -- A persisted hand is stronger actual-start evidence than either a mutable
  -- parent status or a launch receipt that an interrupted launcher failed to
  -- complete. Canonical accepted-hand commits carry tournament_id; the
  -- table-linked branch also fails closed for older rows that omitted it. The
  -- exclusive lifecycle advisory lock above serializes this read against the
  -- shared lock held by every canonical accepted-hand commit.
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSE
    SELECT r.completed_at INTO v_launch_completed_at
      FROM public.tournament_launch_receipts r
     WHERE r.tournament_id=p_tournament_id;
    IF v_t.started_at IS NOT NULL OR v_launch_completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  END IF;
  IF v_reg.id IS NULL THEN
    -- Rolling clients without a request id may recover a just-lost response
    -- only while registration remains open. They can never turn an old receipt
    -- into a successful post-start response.
    IF p_request_id IS NULL THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,NULL);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT s.seat_number INTO v_seat_number
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id
       AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
     ORDER BY s.id LIMIT 1 FOR UPDATE OF s;
    IF v_seat_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok',false,'reason','spin_entry_already_booked');
  END IF;

  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
   ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_non_cash_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.registration_id=v_reg.id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id);
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>1 THEN
    RAISE EXCEPTION
      'satellite-funded registration % requires one unspent ticket entitlement',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  IF NOT COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>0 THEN
    RAISE EXCEPTION
      'cash registration % cannot own a satellite ticket entitlement',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(e.refund_prize),0),2),
         round(COALESCE(sum(e.refund_bounty),0),2),
         round(COALESCE(sum(e.refund_fee),0),2),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.gross),0),2),
         0::numeric
    INTO v_refund_prize,v_refund_bounty,v_refund_fee,v_refund_total,
         v_wallet_amount,v_ticket_amount
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  IF v_refund_total IS DISTINCT FROM
       round(v_refund_prize+v_refund_bounty+v_refund_fee,2)
     OR v_refund_total IS DISTINCT FROM
       round(v_wallet_amount+v_ticket_amount,2) THEN
    RAISE EXCEPTION 'registration % has invalid entitlement totals',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  -- A funded satellite entry does not invent a player-wallet debit.
  -- It returns the same escrow value in cash through its exact source proof.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND EXISTS (
       SELECT 1 FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND e.entitlement_kind='wallet_charge'
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_refund_tranches tr
             WHERE tr.entitlement_id=e.id)) THEN
    RAISE EXCEPTION
      'satellite-funded registration % has an unexpected wallet charge',
      v_reg.id USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_debits
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(e.gross),0),2) INTO v_entitled_wallet_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge';
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT round(COALESCE(sum(tr.amount_paid_now),0),2) INTO v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_wallet_debits IS DISTINCT FROM v_entitled_wallet_total
     OR v_wallet_refunds_before IS DISTINCT FROM v_tranche_total
     OR v_wallet_refunds_before>(
       SELECT COALESCE(sum(e.gross),0)
         FROM public.tournament_refund_entitlements e
        WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_tickets tk
             WHERE tk.source_refund_entitlement_id=e.id)) THEN
    RAISE EXCEPTION 'registration % wallet and entitlement journals disagree',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  v_running_owed:=v_tranche_total;

  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_before
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[])
    INTO v_fee_entitlement_ids
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND e.refund_fee>0
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);

  -- Bind every fee-bearing entitlement to its actual same-transaction rake
  -- journal. The refund wallet club is deliberately absent from this match:
  -- it identifies the payer, while rake_records.club_id identifies the fee
  -- recipient and can be a different club.
  WITH fee_sources AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id,
           r.club_id,r.rake_amount
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_fee_entitlement_ids)
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         round(COALESCE(sum(rake_amount),0),2),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_source_count,v_fee_source_entitlement_count,
         v_fee_source_amount,v_fee_source_rake_record_ids
    FROM fee_sources;
  IF v_fee_source_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_entitlement_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_count<>(
       SELECT count(DISTINCT id)
         FROM unnest(v_fee_source_rake_record_ids) source(id))
     OR v_fee_source_amount IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % fee entitlements do not map one-to-one to exact rake evidence',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.rake_records r
   WHERE r.id=ANY(v_fee_source_rake_record_ids)
   ORDER BY r.club_id,r.id FOR UPDATE;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'unregister entitlement escrow prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_players_before<=0
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance
     OR v_t.total_rake IS DISTINCT FROM v_rake_before
     OR v_t.prize_pool<v_refund_prize
     OR v_t.bounty_pool<v_refund_bounty
     OR v_t.total_rake<v_refund_fee THEN
    RAISE EXCEPTION 'registration % cannot leave divergent tournament state',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.entitlement_kind,e.id
  LOOP
    v_running_owed:=round(v_running_owed+v_ent.gross,2);
    v_settle:=public.fn_settle_tournament_refund_exact(
      p_tournament_id,p_user_id,v_ent.refund_wallet_club_id,v_running_owed,
      v_ent.refund_prize,v_ent.refund_bounty,v_ent.refund_fee,
      'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
       OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_settle->>'amount_paid')::numeric IS DISTINCT FROM v_running_owed
       OR (v_settle->>'source_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id THEN
      RAISE EXCEPTION 'registration % exact wallet refund failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_credit_ledger_ids:=array_append(
      v_credit_ledger_ids,(v_settle->>'credit_ledger_id')::uuid);
    v_wallet_transaction_ids:=array_append(
      v_wallet_transaction_ids,(v_settle->>'wallet_transaction_id')::uuid);
  END LOOP;

  FOR v_fee_group IN
    SELECT r.club_id,round(sum(r.rake_amount),2) AS fee,
           array_agg(r.id ORDER BY r.id) AS source_rake_record_ids,
           array_agg(e.id ORDER BY e.id) AS entitlement_ids
      FROM public.rake_records r
      JOIN public.tournament_refund_entitlements e
        ON e.id=ANY(v_fee_entitlement_ids)
       AND e.refund_fee=r.rake_amount
       AND e.tournament_id=r.tournament_id
       AND e.user_id=p_user_id
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
      JOIN public.chip_ledger l
        ON l.id=e.source_ledger_id AND l.created_at=r.created_at
     WHERE r.id=ANY(v_fee_source_rake_record_ids)
     GROUP BY r.club_id ORDER BY r.club_id
  LOOP
    IF v_fee_group.fee>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,metadata)
      VALUES(
        NULL,NULL,v_fee_group.club_id,-v_fee_group.fee,v_fee_group.fee,1,
        0,true,p_tournament_id,'fn_unregister_from_tournament',
        jsonb_build_object(
          'kind','tournament_fee_refund','user_id',p_user_id,
          'registration_id',v_reg.id,
          'fee_recipient_club_id',v_fee_group.club_id,
          'entitlement_ids',to_jsonb(v_fee_group.entitlement_ids),
          'original_rake_record_ids',
            to_jsonb(v_fee_group.source_rake_record_ids)))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(
        v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee_group.fee,2);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids
    FROM unnest(v_fee_reversal_ids) reversal(id);
  IF v_fees_reversed IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % reversed % in exact fee rows but owes %',
      v_reg.id,v_fees_reversed,v_refund_fee USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(v_t.prize_pool-v_refund_prize,2),
         bounty_pool=round(v_t.bounty_pool-v_refund_bounty,2),
         total_rake=round(v_t.total_rake-v_refund_fee,2),updated_at=now()
   WHERE id=p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,
         scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb
                 WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_after
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.status::text IN ('registered','playing'))<>v_players_before-1
     OR v_wallet_refunds_after IS DISTINCT FROM
          round(v_wallet_refunds_before+v_wallet_amount,2)
     OR v_escrow_after.prize_balance IS DISTINCT FROM
          round(v_escrow_before.prize_balance-v_refund_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
          round(v_escrow_before.bounty_balance-v_refund_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
          round(v_escrow_before.fee_balance-v_refund_fee,2)
     OR v_rake_after IS DISTINCT FROM round(v_rake_before-v_refund_fee,2)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=p_tournament_id
          AND t.current_players=v_players_before-1
          AND t.prize_pool=v_escrow_after.prize_balance
          AND t.bounty_pool=v_escrow_after.bounty_balance
          AND t.total_rake=v_rake_after) THEN
    RAISE EXCEPTION 'registration % did not leave exact final state',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT count(*) INTO v_seats_taken FROM public.table_seats s
     WHERE s.table_id=p_expected_table_id AND s.left_at IS NULL;
  END IF;

  -- Re-prove the chosen start authority after all money and seat work. Timed
  -- events still use the locked schedule cutoff; every product also treats a
  -- persisted hand as irreversible start truth; seat-first products further
  -- use status, started_at and completed launch truth. Any loss of the race
  -- rolls every preceding write back atomically.
  v_unregistered_at:=clock_timestamp();
  SELECT EXISTS (
           SELECT 1
             FROM public.hand_history hh
            WHERE hh.tournament_id=p_tournament_id
         ) OR EXISTS (
           SELECT 1
             FROM public.tables hand_table
             JOIN public.hand_history hh ON hh.table_id=hand_table.id
            WHERE hand_table.tournament_id=p_tournament_id
         )
    INTO v_persisted_hand_exists;
  IF v_persisted_hand_exists THEN
    RAISE EXCEPTION
      'tournament hand persisted before unregistration could commit'
      USING ERRCODE='55000';
  END IF;
  IF v_start_authority='scheduled_clock' THEN
    IF v_unregistered_at>=v_t.start_time THEN
      RAISE EXCEPTION 'tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT t.status::text,t.started_at,launch.completed_at
      INTO v_actual_status,v_actual_started_at,v_launch_completed_at
      FROM public.tournaments t
      LEFT JOIN public.tournament_launch_receipts launch
        ON launch.tournament_id=t.id
     WHERE t.id=p_tournament_id;
    IF upper(COALESCE(v_actual_status,'')) NOT IN ('ANNOUNCED','REGISTERING')
       OR v_actual_started_at IS NOT NULL
       OR v_launch_completed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'seat-first tournament started before unregistration could commit'
        USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,start_authority,settled_at)
  VALUES(
    v_reg.id,v_request_id,p_tournament_id,p_user_id,p_expected_table_id,
    v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids,
    v_source_wallet_club_ids,v_credit_ledger_ids,v_wallet_transaction_ids,
    v_fees_reversed,v_fee_reversal_ids,v_fee_source_rake_record_ids,
    v_seat_number,v_seats_taken,v_t.start_time,v_start_authority,v_unregistered_at);
  v_receipt:=public.fn_ca_tournament_unregistration_receipt(
    p_tournament_id,p_user_id,p_expected_table_id,v_request_id);
  IF v_receipt IS NULL
     OR (v_receipt->>'registration_id')::uuid IS DISTINCT FROM v_reg.id THEN
    RAISE EXCEPTION 'registration % has no exact unregistration receipt',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  RETURN v_receipt||jsonb_build_object('replayed',false);
END;
$function$;
ALTER FUNCTION public.fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid, p_description text, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid, p_description text, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid, p_description text, p_request_id uuid)

-- @@DOOR fn_caller_is_engine()
-- @@PIN md5=d9a70f1d932538025e656bfe2b4d091d len=790 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$;
ALTER FUNCTION public.fn_caller_is_engine() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_caller_is_engine() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_caller_is_engine() TO authenticated, service_role;
-- @@END fn_caller_is_engine()

-- @@DOOR fn_caller_session_is_live()
-- @@PIN md5=23ffeea99f9d9e76102ecbf6185222c0 len=882 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_caller_session_is_live()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
DECLARE
  v_claims jsonb;
  v_sid    uuid;
BEGIN
  IF public.fn_caller_is_engine() THEN
    RETURN true;
  END IF;

  -- Malformed or absent claims are not a crash, they are a refusal.
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_claims IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    v_sid := (v_claims ->> 'session_id')::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  IF v_sid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM auth.sessions s
     WHERE s.id = v_sid
       AND (s.not_after IS NULL OR s.not_after > now())
  );
END;
$function$;
ALTER FUNCTION public.fn_caller_session_is_live() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_caller_session_is_live() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_caller_session_is_live() TO authenticated, service_role;
-- @@END fn_caller_session_is_live()

-- @@DOOR fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text)
-- @@PIN md5=c74a777eacc98bed6cfd90ac0043829c len=1601 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  IF p_reason NOT IN (
    'rebuy','reentry','addon','late_registration','deal_vote','bounty_settled'
  ) THEN
    RAISE EXCEPTION 'invalid tournament manager wake reason';
  END IF;

  -- Serialize every emitter with the tournament lifecycle transition. UPDATE
  -- takes a NO KEY UPDATE lock, which conflicts with FOR SHARE: an emitter that
  -- commits first is consumed by the terminal AFTER trigger, while an emitter
  -- that arrives second observes the terminal state and cannot strand work for
  -- a manager that has already stopped. Terminal recovery can still settle a
  -- legacy financial obligation; it simply has no live manager to wake.
  SELECT upper(COALESCE(t.status,''))
    INTO v_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.tournament_manager_wakes AS pending(tournament_id,reason,generation)
  VALUES (p_tournament_id,p_reason,1)
  ON CONFLICT (tournament_id,reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation=pending.generation+1,
    created_at=clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public.fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text) TO service_role;
-- @@END fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text)

-- @@DOOR fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
-- @@PIN md5=dd462a9943724d4b94fbe683ed364250 len=370 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
       AND cm.status IN ('active', 'approved')
  );
$function$;
ALTER FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid) TO authenticated, service_role;
-- @@END fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)

-- @@DOOR fn_entry_purchases_frozen()
-- @@PIN md5=0b05e2e7905caf71f14c8327a172cea0 len=1092 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;
ALTER FUNCTION public.fn_entry_purchases_frozen() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_entry_purchases_frozen() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_entry_purchases_frozen() TO authenticated, service_role;
-- @@END fn_entry_purchases_frozen()

-- @@DOOR fn_is_platform_admin()
-- @@PIN md5=ed89787c7b832e76a886734e16a27c3d len=375 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN v_role IN ('admin', 'superadmin', 'god');
END;
$function$;
ALTER FUNCTION public.fn_is_platform_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_is_platform_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO authenticated, service_role;
-- @@END fn_is_platform_admin()

-- @@DOOR fn_lock_daily_mission_user(p_user_id uuid)
-- @@PIN md5=0e9d2905374930bda4529a8febc6eff6 len=611 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions player is required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('daily-missions-user:' || p_user_id::text, 0)
  );

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid) TO service_role;
-- @@END fn_lock_daily_mission_user(p_user_id uuid)

-- @@DOOR fn_player_home_club(p_user_id uuid, p_club_hint uuid)
-- @@PIN md5=bdced39339da2e5ec46404177bab7dc2 len=744 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_club_hint IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_hint
       AND cm.status IN ('active','approved')
  ) THEN RETURN p_club_hint; END IF;
  SELECT cm.club_id INTO v_club
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id AND cm.status IN ('active','approved')
   ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
   LIMIT 1;
  RETURN v_club;
END;
$function$;
ALTER FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid) TO authenticated, service_role;
-- @@END fn_player_home_club(p_user_id uuid, p_club_hint uuid)

-- @@DOOR fn_poker_arena_context(p_club_key text)
-- @@PIN md5=6c85536da97db301d7beb4aae885e69c len=2030 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_arena_context(p_club_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_club public.clubs%ROWTYPE; v_role text; v_member boolean;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '28000';
  END IF;
  SELECT c.* INTO v_club FROM public.clubs c
  WHERE c.id::text = btrim(p_club_key) OR c.club_id::text = btrim(p_club_key)
     OR lower(c.slug) = lower(btrim(p_club_key))
  ORDER BY (c.id::text = btrim(p_club_key)) DESC LIMIT 1;
  IF NOT FOUND OR v_club.lifecycle_status = 'retired' THEN RETURN NULL; END IF;
  IF v_club.asset = 'diamonds' THEN
    IF v_club.is_platform IS DISTINCT FROM true OR v_club.union_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE club_id = v_club.id) THEN
      RAISE EXCEPTION 'Invalid Diamond Arena Identity' USING ERRCODE = '23514';
    END IF;
    v_member := true; v_role := 'player';
  ELSIF v_club.asset = 'chips' AND v_club.is_platform = false THEN
    SELECT m.role INTO v_role FROM public.club_members m
      WHERE m.club_id = v_club.id AND m.user_id = v_uid AND m.status IN ('active','approved');
    v_member := FOUND;
  ELSE RAISE EXCEPTION 'Invalid Arena Asset' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('arena',jsonb_build_object('id',v_club.id,'asset',v_club.asset,
    'is_platform',v_club.is_platform,'union_id',v_club.union_id), 'member',v_member,'role',v_role,
    'cashGamesEnabled',v_club.asset='diamonds' AND COALESCE(
      (SELECT s.cash_games_enabled FROM public.ca_arena_settings s WHERE s.club_id=v_club.id),false),
    -- DIAMOND PHASE 8: the tournament switch, read the same way.
    'tournamentsEnabled',v_club.asset='diamonds' AND COALESCE(
      (SELECT s.tournaments_enabled FROM public.ca_arena_settings s WHERE s.club_id=v_club.id),false));
END $function$;
ALTER FUNCTION public.fn_poker_arena_context(p_club_key text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_arena_context(p_club_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_arena_context(p_club_key text) TO authenticated, service_role;
-- @@END fn_poker_arena_context(p_club_key text)

-- @@DOOR fn_poker_bind_diamond_seat()
-- @@PIN md5=c14b4bbfaa71a58210f8de5726040a8c len=1652 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_bind_diamond_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NULL; END IF;
 /* A TOURNAMENT ENTRY BINDS ITS CUSTODY TO THE ENTRY, NEVER TO A SEAT. That
    is what lets one entry survive a table move, a balance and a re-seat: there
    is nothing seat-shaped on the row to re-point. Seating asserts the entry and
    touches no custody at all. */
 IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) IS NOT NULL THEN
   IF NOT EXISTS (
     SELECT 1 FROM public.tables t
       JOIN public.poker_diamond_custody c ON c.target_id=t.tournament_id
        AND c.user_id=NEW.user_id AND c.arena_id=t.club_id
        AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL
     WHERE t.id=NEW.table_id
   ) THEN
     RAISE EXCEPTION 'Diamond Tournament Seat Requires A Funded Entry' USING ERRCODE='P0810';
   END IF;
   RETURN NULL;
 END IF;
 UPDATE public.poker_diamond_custody
   SET seat_id=NEW.id,seat_joined_at=NEW.joined_at,occupancy_id=NEW.occupancy_id,state='active'
   WHERE user_id=NEW.user_id AND target_id=NEW.table_id AND purpose='cash_seat'
     AND entry_key='seat:'||NEW.id AND state='reserved' AND balance=NEW.stack AND seat_id IS NULL;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count<>1 THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_poker_bind_diamond_seat() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_bind_diamond_seat() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_bind_diamond_seat() TO service_role;
-- @@END fn_poker_bind_diamond_seat()

-- @@DOOR fn_poker_diamond_create_tournament(p_config jsonb)
-- @@PIN md5=6d82bede82370a9cc15d71b5ce1699f5 len=12306 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_arena uuid; v_id uuid;
  v_total bigint; v_fee bigint; v_buy_in bigint; v_ratio numeric;
  v_max integer; v_min integer; v_type text; v_variant text; v_game text;
  v_start timestamptz; v_payouts jsonb; v_blinds jsonb; v_pct numeric; v_chips integer;
  v_rebuy boolean; v_reentry boolean; v_addon boolean; v_rebuy_cost bigint; v_addon_cost bigint;
  v_rebuy_num numeric; v_addon_num numeric; v_name text;
  v_is_bounty boolean; v_bounty_num numeric; v_bounty bigint;
  v_mystery boolean; v_mb_activation text; v_mb_profile text; v_mb_value numeric; v_mb_top numeric;
  v_mb_pool numeric; v_mb_regular numeric; v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_unlimited boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_tournament_staff_only' USING ERRCODE='42501';
  END IF;
  SELECT c.id INTO v_arena FROM public.clubs c
   WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL LIMIT 1;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE='P0002'; END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_configuration' USING ERRCODE='22023';
  END IF;

  v_type := lower(COALESCE(p_config->>'type','mtt'));
  IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty','mystery_bounty') THEN
    -- satellite, spin: later Phase 9 pieces.
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  IF COALESCE((p_config->>'guarantee')::numeric,0)<>0 OR COALESCE((p_config->>'satelliteTargetId')::text,'')<>''
     OR COALESCE((p_config->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
  -- A knockout bounty is a format, not a flag: the flat bounty rides on a
  -- 'bounty', 'progressive_bounty' or 'mystery_bounty' event and on nothing else.
  v_is_bounty := v_type IN ('bounty','progressive_bounty','mystery_bounty');
  v_mystery := v_type = 'mystery_bounty';
  v_bounty_num := COALESCE((p_config->>'bountyAmount')::numeric,0);
  IF NOT v_is_bounty AND (v_bounty_num<>0 OR COALESCE((p_config->>'isBounty')::boolean,false)) THEN
    RAISE EXCEPTION 'diamond_tournament_bounty_requires_a_bounty_format' USING ERRCODE='22023';
  END IF;
  IF NOT v_mystery AND (p_config ? 'mysteryBountyMin' OR p_config ? 'mysteryBountyMax' OR p_config ? 'mysteryBounty') THEN
    RAISE EXCEPTION 'diamond_tournament_mystery_requires_a_mystery_format' USING ERRCODE='22023';
  END IF;
  v_game := upper(btrim(COALESCE(p_config->>'gameVariant','NLH')));
  IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8') THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_supported_game' USING ERRCODE='22023';
  END IF;

  v_total := COALESCE((p_config->>'buyIn')::numeric,0);
  IF (p_config->>'buyIn')::numeric IS DISTINCT FROM v_total::numeric OR v_total<1 OR v_total>2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_positive_buy_in' USING ERRCODE='22023';
  END IF;
  v_unlimited:=public.fn_ca_new_tournament_is_unlimited(jsonb_build_object('tournament_type',CASE WHEN v_type='sng' THEN 'SNG' ELSE 'MTT' END));
  v_max := CASE WHEN v_unlimited THEN NULL ELSE COALESCE((p_config->>'maxPlayers')::int,0) END;
  IF NOT v_unlimited AND (v_max<2 OR v_max>10000) THEN RAISE EXCEPTION 'diamond_tournament_requires_a_real_field' USING ERRCODE='22023'; END IF;
  v_min := GREATEST(COALESCE((p_config->>'minPlayers')::int,3),CASE WHEN v_unlimited THEN 3 ELSE 2 END);
  IF NOT v_unlimited AND v_min>v_max THEN v_min := v_max; END IF;
  -- The fee rule the recovery fee already states, at this entry's own unit.
  v_ratio := CASE WHEN NOT v_unlimited AND v_max<=2 THEN 0.05 ELSE 0.10 END;
  v_fee := public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100)/100;
  v_buy_in := v_total - v_fee;
  IF v_buy_in<1 THEN RAISE EXCEPTION 'diamond_tournament_buy_in_below_one_diamond' USING ERRCODE='22023'; END IF;
  -- The chip door's bounty rule at the Diamond unit: a whole bounty of at
  -- least one Diamond, no larger than the buy-in after the fee (the prize
  -- part is what remains; it may be zero, as the chip split allows).
  IF v_is_bounty THEN
    IF v_bounty_num<>trunc(v_bounty_num) OR v_bounty_num<1 OR v_bounty_num>v_buy_in THEN
      RAISE EXCEPTION 'diamond_tournament_requires_a_whole_bounty_within_the_buy_in' USING ERRCODE='22023';
    END IF;
    v_bounty := v_bounty_num;
  ELSE
    v_bounty := 0;
  END IF;
  -- The mystery rules are the chip configuration door's rules
  -- (fn_apply_mystery_bounty_config), stamped here because that door consults
  -- a club owner the arena does not have. The lobby's advertised range is the
  -- chip door's multipliers on the flat bounty, in whole Diamonds.
  IF v_mystery THEN
    v_mb_activation := COALESCE(p_config->'mysteryBounty'->>'activation', 'at_the_money');
    IF v_mb_activation NOT IN ('at_the_money','percent_field','player_count') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_activation_mode' USING ERRCODE='22023';
    END IF;
    v_mb_profile := COALESCE(p_config->'mysteryBounty'->>'profile', 'classic');
    IF v_mb_profile NOT IN ('balanced','classic','jackpot') THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_bad_profile' USING ERRCODE='22023';
    END IF;
    v_mb_value := (p_config->'mysteryBounty'->>'activationValue')::numeric;
    IF v_mb_activation = 'percent_field' AND (COALESCE(v_mb_value,0) <= 0 OR v_mb_value > 100) THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    IF v_mb_activation = 'player_count' AND COALESCE(v_mb_value,0) < 2 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_activation_count_too_small' USING ERRCODE='22023';
    END IF;
    v_mb_top := COALESCE((p_config->'mysteryBounty'->>'topPercent')::numeric, 20);
    IF v_mb_top <= 0 OR v_mb_top > 100 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_top_percent_out_of_range' USING ERRCODE='22023';
    END IF;
    v_mb_pool := COALESCE((p_config->'mysteryBounty'->>'poolPercent')::numeric, 50);
    v_mb_regular := COALESCE((p_config->'mysteryBounty'->>'regularPoolPercent')::numeric, 100 - v_mb_pool);
    IF v_mb_pool < 0 OR v_mb_regular < 0 OR v_mb_pool + v_mb_regular <= 0 THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_pool_split_invalid' USING ERRCODE='22023';
    END IF;
    v_mb_min_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMin','')::numeric, 0.5);
    v_mb_max_mult := COALESCE(NULLIF(p_config->>'mysteryBountyMax','')::numeric, 13);
    IF v_mb_min_mult <= 0 OR v_mb_max_mult < v_mb_min_mult THEN
      RAISE EXCEPTION 'diamond_mystery_bounty_range_invalid' USING ERRCODE='22023';
    END IF;
  END IF;

  v_chips := COALESCE((p_config->>'startingStack')::int, 10000);
  IF v_chips<1 THEN RAISE EXCEPTION 'diamond_tournament_requires_a_starting_stack' USING ERRCODE='22023'; END IF;
  v_blinds := COALESCE(p_config->'blindStructure','[]'::jsonb);
  v_payouts := COALESCE(p_config->'payoutStructure','[]'::jsonb);
  IF jsonb_typeof(v_blinds)<>'array' OR jsonb_array_length(v_blinds)=0 THEN
    RAISE EXCEPTION 'blind_structure_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_payouts)<>'array' OR jsonb_array_length(v_payouts)=0 THEN
    RAISE EXCEPTION 'payout_structure_required' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(sum((e->>'percentage')::numeric),0) INTO v_pct FROM jsonb_array_elements(v_payouts) e;
  IF abs(v_pct-100)>1 THEN RAISE EXCEPTION 'payouts_must_total_100' USING ERRCODE='22023'; END IF;
  IF NOT v_unlimited AND jsonb_array_length(v_payouts)>v_max THEN RAISE EXCEPTION 'more_paid_places_than_players' USING ERRCODE='22023'; END IF;
  v_start := COALESCE((p_config->>'startTime')::timestamptz, now()+interval '1 minute');
  v_rebuy := COALESCE((p_config->>'rebuy')::boolean,false);
  v_reentry := COALESCE((p_config->>'reentry')::boolean,v_rebuy);
  v_addon := COALESCE((p_config->>'addOn')::boolean,false);
  v_rebuy_num := COALESCE((p_config->>'rebuyCost')::numeric, v_total);
  v_addon_num := COALESCE((p_config->>'addonCost')::numeric, v_total);
  IF (v_rebuy OR v_reentry) AND (v_rebuy_num <> trunc(v_rebuy_num) OR v_rebuy_num < 1 OR v_rebuy_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_rebuy_cost' USING ERRCODE='22023';
  END IF;
  IF v_addon AND (v_addon_num <> trunc(v_addon_num) OR v_addon_num < 1 OR v_addon_num > 2147483647) THEN
    RAISE EXCEPTION 'diamond_tournament_requires_a_whole_addon_cost' USING ERRCODE='22023';
  END IF;
  v_rebuy_cost := v_rebuy_num; v_addon_cost := v_addon_num;
  v_name := COALESCE(NULLIF(btrim(p_config->>'name'),''),'Diamond Tournament');
  v_variant := CASE v_type WHEN 'sng' THEN 'sng' WHEN 'bounty' THEN 'bounty'
                           WHEN 'progressive_bounty' THEN 'progressive_bounty'
                           WHEN 'mystery_bounty' THEN 'mystery_bounty' ELSE 'freezeout' END;

  INSERT INTO public.tournaments (
    club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips, max_players, table_size, min_players,
    current_players, status, blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
    mystery_bounty_min, mystery_bounty_max,
    mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_profile,
    mystery_bounty_top_percent, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
    is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, max_rebuys, max_reentries,
    add_on_available, addon_cost, addon_chips, addon_levels,
    payout_percent, free_buy, is_private, action_time_seconds)
  VALUES (
    v_arena, NULL, v_name, v_game, v_variant, CASE WHEN v_type='sng' THEN 'SNG' ELSE 'MTT' END,
    v_buy_in, v_fee, 0, v_chips, v_max, CASE WHEN v_unlimited THEN LEAST(9,GREATEST(2,COALESCE((p_config->>'tableSize')::int,9))) ELSE LEAST(9,GREATEST(2,v_max)) END, v_min,
    0, 'REGISTERING', v_blinds::text, v_payouts::text, v_start,
    COALESCE((p_config->>'lateRegLevels')::int, CASE WHEN v_type='sng' THEN 0 ELSE 8 END), 8,
    v_is_bounty, v_type='progressive_bounty', v_mystery, v_bounty,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_min_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN trunc(v_bounty * v_mb_max_mult) ELSE 0 END,
    CASE WHEN v_mystery THEN v_mb_activation ELSE 'at_the_money' END, CASE WHEN v_mystery THEN v_mb_value END,
    CASE WHEN v_mystery THEN v_mb_profile ELSE 'classic' END,
    CASE WHEN v_mystery THEN v_mb_top ELSE 20 END, CASE WHEN v_mystery THEN v_mb_pool ELSE 50 END,
    CASE WHEN v_mystery THEN v_mb_regular ELSE 50 END,
    v_rebuy, v_reentry, CASE WHEN v_rebuy OR v_reentry THEN v_rebuy_cost ELSE 0 END,
    CASE WHEN v_rebuy OR v_reentry THEN v_chips ELSE 0 END, CASE WHEN v_rebuy OR v_reentry THEN 6 ELSE 4 END,
    CASE WHEN v_rebuy THEN COALESCE((p_config->>'maxRebuys')::int,2) ELSE 0 END,
    CASE WHEN v_reentry THEN COALESCE((p_config->>'maxReentries')::int,1) ELSE 0 END,
    v_addon, CASE WHEN v_addon THEN v_addon_cost ELSE 0 END, CASE WHEN v_addon THEN v_chips ELSE 0 END, 1,
    CASE WHEN (p_config->>'payoutPercent')::int IN (10,15,20) THEN (p_config->>'payoutPercent')::smallint ELSE 10 END,
    false, false, 15)
  RETURNING id INTO v_id;

  -- The row this door wrote must be one the money path will price: whole
  -- Diamonds everywhere, and the unit rule must recognise it.
  IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN
    RAISE EXCEPTION 'diamond_tournament_would_not_be_recognised' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('success',true,'tournamentId',v_id,'id',v_id,'buy_in_amount',v_buy_in,'buy_in_fee',v_fee,
    'total',v_total,'bounty_amount',v_bounty,'is_mystery_bounty',v_mystery,'asset','diamonds');
END $function$;
ALTER FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb) TO authenticated, service_role;
-- @@END fn_poker_diamond_create_tournament(p_config jsonb)

-- @@DOOR fn_poker_diamond_entry_custody_is_the_entry()
-- @@PIN md5=a5d21188b37bb0566c2fb82abeeb29a2 len=1465 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_moved bigint;
BEGIN
 -- OLD is only touched inside the UPDATE branch; a BEFORE/AFTER INSERT has none.
 IF TG_OP='UPDATE' THEN
   IF OLD.purpose='tournament_entry' OR NEW.purpose='tournament_entry' THEN
     IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.target_id IS DISTINCT FROM OLD.target_id
        OR NEW.arena_id IS DISTINCT FROM OLD.arena_id
        OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
        OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
       RAISE EXCEPTION 'A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For'
         USING ERRCODE='P0815';
     END IF;
   END IF;
 END IF;
 IF NEW.purpose <> 'tournament_entry' THEN RETURN NULL; END IF;

 IF NEW.seat_id IS NOT NULL OR NEW.seat_joined_at IS NOT NULL OR NEW.occupancy_id IS NOT NULL THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Never Binds To A Seat' USING ERRCODE='P0813';
 END IF;

 SELECT COALESCE(sum(CASE WHEN m.action='reserve' THEN m.amount ELSE -m.amount END),0)
   INTO v_moved FROM public.poker_diamond_movements m WHERE m.custody_id=NEW.id;
 IF NEW.balance IS DISTINCT FROM v_moved THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Holds Only What Was Reserved For It'
     USING ERRCODE='P0814';
 END IF;

 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry() TO service_role;
-- @@END fn_poker_diamond_entry_custody_is_the_entry()

-- @@DOOR fn_poker_diamond_play_state_columns(p_table text)
-- @@PIN md5=f53dea87eb2d45bcc1c6fdcee2cf9407 len=433 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_play_state_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE p_table
    WHEN 'tournaments' THEN ARRAY['current_players','prize_pool','bounty_pool','total_rake','entry_contract_locked','updated_at']
    WHEN 'tables' THEN ARRAY['current_players','updated_at']
    ELSE ARRAY[]::text[] END;
$function$;
ALTER FUNCTION public.fn_poker_diamond_play_state_columns(p_table text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_play_state_columns(p_table text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_play_state_columns(p_table text) TO service_role;
-- @@END fn_poker_diamond_play_state_columns(p_table text)

-- @@DOOR fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid)
-- @@PIN md5=d525cb1e20d6fb05e5b5e51497b127e7 len=5847 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner uuid;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_prev public.poker_diamond_movements%ROWTYPE;
  v_request jsonb;
  v_credit jsonb;
  v_receipt jsonb;
  v_lot record;
  v_debt_journal uuid;
BEGIN
  IF p_custody_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_diamond_release' USING ERRCODE = '22023';
  END IF;

  SELECT user_id INTO v_owner
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_custody_not_found';
  END IF;

  -- The wallet always locks before its custody, exactly as reserve does.
  PERFORM id FROM public.profiles WHERE id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
  SELECT * INTO v_c
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id
   FOR UPDATE;

  v_request := jsonb_build_object(
    'action', 'release',
    'custody_id', p_custody_id,
    'user_id', v_owner
  );

  SELECT * INTO v_prev
    FROM public.poker_diamond_movements
   WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN v_prev.receipt;
  END IF;

  IF v_c.state = 'released' THEN
    RAISE EXCEPTION 'diamond_custody_already_released';
  END IF;
  -- A DIAMOND TOURNAMENT ENTRY GOES HOME ONLY THROUGH ITS REFUND AUTHORITY
  -- (Phase 8). fn_poker_diamond_tournament_refund names this row in a
  -- transaction-local setting for the one call it makes; any other caller,
  -- service role included, is refused. An entry in play is never releasable.
  IF v_c.purpose = 'tournament_entry'
     AND current_setting('app.poker_diamond_tournament_release', true) IS DISTINCT FROM p_custody_id::text THEN
    RAISE EXCEPTION 'diamond_tournament_entry_requires_refund_authority' USING ERRCODE = '42501';
  END IF;
  -- An ACTIVE tournament entry (activated by the entry door, as the seat
  -- guards P0810-P0812 require) is released whole by its refund authority;
  -- the settlement test below is the cash seat's and stays the cash seat's.
  IF v_c.state <> 'reserved' AND v_c.purpose <> 'tournament_entry' THEN
    IF v_c.state <> 'active' OR v_c.purpose <> 'cash_seat'
       OR v_c.occupancy_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_c.seat_id AND s.joined_at=v_c.seat_joined_at
            AND s.occupancy_id=v_c.occupancy_id AND s.user_id=v_c.user_id
            AND s.table_id=v_c.target_id AND s.left_at IS NOT NULL
            AND s.stack=v_c.balance) THEN
      RAISE EXCEPTION 'diamond_custody_requires_settlement';
    END IF;
  END IF;

  FOR v_lot IN
    SELECT l.id, r.amount-r.consumed AS amount
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id = r.lot_id
     WHERE r.custody_id = p_custody_id
       AND r.released_at IS NULL
     ORDER BY l.created_at, l.id
     FOR UPDATE OF l
  LOOP
    UPDATE public.diamond_purchase_lots
       SET arena_reserved = arena_reserved - v_lot.amount
     WHERE id = v_lot.id;
  END LOOP;

  UPDATE public.poker_diamond_lot_reservations
     SET released_at = now()
   WHERE custody_id = p_custody_id
     AND released_at IS NULL;

  IF v_c.balance > 0 THEN
  v_credit := public.add_diamonds_to_balance(
    v_owner,
    v_c.balance::integer,
    'arena_withdraw',
    'Released Poker Arena reservation',
    'poker-release:' || p_custody_id || ':' || p_request_id
  );
  IF (v_credit->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'diamond_release_credit_failed:%', v_credit->>'error';
  END IF;

  ELSE
    SELECT jsonb_build_object('success',true,'new_balance',diamonds,
      'debt_settled',0,'transaction_id',NULL) INTO v_credit
      FROM public.profiles WHERE id=v_owner;
  END IF;

  IF COALESCE((v_credit->>'debt_settled')::bigint, 0) > 0 THEN
    SELECT id INTO v_debt_journal
      FROM public.diamond_transactions
     WHERE user_id = v_owner
       AND reference_id = 'debt-settlement:' || (v_credit->>'transaction_id')
       AND type = 'debt_settlement'
       AND amount = -(v_credit->>'debt_settled')::bigint;
    IF v_debt_journal IS NULL THEN
      RAISE EXCEPTION 'diamond_debt_journal_missing';
    END IF;

    PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
    IF NOT EXISTS (
      SELECT 1
        FROM public.ca_mint_ledger
       WHERE diamond_tx_id = v_debt_journal
         AND action = 'burn'
         AND asset = 'diamonds'
         AND holder_type = 'player'
         AND holder_id = v_owner
         AND amount = (v_credit->>'debt_settled')::bigint
    ) THEN
      RAISE EXCEPTION 'diamond_debt_retirement_missing';
    END IF;
  END IF;

  UPDATE public.poker_diamond_custody
     SET balance = 0,
         state = 'released',
         released_at = now()
   WHERE id = p_custody_id;

  v_receipt := jsonb_build_object(
    'success', true,
    'custody_id', p_custody_id,
    'request_id', p_request_id,
    'amount', v_c.balance,
    'available_balance', (v_credit->>'new_balance')::bigint,
    'custody_balance', 0,
    'debt_settled', (v_credit->>'debt_settled')::bigint,
    'journal_id', v_credit->>'transaction_id'
  );

  INSERT INTO public.poker_diamond_movements(
    request_id, custody_id, user_id, action, amount,
    source_account, destination_account, wallet_journal_id, request, receipt
  ) VALUES (
    p_request_id, p_custody_id, v_owner, 'release', v_c.balance,
    'arena_custody:' || p_custody_id, 'player:' || v_owner,
    (v_credit->>'transaction_id')::uuid, v_request, v_receipt
  );

  RETURN v_receipt;
END;
$function$;
ALTER FUNCTION public.fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid) TO service_role;
-- @@END fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid)

-- @@DOOR fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)
-- @@PIN md5=a1ccc4bc9a5c6d8d17308e93943a9413 len=6069 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_request jsonb; v_previous public.poker_diamond_movements%ROWTYPE;
 v_wallet bigint; v_arena uuid; v_asset text; v_platform boolean; v_union uuid;
 v_min numeric; v_max numeric; v_status text; v_custody uuid; v_journal uuid;
 v_locked bigint; v_days integer; v_left bigint; v_take bigint; v_lot record; v_receipt jsonb;
BEGIN
 IF p_user_id IS NULL OR p_target_id IS NULL OR p_request_id IS NULL
    OR p_purpose IS NULL OR p_purpose NOT IN ('cash_seat','tournament_entry')
    OR p_entry_key IS NULL OR length(p_entry_key) NOT BETWEEN 1 AND 160
    OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 2147483647 OR p_amount <> trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_reservation' USING ERRCODE = '22023';
 END IF;
 v_request := jsonb_build_object('user_id',p_user_id,'purpose',p_purpose,'target_id',p_target_id,
   'entry_key',p_entry_key,'amount',p_amount,'action','reserve');
 -- All operations for one wallet serialize on that profile, including shop spend/refunds.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_previous FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_previous.request <> v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
   RETURN v_previous.receipt;
 END IF;
 IF p_purpose='cash_seat' THEN
   SELECT t.club_id,t.min_buy_in,t.max_buy_in,t.status INTO v_arena,v_min,v_max,v_status
   FROM public.tables t WHERE t.id=p_target_id FOR SHARE;
   IF NOT FOUND OR v_min IS NULL OR v_max IS NULL OR p_amount<v_min OR p_amount>v_max THEN
     RAISE EXCEPTION 'invalid_diamond_table_buy_in';
   END IF;
 ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status
   INTO v_arena,v_min,v_status FROM public.tournaments t
     JOIN public.clubs c ON c.id=t.club_id
     JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
   WHERE t.id=p_target_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND a.tournaments_enabled
   FOR SHARE OF t;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
   END IF;
   IF v_min IS NULL OR p_amount<>v_min THEN RAISE EXCEPTION 'invalid_diamond_entry_price'; END IF; END IF;
 SELECT asset,is_platform,union_id INTO v_asset,v_platform,v_union FROM public.clubs WHERE id=v_arena FOR SHARE;
 IF v_asset IS DISTINCT FROM 'diamonds' OR v_platform IS DISTINCT FROM true OR v_union IS NOT NULL THEN
   RAISE EXCEPTION 'diamond_asset_required';
 END IF;
 IF v_status IS NULL OR v_status IN ('completed','cancelled','closed','archived') THEN
   RAISE EXCEPTION 'diamond_target_closed';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_arena;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=p_user_id AND settled_at IS NULL AND amount>0) THEN
   RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 -- Lock lots before evaluating age/freeze, so a concurrent dispute cannot slip through.
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=p_user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id
 AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN RAISE EXCEPTION 'insufficient_settled_diamonds'; END IF;
 INSERT INTO public.poker_diamond_custody(user_id,arena_id,purpose,target_id,entry_key,balance)
 VALUES(p_user_id,v_arena,p_purpose,p_target_id,p_entry_key,p_amount) RETURNING id INTO v_custody;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
 FROM public.diamond_purchase_lots WHERE user_id=p_user_id AND frozen_at IS NULL
 AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
   EXIT WHEN v_left=0;
   v_take:=LEAST(v_left,v_lot.available);
   IF v_take>0 THEN
     UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_custody,v_lot.id,v_take);
     v_left:=v_left-v_take;
   END IF;
 END LOOP;
 -- Journal the transfer before the balance update so the existing DR6 audit
 -- sees its evidence inside this same atomic transaction.
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,reference_id,
 description,source,issuance_class,counterparty,metadata)
 VALUES(p_user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
 'poker-reserve:'||p_request_id,'Reserved diamonds for Poker Arena','poker_arena','arena',
 'arena_custody:'||v_custody,jsonb_build_object('custody_id',v_custody,'request_id',p_request_id,
 'purpose',p_purpose,'target_id',p_target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=p_user_id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_custody,'request_id',p_request_id,
 'amount',p_amount,'available_balance',v_wallet-p_amount,'custody_balance',p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,source_account,
 destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_custody,p_user_id,'reserve',p_amount,'player:'||p_user_id,
 'arena_custody:'||v_custody,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid) TO service_role;
-- @@END fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)

-- @@DOOR fn_poker_diamond_seat_keeps_custody()
-- @@PIN md5=d80aed613a97e567268cb2bf6fdfd094 len=2430 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active' AND c.purpose='cash_seat'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.purpose='cash_seat' AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 /* A DIAMOND TOURNAMENT SEAT HOLDS AN ENTRY, NOT A BALANCE. The stack is a
    nonredeemable play unit and bears no relation to custody, so nothing in
    this arm compares it to anything. What must be true at every commit is that
    the seat is covered by a live funded entry for THIS event, held against the
    tournament and not against the seat. */
 IF EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.user_id=s.user_id AND c.target_id=t.tournament_id AND c.arena_id=s.club_id
         AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL)
 ) THEN
   RAISE EXCEPTION 'A Diamond Tournament Seat Must Hold Its Funded Entry' USING ERRCODE='P0812';
 END IF;
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_seat_keeps_custody() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_seat_keeps_custody() TO service_role;
-- @@END fn_poker_diamond_seat_keeps_custody()

-- @@DOOR fn_poker_diamond_tournament(p_tournament_id uuid)
-- @@PIN md5=c91028508fecc2d02e9003f2bdc2e38d len=442 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
       AND c.union_id IS NULL AND t.union_id IS NULL);
$function$;
ALTER FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid) TO service_role;
-- @@END fn_poker_diamond_tournament(p_tournament_id uuid)

-- @@DOOR fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid)
-- @@PIN md5=ee91eac08d166e096ca5faa8c52ff296 len=11569 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_actor uuid := COALESCE(auth.uid(), p_actor_id, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
  v_t public.tournaments%ROWTYPE; v_player record; v_refund jsonb;
  v_cancelled_at timestamptz := transaction_timestamp();
  v_refunds jsonb := '[]'::jsonb; v_receipt jsonb;
  v_source_player_ids uuid[]; v_refunded_registration_ids uuid[] := ARRAY[]::uuid[];
  v_zero_refund_registration_ids uuid[] := ARRAY[]::uuid[]; v_closed_table_ids uuid[];
  v_source_seat_ids uuid[]; v_released_seat_ids uuid[];
  v_total bigint := 0; v_fees bigint := 0; v_count integer := 0; v_lines integer := 0;
  v_rake_before numeric; v_rows integer; v_request uuid;
BEGIN
  IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'Tournament id is required' USING ERRCODE='22004'; END IF;
  -- The global settlement lane is already held when atomic_cancel_tournament
  -- routes here; taken again for a direct owner call, it is re-entrant.
  PERFORM public.fn_ca_lock_settlement_lane_global();
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002'; END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  -- The arena has no club operators; platform staff cancel a Diamond event,
  -- the same authority that creates one. A service-role call carries no uid.
  IF v_uid IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform staff may cancel a Diamond tournament' USING ERRCODE='42501';
  END IF;
  -- A stored receipt is the answer, replayed exactly.
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h WHERE h.tournament_id=p_tournament_id) THEN
    RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING') THEN
    RAISE EXCEPTION 'Tournament is already %',v_t.status USING ERRCODE='55000';
  END IF;
  -- THE CHIP RULE, UNCHANGED: a started event is resumed or settled, never voided.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id AND o.kind<>'refund' AND o.amount_paid>0)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee')) THEN
    RAISE EXCEPTION 'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

  -- Freeze every identity before any refund runs.
  PERFORM 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id ORDER BY tp.user_id,tp.id FOR UPDATE;
  PERFORM 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id ORDER BY tb.id FOR UPDATE;
  PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
    WHERE tb.tournament_id=p_tournament_id ORDER BY s.table_id,s.id FOR UPDATE OF s;
  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[]) INTO v_source_player_ids
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]) INTO v_closed_table_ids
    FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[]) INTO v_source_seat_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
  v_rake_before := COALESCE(v_t.total_rake,0);
  -- The caches must equal the custody banks before anything moves.
  IF (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) IS DISTINCT FROM COALESCE(v_t.prize_pool,0)
     OR (SELECT bounty_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) IS DISTINCT FROM COALESCE(v_t.bounty_pool,0)
     OR (SELECT fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) IS DISTINCT FROM v_rake_before THEN
    RAISE EXCEPTION 'tournament % caches do not equal exact custody before cancellation', p_tournament_id USING ERRCODE='P0404';
  END IF;

  -- Whoever paid in gets it back, entry by entry, from their own custody row.
  FOR v_player IN
    SELECT tp.id, tp.user_id FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id ORDER BY tp.user_id, tp.id
  LOOP
    IF v_player.user_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.poker_diamond_custody c
          WHERE c.user_id=v_player.user_id AND c.purpose='tournament_entry'
            AND c.target_id=p_tournament_id AND c.state<>'released') THEN
      v_request := uuid_in(md5('poker-tournament-cancel:'||p_tournament_id::text||':'||v_player.user_id::text)::cstring);
      v_refund := public.fn_poker_diamond_tournament_refund(
        p_tournament_id, v_player.user_id, 'cancel', 'atomic_cancel_tournament', v_request);
      IF COALESCE((v_refund->>'idempotent')::boolean,false) THEN
        RAISE EXCEPTION 'tournament % refund for % was already recorded before this cancellation', p_tournament_id, v_player.user_id USING ERRCODE='P0404';
      END IF;
      v_total := v_total + (v_refund->>'paid')::bigint;
      v_fees := v_fees + (v_refund->>'refund_fee')::bigint;
      v_count := v_count + 1; v_lines := v_lines + 1;
      v_refunded_registration_ids := array_append(v_refunded_registration_ids, v_player.id);
      v_refunds := v_refunds || jsonb_build_object(
        'registration_id',v_player.id,'user_id',v_player.user_id,
        'custody_id',(v_refund->>'custody_id')::uuid,'ledger_id',(v_refund->>'ledger_id')::bigint,
        'amount',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
        'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
        'obligation_id',(v_refund->>'obligation_id')::uuid,'journal_id',NULLIF(v_refund->>'journal_id','')::uuid,
        'request_id',v_request);
    ELSE
      v_zero_refund_registration_ids := array_append(v_zero_refund_registration_ids, v_player.id);
    END IF;
  END LOOP;
  IF public.fn_poker_diamond_tournament_custody(p_tournament_id) <> 0
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                 WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_tournament_custody_not_empty_after_cancel' USING ERRCODE='P0404';
  END IF;
  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id)) <> 0 THEN
    RAISE EXCEPTION 'tournament % cancellation did not close all custody banks', p_tournament_id USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournament_players
     SET status='eliminated',eliminated_at=v_cancelled_at,chips=0,current_bounty=0
   WHERE tournament_id=p_tournament_id;
  WITH released AS (
    UPDATE public.table_seats s
       SET left_at=v_cancelled_at,status='left',leave_pending=false,
           is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id AND s.left_at IS NULL
     RETURNING s.id)
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_released_seat_ids FROM released;
  UPDATE public.table_seats s
     SET status='left',leave_pending=false,is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.id=ANY(v_source_seat_ids) AND s.left_at IS NOT NULL;
  UPDATE public.tournaments
     SET status='CANCELLED',ended_at=v_cancelled_at,updated_at=now(),
         prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,
         on_break=false,break_started_at=NULL,break_ends_at=NULL
   WHERE id=p_tournament_id
     AND upper(COALESCE(status::text,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED','COMPLETING');
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament % lost its cancellation lifecycle claim', p_tournament_id USING ERRCODE='40001'; END IF;
  UPDATE public.tables
     SET status='closed',lifecycle='closed',current_players=0,terminal_closed_at=v_cancelled_at,updated_at=now()
   WHERE tournament_id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>cardinality(v_closed_table_ids) THEN
    RAISE EXCEPTION 'tournament % did not close every table', p_tournament_id USING ERRCODE='40001';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_refunded_registration_ids FROM unnest(v_refunded_registration_ids) ids(id);
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO v_zero_refund_registration_ids FROM unnest(v_zero_refund_registration_ids) ids(id);
  v_receipt := jsonb_build_object(
    'ok',true,'success',true,'fully_settled',true,'receipt_version',2,'asset','diamonds',
    'tournament_id',p_tournament_id,'actor_id',v_actor,'status','CANCELLED',
    'source_player_count',cardinality(v_source_player_ids),
    'refunded_count',v_count,'refund_line_count',v_lines,
    'ticket_return_count',0,'total_ticket_returned',0,
    'total_refunded',v_total,'fees_reversed',v_fees,
    'closed_table_count',cardinality(v_closed_table_ids),
    'source_seat_count',cardinality(v_source_seat_ids),
    'released_seat_count',cardinality(v_released_seat_ids),
    'refunds',v_refunds,'ticket_returns','[]'::jsonb,
    'settled_at',v_cancelled_at);
  INSERT INTO public.tournament_cancellation_receipts(
    tournament_id,actor_id,receipt_version,
    source_player_count,source_player_ids,
    refunded_count,refunded_registration_ids,refund_line_count,
    ticket_return_count,ticket_return_ids,total_ticket_returned,
    zero_refund_count,zero_refund_registration_ids,
    total_refunded,fees_reversed,total_rake_before,total_rake_after,
    closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
    released_seat_count,released_seat_ids,fee_reversal_ids,
    escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,
    receipt,settled_at)
  VALUES(
    p_tournament_id,v_actor,2,
    cardinality(v_source_player_ids),v_source_player_ids,
    v_count,v_refunded_registration_ids,v_lines,
    0,ARRAY[]::uuid[],0,
    cardinality(v_zero_refund_registration_ids),v_zero_refund_registration_ids,
    v_total,v_fees,v_rake_before,0,
    cardinality(v_closed_table_ids),v_closed_table_ids,cardinality(v_source_seat_ids),v_source_seat_ids,
    cardinality(v_released_seat_ids),v_released_seat_ids,ARRAY[]::uuid[],
    v_cancelled_at,'diamond custody returned: exact zero',NULL,v_receipt,v_cancelled_at);
  RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id,v_actor);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid)

-- @@DOOR fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid)
-- @@PIN md5=361d90e78dee65236635da53740c1eeb len=11424 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_h public.tournament_cancellation_receipts%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_e record; v_ids uuid[];
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'cancellation receipt requires a tournament id' USING ERRCODE='22004';
  END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_h FROM public.tournament_cancellation_receipts h WHERE h.tournament_id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % has no immutable cancellation receipt', p_tournament_id USING ERRCODE='P0404';
  END IF;
  -- A Diamond receipt names its asset; the receipts table is not altered
  -- (it is read under the settlement lane by every hand settlement).
  IF v_h.receipt->>'asset' IS DISTINCT FROM 'diamonds' THEN
    RAISE EXCEPTION 'tournament % carries a chip cancellation receipt on a Diamond event', p_tournament_id USING ERRCODE='P0404';
  END IF;
  IF p_observed_actor_id IS NOT NULL AND v_h.actor_id IS DISTINCT FROM p_observed_actor_id THEN
    RAISE EXCEPTION 'cancellation actor disagrees with stored receipt' USING ERRCODE='40001';
  END IF;
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  IF v_t.id IS NULL
     OR upper(COALESCE(v_t.status::text,'')) NOT IN ('CANCELLED','CANCELED')
     OR v_t.ended_at IS DISTINCT FROM v_h.settled_at
     OR v_t.current_players IS DISTINCT FROM 0
     OR v_t.prize_pool IS DISTINCT FROM 0::numeric
     OR v_t.bounty_pool IS DISTINCT FROM 0::numeric
     OR v_t.total_rake IS DISTINCT FROM v_h.total_rake_after
     OR v_h.total_rake_after IS DISTINCT FROM 0::numeric
     OR v_t.on_break IS DISTINCT FROM false
     OR v_t.break_started_at IS NOT NULL OR v_t.break_ends_at IS NOT NULL
     OR v_e.prize_balance IS DISTINCT FROM 0::numeric
     OR v_e.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_e.fee_balance IS DISTINCT FROM 0::numeric
     OR public.fn_poker_diamond_tournament_custody(p_tournament_id) <> 0
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                 WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released')
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee'))
     OR EXISTS (SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.rake_records r WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w WHERE w.related_entity_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id) THEN
    RAISE EXCEPTION 'cancellation receipt lost its terminal parent or custody state' USING ERRCODE='P0404';
  END IF;

  SELECT COALESCE(array_agg(tp.id ORDER BY tp.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_player_ids OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND (tp.status::text IS DISTINCT FROM 'eliminated'
         OR tp.eliminated_at IS DISTINCT FROM v_h.settled_at
         OR COALESCE(tp.chips,0)<>0 OR COALESCE(tp.current_bounty,0)<>0)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen roster' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.tables tb WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.closed_table_ids OR EXISTS (
    SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id
      AND (lower(COALESCE(tb.status::text,''))<>'closed'
        OR lower(COALESCE(tb.lifecycle,''))<>'closed'
        OR tb.current_players IS DISTINCT FROM 0
        OR tb.terminal_closed_at IS DISTINCT FROM v_h.settled_at)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen tables' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.table_id,s.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id;
  IF v_ids IS DISTINCT FROM v_h.source_seat_ids OR EXISTS (
    SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE tb.tournament_id=p_tournament_id
       AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'
         OR s.leave_pending IS DISTINCT FROM false
         OR s.is_sitting_out IS DISTINCT FROM false
         OR s.is_away IS DISTINCT FROM false OR s.sit_out_at IS NOT NULL
         OR s.scheduled_leave_hands IS NOT NULL)) THEN
    RAISE EXCEPTION 'cancellation receipt lost its frozen seats' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(s.id ORDER BY s.id),ARRAY[]::uuid[]) INTO v_ids
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.left_at IS NOT DISTINCT FROM v_h.settled_at;
  IF v_ids IS DISTINCT FROM v_h.released_seat_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its released-seat identity' USING ERRCODE='P0404';
  END IF;

  -- Disposition roster: every registration is either refunded or a zero line.
  SELECT COALESCE(array_agg(x.registration_id ORDER BY x.registration_id),ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT DISTINCT (line->>'registration_id')::uuid AS registration_id
            FROM jsonb_array_elements(v_h.receipt->'refunds') line) x;
  IF v_ids IS DISTINCT FROM v_h.refunded_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its disposition roster' USING ERRCODE='P0404';
  END IF;
  SELECT COALESCE(array_agg(x.id ORDER BY x.id),ARRAY[]::uuid[]) INTO v_ids
    FROM (SELECT unnest(v_h.source_player_ids) AS id EXCEPT SELECT unnest(v_h.refunded_registration_ids)) x;
  IF v_ids IS DISTINCT FROM v_h.zero_refund_registration_ids THEN
    RAISE EXCEPTION 'cancellation receipt lost its zero-disposition roster' USING ERRCODE='P0404';
  END IF;
  IF v_h.ticket_return_count<>0 OR v_h.total_ticket_returned<>0 OR cardinality(v_h.ticket_return_ids)<>0
     OR cardinality(v_h.fee_reversal_ids)<>0 OR v_h.spin_unwind_tournament_id IS NOT NULL THEN
    RAISE EXCEPTION 'cancellation receipt carries chip evidence on a Diamond event' USING ERRCODE='P0404';
  END IF;

  -- Exact refund evidence: each receipt line is one ledger refund row, one
  -- released custody row, one wallet journal row and one settled obligation.
  IF (SELECT count(*) FROM public.poker_diamond_tournament_ledger l
       WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
         AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.refund_line_count
     OR (SELECT COALESCE(sum(l.amount),0)::numeric FROM public.poker_diamond_tournament_ledger l
          WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
            AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.total_refunded
     OR (SELECT COALESCE(sum(l.fee_part),0)::numeric FROM public.poker_diamond_tournament_ledger l
          WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
            AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.fees_reversed
     OR (SELECT count(DISTINCT l.user_id) FROM public.poker_diamond_tournament_ledger l
          WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
            AND l.request->>'source'='atomic_cancel_tournament')
       IS DISTINCT FROM v_h.refunded_count
     OR EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(
           registration_id uuid,user_id uuid,custody_id uuid,ledger_id bigint,
           amount numeric,refund_prize numeric,refund_bounty numeric,refund_fee numeric,
           obligation_id uuid,journal_id uuid,request_id uuid)
         LEFT JOIN public.tournament_players tp ON tp.id=line.registration_id
         LEFT JOIN public.poker_diamond_tournament_ledger l ON l.id=line.ledger_id
         LEFT JOIN public.poker_diamond_custody c ON c.id=line.custody_id
         LEFT JOIN public.tournament_obligations o ON o.id=line.obligation_id
         LEFT JOIN public.diamond_transactions j ON j.id=line.journal_id
         LEFT JOIN public.poker_diamond_movements m ON m.request_id=line.request_id
        WHERE tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
           OR tp.user_id IS DISTINCT FROM line.user_id
           OR l.id IS NULL OR l.tournament_id IS DISTINCT FROM p_tournament_id
           OR l.kind IS DISTINCT FROM 'refund' OR l.user_id IS DISTINCT FROM line.user_id
           OR l.custody_id IS DISTINCT FROM line.custody_id
           OR l.amount::numeric IS DISTINCT FROM line.amount
           OR l.prize_part::numeric IS DISTINCT FROM line.refund_prize
           OR l.bounty_part::numeric IS DISTINCT FROM line.refund_bounty
           OR l.fee_part::numeric IS DISTINCT FROM line.refund_fee
           OR line.amount IS DISTINCT FROM line.refund_prize+line.refund_bounty+line.refund_fee
           OR l.obligation_id IS DISTINCT FROM line.obligation_id
           OR l.wallet_journal_id IS DISTINCT FROM line.journal_id
           OR l.request->>'source' IS DISTINCT FROM 'atomic_cancel_tournament'
           OR l.request->>'request_id' IS DISTINCT FROM line.request_id::text
           OR c.id IS NULL OR c.user_id IS DISTINCT FROM line.user_id
           OR c.purpose IS DISTINCT FROM 'tournament_entry'
           OR c.target_id IS DISTINCT FROM p_tournament_id
           OR c.state IS DISTINCT FROM 'released' OR c.balance IS DISTINCT FROM 0
           OR o.id IS NULL OR o.tournament_id IS DISTINCT FROM p_tournament_id
           OR o.kind IS DISTINCT FROM 'refund' OR o.place IS NOT NULL
           OR o.user_id IS DISTINCT FROM line.user_id OR o.settled_at IS NULL
           OR o.amount_paid IS DISTINCT FROM o.amount_owed
           OR o.amount_paid IS DISTINCT FROM (
             SELECT COALESCE(sum(x.amount),0)::numeric FROM public.poker_diamond_tournament_ledger x
              WHERE x.obligation_id=o.id AND x.kind='refund')
           OR j.id IS NULL OR j.user_id IS DISTINCT FROM line.user_id
           OR j.type IS DISTINCT FROM 'arena_withdraw'
           OR m.request_id IS NULL OR m.custody_id IS DISTINCT FROM line.custody_id
           OR m.action IS DISTINCT FROM 'release' OR m.amount IS DISTINCT FROM line.amount)
     OR EXISTS (
       SELECT 1 FROM public.poker_diamond_tournament_ledger l
        WHERE l.tournament_id=p_tournament_id AND l.kind='refund'
          AND l.request->>'source'='atomic_cancel_tournament'
          AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_h.receipt->'refunds') AS line(ledger_id bigint)
                           WHERE line.ledger_id=l.id)) THEN
    RAISE EXCEPTION 'cancellation receipt lost exact refund evidence' USING ERRCODE='P0404';
  END IF;
  RETURN v_h.receipt;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid) TO service_role;
-- @@END fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid)

-- @@DOOR fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text)
-- @@PIN md5=76d337b6b86734fb44db277d442afeb9 len=6442 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid; v_c public.poker_diamond_custody%ROWTYPE; v_receipt jsonb;
  v_request uuid; v_ledger bigint; v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_idempotency_key IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('entry','rebuy','reentry','addon')
     OR p_gross IS NULL OR p_prize IS NULL OR p_bounty IS NULL OR p_fee IS NULL
     OR p_gross < 1 OR p_prize < 0 OR p_bounty < 0 OR p_fee < 0
     OR p_gross <> trunc(p_gross) OR p_prize <> trunc(p_prize)
     OR p_bounty <> trunc(p_bounty) OR p_fee <> trunc(p_fee)
     OR p_prize + p_bounty + p_fee <> p_gross THEN
    RAISE EXCEPTION 'diamond_tournament_charge_requires_whole_parts' USING ERRCODE='22023';
  END IF;
  IF p_kind = 'entry' AND p_registration_id IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_entry_requires_a_registration' USING ERRCODE='22023';
  END IF;
  -- Phase 9: the bounty part is a bank of its own (fn_poker_diamond_tournament_drain
  -- 'bounty'); a knockout bounty event carries one on every entry and re-entry.
  SELECT t.club_id INTO v_arena FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;

  -- The same key twice is the same charge: return what it wrote.
  SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.user_id<>p_user_id OR v_existing.tournament_id<>p_tournament_id
       OR v_existing.kind<>p_kind OR v_existing.amount<>p_gross THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN jsonb_build_object('success',true,'idempotent',true,'custody_id',v_existing.custody_id,
      'ledger_id',v_existing.id,'journal_id',v_existing.wallet_journal_id,'amount',v_existing.amount);
  END IF;
  v_request := uuid_in(md5('poker-tournament-charge:'||p_idempotency_key)::cstring);

  SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND purpose='tournament_entry' AND target_id=p_tournament_id AND state<>'released'
   FOR UPDATE;
  IF p_kind = 'entry' THEN
    IF FOUND THEN
      RAISE EXCEPTION 'diamond_tournament_entry_already_held' USING ERRCODE='23505';
    END IF;
    -- The reserve door prices the entry itself (buy-in plus fee, exactly) and
    -- refuses while tournaments_enabled is off. Both refusals surface here.
    v_receipt := public.fn_poker_diamond_reserve(
      p_user_id,'tournament_entry',p_tournament_id,'entry:'||p_registration_id::text,p_gross,v_request);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond_tournament_reserve_failed' USING ERRCODE='P0404';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody WHERE id=(v_receipt->>'custody_id')::uuid FOR UPDATE;
    -- THE ENTRY IS ACTIVE FROM THE MOMENT IT IS PAID. The seat guards (P0810,
    -- P0812) admit a Diamond tournament seat only against an active entry for
    -- its player and event; this is the tournament mirror of the cash binder,
    -- moved to where the money is, and it never binds a seat (P0813).
    UPDATE public.poker_diamond_custody SET state='active' WHERE id=v_c.id AND state='reserved' AND purpose='tournament_entry';
    IF NOT FOUND THEN RAISE EXCEPTION 'diamond_tournament_entry_activation_failed' USING ERRCODE='P0404'; END IF;
    v_c.state := 'active';
    -- The first entry locks the entry contract, as the chip entitlement
    -- trigger does: a price nobody has paid may change, a paid one may not.
    UPDATE public.tournaments t SET entry_contract_locked=true WHERE t.id=p_tournament_id AND NOT t.entry_contract_locked;
  ELSE
    IF NOT FOUND THEN
      RAISE EXCEPTION 'diamond_tournament_entry_not_held' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_arena_settings a WHERE a.id=1 AND a.club_id=v_arena AND a.tournaments_enabled) THEN
      RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
    END IF;
    v_receipt := public.fn_poker_diamond_tournament_custody_add(v_c.id,p_gross,v_request);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond_tournament_add_failed' USING ERRCODE='P0404';
    END IF;
  END IF;

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,registration_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,v_c.id,p_kind,p_gross::bigint,p_prize::bigint,p_bounty::bigint,p_fee::bigint,
    p_idempotency_key,(v_receipt->>'journal_id')::uuid,p_registration_id,
    jsonb_build_object('kind',p_kind,'gross',p_gross,'prize',p_prize,'bounty',p_bounty,'fee',p_fee,'request_id',v_request))
  RETURNING id INTO v_ledger;

  -- Once the escrow shadow is open (a knockout paid mid-event opens it from
  -- the ledger), every later inflow - a late entry, a re-entry, a rebuy, an
  -- add-on - is applied to it, as a chip entry's wallet row applies itself.
  IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id=p_tournament_id) THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond '||p_kind,
      p_gross_in => p_gross, p_fee_entries_in => p_fee, p_bounty_in => p_bounty);
  END IF;

  -- The banks and the custody must agree after every charge.
  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('success',true,'custody_id',v_c.id,'ledger_id',v_ledger,
    'journal_id',v_receipt->>'journal_id','amount',p_gross,'request_id',v_request);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text)

-- @@DOOR fn_poker_diamond_tournament_close_custody(p_tournament_id uuid)
-- @@PIN md5=2c1ca86d949cc689fe1f19c98e08b9db len=1430 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_close_custody(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_c record; v_n integer := 0; v_open bigint; v_receipt jsonb;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  v_open := public.fn_poker_diamond_tournament_custody(p_tournament_id);
  IF v_open <> 0 THEN
    RETURN jsonb_build_object('ok',true,'closed',0,'still_held',v_open);
  END IF;
  FOR v_c IN SELECT c.id FROM public.poker_diamond_custody c
              WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance=0
              ORDER BY c.created_at, c.id
  LOOP
    PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
    v_receipt := public.fn_poker_diamond_release(v_c.id, uuid_in(md5('poker-tournament-close:'||v_c.id::text)::cstring));
    PERFORM set_config('app.poker_diamond_tournament_release', '', true);
    IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE OR (v_receipt->>'amount')::bigint <> 0 THEN
      RAISE EXCEPTION 'diamond_tournament_close_failed' USING ERRCODE='P0404';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'closed',v_n,'still_held',0);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_close_custody(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_close_custody(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_close_custody(p_tournament_id uuid)

-- @@DOOR fn_poker_diamond_tournament_custody(p_tournament_id uuid)
-- @@PIN md5=b2a879b0e870447f2734b6179fe5fac3 len=383 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(balance),0)::bigint FROM public.poker_diamond_custody
   WHERE purpose = 'tournament_entry' AND target_id = p_tournament_id AND state <> 'released';
$function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid) TO service_role;
-- @@END fn_poker_diamond_tournament_custody(p_tournament_id uuid)

-- @@DOOR fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid)
-- @@PIN md5=25af87faee3db07b6dec956278eaa6bc len=4916 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_c public.poker_diamond_custody%ROWTYPE;
 v_prev public.poker_diamond_movements%ROWTYPE;
 v_request jsonb; v_receipt jsonb;
 v_wallet bigint; v_locked bigint; v_days integer;
 v_left bigint; v_take bigint; v_lot record; v_journal uuid;
BEGIN
 IF p_custody_id IS NULL OR p_request_id IS NULL
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647 OR p_amount<>trunc(p_amount) THEN
  RAISE EXCEPTION 'invalid_diamond_tournament_add' USING ERRCODE='22023';
 END IF;
 SELECT user_id INTO v_c.user_id FROM public.poker_diamond_custody WHERE id=p_custody_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_custody_not_found'; END IF;
 -- Wallet first, exactly as the reserve and the top-up take it.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=v_c.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
 SELECT * INTO v_c FROM public.poker_diamond_custody WHERE id=p_custody_id FOR UPDATE;
 v_request:=jsonb_build_object('user_id',v_c.user_id,'custody_id',p_custody_id,
  'amount',p_amount,'action','tournament_add');
 SELECT * INTO v_prev FROM public.poker_diamond_movements WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prev.request IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'idempotency_payload_mismatch'; END IF;
  RETURN v_prev.receipt;
 END IF;
 IF v_c.purpose<>'tournament_entry' OR v_c.state<>'active' THEN
  RAISE EXCEPTION 'diamond_tournament_custody_not_open' USING ERRCODE='55000';
 END IF;
 IF v_c.balance+p_amount>2147483647 THEN
  RAISE EXCEPTION 'diamond_amount_out_of_range' USING ERRCODE='22003';
 END IF;
 SELECT settlement_window_days INTO v_days FROM public.ca_arena_settings WHERE id=1 AND club_id=v_c.arena_id;
 IF v_days IS NULL THEN RAISE EXCEPTION 'diamond_arena_policy_missing'; END IF;
 IF EXISTS(SELECT 1 FROM public.diamond_debts WHERE user_id=v_c.user_id AND settled_at IS NULL AND amount>0) THEN
  RAISE EXCEPTION 'diamond_debt_requires_settlement';
 END IF;
 PERFORM id FROM public.diamond_purchase_lots WHERE user_id=v_c.user_id ORDER BY created_at,id FOR UPDATE;
 SELECT COALESCE(sum(GREATEST(issued-consumed-refunded-arena_reserved,0)),0) INTO v_locked
  FROM public.diamond_purchase_lots WHERE user_id=v_c.user_id
   AND (frozen_at IS NOT NULL OR created_at>now()-make_interval(days=>v_days));
 IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
  RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;
 v_left:=p_amount;
 FOR v_lot IN SELECT id,GREATEST(issued-consumed-refunded-arena_reserved,0) available
  FROM public.diamond_purchase_lots WHERE user_id=v_c.user_id AND frozen_at IS NULL
   AND created_at<=now()-make_interval(days=>v_days) ORDER BY created_at,id LOOP
  EXIT WHEN v_left=0;
  v_take:=LEAST(v_left,v_lot.available);
  IF v_take>0 THEN
   UPDATE public.diamond_purchase_lots SET arena_reserved=arena_reserved+v_take WHERE id=v_lot.id;
   UPDATE public.poker_diamond_lot_reservations SET amount=amount+v_take
     WHERE custody_id=v_c.id AND lot_id=v_lot.id AND released_at IS NULL;
   IF NOT FOUND THEN
    BEGIN
     INSERT INTO public.poker_diamond_lot_reservations(custody_id,lot_id,amount) VALUES(v_c.id,v_lot.id,v_take);
    EXCEPTION WHEN unique_violation THEN
     RAISE EXCEPTION 'diamond_tournament_lot_already_released' USING ERRCODE='23514';
    END;
   END IF;
   v_left:=v_left-v_take;
  END IF;
 END LOOP;
 INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
  reference_id,description,source,issuance_class,counterparty,metadata)
 VALUES(v_c.user_id,'arena_deposit','arena_deposit',-p_amount::integer,v_wallet-p_amount,
  'poker-tournament-add:'||p_request_id,'Added diamonds to a Poker Arena tournament entry','poker_arena','arena',
  'arena_custody:'||v_c.id,jsonb_build_object('custody_id',v_c.id,'request_id',p_request_id,
   'purpose','tournament_entry','target_id',v_c.target_id,'purchased_reserved',p_amount-v_left)) RETURNING id INTO v_journal;
 UPDATE public.profiles SET diamonds=diamonds-p_amount::integer,updated_at=now() WHERE id=v_c.user_id;
 UPDATE public.poker_diamond_custody SET balance=balance+p_amount WHERE id=v_c.id;
 v_receipt:=jsonb_build_object('success',true,'custody_id',v_c.id,'request_id',p_request_id,
  'amount',p_amount,'custody_balance',v_c.balance+p_amount,
  'available_balance',v_wallet-p_amount,'journal_id',v_journal);
 INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
  source_account,destination_account,wallet_journal_id,request,receipt)
 VALUES(p_request_id,v_c.id,v_c.user_id,'reserve',p_amount,'player:'||v_c.user_id,
  'arena_custody:'||v_c.id,v_journal,v_request,v_receipt);
 RETURN v_receipt;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid)

-- @@DOOR fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
-- @@PIN md5=abaf068c32e192f08a1c01c02b089523 len=5510 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_left bigint := p_amount; v_take bigint; v_c record; v_lot record; v_loss bigint;
  v_drained jsonb := '[]'::jsonb; v_req uuid; v_journal uuid; v_wallet bigint; v_name text;
BEGIN
  IF p_tournament_id IS NULL OR p_bank NOT IN ('prize','fee','bounty') OR p_amount IS NULL OR p_amount < 1 OR p_reason IS NULL
     OR p_destination_account IS NULL OR length(btrim(p_destination_account))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_drain' USING ERRCODE='22023';
  END IF;
  IF public.fn_poker_diamond_tournament_custody(p_tournament_id) < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  SELECT t.name INTO v_name FROM public.tournaments t WHERE t.id=p_tournament_id;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;
  FOR v_c IN
    SELECT c.id, c.user_id, c.balance, c.arena_id,
           (SELECT COALESCE(sum(CASE WHEN p_bank='prize' THEN l.prize_part
                                     WHEN p_bank='bounty' THEN l.bounty_part
                                     ELSE l.fee_part END),0)
              FROM public.poker_diamond_tournament_ledger l
             WHERE l.custody_id=c.id AND l.kind IN ('entry','rebuy','reentry','addon'))
         - (SELECT COALESCE(sum(m.amount),0) FROM public.poker_diamond_movements m
             WHERE m.custody_id=c.id AND m.action='release'
               AND m.request->>'action'='tournament_drain' AND m.request->>'bank'=p_bank) AS held
      FROM public.poker_diamond_custody c
     WHERE c.purpose='tournament_entry' AND c.target_id=p_tournament_id AND c.state<>'released' AND c.balance > 0
     ORDER BY c.created_at, c.id
     FOR UPDATE OF c
  LOOP
    EXIT WHEN v_left = 0;
    CONTINUE WHEN v_c.held <= 0;
    v_take := LEAST(v_left, v_c.held, v_c.balance);
    -- The lots this row holds are consumed for what leaves it, oldest first,
    -- exactly as fn_poker_diamond_settle_cash_hand consumes a lost stack.
    v_loss := v_take;
    FOR v_lot IN
      SELECT l.id, r.amount-r.consumed AS held, greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
        FROM public.poker_diamond_lot_reservations r
        JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
       WHERE r.custody_id=v_c.id AND r.released_at IS NULL
       ORDER BY l.created_at, l.id FOR UPDATE OF l, r
    LOOP
      EXIT WHEN v_loss = 0;
      IF v_lot.held > 0 THEN
        UPDATE public.diamond_purchase_lots
           SET arena_reserved=arena_reserved-LEAST(v_loss,v_lot.held),
               consumed=consumed+LEAST(LEAST(v_loss,v_lot.held),v_lot.outstanding)::integer
         WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations SET consumed=consumed+LEAST(v_loss,v_lot.held)
         WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss - LEAST(v_loss,v_lot.held);
      END IF;
    END LOOP;
    -- The journal row the movement carries: the recipient's credit for a
    -- prize or a bounty; for a fee, this player's own spend, which the
    -- register retires.
    IF p_journal_for IS NOT NULL THEN
      v_journal := p_journal_for;
    ELSE
      SELECT COALESCE(diamonds,0) INTO v_wallet FROM public.profiles WHERE id=v_c.user_id;
      INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after,
        reference_id,description,source,issuance_class,counterparty,metadata)
      VALUES (v_c.user_id,'tournament_fee','tournament_fee',-v_take::integer,v_wallet,
        p_reason||':'||v_c.id::text,'Tournament entry fee: '||COALESCE(v_name,'tournament')||' (from custody to the house)',
        'poker_arena','spend','house',
        jsonb_build_object('custody_id',v_c.id,'tournament_id',p_tournament_id,'reason',p_reason,'destination','house'))
      RETURNING id INTO v_journal;
    END IF;
    -- The movement first, then the balance: P0814 (an entry holds exactly its
    -- movements) is checked at the end of this UPDATE, not at commit, because
    -- a row drained twice in one settlement (the fee, then a prize) would
    -- otherwise present its first version against the final movement sum.
    v_req := uuid_in(md5(p_reason||':'||v_c.id::text)::cstring);
    INSERT INTO public.poker_diamond_movements(request_id,custody_id,user_id,action,amount,
      source_account,destination_account,wallet_journal_id,request,receipt)
    VALUES (v_req,v_c.id,v_c.user_id,'release',v_take,'arena_custody:'||v_c.id,p_destination_account,v_journal,
      jsonb_build_object('action','tournament_drain','bank',p_bank,'reason',p_reason,'custody_id',v_c.id,'amount',v_take),
      jsonb_build_object('success',true,'custody_id',v_c.id,'amount',v_take,'custody_balance',v_c.balance-v_take,'journal_id',v_journal));
    UPDATE public.poker_diamond_custody SET balance=balance-v_take WHERE id=v_c.id;
    v_drained := v_drained || jsonb_build_object('custody_id',v_c.id,'user_id',v_c.user_id,'amount',v_take,'journal_id',v_journal,'request_id',v_req);
    v_left := v_left - v_take;
  END LOOP;
  SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_custody_short' USING ERRCODE='P0404';
  END IF;
  RETURN v_drained;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)

-- @@DOOR fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
-- @@PIN md5=850410a45ed7eefe785d3f17a2403247 len=1803 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT
      COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
      COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
      COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'refund'),0) AS refund_out,
      COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
      COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
      COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id)
  SELECT prize_in::numeric, bounty_in::numeric, fee_in::numeric, 0::numeric, 0::numeric,
         prize_out::numeric, bounty_out::numeric, fee_out::numeric, refund_out::numeric,
         (prize_in - prize_out - refund_prize)::numeric,
         (bounty_in - bounty_out - refund_bounty)::numeric,
         (fee_in - fee_out - refund_fee)::numeric
  FROM l;
$function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid) TO service_role;
-- @@END fn_poker_diamond_tournament_escrow(p_tournament_id uuid)

-- @@DOOR fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)
-- @@PIN md5=15beba292789e7f1e665c7caa9530304 len=2853 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l record; v_x record;
BEGIN
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  SELECT
    COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
    COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
    COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
    COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
    COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
    COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
    COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee
    INTO l
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id;
  INSERT INTO public.tournament_escrow
    (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
     prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
     prize_balance, bounty_balance, fee_balance, opened_from)
  VALUES
    (p_tournament_id, true, l.prize_in + l.bounty_in + l.fee_in, l.fee_in, 0, l.bounty_in, 0, 0,
     l.prize_out, l.bounty_out, l.fee_out, l.refund_prize, l.refund_bounty, l.refund_fee, 0, 0,
     l.prize_in - l.prize_out - l.refund_prize, l.bounty_in - l.bounty_out - l.refund_bounty,
     l.fee_in - l.fee_out - l.refund_fee, 'diamond terminal shadow (from the Diamond ledger)')
  ON CONFLICT (tournament_id) DO NOTHING;
  SELECT x.* INTO v_x FROM public.tournament_escrow x WHERE x.tournament_id = p_tournament_id;
  IF v_x.prize_balance IS DISTINCT FROM (l.prize_in - l.prize_out - l.refund_prize)::numeric
     OR v_x.bounty_balance IS DISTINCT FROM (l.bounty_in - l.bounty_out - l.refund_bounty)::numeric
     OR v_x.fee_balance IS DISTINCT FROM (l.fee_in - l.fee_out - l.refund_fee)::numeric
     OR v_x.prize_balance + v_x.bounty_balance + v_x.fee_balance
        IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'tournament % escrow shadow disagrees with its Diamond banks', p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'prize_balance',v_x.prize_balance,'bounty_balance',v_x.bounty_balance,'fee_balance',v_x.fee_balance);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)

-- @@DOOR fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)
-- @@PIN md5=e246c03b5a6d2aff690d227912ff7e82 len=4799 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid; v_kind text; v_bank numeric; v_inserted integer; v_drained jsonb; v_credit jsonb; v_e record;
  v_category text := lower(COALESCE(p_category,''));
BEGIN
  IF p_user_id IS NULL OR p_tournament_id IS NULL OR p_idempotency_key IS NULL
     OR p_amount IS NULL OR p_amount < 1 OR p_amount <> trunc(p_amount) OR p_amount > 2147483647 THEN
    RAISE EXCEPTION 'diamond_tournament_pay_requires_whole_diamonds' USING ERRCODE='22023';
  END IF;
  SELECT t.club_id INTO v_arena FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514'; END IF;
  v_kind := CASE WHEN v_category='bounty' THEN 'bounty'
                 WHEN v_category='prize' THEN 'prize'
                 ELSE NULL END;
  IF v_kind IS NULL THEN
    -- A refund never reaches this door: the Diamond refund authority returns
    -- entries whole through fn_poker_diamond_release.
    RAISE EXCEPTION 'diamond_tournament_pay_unknown_category:%', v_category USING ERRCODE='22023';
  END IF;

  -- The key is claimed before any Diamond moves, as the chip credit claims it.
  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES (p_idempotency_key,p_user_id,p_amount) ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;

  -- The bank this payment draws on: a place from the prize bank, a knockout
  -- (its cash half, the champion's own head, the residual) from the bounty
  -- bank. Each is the sum of the entries' parts less what it already paid.
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_bank := CASE WHEN v_kind='bounty' THEN v_e.bounty_balance ELSE v_e.prize_balance END;
  IF v_bank < p_amount THEN
    RAISE EXCEPTION 'diamond_tournament_bank_short' USING ERRCODE='P0404';
  END IF;
  -- A knockout is paid while the event runs, before the terminal opens the
  -- escrow shadow; the shadow is opened here from the Diamond ledger's exact
  -- parts (idempotent, asserted) so the chip shadow never opens itself from a
  -- proportional split at the first bounty.
  PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);

  -- The recipient's wallet first (its journal row is what every drained
  -- row's movement carries), then the custody rows, oldest first.
  v_credit := public.add_diamonds_to_balance(
    p_user_id, p_amount::integer, 'arena_withdraw',
    COALESCE(NULLIF(btrim(p_description),''), CASE WHEN v_kind='bounty' THEN 'Tournament bounty' ELSE 'Tournament prize' END),
    'poker-tournament-pay:'||p_idempotency_key);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE OR NULLIF(v_credit->>'transaction_id','') IS NULL THEN
    RAISE EXCEPTION 'diamond_tournament_pay_credit_failed:%', v_credit->>'error' USING ERRCODE='P0404';
  END IF;
  v_drained := public.fn_poker_diamond_tournament_drain(
    p_tournament_id, v_kind, p_amount::bigint, 'poker-tournament-pay:'||p_idempotency_key, 'player:'||p_user_id::text,
    (v_credit->>'transaction_id')::uuid);

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,request)
  VALUES (p_tournament_id,v_arena,p_user_id,NULL,v_kind,p_amount::bigint,
    CASE WHEN v_kind='prize' THEN p_amount::bigint ELSE 0 END,
    CASE WHEN v_kind='bounty' THEN p_amount::bigint ELSE 0 END,0,
    'poker-tournament-pay:'||p_idempotency_key,(v_credit->>'transaction_id')::uuid,
    jsonb_build_object('kind',v_kind,'credit_key',p_idempotency_key,'drained',v_drained,'description',p_description));

  -- The escrow shadow follows, as a chip payment's wallet row makes it follow.
  IF v_kind='bounty' THEN
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond bounty',p_bounty_out => p_amount);
  ELSE
    PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond prize',p_prize_out => p_amount);
  END IF;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN true;
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)

-- @@DOOR fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)
-- @@PIN md5=4dcc2e8556323bf831de3863e218f97a len=5977 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_c public.poker_diamond_custody%ROWTYPE; v_parts record;
  v_receipt jsonb; v_key text; v_ledger bigint; v_ob uuid; v_existing public.poker_diamond_tournament_ledger%ROWTYPE;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL
     OR p_kind IS NULL OR p_kind NOT IN ('unregister','cancel')
     OR p_source IS NULL OR length(btrim(p_source))=0 THEN
    RAISE EXCEPTION 'invalid_diamond_tournament_refund' USING ERRCODE='22023';
  END IF;
  SELECT t.id,t.status,t.started_at,t.name INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND OR NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;
  v_key := 'poker-tournament-refund:'||p_tournament_id::text||':'||p_user_id::text||':'||p_kind||':'||p_request_id::text;
  SELECT * INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'fully_settled',true,'remaining',0,
      'paid',v_existing.amount,'refund_prize',v_existing.prize_part,'refund_bounty',v_existing.bounty_part,
      'refund_fee',v_existing.fee_part,'custody_id',v_existing.custody_id,'ledger_id',v_existing.id);
  END IF;

  -- The roster decides whether this Diamond can go home: before the event
  -- starts a registration may be withdrawn; once it has started only a
  -- cancellation returns entries, and a cancellation returns every entry.
  IF p_kind='unregister' THEN
    IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
      RAISE EXCEPTION 'diamond_tournament_entry_in_play' USING ERRCODE='55000';
    END IF;
  ELSE
    IF upper(COALESCE(v_t.status,'')) IN ('COMPLETED','COMPLETING') THEN
      RAISE EXCEPTION 'diamond_tournament_already_settled' USING ERRCODE='55000';
    END IF;
  END IF;
  -- An event that has paid anybody is not refundable by this door.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
              WHERE l.tournament_id=p_tournament_id AND l.kind IN ('prize','bounty','fee')) THEN
    RAISE EXCEPTION 'diamond_tournament_already_paid' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_c FROM public.poker_diamond_custody
   WHERE user_id=p_user_id AND purpose='tournament_entry' AND target_id=p_tournament_id AND state<>'released'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_tournament_entry_not_held' USING ERRCODE='55000';
  END IF;
  IF v_c.state<>'active' OR v_c.balance<1 OR v_c.seat_id IS NOT NULL THEN
    RAISE EXCEPTION 'diamond_custody_requires_settlement' USING ERRCODE='55000';
  END IF;
  -- What this custody row holds, by bank: everything that entered it, less
  -- nothing, because nothing has left it (asserted above).
  SELECT COALESCE(sum(prize_part),0) AS prize, COALESCE(sum(bounty_part),0) AS bounty,
         COALESCE(sum(fee_part),0) AS fee, COALESCE(sum(amount),0) AS gross
    INTO v_parts FROM public.poker_diamond_tournament_ledger
   WHERE custody_id=v_c.id AND kind IN ('entry','rebuy','reentry','addon');
  IF v_parts.gross IS DISTINCT FROM v_c.balance THEN
    RAISE EXCEPTION 'diamond_tournament_custody_disagrees_with_ledger' USING ERRCODE='P0404';
  END IF;

  -- Open the release for this one row, in this transaction only, then close it.
  PERFORM set_config('app.poker_diamond_tournament_release', v_c.id::text, true);
  v_receipt := public.fn_poker_diamond_release(v_c.id, p_request_id);
  PERFORM set_config('app.poker_diamond_tournament_release', '', true);
  IF COALESCE((v_receipt->>'success')::boolean,false) IS NOT TRUE
     OR (v_receipt->>'amount')::bigint IS DISTINCT FROM v_c.balance THEN
    RAISE EXCEPTION 'diamond_tournament_release_failed' USING ERRCODE='P0404';
  END IF;

  -- The refund is an obligation the way a chip refund is, so the reconciler
  -- and the receipt see one vocabulary. amount_paid closes at amount_owed.
  INSERT INTO public.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
  VALUES (p_tournament_id,'refund',NULL,p_user_id,v_c.balance,v_c.balance,p_source,now())
  ON CONFLICT (tournament_id,kind,user_id) WHERE place IS NULL DO UPDATE
    SET amount_owed = public.tournament_obligations.amount_owed + EXCLUDED.amount_owed,
        amount_paid = public.tournament_obligations.amount_paid + EXCLUDED.amount_paid,
        updated_at = now(), settled_at = now()
  RETURNING id INTO v_ob;

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,
    idempotency_key,wallet_journal_id,obligation_id,request)
  VALUES (p_tournament_id,v_c.arena_id,p_user_id,v_c.id,'refund',v_c.balance,v_parts.prize,v_parts.bounty,v_parts.fee,
    v_key,NULLIF(v_receipt->>'journal_id','')::uuid,v_ob,
    jsonb_build_object('kind',p_kind,'source',p_source,'request_id',p_request_id))
  RETURNING id INTO v_ledger;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'paid',v_c.balance,
    'refund_prize',v_parts.prize,'refund_bounty',v_parts.bounty,'refund_fee',v_parts.fee,
    'custody_id',v_c.id,'ledger_id',v_ledger,'obligation_id',v_ob,'journal_id',v_receipt->>'journal_id',
    'available_balance',v_receipt->>'available_balance');
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)

-- @@DOOR fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text)
-- @@PIN md5=4e947c948d953098fb63c26d14decde8 len=4328 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_arena uuid; v_e record; v_fee bigint; v_drained jsonb; v_before numeric; v_after numeric;
  v_supply numeric; v_key text; v_ledger bigint; v_name text; v_existing bigint; v_burned numeric;
BEGIN
  IF p_tournament_id IS NULL THEN RAISE EXCEPTION 'invalid_diamond_tournament_fee' USING ERRCODE='22023'; END IF;
  SELECT t.club_id, t.name INTO v_arena, v_name FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_tournament_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
  IF v_arena IS NULL THEN RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514'; END IF;
  v_key := 'poker-tournament-fee:'||p_tournament_id::text;
  SELECT id INTO v_existing FROM public.poker_diamond_tournament_ledger WHERE idempotency_key=v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',(SELECT amount FROM public.poker_diamond_tournament_ledger WHERE id=v_existing));
  END IF;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id);
  v_fee := v_e.fee_balance::bigint;
  IF v_fee <= 0 THEN
    RETURN jsonb_build_object('ok',true,'amount',0,'destination','none');
  END IF;

  -- Out of the fee parts of the custody rows: each player's own fee,
  -- journaled as that player's spend, which the register retires from that
  -- player (trg_ca_diamond_register_follows_journal).
  v_drained := public.fn_poker_diamond_tournament_drain(p_tournament_id, 'fee', v_fee, v_key, 'house', NULL);
  SELECT COALESCE(sum(m.amount),0) INTO v_burned FROM public.ca_mint_ledger m
   WHERE m.asset='diamonds' AND m.action='burn' AND m.holder_type='player'
     AND m.diamond_tx_id IN (SELECT (d->>'journal_id')::uuid FROM jsonb_array_elements(v_drained) d);
  IF v_burned IS DISTINCT FROM v_fee::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_fee_not_retired_from_players (% of %)', v_burned, v_fee USING ERRCODE='P0404';
  END IF;

  -- Into the house: the balance and the register, exactly as fn_ca_mint
  -- issues to the house (no house journal row: that journal is keyed by a
  -- user, and ca_mint_ledger is the record of a house-side issuance; the
  -- register's generated origin reads 'operator' for every non-journal op_id,
  -- as it does for fn_ca_mint's own house rows).
  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  SELECT COALESCE(balance,0) INTO v_before FROM public.ca_diamond_house WHERE id=1 FOR UPDATE;
  UPDATE public.ca_diamond_house SET balance=COALESCE(balance,0)+v_fee, updated_at=now() WHERE id=1 RETURNING balance INTO v_after;
  SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply FROM public.ca_mint_ledger WHERE asset='diamonds';
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after, supply_after, reason)
  VALUES
    (v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_fee, v_before, v_after, v_supply+v_fee,
     'Tournament entry fees banked to the house from the players'' custody ('||COALESCE(v_name,'tournament')||'), DR14 (poker_tournament_fee)');

  INSERT INTO public.poker_diamond_tournament_ledger(
    tournament_id,arena_id,user_id,custody_id,kind,amount,prize_part,bounty_part,fee_part,idempotency_key,request)
  VALUES (p_tournament_id,v_arena,NULL,NULL,'fee',v_fee,0,0,v_fee,v_key,
    jsonb_build_object('source',p_source,'drained',v_drained,'house_balance_after',v_after))
  RETURNING id INTO v_ledger;

  IF (SELECT prize_balance+bounty_balance+fee_balance FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id))
     IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(p_tournament_id)::numeric THEN
    RAISE EXCEPTION 'diamond_tournament_escrow_disagrees_with_custody' USING ERRCODE='P0404';
  END IF;
  RETURN jsonb_build_object('ok',true,'amount',v_fee,'destination','diamond_house','ledger_id',v_ledger,'house_balance_after',v_after);
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text)

-- @@DOOR fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)
-- @@PIN md5=39f95b499619cab7a1eb65ff583aa638 len=7212 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE; v_reg public.tournament_players%ROWTYPE;
  v_refund jsonb; v_players_before integer; v_rows integer;
  v_prior public.poker_diamond_tournament_ledger%ROWTYPE; v_prior_reg uuid;
  v_authority text := 'scheduled_clock';
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'tournament, player and request ids are required' USING ERRCODE='22004';
  END IF;
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT * INTO v_t FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'diamond_asset_required' USING ERRCODE='23514';
  END IF;

  -- A withdrawal that already happened answers with what it did: the same
  -- receipt the first answer carried, rebuilt from the refund ledger row
  -- (its registration id from the entry row of the same custody), so the
  -- client's one exact replay after a lost response is a receipt. The chip
  -- authority replays its stored receipt the same way, past the clock too.
  SELECT l.* INTO v_prior FROM public.poker_diamond_tournament_ledger l
   WHERE l.tournament_id=p_tournament_id AND l.user_id=p_user_id AND l.kind='refund'
     AND l.request->>'request_id'=p_request_id::text
   ORDER BY l.id LIMIT 1;
  IF FOUND THEN
    SELECT e.registration_id INTO v_prior_reg FROM public.poker_diamond_tournament_ledger e
     WHERE e.custody_id=v_prior.custody_id AND e.kind='entry'
     ORDER BY e.id LIMIT 1;
    RETURN jsonb_build_object('ok',true,'idempotent',true,'replayed',true,'fully_settled',true,'remaining',0,
      'request_id',p_request_id,
      'refunded_diamonds',v_prior.amount,'refund_prize',v_prior.prize_part,
      'refund_bounty',v_prior.bounty_part,'refund_fee',v_prior.fee_part,
      'registration_id',v_prior_reg,'custody_id',v_prior.custody_id,'obligation_id',v_prior.obligation_id,
      'asset','diamonds','diamonds_after',(SELECT p.diamonds FROM public.profiles p WHERE p.id=p_user_id));
  END IF;

  -- The start authority is the chip authority's. A scheduled event closes at
  -- its clock. A spin or a heads-up sit-and-go is seat-first: start_time is
  -- only its fill-window deadline, and it closes when it actually starts. A
  -- launch releasing a registrant it could not seat names its incomplete
  -- receipt through app.ca_launch_release_launch_id; it is past the clock by
  -- design and is held to the seat-first proofs instead. A persisted hand
  -- closes every product.
  IF v_t.format_contract='spin-v1' THEN
    v_authority := 'spin_actual_start';
  ELSIF v_t.format_contract='sng-v1'
     AND COALESCE(v_t.max_players,0)=2 THEN
    v_authority := 'heads_up_sng_actual_start';
  END IF;
  IF v_authority='scheduled_clock' AND EXISTS (
       SELECT 1 FROM public.tournament_launch_receipts r
        WHERE r.tournament_id=p_tournament_id
          AND r.completed_at IS NULL
          AND r.launch_id::text=NULLIF(current_setting('app.ca_launch_release_launch_id',true),'')) THEN
    v_authority := 'launch_release';
  END IF;
  IF upper(COALESCE(v_t.status,'')) NOT IN ('ANNOUNCED','REGISTERING') OR v_t.started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  PERFORM public.fn_ca_tournament_recorded_format(p_tournament_id);
  IF EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables ht JOIN public.hand_history hh ON hh.table_id=ht.id
                 WHERE ht.tournament_id=p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_authority='scheduled_clock' THEN
    IF v_t.start_time IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
    END IF;
    IF clock_timestamp()>=v_t.start_time THEN
      RETURN jsonb_build_object('ok',false,'reason','tournament_started');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id FOR UPDATE;
  IF v_reg.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_registered'); END IF;
  IF v_reg.status::text NOT IN ('registered','playing') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  SELECT count(*)::integer INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.status::text IN ('registered','playing');

  -- Money first: the release is the part that can refuse.
  v_refund := public.fn_poker_diamond_tournament_refund(
    p_tournament_id, p_user_id, 'unregister', 'fn_unregister_from_tournament', p_request_id);

  -- The same roster effects the chip authority produces, in the same order.
  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(COALESCE(prize_pool,0)-(v_refund->>'refund_prize')::numeric,2),
         bounty_pool=round(COALESCE(bounty_pool,0)-(v_refund->>'refund_bounty')::numeric,2),
         total_rake=round(COALESCE(total_rake,0)-(v_refund->>'refund_fee')::numeric,2),
         updated_at=now()
   WHERE id=p_tournament_id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'tournament vanished during unregistration' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('ok',true,'fully_settled',true,'remaining',0,'request_id',p_request_id,
    'refunded_diamonds',(v_refund->>'paid')::numeric,'refund_prize',(v_refund->>'refund_prize')::numeric,
    'refund_bounty',(v_refund->>'refund_bounty')::numeric,'refund_fee',(v_refund->>'refund_fee')::numeric,
    'registration_id',v_reg.id,'custody_id',v_refund->>'custody_id','obligation_id',v_refund->>'obligation_id',
    'asset','diamonds','diamonds_after',(SELECT p.diamonds FROM public.profiles p WHERE p.id=p_user_id));
END $function$;
ALTER FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)

-- @@DOOR fn_poker_guard_chip_seat()
-- @@PIN md5=3326766760c7b9c9bfe12daca34ebd0f len=2392 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_poker_guard_chip_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
     WHERE t.id=NEW.table_id AND c.asset='diamonds') THEN RETURN NEW; END IF;
 IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) IS NULL THEN
   /* A CASH SEAT IS ITS CUSTODY. The stack a player sits down with IS the
      Diamonds held for that seat, which is why a cash-out can pay the stack.
      This block is the live rule, unchanged. */
   IF TG_OP<>'INSERT' OR NOT EXISTS (
     SELECT 1 FROM public.poker_diamond_custody c
       JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
     WHERE c.user_id=NEW.user_id AND c.target_id=NEW.table_id AND c.purpose='cash_seat'
       AND c.entry_key='seat:'||NEW.id AND c.state='reserved' AND c.balance=NEW.stack
       AND c.seat_id IS NULL AND a.cash_games_enabled
   ) THEN
     RAISE EXCEPTION 'Diamond Seat Requires Atomic Custody Funding' USING ERRCODE='23514';
   END IF;
 ELSE
   /* A TOURNAMENT SEAT IS NOT ITS CUSTODY. The stack is a nonredeemable play
      unit; the money is the ENTRY, held against the tournament. So the seat is
      admitted by a funded live entry and by NO equation with the stack. */
   IF NOT EXISTS (
     SELECT 1 FROM public.tables t
       JOIN public.poker_diamond_custody c ON c.target_id=t.tournament_id
        AND c.user_id=NEW.user_id AND c.arena_id=t.club_id
        AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL
       JOIN public.ca_arena_settings a ON a.club_id=c.arena_id AND a.id=1
     WHERE t.id=NEW.table_id AND a.tournaments_enabled
   ) THEN
     RAISE EXCEPTION 'Diamond Tournament Seat Requires A Funded Entry' USING ERRCODE='P0810';
   END IF;
   /* One entry buys one event. Balancing may move the seat from table to table
      inside that event, and nowhere else. */
   IF TG_OP='UPDATE' THEN
     IF (SELECT t.tournament_id FROM public.tables t WHERE t.id=OLD.table_id)
        IS DISTINCT FROM (SELECT t.tournament_id FROM public.tables t WHERE t.id=NEW.table_id) THEN
       RAISE EXCEPTION 'A Diamond Tournament Seat Moves Only Inside Its Own Tournament'
         USING ERRCODE='P0811';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_poker_guard_chip_seat() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_guard_chip_seat() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_poker_guard_chip_seat() TO service_role;
-- @@END fn_poker_guard_chip_seat()

-- @@DOOR fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean)
-- @@PIN md5=591867b92e0749eb0e493c56707ae328 len=16009 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_uid uuid := auth.uid();
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);  -- DIAMOND PHASE 8
  v_dia jsonb;                                                              -- DIAMOND PHASE 8
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
  v_seat_reason text;                                    -- SEAT FIX 2026-08-27
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips,
         variant
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- SEAT-FIRST GUARD 2026-08-27, REBUILT 2026-08-28. A seat-first event is
  -- bought by taking a seat; registering into one debits the player for a
  -- seat that is never allocated. But the seat path ITSELF registers the
  -- player through this function, so the guard admits that caller via
  -- p_seat_first_internal - the original guard refused it too and no human
  -- could buy a Spin or Heads-Up seat at all. And the predicate is now the
  -- CANONICAL seat-first test (variant 'spin' OR a positive max_players <= 2), matching
  -- fn_take_seat_and_buy_in and fn_sync_seat_first_player_count: the original
  -- blocked ALL sngs, which left 6-max and 9-max SNGs with no entry path in
  -- either door.
  IF NOT p_seat_first_internal
     AND NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND (lower(COALESCE(v_t.variant, '')) = 'spin'
       OR (v_t.max_players IS NOT NULL
         AND v_t.max_players > 0 AND v_t.max_players <= 2)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_first_variant',
      'detail', 'This format is entered by taking a seat, not by registering. '
                || 'Call fn_take_seat_and_buy_in for the seat you want.',
      'variant', v_t.variant);
  END IF;

  IF v_t.status = 'RUNNING' THEN
    v_late_open:=public.fn_tournament_late_registration_open(p_tournament_id);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  IF NOT public.fn_ca_tournament_is_unlimited(p_tournament_id)
     AND v_t.max_players IS NOT NULL AND v_t.max_players > 0
     AND v_players_before >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'co_owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: every bounty format puts the flat bounty on
  -- the head; the mystery value is drawn from a funded inventory at the
  -- knockout, not from a seeded PRNG at the till.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 AND v_unit = 100 THEN
    -- DIAMOND PHASE 8: a Diamond entry is custody, not a club-wallet debit. The
    -- roster row is written first so the custody row can name it; the whole
    -- transaction still rolls back together.
    IF v_split.charge <> trunc(v_split.charge) OR v_split.prize <> trunc(v_split.prize)
       OR v_split.rake <> trunc(v_split.rake) OR v_split.bounty <> trunc(v_split.bounty) THEN
      RAISE EXCEPTION 'diamond_tournament_requires_whole_amounts' USING ERRCODE = '23514';
    END IF;
    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_charge(
        v_uid, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
        v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || v_uid::text || ':' || v_player_id::text);
    EXCEPTION WHEN OTHERS THEN
      -- DIAMOND PHASE 8: an ordinary refusal is answered the way the chip core
      -- answers one, with a reason the client can say; anything else is raised.
      IF SQLERRM LIKE '%insufficient_settled_diamonds%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_diamonds');
      ELSIF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_debt_requires_settlement%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_debt_requires_settlement');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE REGISTRATION DEBIT NAMES ITS COUNTERPARTY.
    -- trg_club_members_audit_chip_movement journals the wallet write below; with no
    -- declaration it landed as adjustment player_wallet -> table_stack with no
    -- tournament_id (19,538 rows / 407,412.00 a day). Declared with set_config, not
    -- fn_ca_declare_ledger, so a vocabulary miss can never refuse a buy-in (the
    -- writer falls back to adjustment on its own). The whole charge (prize + bounty
    -- + fee) is ONE wallet write and so ONE row, booked against the tournament
    -- (prize_liability) that holds all three until it completes. The four settings
    -- are restored right after so nothing later in this transaction inherits them.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    PERFORM set_config('app.pnl_tournament_entitlement','',true);
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;
  END IF;

  BEGIN
    IF v_dia IS NOT NULL THEN
      -- DIAMOND PHASE 8: the roster row carries the id the custody row was named with.
      -- DIAMOND PHASE 9: the head rides on the roster row as it does for a
      -- chip entry, so the roster trigger does not seed it a second time.
      INSERT INTO public.tournament_players
        (id, tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (v_player_id, p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered',
              v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSIF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL AND v_unit = 1 THEN
    -- DIAMOND PHASE 8: a Diamond fee stays in custody until the event settles;
    -- rake_records is the chip estate's fee rail.
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  -- The roster trigger already writes the exact count while an event is
  -- ANNOUNCED/REGISTERING, but deliberately leaves RUNNING counts to the
  -- transaction that also seats the late entrant. Incrementing the cached
  -- value here therefore double-counted every pre-start entry. Require the
  -- exact state produced by that trigger (or the unchanged RUNNING state),
  -- then publish one roster-derived value together with the funded pools.
  v_expected_cached_players:=CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before+1
    ELSE v_players_before
  END;
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_expected_cached_players;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during registration'
      USING ERRCODE='40001';
  END IF;

  -- LATE SEAT 2026-08-23
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);

    -- SEAT FIX 2026-08-27: a late registrant who cannot be seated must not be
    -- charged; abort so debit, roster row, rake record and pool increments
    -- roll back together. 'already_seated_or_missing' is NOT a failure.
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) - no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,
    v_original_entitlement,v_original_wallet,v_dia);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    -- DIAMOND PHASE 8: the receipt names its asset and, for a Diamond entry,
    -- the wallet after the charge, so the client can move the balance it shows.
    'asset', CASE WHEN v_dia IS NOT NULL THEN 'diamonds' ELSE 'chips' END,
    'diamonds_after', CASE WHEN v_dia IS NOT NULL THEN (SELECT p.diamonds FROM public.profiles p WHERE p.id = v_uid) END,
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END;
$function$;
ALTER FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean)

-- @@DOOR fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=ff905b806203482d3e95fd706210bfb5 len=303 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_register_horse_for_tournament(
    p_tournament_id,p_user_id,true)
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid) TO service_role;
-- @@END fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
-- @@PIN md5=84c0354e68fb129b5373bc6024cba334 len=863 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  -- DIAMOND PHASE 8: house-funded horse entries are Phase 9.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN jsonb_build_object('ok',false,'reason','diamond_horse_funding_not_open');
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
END;
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) TO service_role;
-- @@END fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)

-- @@DOOR fn_register_horse_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=3717c2b05d58d51049181530338bf1e9 len=997 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.fn_register_horse_for_tournament_before_maintenance_gate(
      p_tournament_id, p_user_id);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM NOT LIKE 'Late registration could not seat the player (%)%' THEN
      RAISE;
    END IF;
    PERFORM public.fn_ensure_late_registration_capacity(p_tournament_id, 1);
    v_result := public.fn_register_horse_for_tournament_before_maintenance_gate(
      p_tournament_id, p_user_id);
  END;

  IF COALESCE((v_result->>'ok')::boolean, false)
     AND COALESCE((v_result->>'late_registration')::boolean, false) THEN
    PERFORM public.fn_emit_tournament_manager_wake(p_tournament_id, 'late_registration');
  END IF;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_register_horse_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=33de93271803a28f46c0a259bb2c01c4 len=10268 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_late_open boolean := false;
  v_start_chips integer := 0;
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
  v_seat jsonb := NULL;
  v_seat_reason text;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, start_time, early_bird_enabled, early_bird_chips,
         prize_pool_finalized
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- THE HUMAN DOOR'S STATUS TEST (2026-09-11). A finalized pool takes no
  -- entrant and says so as a reason; a RUNNING event admits an entrant while
  -- its late registration is open, exactly as fn_register_for_tournament does.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.status = 'RUNNING' THEN
    v_late_open := public.fn_tournament_late_registration_open(p_tournament_id);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before horse registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  /* ONE DEFINITION OF FULL (2026-09-06). This read `current_players >=
     max_players`, and on a seat-first event that column is overwritten with
     the live SEATED count - so an emptied seat read as a vacancy and this
     function walked back through the door, up to 32 paid entries into a
     two-handed sit-and-go. fn_enforce_tournament_capacity is the authority
     and would now refuse the insert outright; asking here keeps the refusal a
     reason rather than an exception, and rolls back nothing. */
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: no roll here either. A horse and a human must
  -- enter the same event on the same terms; when the two register functions
  -- disagreed about how a bounty head was set, they were two tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN
    -- DOOR (R11 - horses and humans are identical on every path). The wallet write
    -- below is journaled by trg_club_members_audit_chip_movement; undeclared it landed
    -- as adjustment player_wallet -> table_stack with no tournament. set_config, not
    -- fn_ca_declare_ledger, for the same reason as fn_register_for_tournament: a
    -- vocabulary miss must never refuse a buy-in. Restored right after the write.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    PERFORM set_config('app.pnl_tournament_entitlement','',true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM set_config('app.pnl_tournament_wallet_tx','',true);
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Horse tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  -- The roster trigger refreshes the cached count while ANNOUNCED/REGISTERING
  -- and leaves RUNNING to the transaction that seats the late entrant - the
  -- same expectation the human core holds.
  v_expected_cached_players := CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before + 1
    ELSE v_players_before
  END;
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_expected_cached_players;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during horse registration'
      USING ERRCODE='40001';
  END IF;

  -- LATE SEAT, as the human core does it: an entrant who cannot be seated is
  -- not charged - the 55000 abort rolls the debit, the roster row, the rake
  -- record and the pool increments back together.
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, p_user_id);
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) - no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- This original owner charged chips; the public Diamond refusal and ticket
  -- owner remain unchanged. Bind only this transaction's actual debit IDs.
  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,'chips',v_original_entitlement,v_original_wallet,NULL);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'late_registration', v_late_open,
    'seat', v_seat);
END;
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
-- @@PIN md5=d9a34831bf01f85933a6c79f3662be33 len=3122 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_is_horse boolean;
  v_ticket_lookup jsonb;
  v_ticket_id uuid;
  v_ticket_registration_count integer:=0;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_allow_wallet_charge IS NULL THEN
    RAISE EXCEPTION 'tournament, horse and wallet authority are required'
      USING ERRCODE='22004';
  END IF;

  -- Ticket return, ticket admission and terminal settlement use this order.
  -- Holding both locks through the no-ticket decision prevents a concurrent
  -- unregister from issuing a ticket between selection and a wallet debit.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
  END IF;

  SELECT is_horse INTO v_is_horse
    FROM public.profiles WHERE id=p_user_id;
  IF NOT COALESCE(v_is_horse,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_a_horse');
  END IF;

  -- An ambiguous-response retry arrives after the issued ticket has become
  -- redeemed. Recover that exact ticket id from the active immutable entry
  -- entitlement and let the admission core prove and replay the receipt.
  SELECT count(*),min(e.source_ticket_id::text)::uuid
    INTO v_ticket_registration_count,v_ticket_id
    FROM public.tournament_refund_entitlements e
    JOIN public.tournament_players tp ON tp.id=e.registration_id
   WHERE e.tournament_id=p_tournament_id
     AND e.user_id=p_user_id
     AND e.entitlement_kind='tournament_ticket'
     AND e.source_ticket_id IS NOT NULL
     AND tp.tournament_id=e.tournament_id
     AND tp.user_id=e.user_id
     AND tp.status::text IN ('registered','playing');
  IF v_ticket_registration_count>1 THEN
    RAISE EXCEPTION
      'horse ticket admission has multiple active immutable entitlements'
      USING ERRCODE='P0404';
  END IF;
  IF v_ticket_registration_count=1 AND v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  v_ticket_lookup:=public.fn_ca_find_tournament_entry_ticket_for(
    p_tournament_id,p_user_id);
  IF COALESCE((v_ticket_lookup->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_ticket_lookup;
  END IF;
  v_ticket_id:=NULLIF(v_ticket_lookup->>'ticket_id','')::uuid;
  IF v_ticket_id IS NOT NULL THEN
    RETURN public.fn_ca_register_for_tournament_with_ticket_for(
      p_tournament_id,v_ticket_id,p_user_id);
  END IF;

  IF p_allow_wallet_charge IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','hinted_tournament_ticket_no_longer_available');
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_atomic_lifecycle_gate(
    p_tournament_id,p_user_id);
END;
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)

-- @@DOOR fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=51a3254789bfdc2c1f80994d0c26ad6a len=564 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_seat_late_registrant_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$function$;
ALTER FUNCTION public.fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid) TO service_role;
-- @@END fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=4f1800b2cd9bbf61cf926130eb8f03db len=4434 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_start_chips integer;
  v_club uuid;
  v_bonus integer;
  v_chips integer;
  v_table uuid;
  v_cap int;
  v_seat int;
  v_taken int;
  v_opened boolean := false;
  v_capacity jsonb;
BEGIN
  PERFORM set_config('app.money_path', 'fn_seat_late_registrant', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  SELECT status, COALESCE(starting_chips, 0), club_id
    INTO v_status, v_start_chips, v_club
    FROM public.tournaments WHERE id = p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_running');
  END IF;

  SELECT COALESCE(chips, 0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = p_user_id
     AND table_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.user_id = p_user_id
         AND s.left_at IS NULL
     )
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_seated_or_missing');
  END IF;

  v_chips := v_start_chips + GREATEST(v_bonus, 0);

  SELECT tb.id, COALESCE(tb.max_players, 9)
    INTO v_table, v_cap
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running', 'active')
     AND COALESCE(tb.is_deleted,false)=false
     AND (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) < COALESCE(tb.max_players, 9)
   ORDER BY (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) DESC, tb.created_at ASC
   LIMIT 1
     FOR UPDATE OF tb;

  -- Capacity owns the table format, current blinds, legal chairs and durable
  -- manager receipt. The entry already exists here, so reserve no second entry.
  IF v_table IS NULL THEN
    v_capacity := public.fn_ensure_late_registration_capacity(p_tournament_id,0);
    v_table := NULLIF(v_capacity->>'table_id','')::uuid;
    IF COALESCE((v_capacity->>'ok')::boolean,false) IS NOT TRUE
       OR v_table IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','no_open_seat');
    END IF;
    SELECT tb.max_players INTO STRICT v_cap FROM public.tables tb
     WHERE tb.id=v_table AND tb.tournament_id=p_tournament_id
       AND tb.status IN ('waiting','running','active')
       AND COALESCE(tb.is_deleted,false)=false FOR UPDATE;
    v_opened := COALESCE((v_capacity->>'created')::boolean,false);
  END IF;

  SELECT g.n INTO v_seat
    FROM generate_series(1, v_cap) AS g(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats s
      WHERE s.table_id = v_table AND s.seat_number = g.n AND s.left_at IS NULL
   )
   ORDER BY g.n LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_open_seat');
  END IF;

  UPDATE public.table_seats
     SET user_id        = p_user_id,
         stack          = v_chips,
         left_at        = NULL,
         joined_at      = now(),
         is_sitting_out = false,
         is_away        = false,
         club_id        = COALESCE(club_id, v_club)
   WHERE table_id = v_table AND seat_number = v_seat AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, club_id)
      VALUES (v_table, p_user_id, v_seat, v_chips, v_club);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'seat_race');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status      = 'playing',
         chips       = v_chips,
         table_id    = v_table,
         seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  SELECT count(*) INTO v_taken
    FROM public.table_seats WHERE table_id = v_table AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = v_table;

  RETURN jsonb_build_object('ok', true, 'table_id', v_table,
    'seat_number', v_seat, 'chips', v_chips, 'opened_table', v_opened);
END;
$function$;
ALTER FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_seat_late_registrant_before_terminal_seat_gate(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=75e932d212ff2687ad549309a3f9afcf len=550 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant_before_terminal_seat_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_seat_late_registrant_before_maintenance_gate(
    p_tournament_id, p_user_id
  );
END;
$function$;
ALTER FUNCTION public.fn_seat_late_registrant_before_terminal_seat_gate(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_seat_late_registrant_before_terminal_seat_gate(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_seat_late_registrant_before_terminal_seat_gate(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text)
-- @@PIN md5=5e696c31a3f1af7a95f34fd91d6915d4 len=16402 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric := round(COALESCE(p_total_owed,0),2);
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
  v_ob public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_pay numeric;
  v_key text;
  v_rows integer;
  v_token uuid;
  v_source_debits numeric;
  v_source_credits numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_credit_ledger_id uuid;
  v_wallet_transaction_id uuid;
  v_prev_category text;
  v_prev_counterparty text;
  v_prev_counterparty_entity text;
  v_prev_tournament text;
  v_prev_tournament_id text;
  v_prev_idempotency text;
  v_entitlement record;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_wallet_club_id IS NULL
     OR p_total_owed IS NULL OR p_refund_prize IS NULL
     OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_total_owed::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_total_owed IS DISTINCT FROM v_total
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_total <= 0 OR v_prize < 0 OR v_bounty < 0 OR v_fee < 0
     OR p_source IS NULL OR length(btrim(p_source)) = 0
     OR p_description IS NULL OR length(btrim(p_description)) = 0 THEN
    RAISE EXCEPTION 'exact refund payer received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source = lower(btrim(p_source))) THEN
    RAISE EXCEPTION 'exact refund source % is not a platform authority',p_source
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact refund tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'exact refund escrow prelock');

  SELECT * INTO v_ob FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'refund' AND o.place IS NULL AND o.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    SELECT round(COALESCE(sum(w.amount),0),2) INTO v_seeded_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND w.user_id = p_user_id AND w.type = 'credit'
       AND lower(w.category) IN ('refund','tournament_refund');
    IF v_seeded_paid > v_total THEN
      RAISE EXCEPTION 'refund ledger already exceeds exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.tournament_obligations(
      tournament_id,kind,place,user_id,amount_owed,amount_paid,source)
    VALUES(
      p_tournament_id,'refund',NULL,p_user_id,v_total,v_seeded_paid,p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
       OR v_ob.amount_paid > v_ob.amount_owed
       OR v_total < v_ob.amount_owed THEN
      RAISE EXCEPTION 'existing refund obligation is incompatible with exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_pay := round(v_total - v_ob.amount_paid,2);
  IF v_pay <= 0 OR v_pay IS DISTINCT FROM round(v_prize + v_bounty + v_fee,2) THEN
    RAISE EXCEPTION
      'exact refund components %, %, % do not equal newly owed amount %',
      v_prize,v_bounty,v_fee,v_pay USING ERRCODE = '23514';
  END IF;

  -- The caller cannot choose money. Resolve one deterministic, still-open
  -- immutable entitlement whose stored club and rails exactly match this
  -- tranche. Satellite entry value is ordinary funded target escrow under
  -- the approved cash rule. Its original transfer must be proved exactly;
  -- a ticket already issued for this entitlement consumes that same value.
  SELECT e.* INTO v_entitlement
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id = p_source_wallet_club_id
     AND e.gross = v_pay
     AND e.refund_prize = v_prize
     AND e.refund_bounty = v_bounty
     AND e.refund_fee = v_fee
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND e.entitlement_kind IN ('wallet_charge','satellite_seat','tournament_ticket')
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
   ORDER BY e.entitlement_kind,e.id
   LIMIT 1;
  IF v_entitlement.id IS NULL THEN
    RAISE EXCEPTION
      'refund source club and component rails do not match one immutable entitlement'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*) INTO v_rows FROM public.chip_ledger l
   WHERE l.id=v_entitlement.source_ledger_id
     AND l.club_id=v_entitlement.refund_wallet_club_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_entitlement.tournament_id
     AND l.amount=v_entitlement.gross
     AND (
       (v_entitlement.entitlement_kind='wallet_charge'
        AND l.tournament_id=v_entitlement.tournament_id
        AND l.from_type='player_wallet'
        AND l.from_entity_id=v_entitlement.user_id
        AND lower(l.category)=v_entitlement.charge_category)
       OR (v_entitlement.entitlement_kind='satellite_seat'
        AND l.from_type='prize_liability'
        AND l.from_entity_id=v_entitlement.source_satellite_id
        AND l.metadata->>'user_id'=v_entitlement.user_id::text
        AND l.metadata->>'registration_id'=v_entitlement.registration_id::text)
       OR (v_entitlement.entitlement_kind='tournament_ticket'
        AND l.tournament_id=v_entitlement.tournament_id
        AND l.from_type='escrow'
        AND l.from_entity_id=v_entitlement.source_ticket_id
        AND l.category='ticket_redeem'
        AND l.metadata->>'user_id'=v_entitlement.user_id::text
        AND l.metadata->>'registration_id'=v_entitlement.registration_id::text
        AND EXISTS (
          SELECT 1 FROM public.tournament_tickets tk
           WHERE tk.id=v_entitlement.source_ticket_id
             AND tk.holder_id=v_entitlement.user_id AND tk.status='redeemed'
             AND tk.redemption_mode='tournament_entry_only'
             AND tk.value=v_entitlement.gross
             AND tk.entry_prize=v_entitlement.refund_prize
             AND tk.entry_bounty=v_entitlement.refund_bounty
             AND tk.entry_fee=v_entitlement.refund_fee
             AND tk.source_satellite_id=v_entitlement.source_satellite_id)));
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'refund entitlement lost its exact funded source'
      USING ERRCODE = 'P0404';
  END IF;
  v_key := 'tourney:' || p_tournament_id::text
           || ':refund-entitlement:'
           || v_entitlement.id::text;

  v_token := gen_random_uuid();
  INSERT INTO public.tournament_refund_authorizations(
    token,idempotency_key,tournament_id,obligation_id,user_id,
    source_wallet_club_id,entitlement_id,
    amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
    source,description,created_at)
  VALUES(
    v_token,v_key,p_tournament_id,v_ob.id,p_user_id,
    p_source_wallet_club_id,v_entitlement.id,
    v_ob.amount_paid,v_pay,v_prize,v_bounty,v_fee,
    lower(btrim(p_source)),p_description,transaction_timestamp());
  -- Wallet debits and funded satellite transfers are separate sources.
  -- The immutable entitlement fixes the recipient club. Existing cash refunds
  -- reduce capacity; a value already returned as a ticket cannot fund cash.
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_debits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'player_wallet'
     AND l.from_entity_id = p_user_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.category IN ('tournament_buyin','rebuy','addon');
  SELECT v_source_debits + round(COALESCE(sum(e.gross),0),2)
    INTO v_source_debits
    FROM public.tournament_refund_entitlements e
    JOIN public.chip_ledger l ON l.id=e.source_ledger_id
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id=p_source_wallet_club_id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND l.club_id=e.refund_wallet_club_id
     AND l.to_type='prize_liability' AND l.to_entity_id=e.tournament_id
     AND l.amount=e.gross
     AND l.metadata->>'user_id'=e.user_id::text
     AND l.metadata->>'registration_id'=e.registration_id::text
     AND ((e.entitlement_kind='satellite_seat'
           AND l.from_type='prize_liability'
           AND l.from_entity_id=e.source_satellite_id)
       OR (e.entitlement_kind='tournament_ticket'
           AND l.from_type='escrow' AND l.from_entity_id=e.source_ticket_id
           AND l.category='ticket_redeem'))
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_credits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category IN ('refund','tournament_refund');
  IF v_source_debits IS NULL OR v_source_credits IS NULL
     OR v_source_debits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_credits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_debits < 0 OR v_source_credits < 0
     OR round(v_source_debits-v_source_credits,2) < v_pay THEN
    RAISE EXCEPTION
      'source club % has only % of exact tournament debit left for refund %',
      p_source_wallet_club_id,
      round(v_source_debits-v_source_credits,2),v_pay
      USING ERRCODE = 'P0404';
  END IF;

  SELECT m.chip_balance INTO v_balance_before
    FROM public.club_members m
   WHERE m.user_id = p_user_id AND m.club_id = p_source_wallet_club_id
   FOR UPDATE;
  IF NOT FOUND OR v_balance_before IS NULL
     OR v_balance_before::text IN ('NaN','Infinity','-Infinity')
     OR v_balance_before IS DISTINCT FROM round(v_balance_before,2) THEN
    RAISE EXCEPTION
      'exact source wallet % for player % is absent or invalid',
      p_source_wallet_club_id,p_user_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_pay)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit key % was already claimed',v_key
      USING ERRCODE = '23505';
  END IF;

  v_prev_category := current_setting('app.ledger_category',true);
  v_prev_counterparty := current_setting('app.ledger_counterparty',true);
  v_prev_counterparty_entity := current_setting(
    'app.ledger_counterparty_entity',true);
  v_prev_tournament := current_setting('app.ledger_tournament',true);
  v_prev_tournament_id := current_setting('app.ledger_tournament_id',true);
  v_prev_idempotency := current_setting('app.ledger_idempotency_key',true);
  PERFORM public.fn_ca_declare_ledger(
    'refund','prize_liability',p_tournament_id,NULL,v_key,NULL);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament_id',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance = chip_balance + v_pay,updated_at = now()
   WHERE user_id = p_user_id AND club_id = p_source_wallet_club_id
     AND chip_balance IS NOT DISTINCT FROM v_balance_before
  RETURNING chip_balance INTO v_balance_after;
  PERFORM set_config('app.ledger_category',COALESCE(v_prev_category,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_prev_counterparty,''),true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(v_prev_counterparty_entity,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_prev_tournament,''),true);
  PERFORM set_config('app.ledger_tournament_id',COALESCE(v_prev_tournament_id,''),true);
  PERFORM set_config('app.ledger_idempotency_key',COALESCE(v_prev_idempotency,''),true);
  IF v_balance_after IS NULL
     OR v_balance_after IS DISTINCT FROM round(v_balance_before+v_pay,2) THEN
    RAISE EXCEPTION 'exact source wallet changed during refund'
      USING ERRCODE = '40001';
  END IF;
  SELECT count(*),min(l.id::text)::uuid INTO v_rows,v_credit_ledger_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key
     AND l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category = 'refund' AND l.amount = v_pay;
  IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'exact source-wallet credit % has no single journal row',v_key
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM set_config('app.ca_exact_refund_token',v_token::text,true);
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,amount,type,category,description,
    related_entity_id,table_id,hand_id,balance_after)
  VALUES(
    p_user_id,'PLAYER',v_pay,'credit','refund',p_description,
    p_tournament_id,NULL,NULL,v_balance_after)
  RETURNING id INTO v_wallet_transaction_id;
  PERFORM set_config('app.ca_exact_refund_token','',true);
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_authorizations a
     WHERE a.token = v_token) THEN
    RAISE EXCEPTION 'exact refund authorization % was not consumed',v_token
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows FROM public.tournament_refund_tranches tr
   WHERE tr.wallet_transaction_id = v_wallet_transaction_id
     AND tr.idempotency_key = v_key
     AND tr.tournament_id = p_tournament_id
     AND tr.obligation_id = v_ob.id AND tr.user_id = p_user_id
     AND tr.source_wallet_club_id = p_source_wallet_club_id
     AND tr.entitlement_id = v_entitlement.id
     AND tr.credit_ledger_id = v_credit_ledger_id
     AND tr.amount_paid_before = v_ob.amount_paid
     AND tr.amount_paid_now = v_pay
     AND tr.refund_prize = v_prize
     AND tr.refund_bounty = v_bounty
     AND tr.refund_fee = v_fee
     AND tr.source = lower(btrim(p_source))
     AND tr.description = p_description;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit % has no single component receipt',v_key
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         amount_owed = v_total,
         source = p_source,
         updated_at = now(),settled_at = now()
   WHERE id = v_ob.id AND amount_paid = v_ob.amount_paid
  RETURNING * INTO v_ob;
  IF v_ob.id IS NULL OR v_ob.amount_paid IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'exact refund obligation did not close at %',v_total
      USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'fully_settled',true,'remaining',0,
    'obligation_id',v_ob.id,'idempotency_key',v_key,
    'entitlement_id',v_entitlement.id,
    'entitlement_kind',v_entitlement.entitlement_kind,
    'source_wallet_club_id',p_source_wallet_club_id,
    'credit_ledger_id',v_credit_ledger_id,
    'wallet_transaction_id',v_wallet_transaction_id,
    'already_paid',round(v_total-v_pay,2),'paid',v_pay,
    'amount_owed',v_total,'amount_paid',v_total,
    'refund_prize',v_prize,'refund_bounty',v_bounty,'refund_fee',v_fee);
END;
$function$;
ALTER FUNCTION public.fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text)

-- @@DOOR fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid)
-- @@PIN md5=344609ab3cf21094b9e85167bfb6655e len=2811 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_t_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_t_club
    FROM tournaments t WHERE t.id = p_tournament_id;

  IF v_union IS NULL THEN
    RETURN v_t_club;                       -- standalone club tournament
  END IF;

  /* THE HOST CLUB IS IN ITS OWN UNION (2026-09-10). A tournament hosted BY a
     union has club_id = union_id, and that house club is never a row in
     union_clubs. The membership test below joined union_clubs, so the
     tournament's own club could never be the preferred club - a satellite
     winner who IS a member of the host club was resolved to some other club
     and the ticket award was refused for a club mismatch. Friday Night
     Feature Satellite Heads-Up sat RUNNING for 16 hours on that refusal. The
     host club counts as in the union without needing the row. */
  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved')
                   AND (m.club_id = v_t_club
                        OR EXISTS (SELECT 1 FROM union_clubs uc
                                    WHERE uc.club_id = m.club_id AND uc.union_id = v_union)))
  THEN
    RETURN p_preferred_club;
  END IF;

  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM profiles p WHERE p.id = p_user_id;

  IF v_is_horse THEN
    -- Same stable home club a horse uses for cash play, so a horse's tournament
    -- and cash activity always belong to the same club.
    SELECT count(*) INTO v_n
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
     WHERE m.user_id = p_user_id AND m.status IN ('active','approved');
    IF v_n > 1 THEN
      v_idx := (abs(hashtextextended(p_user_id::text, 0)) % v_n)::int;
      SELECT m.club_id INTO v_club
        FROM club_members m
        JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
       WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
       ORDER BY m.club_id OFFSET v_idx LIMIT 1;
      IF v_club IS NOT NULL THEN RETURN v_club; END IF;
    END IF;
  END IF;

  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;
ALTER FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid) TO authenticated, service_role;
-- @@END fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid)

-- @@DOOR fn_tournament_current_blinds(p_tournament_id uuid)
-- @@PIN md5=be0a708cb57fad978515b48f533d5322 len=1362 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_current_blinds(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_entrants bigint;
  v_rebuys bigint;
  v_addons bigint;
  v_total_chips numeric := NULL;
BEGIN
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found' USING ERRCODE='P0002';
  END IF;

  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id;
  SELECT count(*) INTO v_rebuys
    FROM public.wallet_transactions wt
   WHERE wt.related_entity_id=p_tournament_id AND wt.category='rebuy';
  SELECT count(*) INTO v_addons
    FROM public.wallet_transactions wt
   WHERE wt.related_entity_id=p_tournament_id AND wt.category='addon';
  IF COALESCE(v_t.starting_chips,0)>0 AND v_entrants>0 THEN
    v_total_chips := v_t.starting_chips*v_entrants
      +COALESCE(NULLIF(v_t.rebuy_chips,0),v_t.starting_chips)*v_rebuys
      +COALESCE(NULLIF(v_t.addon_chips,0),v_t.starting_chips)*v_addons;
  END IF;

  RETURN public.fn_resolve_tournament_blinds(
    v_t.blind_structure::text,
    COALESCE(v_t.current_level,0),
    v_t.variant,
    v_t.tournament_type,
    v_total_chips
  );
END;
$function$;
ALTER FUNCTION public.fn_tournament_current_blinds(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_current_blinds(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_current_blinds(p_tournament_id uuid) TO service_role;
-- @@END fn_tournament_current_blinds(p_tournament_id uuid)

-- @@DOOR fn_tournament_entry_cap_reached(p_tournament_id uuid)
-- @@PIN md5=9a34a1460abf1c71f24d88bce182e488 len=1006 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_entry_cap_reached(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cap      integer;
  v_counter  integer;
  v_entries  integer;
BEGIN
  PERFORM public.fn_ca_lock_mtt_admission_contract();
  SELECT t.max_players, COALESCE(t.current_players, 0)
    INTO v_cap, v_counter
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND OR public.fn_ca_tournament_is_unlimited(p_tournament_id)
     OR v_cap IS NULL OR v_cap <= 0 THEN
    RETURN false;                      -- uncapped: this function never refuses
  END IF;

  SELECT count(*) INTO v_entries
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;

  /* GREATEST, never the entry count alone: this can only ever be stricter than
     the counter test it replaces, never looser. */
  RETURN GREATEST(v_counter, COALESCE(v_entries, 0)) >= v_cap;
END;
$function$;
ALTER FUNCTION public.fn_tournament_entry_cap_reached(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_entry_cap_reached(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_entry_cap_reached(p_tournament_id uuid) TO authenticated, service_role;
-- @@END fn_tournament_entry_cap_reached(p_tournament_id uuid)

-- @@DOOR fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)
-- @@PIN md5=89cc73d13fe8fbe6905233c8f9f74848 len=1229 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)
 RETURNS TABLE(charge numeric, rake numeric, bounty numeric, prize numeric)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_charge numeric; v_rake numeric; v_bounty numeric; v_prize numeric;
BEGIN
  IF NOT COALESCE(p_is_bounty, false) THEN
    -- Non-bounty: unchanged - fee charged on top of the buy-in portion.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := 0;
    v_prize  := round(COALESCE(p_buy_in,0),2);
  ELSE
    -- Bounty event: the rake is exactly the fee. A zero fee is a legitimate
    -- outcome of the whole-number floor rule (totals under 10 take no rake)
    -- and must NEVER be replaced with a percentage default.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := round(COALESCE(p_bounty,0), 2);
    v_prize  := round(v_charge - v_rake - v_bounty, 2);  -- = buy_in - bounty
  END IF;
  RETURN QUERY SELECT v_charge, v_rake, v_bounty, v_prize;
END;
$function$;
ALTER FUNCTION public.fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean) TO anon, authenticated, service_role;
-- @@END fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)

-- @@DOOR fn_tournament_late_registration_open(p_tournament_id uuid)
-- @@PIN md5=0a189819d8064f393f5de5b12a2c51f4 len=1257 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT t.status='RUNNING'
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND COALESCE(t.current_level,0)>=0
       AND COALESCE(t.late_reg_levels,0)>=0
       AND COALESCE(t.rebuy_levels,0)>=0
       AND COALESCE(t.late_reg_mins,0)>=0
       AND (
         CASE
           WHEN COALESCE(t.late_reg_levels,t.rebuy_levels,0)>0
             THEN COALESCE(t.current_level,0)
                    <COALESCE(t.late_reg_levels,t.rebuy_levels,0)
           WHEN COALESCE(t.late_reg_mins,0)>0
             THEN t.started_at IS NOT NULL
              AND clock_timestamp()
                    <t.started_at+make_interval(mins=>t.late_reg_mins)
           ELSE false
         END
       )
       AND (
         public.fn_ca_tournament_is_unlimited(t.id)
         OR t.max_players IS NULL OR t.max_players<=0 OR (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id=t.id
         )<t.max_players
       )
      FROM public.tournaments t
     WHERE t.id=p_tournament_id
  ),false);
$function$;
ALTER FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid) TO service_role;
-- @@END fn_tournament_late_registration_open(p_tournament_id uuid)

-- @@DOOR fn_unregister_from_tournament(p_tournament_id uuid)
-- @@PIN md5=b883532da31ca40919b4f3ef5c925513 len=674 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a live session'
      USING ERRCODE='28000';
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,v_uid,NULL,'Tournament unregistration refund');
END;
$function$;
ALTER FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid) TO authenticated, service_role;
-- @@END fn_unregister_from_tournament(p_tournament_id uuid)

-- @@DOOR fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid)
-- @@PIN md5=c39310bcf1158d66bd0aced7bc0f9c73 len=1091 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a live session'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires a request id'
      USING ERRCODE='22004';
  END IF;
  -- DIAMOND PHASE 8: a Diamond entry goes home through its own authority.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    RETURN public.fn_poker_diamond_tournament_unregister(p_tournament_id,v_uid,p_request_id);
  END IF;
  RETURN public.fn_ca_unregister_tournament_player_exact(
    p_tournament_id,v_uid,NULL,'Tournament unregistration refund',p_request_id);
END;
$function$;
ALTER FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid) TO authenticated, service_role;
-- @@END fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid)

-- ============================================================================
-- THE CAPTURE PROVES ITSELF
-- ============================================================================
-- Every door above, read back out of the catalogue it was just loaded into,
-- must render to the md5 its own @@PIN line records. A door that does not is
-- either a corrupted capture or a base that already carried a different
-- function of the same name; either way the fixture stops here rather than
-- testing something other than what production runs.
DO $capture$
DECLARE r record; v_oid oid; v_bad integer := 0; v_seen integer := 0;
BEGIN
  FOR r IN SELECT t.ident::text AS ident, t.want::text AS want FROM (VALUES
    ('atomic_deduct_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_table_id uuid, p_hand_id uuid, p_related_entity_id uuid)','ab3d8e4c0baac59e7194319ffceba71e'),
    ('fn_active_maintenance_release_boundary()','0d9548e27105b7172d83be4f7d10ea47'),
    ('fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid, p_settlement_id uuid, p_idempotency_key text, p_autoskip_tables text[])','1991d9f52317f33a4b9cf560d6fc91d5'),
    ('fn_ca_diamond_journal_is_transfer(p_type text, p_transaction_type text, p_source text, p_issuance_class text)','918b4dccaf2255fe90a7153cc600890d'),
    ('fn_ca_diamond_journal_origin(p_type text, p_transaction_type text, p_source text, p_issuance_class text, p_amount numeric)','ba8e79dfa3ce176381524eb5fb90f3fa'),
    ('fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)','22e286701d8e4ce9a256efb74ae1dbb5'),
    ('fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric, p_fee_entries_in numeric, p_satellite_fee_in numeric, p_bounty_in numeric, p_overlay_in numeric, p_satellite_in numeric, p_prize_out numeric, p_bounty_out numeric, p_fee_out numeric, p_refund numeric, p_reserve_out numeric, p_reserve_in numeric)','c6c26c25ab8a8b1222d375c7d6df0d2f'),
    ('fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)','44534508da577df94a34d2055e99b1d6'),
    ('fn_ca_find_tournament_entry_ticket_for(p_tournament_id uuid, p_beneficiary_id uuid)','bc9acd00e516e3336b339349063b380d'),
    ('fn_ca_guard_watchlist()','92ee208d0887728444bda396d0b4d442'),
    ('fn_ca_is_new_mtt(p_row jsonb)','dff4202458ea4b5b940e78050e6de91c'),
    ('fn_ca_lock_mtt_admission_contract()','10644d522bb50245f76942ecce735cbc'),
    ('fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)','76e4c6b5291bab20f0cfc65dd060022b'),
    ('fn_ca_lock_settlement_lane_for_tournament(p_tournament_id uuid, p_table_id uuid)','9877846ffabee004690e6b24a3ddcee2'),
    ('fn_ca_lock_settlement_lane_global()','7c759bb7a639c3124de2607bdbf12577'),
    ('fn_ca_lock_tournament_seat_acquisition(p_tournament_id uuid, p_table_id uuid, p_user_id uuid)','2d8c9bd676a8ee02e009dd470fbfd585'),
    ('fn_ca_mint_supply(p_asset text)','b735bae7649d0b0753352abf5439f8d9'),
    ('fn_ca_new_tournament_is_unlimited(p_config jsonb)','34b80f98d9d110072ae6951bb4377ee0'),
    ('fn_ca_record_tournament_participant_funding(p_registration uuid, p_operation text, p_key text, p_amount numeric, p_asset text, p_entitlement uuid, p_wallet uuid, p_custody jsonb)','6cfd4af7307ce31460fd62c5b3f38bef'),
    ('fn_ca_recovery_fee_cents(p_gross_cents bigint, p_ratio numeric, p_unit_cents integer)','3960a8bc558ead330e1e47e7a38e31c4'),
    ('fn_ca_register_diamond_journal_row(p_tx_id uuid)','0f64c74772d556971760abc3962e7a6a'),
    ('fn_ca_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid)','cf0bf7f56e2e50376626c37b59cfaca8'),
    ('fn_ca_tournament_escrow(p_tournament_id uuid)','707b4cbeb6f4906c2216cefea6635ca8'),
    ('fn_ca_tournament_escrow_chips(p_tournament_id uuid)','bf70fec2d07ab459fe1da245bfb59ee7'),
    ('fn_ca_tournament_fee_ratio(p_buy_in numeric, p_buy_in_fee numeric)','858c3f3cda609a0b427f294d1c9edf36'),
    ('fn_ca_tournament_is_unlimited(p_tournament_id uuid)','fd66c28075f1d7c63b9d763632592471'),
    ('fn_ca_tournament_recorded_format(p_tournament_id uuid)','a7357dd1366f930eba6cd7f404090bbd'),
    ('fn_ca_tournament_unit_cents(p_tournament_id uuid)','426ba550ff84f4210906a0071538803b'),
    ('fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid, p_request_id uuid)','a1eb3a788f88279d07cd421e5fee5a69'),
    ('fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer)','1aee5e7fa9aa60b575aeccd2793bd215'),
    ('fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid, p_description text, p_request_id uuid)','3fc3f147808ab3ecc50982f5b6968bff'),
    ('fn_caller_is_engine()','d9a70f1d932538025e656bfe2b4d091d'),
    ('fn_caller_session_is_live()','23ffeea99f9d9e76102ecbf6185222c0'),
    ('fn_emit_tournament_manager_wake(p_tournament_id uuid, p_reason text)','c74a777eacc98bed6cfd90ac0043829c'),
    ('fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)','dd462a9943724d4b94fbe683ed364250'),
    ('fn_entry_purchases_frozen()','0b05e2e7905caf71f14c8327a172cea0'),
    ('fn_is_platform_admin()','ed89787c7b832e76a886734e16a27c3d'),
    ('fn_lock_daily_mission_user(p_user_id uuid)','0e9d2905374930bda4529a8febc6eff6'),
    ('fn_player_home_club(p_user_id uuid, p_club_hint uuid)','bdced39339da2e5ec46404177bab7dc2'),
    ('fn_poker_arena_context(p_club_key text)','6c85536da97db301d7beb4aae885e69c'),
    ('fn_poker_bind_diamond_seat()','c14b4bbfaa71a58210f8de5726040a8c'),
    ('fn_poker_diamond_create_tournament(p_config jsonb)','6d82bede82370a9cc15d71b5ce1699f5'),
    ('fn_poker_diamond_entry_custody_is_the_entry()','a5d21188b37bb0566c2fb82abeeb29a2'),
    ('fn_poker_diamond_play_state_columns(p_table text)','f53dea87eb2d45bcc1c6fdcee2cf9407'),
    ('fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid)','d525cb1e20d6fb05e5b5e51497b127e7'),
    ('fn_poker_diamond_reserve(p_user_id uuid, p_purpose text, p_target_id uuid, p_entry_key text, p_amount numeric, p_request_id uuid)','a1ccc4bc9a5c6d8d17308e93943a9413'),
    ('fn_poker_diamond_seat_keeps_custody()','d80aed613a97e567268cb2bf6fdfd094'),
    ('fn_poker_diamond_tournament(p_tournament_id uuid)','c91028508fecc2d02e9003f2bdc2e38d'),
    ('fn_poker_diamond_tournament_cancel(p_tournament_id uuid, p_actor_id uuid)','ee91eac08d166e096ca5faa8c52ff296'),
    ('fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id uuid, p_observed_actor_id uuid)','361d90e78dee65236635da53740c1eeb'),
    ('fn_poker_diamond_tournament_charge(p_user_id uuid, p_tournament_id uuid, p_kind text, p_gross numeric, p_prize numeric, p_bounty numeric, p_fee numeric, p_registration_id uuid, p_idempotency_key text)','76d337b6b86734fb44db277d442afeb9'),
    ('fn_poker_diamond_tournament_close_custody(p_tournament_id uuid)','2c1ca86d949cc689fe1f19c98e08b9db'),
    ('fn_poker_diamond_tournament_custody(p_tournament_id uuid)','b2a879b0e870447f2734b6179fe5fac3'),
    ('fn_poker_diamond_tournament_custody_add(p_custody_id uuid, p_amount numeric, p_request_id uuid)','25af87faee3db07b6dec956278eaa6bc'),
    ('fn_poker_diamond_tournament_drain(p_tournament_id uuid, p_bank text, p_amount bigint, p_reason text, p_destination_account text, p_journal_for uuid)','abaf068c32e192f08a1c01c02b089523'),
    ('fn_poker_diamond_tournament_escrow(p_tournament_id uuid)','850410a45ed7eefe785d3f17a2403247'),
    ('fn_poker_diamond_tournament_open_shadow(p_tournament_id uuid)','15beba292789e7f1e665c7caa9530304'),
    ('fn_poker_diamond_tournament_pay(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_tournament_id uuid, p_description text)','e246c03b5a6d2aff690d227912ff7e82'),
    ('fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)','4dcc2e8556323bf831de3863e218f97a'),
    ('fn_poker_diamond_tournament_settle_fee(p_tournament_id uuid, p_source text)','4e947c948d953098fb63c26d14decde8'),
    ('fn_poker_diamond_tournament_unregister(p_tournament_id uuid, p_user_id uuid, p_request_id uuid)','39f95b499619cab7a1eb65ff583aa638'),
    ('fn_poker_guard_chip_seat()','3326766760c7b9c9bfe12daca34ebd0f'),
    ('fn_register_for_tournament_before_atomic_capacity_20260907(p_tournament_id uuid, p_seat_first_internal boolean)','591867b92e0749eb0e493c56707ae328'),
    ('fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)','ff905b806203482d3e95fd706210bfb5'),
    ('fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)','84c0354e68fb129b5373bc6024cba334'),
    ('fn_register_horse_for_tournament_before_atomic_lifecycle_gate(p_tournament_id uuid, p_user_id uuid)','3717c2b05d58d51049181530338bf1e9'),
    ('fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)','33de93271803a28f46c0a259bb2c01c4'),
    ('fn_register_horse_for_tournament_before_terminal_gate(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)','d9a34831bf01f85933a6c79f3662be33'),
    ('fn_seat_late_registrant(p_tournament_id uuid, p_user_id uuid)','51a3254789bfdc2c1f80994d0c26ad6a'),
    ('fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)','4f1800b2cd9bbf61cf926130eb8f03db'),
    ('fn_seat_late_registrant_before_terminal_seat_gate(p_tournament_id uuid, p_user_id uuid)','75e932d212ff2687ad549309a3f9afcf'),
    ('fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text)','5e696c31a3f1af7a95f34fd91d6915d4'),
    ('fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid)','344609ab3cf21094b9e85167bfb6655e'),
    ('fn_tournament_current_blinds(p_tournament_id uuid)','be0a708cb57fad978515b48f533d5322'),
    ('fn_tournament_entry_cap_reached(p_tournament_id uuid)','9a34a1460abf1c71f24d88bce182e488'),
    ('fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)','89cc73d13fe8fbe6905233c8f9f74848'),
    ('fn_tournament_late_registration_open(p_tournament_id uuid)','0a189819d8064f393f5de5b12a2c51f4'),
    ('fn_unregister_from_tournament(p_tournament_id uuid)','b883532da31ca40919b4f3ef5c925513'),
    ('fn_unregister_from_tournament(p_tournament_id uuid, p_request_id uuid)','c39310bcf1158d66bd0aced7bc0f9c73')
  ) AS t(ident, want)
  LOOP
    v_seen := v_seen + 1;
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = r.ident;
    IF v_oid IS NULL THEN
      RAISE WARNING 'captured door % is not installed', r.ident; v_bad := v_bad + 1;
    ELSIF md5(pg_get_functiondef(v_oid)) <> r.want THEN
      RAISE WARNING 'captured door % renders to % but its pin says %',
        r.ident, md5(pg_get_functiondef(v_oid)), r.want;
      v_bad := v_bad + 1;
    END IF;
    v_oid := NULL;
  END LOOP;
  IF v_seen <> 79 THEN
    RAISE EXCEPTION 'the capture declares % doors but this file carries %', 79, v_seen;
  END IF;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% of % captured Diamond tournament doors do not match their pins', v_bad, v_seen;
  END IF;
  RAISE NOTICE 'PASS: all % captured Diamond tournament doors match their installed pins', v_seen;
END $capture$;
