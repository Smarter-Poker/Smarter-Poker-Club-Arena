-- @live-proof: (SELECT md5(pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure)) = 'a808ef9877d71cad2ede54d10ef8866a')
-- Version reserved by scripts/new-migration.mjs.
-- Reporting only. Personal earned fees use Player Management's standing shares
-- and declared fee adjustments. Games retain gross generated fees. Member fees
-- use canonical UTC ledger dates, independent of game and search filters.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE
  original text := pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure);
  patched text;
BEGIN
  IF md5(original) <> '5931794acd5d1319ebf7d7e061d9ba17' THEN
    RAISE EXCEPTION 'Club Data earned fee reader preimage changed; nothing changed';
  END IF;
  patched := replace(original, '  v_sum jsonb;', E'  v_member_fees jsonb;\n  v_sum jsonb;');
  patched := replace(patched, '  IF v_game = ''ALL'' AND v_stakes = ''ALL'' AND v_q IS NULL THEN',
$insert$  IF v_scope = 'downline' THEN
    SELECT jsonb_build_object('cash_fees', coalesce(sum(f.cash_fees),0),
      'tournament_fees', coalesce(sum(f.tournament_fees),0),
      'total_fees', coalesce(sum(f.total_fees),0), 'day_basis', 'UTC')
      INTO v_member_fees
      FROM public.ca_club_member_fee_totals(p_club_id, v_start, v_end, auth.uid()) f;
  END IF;
  IF v_game = 'ALL' AND v_stakes = 'ALL' AND v_q IS NULL THEN$insert$);
  patched := replace(patched, '''summary'', v_sum,', '''member_fees'', v_member_fees, ''summary'', v_sum,');
  IF patched = original OR position('INTO v_member_fees' IN patched) = 0
     OR (length(patched)-length(replace(patched, '''member_fees'', v_member_fees,', ''))) / length('''member_fees'', v_member_fees,') <> 2 THEN
    RAISE EXCEPTION 'Club Data earned fee patch incomplete';
  END IF;
  EXECUTE patched;
END;
$patch$;
COMMIT;
