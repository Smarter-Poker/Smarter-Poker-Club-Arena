#!/usr/bin/env python3
"""Generate a narrowly patched real bank owner; fail if any pinned anchor moves."""
import json
from pathlib import Path
p=Path(__file__).resolve().parent
catalog=p.parent/'owner-composition'
fs=[x for f in catalog.glob('function-catalog-*.json') for x in json.loads(f.read_text())]
base=next(x for x in fs if x['signature'].startswith('atomic_distribute_rake('))
assert base['body_md5']=='56fe5715421d7e35bc386a669bb483a2'
s=base['definition']
def replace(old,new):
 global s
 assert s.count(old)==1,(old[:80],s.count(old))
 s=s.replace(old,new)
replace('  v_union_id     uuid;',"""  v_source public.ca_cash_commission_sources%ROWTYPE;
  v_receipt public.ca_cash_bank_receipts%ROWTYPE;
  v_captured boolean := false;
  v_envelope jsonb;
  v_bank_tx uuid;
  v_bank_ledger uuid;
  v_bank_at timestamptz;
  v_bank_before numeric;
  v_bank_after numeric;
  v_lock_club uuid;
  v_union_id     uuid;""")
replace('BEGIN\n  IF p_club_id IS NULL',"""BEGIN
  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
   SELECT id INTO p_hand_id FROM public.hand_history
   WHERE table_id=p_table_id AND hand_number=p_hand_number ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF EXISTS(SELECT 1 FROM public.ca_cash_commission_sources
   WHERE table_id=p_table_id AND hand_number=p_hand_number AND hand_id IS DISTINCT FROM p_hand_id) THEN
   RAISE EXCEPTION 'Captured cash bank cannot resolve its accepted hand identity';
  END IF;
  SELECT * INTO v_source FROM public.ca_cash_commission_sources WHERE hand_id=p_hand_id;
  v_captured:=FOUND;
  IF v_captured THEN
   SELECT h.post_commit_payload->'rake' INTO v_envelope
   FROM public.hand_atomic_commits h JOIN public.ca_cash_commission_authority a ON a.singleton
   WHERE h.hand_id=p_hand_id AND h.commission_capture_version=a.contract_version
    AND a.contract_version=1 AND h.post_commit_payload_hash=v_source.accepted_payload_hash;
   IF NOT FOUND OR p_table_id IS DISTINCT FROM v_source.table_id
    OR p_club_id IS DISTINCT FROM v_source.requested_club_id
    OR p_hand_number IS DISTINCT FROM v_source.hand_number
    OR p_rake IS DISTINCT FROM v_source.rake_total
    OR coalesce(p_bbj,0) IS DISTINCT FROM (v_envelope->>'bbj')::numeric
    OR p_pot IS DISTINCT FROM (v_envelope->>'pot')::numeric
    OR p_num_players IS DISTINCT FROM (v_envelope->>'num_players')::integer
    OR p_contributions IS DISTINCT FROM v_source.contributions
    OR p_returned_uncalled IS DISTINCT FROM v_source.returned_uncalled
    OR p_rake_method IS DISTINCT FROM v_source.rake_method
    OR p_tournament_id IS NOT NULL THEN
     RAISE EXCEPTION 'Cash bank arguments conflict with accepted source';
   END IF;
   -- Shared club admission precedes this bank's hand and wallet locks.
   FOR v_lock_club IN
    SELECT club_id FROM (
     SELECT v_source.requested_club_id AS club_id UNION
     SELECT booked_club_id FROM public.ca_cash_commission_facts WHERE hand_id=p_hand_id
    ) c WHERE club_id IS NOT NULL ORDER BY club_id
   LOOP
    PERFORM pg_advisory_xact_lock(hashtext('club-arena:rakeback-payer'),hashtext(v_lock_club::text));
   END LOOP;
   PERFORM public.fn_ca_cash_bank_admission(p_hand_id,p_table_id,p_hand_number::text);
   SELECT * INTO v_receipt FROM public.ca_cash_bank_receipts WHERE hand_id=p_hand_id;
   IF FOUND THEN
    PERFORM public.fn_ca_assert_cash_bank_receipt(p_hand_id);
    RETURN QUERY SELECT false,true,false,v_receipt.rake_record_id,v_receipt.club_net_credit,
     v_receipt.funding_route,v_receipt.credited_amount,v_receipt.funding_union_id;
    RETURN;
   END IF;
   IF EXISTS(SELECT 1 FROM public.rake_records WHERE hand_id=p_hand_id
      OR (table_id=p_table_id AND metadata->>'hand_number'=p_hand_number::text))
    OR EXISTS(SELECT 1 FROM public.rake_distribution_legs WHERE leg_key IN
      (v_source.bank_leg_key,md5('rake:'||p_table_id::text||':'||p_hand_number::text)::uuid)) THEN
    RAISE EXCEPTION 'Captured cash bank refuses preexisting unacknowledged funding';
   END IF;
  END IF;
  IF p_club_id IS NULL""")
