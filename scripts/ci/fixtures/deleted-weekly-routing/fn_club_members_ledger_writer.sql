CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_ledger uuid;
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  /* RAKEBACK IS NOT JOURNALLED FROM HERE (2026-09-21). This trigger takes the
     category from app.ledger_category and the counterparty from
     app.ledger_counterparty, and it knows no period, certificate, payout row,
     settlement run or document. On 2026-09-14 that produced 420 anonymous
     rakeback legs moving 84,041.00 into 420 player wallets with no invoice, no
     receipt and no run to tie them to. Rakeback is paid by
     public.fn_settle_accounting_rakeback_stage, which stands this journal down
     with app.ledger_autoskip_club_members and writes its own leg carrying all
     of those facts. A caller that reaches this line with rakeback declared is
     by construction a caller that has none of them, so it refuses instead of
     minting an anonymous twin. The 420 historical rows are left exactly as
     they are. */
  IF cat = 'rakeback' THEN
    RAISE EXCEPTION 'rakeback_requires_accounting_authority'
      USING ERRCODE = '42501',
            DETAIL  = 'club_members.chip_balance moved under app.ledger_category=rakeback outside public.fn_settle_accounting_rakeback_stage',
            HINT    = 'The weekly accounting authority stands this journal down with app.ledger_autoskip_club_members and writes its own documented, period- and run-identified rakeback leg.';
  END IF;

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text)
    RETURNING id INTO v_original_ledger;
    -- Private original-debit callers read this immediately after their UPDATE.
    PERFORM set_config('app.cash_original_debit_ledger',v_original_ledger::text,true);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$
