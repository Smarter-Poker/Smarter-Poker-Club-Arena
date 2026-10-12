DO $$DECLARE r record; v jsonb; old_v jsonb; n integer:=0; BEGIN
 FOR r IN SELECT * FROM (VALUES ('a8798e10-ccca-40ac-b7b1-d9741af5e98f'::uuid,26114212::bigint,139.55::numeric),('c2fb4ddf-861a-4c38-8285-f5c1951b8399'::uuid,26114214::bigint,35.99::numeric),('3432f4c2-6ab2-44e4-8e8e-b405defbff95'::uuid,26114243::bigint,621.8::numeric))x(table_id,hand_number,stack) LOOP
 old_v:=fn_union_pnl_prove_late_seat_credit(r.table_id,r.hand_number);
 v:=fn_union_pnl_prove_original_unchanged_stack(r.table_id,r.hand_number);
 IF old_v->>'status' IS DISTINCT FROM 'refused' OR v->>'status' IS DISTINCT FROM 'proven' THEN RAISE EXCEPTION 'real case % old % new %',r.hand_number,old_v,v;END IF;
 IF (v#>>'{participants,0,dealt_stack_before}')::numeric IS DISTINCT FROM r.stack OR (v#>>'{participants,0,previous_hand,stack_after}')::numeric IS DISTINCT FROM r.stack THEN RAISE EXCEPTION 'real original stack mismatch % %',r.hand_number,v;END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE table_id=r.table_id AND hand_number=r.hand_number) THEN RAISE EXCEPTION 'real case already accepted without certificate';END IF;
 RAISE NOTICE 'PASS actual captured hand %: old refusal %, new proof %, original unchanged stack %',r.hand_number,old_v->>'reason',md5(v::text),r.stack;
 n:=n+1;
 END LOOP;
 IF n<>3 THEN RAISE EXCEPTION 'real cohort incomplete';END IF;
END$$;
BEGIN;
DO $$DECLARE r public.union_pnl_cash_outcomes%ROWTYPE; v jsonb; BEGIN
 FOR r IN SELECT * FROM union_pnl_cash_outcomes WHERE hand_number IN(26114212,26114214,26114243) LOOP
 v:=fn_union_pnl_resolve_original_unchanged_stack(r.table_id,r.hand_number,'Native retained exact primary original unchanged-stack qualification');
 IF v->>'status' IS DISTINCT FROM 'resolved' OR NOT fn_union_pnl_cash_outcome_accepted(r) THEN RAISE EXCEPTION 'actual captured consumer refused % %',r.hand_number,v;END IF;
 END LOOP;
 IF (SELECT count(*) FROM union_pnl_cash_outcome_resolutions)<>3 THEN RAISE EXCEPTION 'real cert count not three';END IF;
 RAISE NOTICE 'PASS actual three captured writer/consumer proofs in rolled-back native transaction';
END$$;
ROLLBACK;
DO $$BEGIN IF EXISTS(SELECT 1 FROM union_pnl_cash_outcome_resolutions) THEN RAISE EXCEPTION 'local rollback retained certificate';END IF;END$$;

-- The real moved participant's monetary converter is the installed component,
-- not a raw numeric cast. Invalid original move-stack fields remain refused.
BEGIN;
UPDATE cash_seat_move_receipts SET receipt=jsonb_set(receipt,'{stack}','"199.70"'::jsonb);
DO $$BEGIN IF fn_union_pnl_prove_original_unchanged_stack('3432f4c2-6ab2-44e4-8e8e-b405defbff95',26114243)->>'status' IS DISTINCT FROM 'refused' THEN RAISE EXCEPTION 'string original move stack accepted';END IF;RAISE NOTICE 'PASS actual original move string stack refuses';END$$;
ROLLBACK;
BEGIN;
UPDATE cash_seat_move_receipts SET receipt=jsonb_set(receipt,'{stack}','199.701'::jsonb);
DO $$BEGIN IF fn_union_pnl_prove_original_unchanged_stack('3432f4c2-6ab2-44e4-8e8e-b405defbff95',26114243)->>'status' IS DISTINCT FROM 'refused' THEN RAISE EXCEPTION 'subcent original move stack accepted';END IF;RAISE NOTICE 'PASS actual original move subcent stack refuses';END$$;
ROLLBACK;
BEGIN;
UPDATE cash_seat_move_receipts SET receipt=jsonb_set(receipt,'{stack}','"malformed"'::jsonb);
DO $$BEGIN IF fn_union_pnl_prove_original_unchanged_stack('3432f4c2-6ab2-44e4-8e8e-b405defbff95',26114243)->>'status' IS DISTINCT FROM 'refused' THEN RAISE EXCEPTION 'malformed original move stack accepted';END IF;RAISE NOTICE 'PASS actual original move malformed stack refuses';END$$;
ROLLBACK;
DO $$BEGIN IF md5(pg_get_functiondef('fn_pnl_evidence_cents(jsonb)'::regprocedure)) IS DISTINCT FROM '8d712bd799c3dfa691f2d8d9ff5101e8' THEN RAISE EXCEPTION 'monetary converter preimage differs';END IF;END$$;
