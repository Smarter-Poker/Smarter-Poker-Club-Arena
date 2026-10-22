-- Reciprocal accepted friendship rows are intentional projections. Joining both
-- directions multiplies a single shared player into four rows. Intersect player
-- IDs first, then resolve profiles once per shared player. No friendships are
-- changed. Preserve the RPC signature, identity resolution, auth guard and ACLs.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.get_mutual_friends(uuid)'::regprocedure))
     <> 'ebf123956cfb4a9cc1505278cd1df8d4' THEN
    RAISE EXCEPTION 'mutual_friends_preimage_changed';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_mutual_friends(p_other_user_id uuid)
RETURNS TABLE(id uuid, username text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH mutual AS (
    SELECT CASE WHEN user_id = auth.uid() THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND auth.uid() IN (user_id, friend_id)
    INTERSECT
    SELECT CASE WHEN user_id = p_other_user_id THEN friend_id ELSE user_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted' AND p_other_user_id IN (user_id, friend_id)
  )
  SELECT
    p.id,
    -- The arena name, never the raw username: alias -> username -> a
    -- display_name that is not simply the real name -> 'Player'.
    public.fn_arena_name(
      p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name
    ) AS username,
    -- The arena portrait. The social photo is the World Hub's; it only stands
    -- in when a player has not chosen arena art yet.
    COALESCE(NULLIF(btrim(p.arena_avatar_url), ''), p.avatar_url) AS avatar_url
  FROM mutual
  JOIN public.profiles p ON p.id = mutual.friend_id
  WHERE auth.uid() IS NOT NULL AND p_other_user_id IS NOT NULL
  ORDER BY public.fn_arena_name(
    p.alias, p.username, p.display_name, p.first_name, p.last_name, p.full_name
  ), p.id
  LIMIT 100
$function$;


COMMIT;
