-- 20261005222016_messenger_never_carries_a_statement_s_ledger_id_list.sql
-- @live-proof: position('''private_bank_ledger_ids''' in pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure)) > 0 AND position('{lines,private_bank_ledger_ids}' in pg_get_functiondef('public.fn_messenger_message_page(uuid,uuid,timestamp with time zone,uuid,integer)'::regprocedure)) > 0 AND position('{lines,private_bank_ledger_ids}' in pg_get_functiondef('public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure)) > 0
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT BROKE (read from production 2026-10-05)
--
-- Dan opened "Deep Stack Society Accounting" in the Messenger Club Arena
-- drawer and it never loaded. /api/messenger/get-messages returned 503
-- "Messenger State Unavailable" at 21:53:22, 21:54:29 and 21:55:04 UTC.
--
-- The thread's only message is Weekly Club Statement CA-2026-00000608
-- (invoice 5e0cacf5-55f4-48b6-a064-fe516e7ad0ff, week 2026-09-21). Its
-- media_metadata is 8,686,492 bytes, 8,683,888 of them the single key
-- lines.private_bank_ledger_ids: every private cash deposit of the week, about
-- 197k ledger ids. fn_messenger_continuity_window turns the page into JSON with
-- jsonb_agg(to_jsonb(m)); on that one row it takes 27-32 s (measured three
-- times), and service_role's statement_timeout is 8 s, so every open is
-- cancelled. The same statement sits in the club's own invoice thread
-- (message 3c9a4891-86cd-438a-b89d-98c492ff15b5) and in Dan's unread
-- notification 723a194e-1827-48f4-aed2-9d1d2966aaa5 (data AND metadata,
-- 17 MB together).
--
-- THE LINE THAT PRODUCED IT
--
-- fn_deliver_accounting_invoice copies the invoice breakdown into the message
-- and notification as 'lines', minus 'source_ledger_ids' - the statement's id
-- list as it was when delivery was written (2026-09-14). On 2026-09-28
-- (20260928164258) the statement gained a second id list,
-- 'private_bank_ledger_ids', and the delivery's exclusion was never widened.
-- The lists are the statement's provenance; they stay on
-- settlement_invoices.breakdown, which is the record. Nothing in a messenger
-- or notification surface reads them (World Hub and Club Arena clients
-- searched; no reader names either key).
--
-- WHAT THIS CHANGES
--
--  1. The writer: the delivered 'lines' exclude both id lists, so no future
--     statement can put the list in a message or a notification.
--  2. The two private readers (fn_messenger_message_page, which the continuity
--     window and get-messages use, and fn_messenger_search_messages) project
--     an issued message without either id list. An issued accounting message
--     is immutable (fn_accounting_document_immutable) and stays byte for byte
--     as delivered; the reader simply does not ship 8 MB of ids nobody shows.
--  3. The three notifications that carry the list lose that one key from data
--     and metadata. Notifications are delivery copies, not documents: no
--     immutability trigger covers them and the invoice is untouched.
--
-- No money moves, no invoice, ledger, delivery or message row is written.
-- Each patch asserts its exact pre-image fragment occurs once and its post-image
-- is installed, so the migration aborts if either function moved underneath it.
-- A function already carrying its post-image is left as it is, so the file is
-- safe to send through apply-merged-migration.yml after the same body was
-- installed by hand on 2026-10-05 22:45 UTC to restore the thread (that
-- installation wrote no history row; the applier records it).
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md,
-- production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $patch$
DECLARE
  v_def text;
  v_old text;
  v_new text;
  v_fn  regprocedure;
BEGIN
  -- 1. The writer.
  v_fn := 'public.fn_deliver_accounting_invoice(uuid)'::regprocedure;
  v_old := $$'lines',inv.breakdown-'source_ledger_ids')$$;
  v_new := $$'lines',inv.breakdown-ARRAY['source_ledger_ids','private_bank_ledger_ids'])$$;
  v_def := pg_get_functiondef(v_fn);
  IF position(v_new IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'fn_deliver_accounting_invoice pre-image moved: lines fragment not found exactly once';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
  IF position(v_new IN pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'fn_deliver_accounting_invoice post-image not installed';
  END IF;

  -- 2. The readers. Parenthesised: binary minus binds tighter than #-.
  v_old := $$(COALESCE(m.media_metadata,'{}')-ARRAY['cashier',$$;
  v_new := $$((COALESCE(m.media_metadata,'{}') #- '{lines,private_bank_ledger_ids}'::text[] #- '{lines,source_ledger_ids}'::text[])-ARRAY['cashier',$$;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.fn_messenger_message_page(uuid,uuid,timestamp with time zone,uuid,integer)'::regprocedure,
    'public.fn_messenger_search_messages(uuid,uuid[],text,integer)'::regprocedure
  ] LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(v_new IN v_def) = 0 THEN
      IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
        RAISE EXCEPTION '% pre-image moved: metadata projection not found exactly once', v_fn;
      END IF;
      EXECUTE replace(v_def, v_old, v_new);
    END IF;
    IF position(v_new IN pg_get_functiondef(v_fn)) = 0 THEN
      RAISE EXCEPTION '% post-image not installed', v_fn;
    END IF;
  END LOOP;
END
$patch$;

-- 3. The delivery copies already carrying the list.
UPDATE public.notifications
   SET data     = data     #- '{lines,private_bank_ledger_ids}'::text[],
       metadata = metadata #- '{lines,private_bank_ledger_ids}'::text[]
 WHERE data->'lines' ? 'private_bank_ledger_ids'
    OR metadata->'lines' ? 'private_bank_ledger_ids';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.notifications
              WHERE data->'lines' ? 'private_bank_ledger_ids'
                 OR metadata->'lines' ? 'private_bank_ledger_ids') THEN
    RAISE EXCEPTION 'a notification still carries private_bank_ledger_ids';
  END IF;
END
$post$;

COMMIT;
