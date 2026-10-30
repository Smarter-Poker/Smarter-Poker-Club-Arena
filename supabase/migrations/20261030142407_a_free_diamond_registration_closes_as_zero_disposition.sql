-- A free Diamond registration closes as zero disposition.
-- The refund authority releases free custody at zero, without a ledger or journal.
-- Cancellation incorrectly counted that result as a paid line; the exact receipt
-- verifier then correctly refused and rolled back the entire cancellation.
-- Preserve every paid refund, immutable receipt check, lock and permission.
-- No wallet changes or recurring repair; classify the original refund result.
-- @live-proof: EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_poker_diamond_tournament_cancel(uuid,uuid)') AND md5(pg_get_functiondef(p.oid))='cc361623d8e6effbcefcff0c84157006' AND p.proowner='postgres'::regrole AND p.prosecdef)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE original text; candidate text;
  seam text := $seam$      IF COALESCE((v_refund->>'idempotent')::boolean,false) THEN$seam$;
  replacement text := $replacement$      -- A free entry releases zero custody and has no financial ledger line.
      IF v_refund->>'free_entry' = 'true' THEN
        IF v_refund->>'fully_settled' IS DISTINCT FROM 'true'
           OR (v_refund->>'paid')::numeric IS DISTINCT FROM 0::numeric
           OR v_refund->>'ledger_id' IS NOT NULL
           OR v_refund->>'obligation_id' IS NOT NULL
           OR v_refund->>'journal_id' IS NOT NULL THEN
          RAISE EXCEPTION 'free Diamond entry has invalid refund evidence' USING ERRCODE='P0404';
        END IF;
        v_zero_refund_registration_ids := array_append(v_zero_refund_registration_ids, v_player.id);
        CONTINUE;
      END IF;
$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_diamond_tournament_cancel(uuid,uuid)'::regprocedure) INTO original;
  IF md5(original) IS DISTINCT FROM '17773dfaaa9365a2abdc8fa2666402a5'
     OR (length(original)-length(replace(original,seam,'')))/length(seam) <> 1 THEN
    RAISE EXCEPTION 'Diamond cancellation source changed; review current authority';
  END IF;
  candidate := replace(original,seam,replacement||seam);
  EXECUTE candidate;
  IF pg_get_functiondef('public.fn_poker_diamond_tournament_cancel(uuid,uuid)'::regprocedure) IS DISTINCT FROM candidate THEN
    RAISE EXCEPTION 'Diamond cancellation postimage changed';
  END IF;
END $patch$;
COMMIT;
