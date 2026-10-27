-- @live-proof: (position('Rakeback is due before club-book settlement' IN pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))>0 AND position('club_books_close_after_rakeback' IN pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure))>0)
-- Owner-directed ordering, 2026-10-26: union fees -> club main banks (90%),
-- club banks -> agents -> players, THEN club settlements and weekly invoices.
-- A later book-report classification gap must not withhold fully certified
-- earned fees. Every closed-book, cash-source, historical-rate, calculation,
-- funding, conservation and original payment/duplicate receipt check remains.
-- Move the SAME P&L guard to its original settlement owner after conserved
-- paid rounds. A warming book keeps only truthful proof progress; a bad book
-- still refuses settled status, ECO and weekly invoices. No new payer/schedule.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $repair$
DECLARE original text;patched text;anchor text;replacement text;
BEGIN
 original:=pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(original)<>'59ffa64567422631e131fd3cc2b03552' THEN RAISE EXCEPTION 'fees_before_books_original_owner_changed: fn_prepare_accounting_week';END IF;
 anchor:=$old$ -- P&L/ECO is part of a union's full weekly close. A diagnostic gap must
 -- stop this book before any payer stage, even when rake sources are ready.
 IF p_union_id IS NOT NULL THEN
  source_check:=public.fn_union_pnl_close_quality(p_union_id,p_from,p_to);
  IF source_check->>'status' IS DISTINCT FROM 'ready' THEN
   RETURN jsonb_build_object('success',false,'accounting_version',3,
    'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
    'problems',jsonb_build_array(jsonb_build_object('reason','union_pnl_basis_uncertified','pnl_evidence',source_check)));
  END IF;
 END IF;
$old$;replacement:=$new$ -- Rakeback is due before club-book settlement (owner, 2026-10-26).
 -- Keep the closed book, source queue, recorded contracts and calculation
 -- receipts here. The original cascade proves P&L after its conserved paid
 -- rounds, before any club period is settled or weekly invoice is issued.
$new$;
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'fees_before_books_original_anchor_changed';END IF;
 patched:=replace(original,anchor,replacement);EXECUTE patched;
 IF pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'fees_before_books_postimage_changed';END IF;
 original:=pg_get_functiondef('fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(original)<>'88417415bde34f4d8ea462950aa7f20f' THEN RAISE EXCEPTION 'fees_before_books_original_owner_changed: fn_union_settlement_cascade';END IF;
 anchor:=$old$  -- A CLUB STATEMENT'S TOURNAMENT PROOF IS ITS OWN STEP (20261017223358).$old$;replacement:=$new$  -- club_books_close_after_rakeback: the P&L guard owns the club settlement,
  -- after the earned fee cascade, before statements, ECO or settled status.
  v_quality:=public.fn_union_pnl_close_quality(p_union_id,v_from,v_to);
  IF v_quality->>'status' IS DISTINCT FROM 'ready' THEN
    IF v_chunked AND v_quality->'issues'='["union_pnl_certification_in_progress"]'::jsonb THEN
      RETURN jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,
        'stage','certifying','purpose','club_settlements','union_id',p_union_id,
        'period_start',v_from,'period_end',v_to,'pnl_evidence',v_quality);
    END IF;
    RAISE EXCEPTION 'union_pnl_basis_uncertified' USING ERRCODE='55000',DETAIL=v_quality::text;
  END IF;

  -- A CLUB STATEMENT'S TOURNAMENT PROOF IS ITS OWN STEP (20261017223358).$new$;
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'fees_before_books_original_anchor_changed';END IF;
 patched:=replace(original,anchor,replacement);EXECUTE patched;
 IF pg_get_functiondef('fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'fees_before_books_postimage_changed';END IF;
END $repair$;
COMMIT;
