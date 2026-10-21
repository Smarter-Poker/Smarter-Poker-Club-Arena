-- Owner request 2026-10-21: automatically show each new club news message
-- once per player, across devices. No daily reset and no opt-out preference.
-- Receipts belong to the authenticated reader; no client-selected revision.
-- No foreign keys to hot club/member tables: receipts contain no money.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE public.club_entry_news_receipts (
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  news_key text NOT NULL,
  content_key text NOT NULL,
  shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, club_id, news_key)
);
ALTER TABLE public.club_entry_news_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_entry_news_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.club_entry_news_receipts TO authenticated;
CREATE POLICY club_entry_news_receipts_own ON public.club_entry_news_receipts
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE FUNCTION public.fn_claim_club_entry_news(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_entry jsonb;
  v_message text := '';
  v_posts jsonb := '[]'::jsonb;
  v_key text;
  v_post record;
  v_inserted integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  -- Match the announcement reader's membership boundary. Staff with a
  -- management grant may also enter through the club-management workspace.
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                 WHERE m.club_id = p_club_id AND m.user_id = v_uid)
     AND NOT COALESCE(public.fn_can_manage_club_message(p_club_id, v_uid), false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  v_entry := public.fn_get_club_entry_message(p_club_id);
  IF NOT COALESCE((v_entry->>'ok')::boolean, false) THEN RETURN v_entry; END IF;

  -- Unique receipts arbitrate concurrent tabs/devices. Only the INSERT
  -- winner returns each message. Neither a reread nor a date can reopen it.
  IF COALESCE((v_entry->>'should_show')::boolean, false) THEN
    v_key := md5(v_entry->>'message');
    INSERT INTO public.club_entry_news_receipts AS r(user_id, club_id, news_key, content_key)
    VALUES (v_uid, p_club_id, 'lobby', v_key)
    ON CONFLICT (user_id, club_id, news_key) DO UPDATE
      SET content_key = EXCLUDED.content_key, shown_at = now()
      WHERE r.content_key IS DISTINCT FROM EXCLUDED.content_key;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 1 THEN v_message := btrim(v_entry->>'message'); END IF;
  END IF;

  FOR v_post IN
    SELECT a.id, a.title, a.content FROM public.club_announcements a
    WHERE a.club_id = p_club_id AND COALESCE(a.is_active, true)
      AND (a.expires_at IS NULL OR a.expires_at > now())
    ORDER BY a.is_pinned DESC, a.created_at DESC, a.id
    LIMIT 200
  LOOP
    -- Pins, ordering, unchanged saves and expiry edits are not new copy.
    -- A new announcement ID or changed title/body is new news.
    v_key := md5(jsonb_build_array(v_post.title, v_post.content)::text);
    INSERT INTO public.club_entry_news_receipts AS r(user_id, club_id, news_key, content_key)
    VALUES (v_uid, p_club_id, 'post:' || v_post.id::text, v_key)
    ON CONFLICT (user_id, club_id, news_key) DO UPDATE
      SET content_key = EXCLUDED.content_key, shown_at = now()
      WHERE r.content_key IS DISTINCT FROM EXCLUDED.content_key;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 1 THEN
      v_posts := v_posts || jsonb_build_array(jsonb_build_object(
        'id', v_post.id, 'title', v_post.title, 'content', v_post.content));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'message', v_message,
    'revision', v_entry->'revision', 'should_show', v_message <> '',
    'announcements', v_posts);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_claim_club_entry_news(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_club_entry_news(uuid) TO authenticated;
COMMIT;
