-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- Epoch-3 preflight rehearsal (2026-09-01 00:12 UTC) surfaced the last three
-- unregistered money writers and one live uncategorized path:
--   1. fn_spin_move_owner_wallet - the spin margin mover for STANDALONE club
--      owners (the new club 2a1132b9 is the first standalone club running
--      spins since the suspense drain, which is why this path only started
--      writing suspense tonight). It now declares its ledger identity:
--      margin to the owner journals as rake vs spin_reserve; owner funding
--      into spins journals as overlay.
--   2. fn_agent_claim_commission - pays claimed commission into the agent's
--      club wallet with no category; now declares commission.
--   3. The two membership impls write chip_balance = 0 explicitly (zero
--      delta, the auto-ledger ignores it) - registered as approved.

CREATE OR REPLACE FUNCTION public.fn_spin_move_owner_wallet(p_owner_id uuid, p_owner_kind text, p_wallet text, p_delta numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_after numeric;
BEGIN
  /* ZERO-DRIFT phase 6: declare the ledger identity of the spin margin flow.
     Positive delta = spin margin landing with the owner (rake, from the spin
     reserve); negative delta = the owner funding the spin pool (overlay). */
  PERFORM set_config('app.ledger_category',
                     CASE WHEN p_delta >= 0 THEN 'rake' ELSE 'overlay' END, true);
  PERFORM set_config('app.ledger_counterparty', 'spin_reserve', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  IF p_owner_kind = 'union' THEN
    IF p_wallet NOT IN ('chip_balance','promo_wallet','rake_wallet','spin_reserve_wallet') THEN
      RAISE EXCEPTION 'unknown union wallet %', p_wallet;
    END IF;
    EXECUTE format(
      'UPDATE public.union_wallets SET %I = %I + $1, updated_at = now()
        WHERE union_id = $2 AND %I + $1 >= 0 RETURNING %I',
      p_wallet, p_wallet, p_wallet, p_wallet)
      INTO v_after USING p_delta, p_owner_id;
  ELSE
    IF p_wallet NOT IN ('chip_treasury','promo_balance') THEN
      RAISE EXCEPTION 'unknown club wallet %', p_wallet;
    END IF;
    EXECUTE format(
      'UPDATE public.clubs SET %I = COALESCE(%I,0) + $1
        WHERE id = $2 AND COALESCE(%I,0) + $1 >= 0 RETURNING %I',
      p_wallet, p_wallet, p_wallet, p_wallet)
      INTO v_after USING p_delta, p_owner_id;
  END IF;
  RETURN v_after;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_move_owner_wallet(uuid, text, text, numeric) TO service_role;

-- fn_agent_claim_commission: anchored injection of the category declaration
-- at the top of the function body (first BEGIN), preserving everything else.
DO $do$
DECLARE src text; pos int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_agent_claim_commission';
  IF src ILIKE '%ledger_category%' THEN
    RAISE NOTICE 'fn_agent_claim_commission already declares a category';
    RETURN;
  END IF;
  pos := position('BEGIN' in src);
  IF pos = 0 THEN RAISE EXCEPTION 'no BEGIN found'; END IF;
  src := overlay(src PLACING
    'BEGIN
  /* ZERO-DRIFT phase 6: commission claims journal as commission. */
  PERFORM set_config(''app.ledger_category'', ''commission'', true);
  PERFORM set_config(''app.ledger_counterparty'', ''agent_wallet'', true);
  PERFORM set_config(''app.ledger_counterparty_entity'', '''', true);'
    FROM pos FOR 5);
  EXECUTE src;
END $do$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.proname, 'approved', v.notes FROM (VALUES
 ('fn_spin_move_owner_wallet', 'Audited 2026-09-01: spin margin mover for standalone club owners and unions, service_role only. Declares rake/overlay categories vs spin_reserve as of ca_phase6_last_uncategorized_writers_learn_their_names.'),
 ('fn_agent_claim_commission', 'Audited 2026-09-01: agent commission claim, consults auth, idempotent claim flow. Declares commission category as of ca_phase6_last_uncategorized_writers_learn_their_names.'),
 ('fn_create_club_atomic_membership_impl', 'Audited 2026-09-01: membership creation writes chip_balance = 0 explicitly (zero delta, no money moves).'),
 ('fn_join_club_membership_impl', 'Audited 2026-09-01: membership join writes chip_balance = 0 explicitly (zero delta, no money moves; the 1000-chip default died 2026-08).')
) AS v(proname, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry r WHERE r.proname = v.proname);;
