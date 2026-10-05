-- 20261005230238_a_removed_certification_identity_takes_its_accounting_thread.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT DAN SAW (2026-10-05)
--
-- In the World Hub Messenger Club Arena drawer, Deep Stack Society's Messages
-- tab listed a thread called "Deep Stack Society Accounting" that was not an
-- invoice thread at all: no accounting_conversations row, no delivery row, Dan
-- (kingfish) its only participant, and inside it a second copy of Weekly Club
-- Statement CA-2026-00000608 whose own metadata names the real delivery's
-- conversation (fa9e35df-cd50-4729-9e1c-e6069dd27f59). Six such threads exist,
-- for Deep Stack Society and its union (read from production, listed below).
--
-- THE LINE THAT PRODUCED THEM
--
-- fn_deliver_accounting_invoice gives every recipient of an invoice its own
-- private conversation with the sender. The reserved post-deploy
-- certification identity is a member of the protected E2E club, so a weekly
-- statement reaches it like any member: one conversation per invoice
-- audience, sender plus that identity. cleanup_reserved_certification_account
-- (20260926072127) then removes the identity's delivery rows and its
-- accounting_conversations mapping and, by its own comment, leaves "the social
-- conversation itself ... in place". Deleting the identity's profile cascades
-- its participant row away, so what remains is a conversation whose only
-- member is the sender, with no mapping: Messenger correctly files an
-- unmapped club conversation under Messages, and the sender sees an
-- "Accounting" thread holding somebody else's copy of a statement.
--
-- WHAT THIS CHANGES
--
--  1. The cleanup deletes the conversations it unmaps, in the same statement
--     that unmaps them (a data-modifying CTE). Each mapped conversation has
--     exactly one recipient, so it is the removed identity's own copy and
--     nothing else; its messages, participants, read and saved state cascade
--     with it. The delivery rows are already gone at that point, so
--     fn_accounting_document_immutable no longer treats the messages as issued,
--     and the mapping is gone before the participant cascade runs, so the
--     audience guard does not refuse it (proved in a rolled-back probe on
--     production 2026-10-05: conversation, messages and participants all 0).
--  2. The six threads already orphaned this way are removed. Each is checked
--     on the way: no mapping, every message an undelivered 'invoice' copy sent
--     by the conversation's one remaining participant. The invoices, the real
--     deliveries, their messages and notifications are untouched.
--
-- No money moves. No invoice, ledger or delivery row is written.
--
-- Wrap ALL DDL for one change in ONE transaction (club-arena CLAUDE.md,
-- production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $patch$
DECLARE
  v_fn  regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_def text;
  v_old text := E'  -- for this identity only; the social conversation itself is audience-\n'
             || E'  -- immutable and is left in place.\n';
  v_new text := E'  -- for this identity only. The social conversation goes with its mapping\n'
             || E'  -- (20261005230238): each one has a single recipient, so it is this\n'
             || E'  -- identity\'s own copy, and leaving it behind left the sender a\n'
             || E'  -- one-member, unmapped "Accounting" thread in its Messages tab.\n';
  v_old_delete text := E'  DELETE FROM public.accounting_conversations\n'
                    || E'   WHERE recipient_id = p_user_id OR sender_id = p_user_id;\n';
  v_new_delete text := E'  WITH unmapped AS (\n'
                    || E'    DELETE FROM public.accounting_conversations\n'
                    || E'     WHERE recipient_id = p_user_id OR sender_id = p_user_id\n'
                    || E'    RETURNING conversation_id\n'
                    || E'  )\n'
                    || E'  DELETE FROM public.social_conversations s\n'
                    || E'   WHERE s.id IN (SELECT conversation_id FROM unmapped);\n';
BEGIN
  v_def := pg_get_functiondef(v_fn);
  IF position(v_new_delete IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1
       OR (length(v_def) - length(replace(v_def, v_old_delete, ''))) / length(v_old_delete) <> 1 THEN
      RAISE EXCEPTION 'cleanup_reserved_certification_account pre-image moved';
    END IF;
    EXECUTE replace(replace(v_def, v_old, v_new), v_old_delete, v_new_delete);
  END IF;
  IF position(v_new_delete IN pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'cleanup_reserved_certification_account post-image not installed';
  END IF;
END
$patch$;

-- The threads already left behind. Read 2026-10-05 22:55 UTC:
--   3636a900-c626-4bf3-86b8-71806a40de73  union_weekly_credit_note   2026-09-26
--   a6a54601-9c3a-4db6-8e1b-cf4bd0377f40  club_weekly_accounting     2026-09-29
--   602c1d3c-75c4-424f-97f2-37f0efc4960b  club_weekly_accounting     2026-10-01
--   f5ecb36b-b87b-43dd-8933-20ad66ec3145  union_to_club + squareup   2026-10-01
--   3b381238-9825-41c5-aa69-e42de8c70559  union_weekly_credit_note x2 2026-10-02
--   30eb000c-bead-4c61-b9b2-eb024f6d3d5d  union_to_club              2026-10-03
DO $orphans$
DECLARE
  v_ids uuid[];
  v_deleted integer;
BEGIN
  SELECT coalesce(array_agg(c.id), '{}') INTO v_ids
    FROM public.social_conversations c
   WHERE c.group_name LIKE '% Accounting'
     AND NOT EXISTS (SELECT 1 FROM public.accounting_conversations a WHERE a.conversation_id = c.id)
     AND EXISTS (SELECT 1 FROM public.social_messages m WHERE m.conversation_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM public.social_messages m
                      WHERE m.conversation_id = c.id
                        AND (m.message_type IS DISTINCT FROM 'invoice'
                          OR EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.message_id = m.id)
                          OR NOT EXISTS (SELECT 1 FROM public.social_conversation_participants p
                                          WHERE p.conversation_id = c.id AND p.user_id = m.sender_id)))
     AND (SELECT count(*) FROM public.social_conversation_participants p WHERE p.conversation_id = c.id) = 1;

  -- Never more than were read; fewer only if another agent removed some first.
  IF cardinality(v_ids) > 6 OR NOT (v_ids <@ ARRAY[
       '3636a900-c626-4bf3-86b8-71806a40de73', 'a6a54601-9c3a-4db6-8e1b-cf4bd0377f40',
       '602c1d3c-75c4-424f-97f2-37f0efc4960b', 'f5ecb36b-b87b-43dd-8933-20ad66ec3145',
       '3b381238-9825-41c5-aa69-e42de8c70559', '30eb000c-bead-4c61-b9b2-eb024f6d3d5d']::uuid[]) THEN
    RAISE EXCEPTION 'orphaned accounting threads changed since they were read: %', v_ids;
  END IF;

  DELETE FROM public.social_conversations WHERE id = ANY (v_ids);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'removed % of % orphaned accounting threads', v_deleted, cardinality(v_ids);
  END IF;
END
$orphans$;

COMMIT;