replace("  -- UNION LAW (Dan, restored 2026-08-30): route by the GAME's union stamp,", """  IF v_captured THEN
   v_union_id:=v_source.funding_union_id;
   v_is_private:=(v_source.funding_context->>'is_private')::boolean;
  ELSE
  -- UNION LAW (Dan, restored 2026-08-30): route by the GAME's union stamp,""")
replace('  /* A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE AND',"""  END IF;

  /* A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE AND""")
replace("""           COALESCE((SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id
                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id),""","""           CASE WHEN v_captured THEN
            (SELECT f.booked_club_id FROM public.ca_cash_commission_facts f
             WHERE f.hand_id=p_hand_id AND f.player_id=a.user_id)
           ELSE COALESCE((SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id
                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id) END,""")
replace("  PERFORM set_config('app.ledger_settlement', 'rake:' || v_leg_key::text, true);","""  PERFORM set_config('app.ledger_settlement', 'rake:' || v_leg_key::text, true);
  -- A prior spendable route cannot be changed into a second credit, including
  -- legacy replays. Refusal leaves prior history untouched.
  IF EXISTS(SELECT 1 FROM public.rake_distribution_legs l WHERE l.leg_key=v_leg_key
   AND l.leg IN ('union_rake','chip_treasury')
   AND (l.leg IS DISTINCT FROM CASE WHEN v_union_id IS NULL THEN 'chip_treasury' ELSE 'union_rake' END
    OR l.union_id IS DISTINCT FROM v_union_id OR l.club_id IS DISTINCT FROM p_club_id
    OR l.amount IS DISTINCT FROM p_rake)) THEN
   RAISE EXCEPTION 'Cash bank replay conflicts with original spendable leg';
  END IF;""")
replace("""          ' (' || COALESCE(v_club_name, 'club') || ')'
      );""","""          ' (' || COALESCE(v_club_name, 'club') || ')'
      ) RETURNING id,created_at INTO v_bank_tx,v_bank_at;""")
replace("""            || ' (atomic_distribute_rake)');""","""            || ' (atomic_distribute_rake)')
        RETURNING id,created_at INTO v_bank_ledger,v_bank_at;""")
replace('  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,',"""  IF v_captured THEN
   IF NOT v_first_claim OR v_recovered OR v_bank_at IS NULL
    OR (v_bank_tx IS NULL AND v_bank_ledger IS NULL)
    OR v_route IS DISTINCT FROM v_source.funding_route THEN
    RAISE EXCEPTION 'Captured cash bank did not produce a complete new credit';
   END IF;
   INSERT INTO public.ca_cash_bank_receipts(hand_id,contract_version,accepted_payload_hash,
    rake_record_id,leg_key,leg,requested_club_id,funding_union_id,funding_route,credited_amount,
    bbj_contribution,club_net_credit,union_wallet_transaction_id,chip_ledger_id,bank_credit_at)
   VALUES(p_hand_id,1,v_source.accepted_payload_hash,v_rr_id,v_leg_key,
    CASE WHEN v_union_id IS NULL THEN 'chip_treasury' ELSE 'union_rake' END,p_club_id,v_union_id,
    v_route,p_rake,v_bbj,v_net,v_bank_tx,v_bank_ledger,v_bank_at);
   PERFORM public.fn_ca_assert_cash_bank_receipt(p_hand_id);
  END IF;
  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,""")
replace("      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)", """      SELECT coalesce(rake_wallet,0) INTO v_bank_before FROM public.union_wallets
       WHERE union_id=v_union_id FOR UPDATE;
      IF NOT FOUND THEN v_bank_before:=0; END IF;
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)""")
replace("      RETURNING rake_wallet INTO v_union_rake;", """      RETURNING rake_wallet INTO v_union_rake;
      IF NOT FOUND OR v_union_rake IS DISTINCT FROM v_bank_before+p_rake THEN
       RAISE EXCEPTION 'Cash bank Union destination credit did not apply exactly once';
      END IF;""")
replace("      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);", """      SELECT coalesce(chip_treasury,0) INTO STRICT v_bank_before FROM public.clubs
       WHERE id=p_club_id FOR UPDATE;
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);""")
replace("""       WHERE id = p_club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);""","""       WHERE id = p_club_id RETURNING chip_treasury INTO v_bank_after;
      IF NOT FOUND OR v_bank_after IS DISTINCT FROM v_bank_before+p_rake THEN
       RAISE EXCEPTION 'Cash bank club destination credit did not apply exactly once';
      END IF;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);""")
preflight="""-- PROPOSAL ONLY. Execute with receipt DDL and source activation in ONE bounded transaction.
DO $pin$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure)
 IS DISTINCT FROM '56fe5715421d7e35bc386a669bb483a2' THEN
  RAISE EXCEPTION 'Actual cash bank owner changed';
 END IF;
END $pin$;
"""
(p/'02-bank-owner.sql').write_text(preflight+s.rstrip()+';\n')
(p/'actual-bank-owner.sql').write_text(base['definition'].rstrip()+';\n')
print('Generated pinned actual bank owner')
