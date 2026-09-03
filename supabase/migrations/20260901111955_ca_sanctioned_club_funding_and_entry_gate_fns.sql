-- Deep Stack Society event (2026-09-01 09:30-11:15 UTC) hardening, part 1.
-- What happened: a new standalone club was funded by RAW balance UPDATEs
-- (9,901,500 into chip_treasury, member funding via agent-wallet churn -
-- 47.7M gross unclassified flow). The autoledger safety net journaled every
-- row (category adjustment vs settlement_suspense), the supply watch paged
-- the 9.9M as unexplained (correct - nothing was minted), and the clawback
-- burned 9,902,390.22 (ledgered). Nothing was lost, but funding a club must
-- NEVER look like drift. Two structural answers:
--
-- 1. fn_ca_fund_club: THE sanctioned way to fund a club treasury. Declares
--    mint vs issuance_reserve through fn_ca_declare_ledger, so the supply
--    snapshot sees a ledgered mint and stays green at any amount.
-- 2. fn_ca_entry_scope_ok: the membership test one place, used by the entry
--    gate trigger (part 2): a player may enter a tournament only inside
--    their club/union scope. This closes BOTH directions seen today:
--    club-less horses in Midway-union freerolls, and 230 out-of-club
--    players inside Deep Stack tournaments.

CREATE OR REPLACE FUNCTION public.fn_ca_fund_club(
  p_club_id uuid,
  p_amount numeric,
  p_reason text,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club record; v_key text; v_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'fund_club refused: amount must be positive';
  END IF;
  IF COALESCE(length(trim(p_reason)),0) < 10 THEN
    RAISE EXCEPTION 'fund_club refused: a reason of at least 10 characters is required';
  END IF;
  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'fund_club refused: unknown club %', p_club_id;
  END IF;
  v_key := COALESCE(p_idempotency_key,
                    'club-funding:' || p_club_id::text || ':' ||
                    extract(epoch from clock_timestamp())::bigint::text);
  -- Replay safety: an identical key that already journaled is a no-op.
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = v_key) THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'idempotency_key', v_key);
  END IF;
  PERFORM public.fn_ca_declare_ledger('mint', 'system_mint', NULL, NULL, v_key);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury,0) + p_amount
   WHERE id = p_club_id
   RETURNING chip_treasury INTO v_after;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'club_id', p_club_id,
                            'amount', p_amount, 'treasury_after', v_after,
                            'idempotency_key', v_key, 'reason', p_reason);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_fund_club(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_club(uuid, numeric, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_entry_scope_ok(p_user_id uuid, p_tournament_club uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union boolean; v_club_union uuid;
BEGIN
  IF p_user_id IS NULL OR p_tournament_club IS NULL THEN
    RETURN false;
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
REVOKE ALL ON FUNCTION public.fn_ca_entry_scope_ok(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_entry_scope_ok(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_entry_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tclub uuid;
BEGIN
  -- Maintenance escape for deliberate service operations.
  IF current_setting('app.ca_entry_gate_skip', true) = '1' THEN
    RETURN NEW;
  END IF;
  SELECT t.club_id INTO v_tclub FROM public.tournaments t WHERE t.id = NEW.tournament_id;
  IF v_tclub IS NULL THEN
    RETURN NEW; -- clubless tournament: nothing to scope against
  END IF;
  IF NOT public.fn_ca_entry_scope_ok(NEW.user_id, v_tclub) THEN
    RAISE EXCEPTION 'tournament entry refused: player % has no club membership in the scope of tournament % (club/union %). Join a club in this union first.',
      NEW.user_id, NEW.tournament_id, v_tclub
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_entry_gate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_entry_gate() TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
 ('fn_ca_fund_club', 'approved', 'Sanctioned club-treasury funding: declared mint vs system_mint, idempotent, service_role only. Added after the Deep Stack raw-UPDATE funding event of 2026-09-01.'),
 ('process_tournament_rebuy_before_one_minute_addon', 'approved', 'Audited 2026-09-01: journals under the horse_funding category, zero suspense rows in its first live hours, ACL postgres-only (not browser reachable). Registered so the drift scan stops flagging it.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;
