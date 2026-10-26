-- TIER: 2. Read-only Messenger projection; no account/message/financial writes.
-- Reserved by scripts/new-migration.mjs; successor to installed 20261025185834.
-- Live name readback exposed 73 retired PostDeploy profiles whose auth.users
-- rows are soft-deleted. Immutable-ledger retirement retains profiles and clears
-- the reserved email, so the active certification predicate no longer matches.
-- A deleted sign-in counterpart cannot be an active direct-message identity.
-- Exclude that authoritative state, independent of any name or email pattern.
-- Groups and every active named user remain visible. Keep existing auth,
-- unread boundaries, active-certification isolation, signature and ACLs.
-- Rollback: restore the guarded preceding definition from
-- tests/fixtures/messenger-inbox-equipment/installed-inbox-pre-retirement.sql
-- in a newly reserved one-transaction migration; never replay installed files.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $preflight$
BEGIN
 IF md5(pg_get_functiondef('public.fn_get_user_conversations(uuid,uuid)'::regprocedure))
    <> '9de6d724a124f5be3f3a487fa5d0f41f' THEN
  RAISE EXCEPTION 'Messenger retirement preimage changed; requalify before installation';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='auth'
               AND table_name='users' AND column_name='deleted_at') THEN
  RAISE EXCEPTION 'Authoritative sign-in retirement state is required';
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
      AND (COALESCE(c.is_group, false) OR NOT EXISTS (
           SELECT 1 FROM auth.users counterpart_account
           WHERE counterpart_account.id = ou.id
             AND counterpart_account.deleted_at IS NOT NULL))
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
$function$
;
DO $postflight$
BEGIN
 IF position('counterpart_account.deleted_at IS NOT NULL' IN
    (SELECT prosrc FROM pg_proc WHERE oid='public.fn_get_user_conversations(uuid,uuid)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'Messenger retired-counterpart visibility contract was not installed';
 END IF;
END $postflight$;
COMMIT;
