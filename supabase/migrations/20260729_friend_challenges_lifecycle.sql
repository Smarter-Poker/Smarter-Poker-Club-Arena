-- Friend challenges were send-only (a row was inserted, then nothing). Full
-- lifecycle: accept/decline, progress accrual, expiry resolution (races — most
-- progress by expires_at wins). Applied via Supabase MCP 2026-07-29 (incl. pg_cron
-- 'resolve-friend-challenges' every 15 min).

ALTER TABLE public.friend_challenges
  ADD COLUMN IF NOT EXISTS winner_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE OR REPLACE FUNCTION public.fn_respond_friend_challenge(p_challenge_id uuid, p_accept boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row friend_challenges;
BEGIN
  SELECT * INTO v_row FROM friend_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_row.challengee_id <> auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_responded');
  END IF;
  UPDATE friend_challenges
     SET status = CASE WHEN p_accept THEN 'active' ELSE 'declined' END
   WHERE id = p_challenge_id;
  RETURN jsonb_build_object('success', true, 'status', CASE WHEN p_accept THEN 'active' ELSE 'declined' END);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_bump_friend_challenge_progress(p_challenge_type text, p_amount numeric DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_amount IS NULL OR p_amount = 0 THEN RETURN; END IF;
  UPDATE friend_challenges
     SET challenger_progress = COALESCE(challenger_progress,0) + p_amount
   WHERE challenge_type = p_challenge_type AND status = 'active'
     AND challenger_id = v_uid AND expires_at > now();
  UPDATE friend_challenges
     SET challengee_progress = COALESCE(challengee_progress,0) + p_amount
   WHERE challenge_type = p_challenge_type AND status = 'active'
     AND challengee_id = v_uid AND expires_at > now();
END; $$;

CREATE OR REPLACE FUNCTION public.fn_resolve_expired_friend_challenges()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  WITH resolved AS (
    UPDATE friend_challenges fc
       SET status = 'completed', resolved_at = now(),
           winner_id = CASE
             WHEN COALESCE(fc.challenger_progress,0) > COALESCE(fc.challengee_progress,0) THEN fc.challenger_id
             WHEN COALESCE(fc.challengee_progress,0) > COALESCE(fc.challenger_progress,0) THEN fc.challengee_id
             ELSE NULL END
     WHERE fc.status = 'active' AND fc.expires_at <= now()
     RETURNING 1)
  SELECT count(*) INTO v_count FROM resolved;
  RETURN jsonb_build_object('success', true, 'resolved', v_count);
END; $$;

GRANT EXECUTE ON FUNCTION public.fn_respond_friend_challenge(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_bump_friend_challenge_progress(text, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_expired_friend_challenges() TO service_role;
