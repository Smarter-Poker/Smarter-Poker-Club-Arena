-- Account closure already refuses unsettled custody in fn_close_account.
-- Enforce that same prerequisite at the status transition, including staff/service
-- updates which otherwise bypass Close Account. A pending escrow refund must not
-- collide with the deleted-wallet bank return and abort its canonical receipt.
-- No existing deleted account, balance, seat or immutable receipt is rewritten.
-- @live-proof: EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND tgname='trg_deleted_account_custody_settled' AND tgenabled='O') AND EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_close_account(uuid)'::regprocedure AND md5(prosrc)='9074d13b81c1bb07c01826cd2155846e')
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '10s';

CREATE FUNCTION public.fn_deleted_account_custody_settled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Profile UPDATE already owns its row. Never wait for the inverse user/wallet
  -- order held by a credit, buy-in or cashier operation: refuse atomically instead.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || OLD.id::text, 0)) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_BUSY' USING ERRCODE = '55P03';
  END IF;
  PERFORM 1 FROM public.agents a WHERE a.user_id = OLD.id
    ORDER BY a.club_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.club_members m WHERE m.user_id = OLD.id
    ORDER BY m.club_id FOR UPDATE NOWAIT;

  IF EXISTS (SELECT 1 FROM public.table_seats s WHERE s.user_id = OLD.id AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: seated' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players p JOIN public.tournaments t ON t.id = p.tournament_id
    WHERE p.user_id = OLD.id AND p.status IN ('registered','playing')
      AND t.status NOT IN ('COMPLETED','CANCELLED')) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: tournament_entry' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cashout_requests r
    WHERE (r.player_id = OLD.id OR r.agent_id = OLD.id)
      AND (r.status IN ('pending','cancelling','completing')
        OR (r.status = 'approved' AND r.completed_at IS NULL))) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: pending_cashout' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_escrow e WHERE e.player_id = OLD.id AND e.released_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.chip_escrow_holds h WHERE h.user_id = OLD.id AND h.status = 'held') THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: escrow' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = OLD.id
    AND (coalesce(m.held_chips,0) <> 0 OR coalesce(m.locked_chips,0) <> 0)) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: held_chips' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_deleted_account_custody_settled() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_deleted_account_custody_settled() IS
  'Account deletion refuses unsettled table, tournament, cashout and held custody before status or bank-return writes. No waiting behind an inverse wallet lock.';
CREATE TRIGGER trg_deleted_account_custody_settled
BEFORE UPDATE OF status ON public.profiles
FOR EACH ROW
WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
EXECUTE FUNCTION public.fn_deleted_account_custody_settled();
-- An approved request with a completed timestamp has already settled. Its
-- released escrow is checked independently; it must not block closure forever.
DO $close$
DECLARE v_definition text;
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_close_account(uuid)'::regprocedure))
      <> '2a65f0150ab9365424754d3096ab3c41' THEN
    RAISE EXCEPTION 'account_close_custody_preimage_changed';
  END IF;
  v_definition := pg_get_functiondef('public.fn_close_account(uuid)'::regprocedure);
  IF strpos(v_definition,$before$AND cr.status IN ('pending', 'approved', 'cancelling', 'completing')$before$)=0 THEN
    RAISE EXCEPTION 'account_close_cashout_predicate_missing';
  END IF;
  EXECUTE replace(v_definition,$before$AND cr.status IN ('pending', 'approved', 'cancelling', 'completing')$before$,$after$AND (cr.status IN ('pending', 'cancelling', 'completing')
                  OR (cr.status = 'approved' AND cr.completed_at IS NULL))$after$);
  IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_close_account(uuid)'::regprocedure))
      <> '9074d13b81c1bb07c01826cd2155846e' THEN
    RAISE EXCEPTION 'account_close_custody_postimage_changed';
  END IF;
END;
$close$;
COMMIT;
