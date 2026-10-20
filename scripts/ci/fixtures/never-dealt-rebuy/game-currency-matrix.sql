-- The actual proof owner is shared by all persisted game types and both paid generations.
-- Executed independently against the chip and Diamond fixtures; isolated PG only.
BEGIN;
DO $matrix$
DECLARE game text; op text; asset text; proof jsonb; runs integer:=0;
BEGIN
 SELECT min(f.asset) INTO asset FROM public.tournament_participant_funding_receipts f WHERE f.operation='rebuy';
 IF asset NOT IN ('chips','diamonds') THEN RAISE EXCEPTION 'MATRIX_ASSET_MISSING'; END IF;
 FOREACH game IN ARRAY ARRAY['NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','OFC_PINEAPPLE'] LOOP
  FOREACH op IN ARRAY ARRAY['rebuy','reentry'] LOOP
   UPDATE public.tables SET game_type=game;
   UPDATE public.tournaments SET game_type=game;
   UPDATE public.tournament_participant_funding_receipts SET operation=op,
    tournament_snapshot=jsonb_set(tournament_snapshot,'{game_type}',to_jsonb(game))
    WHERE operation IN ('rebuy','reentry');
   UPDATE public.entry_purchase_idempotency_receipts SET request=jsonb_set(request,'{rebuy_type}',to_jsonb(op)),
    response=jsonb_set(response,'{rebuy_type}',to_jsonb(op));
   UPDATE public.chip_ledger SET category=op WHERE category IN ('rebuy','reentry');
   UPDATE public.wallet_transactions SET category=op WHERE category IN ('rebuy','reentry');
   IF asset='chips' THEN
    UPDATE public.tournament_participant_funding_receipts f SET ledger_snapshot=to_jsonb(l),wallet_snapshot=to_jsonb(w) FROM public.chip_ledger l,public.wallet_transactions w WHERE l.id=f.ledger_id AND w.id=f.wallet_transaction_id;
   END IF;
   IF asset='diamonds' THEN
    UPDATE public.poker_diamond_tournament_ledger SET kind=op WHERE kind IN ('rebuy','reentry');
   END IF;
   proof:=smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67');
   IF proof->'first_hand' IS DISTINCT FROM 'true'::jsonb OR jsonb_array_length(proof->'roster')<>2
    OR (SELECT count(*) FROM jsonb_array_elements(proof#>'{receipts,entries}') x
        WHERE x->>'operation'=op AND x ? 'atomic_purchase')<>2 THEN
    RAISE EXCEPTION 'GAME_CURRENCY_PROOF_REFUSED % % %',game,asset,op;
   END IF;
   runs:=runs+1;
  END LOOP;
 END LOOP;
 IF runs<>14 THEN RAISE EXCEPTION 'INCOMPLETE_MATRIX'; END IF;
 RAISE NOTICE 'ALL_SEVEN_GAMES_TWO_GENERATIONS_PASS:%',asset;
END $matrix$;
ROLLBACK;
SELECT 'GAME_CURRENCY_MATRIX_PASS';
