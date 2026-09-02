-- ===========================================================================
-- CLAIM BACK: REPLAY PROTECTION, AND A SUPER AGENT STAYS IN THEIR OWN DOWNLINE
-- (2026-08-24)
--
-- Follow-up to 20260824010000. Applied live and recorded here so the repo
-- matches the database. Idempotent; safe to re-run.
--
-- ---------------------------------------------------------------------------
-- 1. A RETRIED CLAIM CHARGED THE PLAYER TWICE
--
--    Both claim-back functions moved chips with no replay protection. The
--    shape that matters is not a double-click - it is a request that COMMITTED
--    and then failed on the way back: a dropped connection, a proxy timeout.
--    To the caller that is indistinguishable from a request that never ran,
--    and the only remedy available to them, retrying, takes the chips again.
--    Every other money path here already carries a key (credit_player_wallet,
--    the tournament RPCs); these two were the exception.
--
--    Three parts:
--      * ux_chip_transactions_idempotency_key - a PARTIAL unique index, so the
--        118k existing rows are untouched and only keyed rows participate.
--        This is the actual guarantee: a pre-check alone loses the race
--        between two concurrent identical submissions, which is precisely the
--        double-charge being prevented.
--      * a pre-check for the common case (a human retrying seconds later),
--        returning the ORIGINAL outcome with "replayed": true rather than an
--        error the caller would answer with yet another retry.
--      * the writes wrapped so that losing the race rolls the money back and
--        reports the winner's result instead of raising.
--
--    Verified live, in rolled-back transactions:
--      first call  -> success, bank 1051817.71 -> 1052117.71
--      same key    -> success, "replayed": true, bank UNCHANGED at 1052117.71
--      new key     -> success, bank 1052417.71   (a genuinely new claim)
--      null key    -> success                    (backward compatible)
--    and the index itself rejects a duplicate with 23505, which is the
--    mechanism the handler depends on.
--
-- 2. A SUPER AGENT COULD CLAIM FROM ANYONE IN THE CLUB
--
--    fn_wallet_claim_back's club_bank branch admitted super_agent alongside
--    owner / co_owner / admin and then applied NO downline test - while the
--    agent_wallet branch directly below it already required one. So a super
--    agent could take chips from any member of the club, including players
--    belonging to a different agent entirely, simply by naming the club bank
--    as the destination. owner / co_owner / admin genuinely do hold club-wide
--    authority and are deliberately left unrestricted.
--
--    Uses the platform's own fn_club_is_in_downline (recursive, UNION,
--    depth-capped at 20, fails closed) rather than the direct-parent test the
--    agent_wallet branch uses, because a super agent's players normally hang
--    off their sub-agents. Verified live: a super agent claiming from a member
--    outside their downline is refused with "Player Is Not In Your Downline",
--    and the same super agent claiming from a member inside it succeeds.
--
-- 3. co_owner COULD NOT USE CASHIER CLAIM BACK AT ALL
--
--    fn_cashier_claim_back's role list omitted co_owner, though
--    fn_club_bank_role and fn_wallet_claim_back both treat co_owner as club
--    leadership. Added rather than silently left out.
--
-- SIGNATURES CHANGED. Adding a parameter creates a NEW function rather than
-- replacing the old one, so both old bodies are dropped: leaving them would
-- let PostgREST resolve to a version with no replay guard. Note also that a
-- freshly created function inherits PUBLIC EXECUTE by default - both are
-- explicitly revoked from PUBLIC and anon below, which is why that is not left
-- to the default.
--
-- ROLLBACK: previous bodies are in the remote migration history; drop the
-- index and re-create the 4-arg / 6-arg forms.
-- ===========================================================================

BEGIN;

-- == The guarantee: only keyed rows participate, so this stays tiny ==========
CREATE UNIQUE INDEX IF NOT EXISTS ux_chip_transactions_idempotency_key
  ON public.chip_transactions ((metadata->>'idempotency_key'))
  WHERE metadata ? 'idempotency_key';

