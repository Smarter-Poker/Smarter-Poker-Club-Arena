-- Return cancelled Spin draws to the reserve owner stored on their ledger legs.
-- Do not redirect funds to the current event club. Refuse a missing original
-- bank before claiming a return; record UPDATE row count before set_config.
-- Isolated actual-function probes cover ownership, prior return, replay,
-- missing bank, paid-prize guard and journal-failure rollback.
-- No historical balances are changed.
BEGIN;
DO $guard$ BEGIN
IF md5(pg_get_functiondef('public.fn_ca_spin_cancel_returns_draw()'::regprocedure)) <> '357056cf2d64439a27992122fb93dd51' THEN
RAISE EXCEPTION 'Spin cancellation function changed; rebase correction';
END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_spin_cancel_returns_draw()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_owed numeric; v_bal numeric; v_funding record; v_updated integer;
BEGIN
  IF NOT (NEW.status IN ('CANCELLED','CANCELED')
          AND COALESCE(OLD.status,'') NOT IN ('CANCELLED','CANCELED')) THEN
    RETURN NEW;
  END IF;

  FOR v_funding IN
  SELECT club_id, round(sum(CASE WHEN kind='jackpot_draw'   THEN -amount
                        WHEN kind='surplus_return' THEN -amount ELSE 0 END), 2)
    AS owed
    FROM public.spin_reserve_ledger WHERE tournament_id = NEW.id
    GROUP BY club_id ORDER BY club_id
  LOOP
  v_owed := v_funding.owed;

  IF COALESCE(v_owed,0) <= 0 THEN CONTINUE; END IF;

  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id = NEW.id
                AND w.type='credit' AND w.category='prize') THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.ledger_category', 'refund', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance = balance + v_owed
   WHERE club_id = v_funding.club_id
  RETURNING balance INTO v_bal;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Spin cancellation cannot return draw: original reserve owner % is missing', v_funding.club_id;
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);

  IF v_updated = 1 THEN
    INSERT INTO public.spin_reserve_ledger
      (club_id, tournament_id, kind, amount, balance_after, note)
    VALUES (v_funding.club_id, NEW.id, 'surplus_return', v_owed, v_bal,
            'spin cancelled without awarding a prize; jackpot draw returned in the cancel');
  END IF;

  END LOOP;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_spin_cancel_returns_draw() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_spin_cancel_returns_draw() TO service_role;
COMMIT;
