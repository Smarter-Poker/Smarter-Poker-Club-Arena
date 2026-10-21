CREATE OR REPLACE FUNCTION public.get_mutual_friends(p_other_user_id uuid)
 RETURNS TABLE(id uuid, username text, avatar_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH mine AS (
    SELECT CASE WHEN user_id = auth.uid() THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND auth.uid() IN (user_id, friend_id)
  ), theirs AS (
    SELECT CASE WHEN user_id = p_other_user_id THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND p_other_user_id IN (user_id, friend_id)
  )
  SELECT
    p.id,
    public.fn_arena_name(
      p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name
    ) AS username,
    COALESCE(NULLIF(btrim(p.arena_avatar_url), ''), p.avatar_url) AS avatar_url
  FROM mine JOIN theirs USING (friend_id)
  JOIN public.profiles p ON p.id = mine.friend_id
  WHERE auth.uid() IS NOT NULL AND p_other_user_id IS NOT NULL
  ORDER BY public.fn_arena_name(
    p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name
  ), p.id
  LIMIT 100
$function$