-- == 1 + 3. fn_cashier_claim_back (the path the Cashier UI actually calls) ===
CREATE OR REPLACE FUNCTION public.fn_cashier_claim_back(
  p_club_id uuid,
  p_from_user_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_player_agent uuid;
  v_player_before numeric;
  v_player_after numeric;
  v_actor_after numeric;
  v_first uuid;
  v_second uuid;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'not authenticated');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount > 1e9 then
    return jsonb_build_object('success', false, 'error', 'amount exceeds limit');
  end if;
  if p_from_user_id is null or p_from_user_id = v_actor then
    return jsonb_build_object('success', false, 'error', 'invalid player');
  end if;

  -- Fast path for a human retrying after a lost response. NOT the guarantee -
  -- two concurrent submissions both pass this; the unique index settles that,
  -- see the handler around the writes.
  if v_key is not null then
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is not null then
      return jsonb_build_object(
        'success', true,
        'player_balance', (v_prior->>'player_balance_after')::numeric,
        'your_balance',   (v_prior->>'actor_balance_after')::numeric,
        'replayed', true);
    end if;
  end if;

  if v_actor < p_from_user_id then
    v_first := v_actor; v_second := p_from_user_id;
  else
    v_first := p_from_user_id; v_second := v_actor;
  end if;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_first for update;
  perform 1 from club_members
    where club_id = p_club_id and user_id = v_second for update;

  select role into v_actor_role
    from club_members
   where club_id = p_club_id and user_id = v_actor and status in ('active', 'approved');
  if v_actor_role is null then
    return jsonb_build_object('success', false, 'error', 'you are not an active member of this club');
  end if;
  -- co_owner was missing here, though fn_club_bank_role and
  -- fn_wallet_claim_back both treat co_owner as club leadership.
  if v_actor_role not in ('owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent') then
    return jsonb_build_object('success', false, 'error', 'your role cannot claim back chips');
  end if;

  select agent_id, coalesce(chip_balance, 0)
    into v_player_agent, v_player_before
    from club_members
   where club_id = p_club_id and user_id = p_from_user_id and status in ('active', 'approved');
  if v_player_before is null then
    return jsonb_build_object('success', false, 'error', 'player is not an active member of this club');
  end if;
  if v_actor_role in ('super_agent', 'agent', 'sub_agent')
     and v_player_agent is distinct from v_actor then
    return jsonb_build_object('success', false, 'error', 'player is not in your downline');
  end if;

  if v_player_before < p_amount then
    return jsonb_build_object('success', false, 'error', 'insufficient chips',
                              'balance', v_player_before);
  end if;

  begin
    update club_members
       set chip_balance = chip_balance - p_amount, updated_at = now()
     where club_id = p_club_id and user_id = p_from_user_id
     returning chip_balance into v_player_after;

    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount, updated_at = now()
     where club_id = p_club_id and user_id = v_actor
     returning chip_balance into v_actor_after;

    insert into chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, metadata)
    values
      (p_club_id, p_from_user_id, v_actor, p_amount, 'peer_transfer',
       coalesce(p_reason, 'Cashier claim back'), v_actor_after,
       case when v_key is null then '{}'::jsonb
            else jsonb_build_object(
                   'idempotency_key', v_key,
                   'player_balance_after', v_player_after,
                   'actor_balance_after', v_actor_after) end);

    insert into wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    values
      (p_from_user_id, 'PLAYER', 'debit', p_amount, 'transfer',
       coalesce(p_reason, 'Cashier claim back'), v_player_after),
      (v_actor, 'PLAYER', 'credit', p_amount, 'transfer',
       coalesce(p_reason, 'Cashier claim back'), v_actor_after);
  exception when unique_violation then
    -- A concurrent identical submission committed first. Everything this block
    -- did rolls back with it, so nothing moved twice; report the winner's
    -- outcome rather than an error the caller would answer with a retry.
    select ct.metadata into v_prior
      from chip_transactions ct
     where ct.metadata->>'idempotency_key' = v_key
     limit 1;
    if v_prior is null then raise; end if;
    return jsonb_build_object(
      'success', true,
      'player_balance', (v_prior->>'player_balance_after')::numeric,
      'your_balance',   (v_prior->>'actor_balance_after')::numeric,
      'replayed', true);
  end;

  return jsonb_build_object(
    'success', true,
    'player_balance', v_player_after,
    'your_balance', v_actor_after
  );
