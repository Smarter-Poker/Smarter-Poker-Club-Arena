-- TIER: 2; read-only inbox projection. No player, money, message or read-state writes.
-- Reserved by scripts/new-migration.mjs against main and remote branches.
-- Screenshot 2026-10-25: retained certification profiles received historical
-- owner/agent welcomes, so a real owner's inbox listed PostDeploy identities.
-- Equipment has no person's name to substitute. Use the authoritative existing
-- equipment predicate, never username patterns, and retain public profile names.
-- New certification welcomes are already refused by the welcome trigger.
-- Real people/horse peers and groups stay visible; equipment keeps its own inbox.
-- Unread takes priority at the owning reader, newest within unread/read groups.
-- Authentication, context boundaries, invoice exclusions, hidden/deleted-message
-- unread counting and signature remain intact. CREATE OR REPLACE retains ACLs.
-- Rollback: apply tests/fixtures/messenger-inbox-equipment/production-inbox.sql
-- as one new BEGIN/COMMIT migration (captured previous exact definition).
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_get_user_conversations(uuid,uuid)'::regprocedure))
    <> 'ebb1b8ca5bec8f89f17a2df579d5e433' THEN
  RAISE EXCEPTION 'Messenger inbox preimage changed; requalify before installation';
 END IF;
 IF to_regprocedure('public.fn_ca_is_cert_account(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Authoritative certification identity predicate is required';
 END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.fn_get_user_conversations(p_user_id uuid, p_context_entity_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(conversation_id uuid, title text, is_group boolean, last_message_at timestamp with time zone, unread_count bigint, other_user_id uuid, other_user_username text, other_user_avatar text, context_entity_id uuid, context_entity_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() IS DISTINCT FROM p_user_id)) THEN
        RAISE EXCEPTION 'fn_get_user_conversations: not authorized to read another user''s inbox';
    END IF;

    RETURN QUERY
    SELECT inbox.* FROM (
    SELECT
        c.id AS conversation_id,
        COALESCE(c.group_name, NULL) AS title,
        c.is_group,
        c.last_message_at,
        (
            SELECT COUNT(*)
              FROM social_messages m
             WHERE m.conversation_id = c.id
               AND m.sender_id != p_user_id
               AND COALESCE(m.is_deleted, false) = false
               AND NOT EXISTS(SELECT 1 FROM public.messenger_hidden_messages hidden WHERE hidden.user_id=p_user_id AND hidden.message_id=m.id)
               AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
        ) AS unread_count,
        ou.id AS other_user_id,
        -- Never nameless: every profile carries a player number.
        COALESCE(
            NULLIF(btrim(ou.display_name), ''),
            NULLIF(btrim(ou.username), ''),
            NULLIF(btrim(ou.alias), ''),
            CASE WHEN ou.id IS NOT NULL THEN 'Player #' || COALESCE(NULLIF(btrim(ou.player_number), ''), left(ou.id::text, 8)) END
        ) AS other_user_username,
        ou.avatar_url AS other_user_avatar,
        p.context_entity_id,
        p.context_entity_type
    FROM social_conversations c
    JOIN social_conversation_participants p
      ON p.conversation_id = c.id AND p.user_id = p_user_id
    LEFT JOIN social_conversation_participants op
      ON op.conversation_id = c.id AND op.user_id <> p_user_id
    LEFT JOIN profiles ou ON ou.id = op.user_id
    WHERE p.context_entity_id IS NOT DISTINCT FROM p_context_entity_id
      -- A one-to-one thread whose other person no longer exists (deleted
      -- account) is never listed or counted: it would render as "Unknown".
      AND (COALESCE(c.is_group, false) OR ou.id IS NOT NULL)
      AND (COALESCE(c.is_group, false)
           OR NOT public.fn_ca_is_cert_account(ou.id)
           OR public.fn_ca_is_cert_account(p_user_id))
      AND EXISTS (
        SELECT 1 FROM public.social_messages m
        WHERE m.conversation_id = c.id
          AND NOT EXISTS (
            SELECT 1 FROM public.accounting_invoice_deliveries d
            JOIN public.settlement_invoices si ON si.id = d.invoice_id
            WHERE d.message_id = m.id
              AND si.invoice_type IS DISTINCT FROM 'cashier_cashout'
          )
      )
    ) inbox
    ORDER BY (inbox.unread_count > 0) DESC, inbox.last_message_at DESC NULLS LAST;
END;
$function$;


DO $postflight$
DECLARE body text;
BEGIN
 SELECT prosrc INTO body FROM pg_proc WHERE oid='public.fn_get_user_conversations(uuid,uuid)'::regprocedure;
 IF position('NOT public.fn_ca_is_cert_account(ou.id)' IN body)=0
 OR position('OR public.fn_ca_is_cert_account(p_user_id)' IN body)=0
 OR position('(inbox.unread_count > 0) DESC' IN body)=0
 OR position('auth.uid() IS DISTINCT FROM p_user_id' IN body)=0 THEN
  RAISE EXCEPTION 'Messenger inbox projection contract was not installed';
 END IF;
END $postflight$;
COMMIT;

