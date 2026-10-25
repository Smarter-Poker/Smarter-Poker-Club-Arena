-- Reserved by maintained helper on 2026-10-25 20:05:52 UTC; sole SQL owner transferred explicitly.
-- Lightning did not retain the DB-accepted lease generation with private hand facts.
-- A later lease holder therefore could not reconstruct the original horse-journal coordinate.
-- Preserve only version+validated lease generation in the first immutable accepted facts.
-- First response and replay read that original atomic PK receipt. Never read a current lease
-- for replay; old rows return JSON null. No new hand-row casts, refusal, money/stack/rake,
-- request-hash definition, public hand-row fields, stored receipt fields or receipt-hash definition changes.
-- The existing physical payload hash naturally covers the added private accepted fact.
-- Native proof exercises actual physical accepted-facts storage and privacy in PG17.
-- @live-proof: md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure))='e1e07d5b421eac181db374a5adb20cb6'
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $journal_coordinate$
DECLARE definition text; before_md5 text := 'd66cc7cdcfd286fbed16127a6798931d';
BEGIN
 definition:=pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure);
 IF md5(definition)<>before_md5 THEN RAISE EXCEPTION 'lightning_private_journal_preimage_changed:%',md5(definition); END IF;
 IF (length(definition)-length(replace(definition,$old0$'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb)$old0$,'')))/length($old0$'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb)$old0$)<>1 THEN RAISE EXCEPTION 'lightning_private_journal_anchor_changed:0'; END IF;
 definition:=replace(definition,$old0$'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb)$old0$,$new0$'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb,
                    'horse_journal_identity', jsonb_build_object('version', 1, 'lease_generation', p_lease_generation))$new0$);
 IF (length(definition)-length(replace(definition,$old1$RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true);$old1$,'')))/length($old1$RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true);$old1$)<>1 THEN RAISE EXCEPTION 'lightning_private_journal_anchor_changed:1'; END IF;
 definition:=replace(definition,$old1$RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true);$old1$,$new1$RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true,
        'accepted_lease_generation', (SELECT c.post_commit_payload #> '{accepted_hand_facts,horse_journal_identity,lease_generation}'
          FROM public.hand_atomic_commits c WHERE c.hand_id = h.hand_history_id AND c.table_id = h.host_table_id));$new1$);
 IF (length(definition)-length(replace(definition,$old2$RETURN v_receipt;$old2$,'')))/length($old2$RETURN v_receipt;$old2$)<>1 THEN RAISE EXCEPTION 'lightning_private_journal_anchor_changed:2'; END IF;
 definition:=replace(definition,$old2$RETURN v_receipt;$old2$,$new2$RETURN v_receipt || jsonb_build_object('accepted_lease_generation',
    (SELECT c.post_commit_payload #> '{accepted_hand_facts,horse_journal_identity,lease_generation}'
       FROM public.hand_atomic_commits c WHERE c.hand_id = v_hh AND c.table_id = p_host_table_id));$new2$);
 IF md5(definition)<>'e1e07d5b421eac181db374a5adb20cb6' THEN RAISE EXCEPTION 'lightning_private_journal_postimage_changed'; END IF;
 EXECUTE definition;
END $journal_coordinate$;
COMMIT;