end
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_claim_back(uuid,uuid,numeric,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cashier_claim_back(uuid,uuid,numeric,text,text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_claim_back(uuid,uuid,numeric,text,text)
  TO authenticated, service_role;
DROP FUNCTION IF EXISTS public.fn_cashier_claim_back(uuid,uuid,numeric,text);

-- == 1 + 2. fn_wallet_claim_back ============================================
-- Patched in place: this body is not in the repo, and re-pasting it from a
-- description would be invention. Each step asserts its target appears exactly
-- once and refuses otherwise.
DO $$
DECLARE
  v_src text; v_out text; n int;
  c_sig   constant text := 'p_reason text DEFAULT NULL::text)';
  c_sig2  constant text := 'p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)';
  c_decl  constant text := '  v_min_comm numeric;';
  c_decl2 constant text := '  v_min_comm numeric;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '''')), '''');
  v_prior jsonb;';
  c_perm  constant text := '  -- Verify actor permissions based on target wallet';
  c_perm2 constant text :=
'  -- Fast path for a retry after a lost response; the unique index is the
  -- actual guarantee for a concurrent race.
  if v_key is not null then
    select ct.metadata into v_prior from chip_transactions ct
     where ct.metadata->>''idempotency_key'' = v_key limit 1;
    if v_prior is not null then
      return jsonb_build_object(''success'', true,
        ''balance_after'', (v_prior->>''target_balance_after'')::numeric, ''replayed'', true);
    end if;
  end if;

  -- Verify actor permissions based on target wallet';
  c_bank  constant text :=
'    if coalesce(v_actor_role, '''') not in (''owner'', ''co_owner'', ''admin'', ''super_agent'') then
      return jsonb_build_object(''success'', false, ''error'', ''Your Role Cannot Claim Back Into The Club Bank'');
    end if;';
  c_bank2 constant text :=
'    if coalesce(v_actor_role, '''') not in (''owner'', ''co_owner'', ''admin'', ''super_agent'') then
      return jsonb_build_object(''success'', false, ''error'', ''Your Role Cannot Claim Back Into The Club Bank'');
    end if;
    -- A SUPER AGENT IS NOT CLUB LEADERSHIP (2026-08-24). owner / co_owner /
    -- admin hold club-wide authority and stay unrestricted. A super_agent does
    -- not: this branch let one claim chips out of ANY member of the club,
    -- including players belonging to a different agent, simply by naming the
    -- club bank as the destination - while the agent_wallet branch below
    -- already required a downline relationship.
    if coalesce(v_actor_role, '''') = ''super_agent''
       and not public.fn_club_is_in_downline(p_club_id, v_actor, p_from_user_id) then
      return jsonb_build_object(''success'', false, ''error'', ''Player Is Not In Your Downline'');
    end if;';
  c_meta  constant text := '''from_balance_after'', v_from_after
    )';
  c_meta2 constant text := '''from_balance_after'', v_from_after,
      ''target_balance_after'', v_target_after
    ) || case when v_key is null then ''{}''::jsonb
              else jsonb_build_object(''idempotency_key'', v_key) end';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_wallet_claim_back'
   ORDER BY p.pronargs DESC LIMIT 1;
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_wallet_claim_back not found'; END IF;
  IF position('A SUPER AGENT IS NOT CLUB LEADERSHIP' IN v_src) > 0
     AND position('v_key is null' IN v_src) > 0 THEN
    RAISE NOTICE 'fn_wallet_claim_back already carries both changes'; RETURN;
  END IF;

  v_out := v_src;
  IF position('p_idempotency_key' IN v_out) = 0 THEN
    n := (length(v_out)-length(replace(v_out,c_sig,'')))/length(c_sig);
    IF n <> 1 THEN RAISE EXCEPTION 'signature hits=%', n; END IF;
    v_out := replace(v_out, c_sig, c_sig2);
    n := (length(v_out)-length(replace(v_out,c_decl,'')))/length(c_decl);
    IF n <> 1 THEN RAISE EXCEPTION 'decl hits=%', n; END IF;
    v_out := replace(v_out, c_decl, c_decl2);
    n := (length(v_out)-length(replace(v_out,c_perm,'')))/length(c_perm);
    IF n <> 1 THEN RAISE EXCEPTION 'perm anchor hits=%', n; END IF;
    v_out := replace(v_out, c_perm, c_perm2);
  END IF;
  IF position('A SUPER AGENT IS NOT CLUB LEADERSHIP' IN v_out) = 0 THEN
    n := (length(v_out)-length(replace(v_out,c_bank,'')))/length(c_bank);
    IF n <> 1 THEN RAISE EXCEPTION 'club_bank guard hits=%', n; END IF;
    v_out := replace(v_out, c_bank, c_bank2);
  END IF;
  IF position('v_key is null' IN v_out) = 0 THEN
    n := (length(v_out)-length(replace(v_out,c_meta,'')))/length(c_meta);
    IF n <> 1 THEN RAISE EXCEPTION 'metadata tail hits=%', n; END IF;
    v_out := replace(v_out, c_meta, c_meta2);
  END IF;
  EXECUTE v_out;
END $$;

REVOKE ALL ON FUNCTION public.fn_wallet_claim_back(uuid,uuid,numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_wallet_claim_back(uuid,uuid,numeric,text,text,text,text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_wallet_claim_back(uuid,uuid,numeric,text,text,text,text)
  TO authenticated, service_role;
DROP FUNCTION IF EXISTS public.fn_wallet_claim_back(uuid,uuid,numeric,text,text,text);

-- == Post-conditions ========================================================
DO $$
DECLARE v text; c int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='ux_chip_transactions_idempotency_key') THEN
    RAISE EXCEPTION 'post-check: idempotency index missing';
  END IF;

  SELECT count(*) INTO c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cashier_claim_back';
  IF c <> 1 THEN RAISE EXCEPTION 'post-check: expected 1 fn_cashier_claim_back, found %', c; END IF;

  SELECT count(*) INTO c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_wallet_claim_back';
  IF c <> 1 THEN RAISE EXCEPTION 'post-check: expected 1 fn_wallet_claim_back, found %', c; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_cashier_claim_back' LIMIT 1;
  IF position('replayed' IN v) = 0 THEN RAISE EXCEPTION 'post-check: cashier replay path missing'; END IF;
  IF position('co_owner' IN v) = 0 THEN RAISE EXCEPTION 'post-check: co_owner still excluded'; END IF;
  IF has_function_privilege('anon', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_cashier_claim_back' LIMIT 1), 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: anon can execute fn_cashier_claim_back';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_wallet_claim_back' LIMIT 1;
  IF position('A SUPER AGENT IS NOT CLUB LEADERSHIP' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: super_agent downline requirement missing'; END IF;
  IF position('v_key is null' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: wallet key is never written'; END IF;
  IF position('You Are Not A Member Of This Club' IN v) = 0 THEN
    RAISE EXCEPTION 'post-check: the NULL-role guard was lost'; END IF;
  IF has_function_privilege('anon', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='fn_wallet_claim_back' LIMIT 1), 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: anon can execute fn_wallet_claim_back';
  END IF;
END $$;

COMMIT;
